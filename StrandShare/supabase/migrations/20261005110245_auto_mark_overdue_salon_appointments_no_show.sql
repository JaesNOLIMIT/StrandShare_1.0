-- Close unattended booked salon appointments as soon as their configured
-- late-arrival grace period expires. Expected walk-in/drop-off records also
-- have a legacy appointment row, so they are deliberately excluded here.

begin;

alter table public."Salon_Donation_Appointments"
  add column if not exists "Auto_No_Show_At" timestamp without time zone;

create index if not exists idx_salon_appointments_overdue_active
  on public."Salon_Donation_Appointments" ("Appointment_Start_At")
  where "Status" in ('Confirmed', 'Rescheduled')
    and "Auto_No_Show_At" is null;

create or replace function public.mark_overdue_salon_appointments_no_show()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_count integer := 0;
begin
  update public."Salon_Donation_Appointments" appointment
  set
    "Status" = 'No Show',
    "Cancelled_At" = coalesce(appointment."Cancelled_At", v_now),
    "Cancellation_Reason" =
      'Automatically marked No Show after the appointment grace period expired.',
    "Auto_No_Show_At" = v_now,
    "Updated_At" = v_now
  from public."Salon_Operating_Hours" hours
  where appointment."Status" in ('Confirmed', 'Rescheduled')
    and appointment."Auto_No_Show_At" is null
    and hours."Day_Group" = case
      when extract(isodow from appointment."Appointment_Start_At"::date) between 1 and 5
        then 'Weekday'
      else 'Weekend'
    end
    and appointment."Appointment_Start_At"
      + make_interval(mins => greatest(coalesce(hours."Late_Grace_Minutes", 0), 0))
      <= v_now
    and not exists (
      select 1
      from public."Hair_Submission_Logistics" logistics
      where logistics."Submission_ID" = appointment."Hair_Submission_ID"
        and (
          lower(coalesce(logistics."Logistics_Type", '')) like '%walk-in%'
          or lower(coalesce(logistics."Logistics_Type", '')) like '%dropoff%'
          or lower(coalesce(logistics."Logistics_Type", '')) like '%courier%'
        )
    );

  get diagnostics v_count = row_count;

  -- Release the donor's screening from an unattended booking. No detail is
  -- approved and no inventory row can be created by this transition.
  update public."Hair_Submissions" submission
  set
    "Status" = 'Cancelled',
    "Updated_At" = v_now
  from public."Salon_Donation_Appointments" appointment
  where appointment."Hair_Submission_ID" = submission."Submission_ID"
    and appointment."Auto_No_Show_At" = v_now
    and public.normalize_flow_key(submission."Status") = 'pending'
    and submission."Bundle_ID" is null;

  return v_count;
end;
$fn$;

revoke all on function public.mark_overdue_salon_appointments_no_show()
  from public, anon, authenticated;

create or replace function public.staff_refresh_overdue_salon_appointments()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin') then
    raise exception 'Only active staff or admin accounts can refresh salon appointments.';
  end if;

  return public.mark_overdue_salon_appointments_no_show();
end;
$fn$;

revoke all on function public.staff_refresh_overdue_salon_appointments()
  from public, anon, authenticated;
grant execute on function public.staff_refresh_overdue_salon_appointments()
  to authenticated;

comment on function public.mark_overdue_salon_appointments_no_show() is
  'Marks unattended booked salon appointments No Show after start time plus the configured Manila-time grace period.';

comment on column public."Salon_Donation_Appointments"."Auto_No_Show_At" is
  'Manila timestamp when the appointment was automatically closed after its late-arrival grace period.';

create extension if not exists pg_cron with schema pg_catalog;

do $do$
declare
  v_job_id bigint;
  v_duplicate_job_id bigint;
begin
  select min(job.jobid)
  into v_job_id
  from cron.job job
  where job.jobname = 'strandshare-salon-appointment-no-shows';

  if v_job_id is null then
    v_job_id := cron.schedule(
      'strandshare-salon-appointment-no-shows',
      '* * * * *',
      'select public.mark_overdue_salon_appointments_no_show();'
    );
  else
    perform cron.alter_job(
      v_job_id,
      schedule := '* * * * *',
      command := 'select public.mark_overdue_salon_appointments_no_show();',
      active := true
    );
  end if;

  for v_duplicate_job_id in
    select job.jobid
    from cron.job job
    where job.jobname = 'strandshare-salon-appointment-no-shows'
      and job.jobid <> v_job_id
  loop
    delete from cron.job_run_details detail
    where detail.jobid = v_duplicate_job_id;
    perform cron.unschedule(v_duplicate_job_id);
  end loop;
end;
$do$;

-- Apply the rule to stale records during deployment. Staff page refreshes and
-- the minute cron keep it current afterward.
select public.mark_overdue_salon_appointments_no_show();

notify pgrst, 'reload schema';

commit;
