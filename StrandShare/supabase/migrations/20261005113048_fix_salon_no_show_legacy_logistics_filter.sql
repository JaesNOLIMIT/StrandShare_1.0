-- The original no-show rule excluded every appointment whose submission had a
-- walk-in/drop-off logistics row. Older genuine booked appointments also use
-- that label with Dropoff_Status = Scheduled, so they were never closed. Only
-- exclude true expected-arrival records, which carry an expected date/time.

begin;

-- The legacy appointment guard requires the old check-in workflow and a
-- signed-in staff actor. Add tightly scoped exits for the two trusted server
-- operations; every ordinary walk-in update continues through the full guard.
do $do$
declare
  v_guard_definition text;
  v_review_definition text;
begin
  select pg_get_functiondef(
    'public.guard_salon_donation_appointment()'::regprocedure
  ) into v_guard_definition;

  if position('strandshare.salon_appointment_transition' in v_guard_definition) = 0 then
    v_guard_definition := regexp_replace(
      v_guard_definition,
      E'begin\\n',
      E'begin\n  if tg_op = ''UPDATE''\n     and current_setting(''strandshare.salon_appointment_transition'', true) = ''auto_no_show''\n     and old."Status" in (''Confirmed'', ''Rescheduled'')\n     and new."Status" = ''No Show''\n     and new."Auto_No_Show_At" is not null then\n    new."Cancelled_At" := coalesce(new."Cancelled_At", timezone(''Asia/Manila'', now()));\n    new."Updated_At" := timezone(''Asia/Manila'', now());\n    return new;\n  end if;\n\n  if tg_op = ''UPDATE''\n     and current_setting(''strandshare.salon_appointment_transition'', true) = ''appointment_review''\n     and old."Status" in (''Confirmed'', ''Rescheduled'', ''Checked In'')\n     and new."Status" = ''Completed''\n     and new."Completed_At" is not null then\n    new."Updated_At" := timezone(''Asia/Manila'', now());\n    return new;\n  end if;\n',
      ''
    );
    execute v_guard_definition;
  end if;

  select pg_get_functiondef(
    'public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb)'::regprocedure
  ) into v_review_definition;

  if position('strandshare.salon_appointment_transition' in v_review_definition) = 0 then
    v_review_definition := replace(
      v_review_definition,
      E'  return public.staff_review_salon_appointment_hair(',
      E'  perform set_config(''strandshare.salon_appointment_transition'', ''appointment_review'', true);\n\n  return public.staff_review_salon_appointment_hair('
    );
    execute v_review_definition;
  end if;
end;
$do$;

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
  perform set_config(
    'strandshare.salon_appointment_transition',
    'auto_no_show',
    true
  );

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
          logistics."Expected_Dropoff_Date" is not null
          or logistics."Expected_Arrival_Time" is not null
        )
    );

  get diagnostics v_count = row_count;

  update public."Hair_Submissions" submission
  set
    "Status" = 'Cancelled',
    "Updated_At" = v_now
  from public."Salon_Donation_Appointments" appointment
  where appointment."Hair_Submission_ID" = submission."Submission_ID"
    and appointment."Auto_No_Show_At" = v_now
    and public.normalize_flow_key(submission."Status") = 'pending'
    and submission."Bundle_ID" is null;

  -- Keep legacy scheduled logistics consistent with the appointment. True
  -- expected-arrival rows were excluded above and are not changed here.
  update public."Hair_Submission_Logistics" logistics
  set
    "Dropoff_Status" = 'No Show',
    "Cancelled_At" = coalesce(logistics."Cancelled_At", v_now),
    "Cancellation_Reason" =
      'Automatically marked No Show after the appointment grace period expired.',
    "Updated_At" = v_now
  from public."Salon_Donation_Appointments" appointment
  where appointment."Hair_Submission_ID" = logistics."Submission_ID"
    and appointment."Auto_No_Show_At" = v_now
    and logistics."Expected_Dropoff_Date" is null
    and logistics."Expected_Arrival_Time" is null
    and public.normalize_flow_key(coalesce(logistics."Dropoff_Status", ''))
      not in ('completed', 'cancelled', 'noshow');

  return v_count;
end;
$fn$;

revoke all on function public.mark_overdue_salon_appointments_no_show()
  from public, anon, authenticated;

comment on function public.mark_overdue_salon_appointments_no_show() is
  'Marks unattended booked salon appointments No Show after start plus grace, including legacy Scheduled appointment logistics while excluding true expected arrivals.';

-- Correct already-overdue rows immediately; the existing minute cron keeps
-- invoking this replaced function afterward.
select public.mark_overdue_salon_appointments_no_show();

notify pgrst, 'reload schema';

commit;
