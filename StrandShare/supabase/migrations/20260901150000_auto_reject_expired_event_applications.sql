-- Permanently close event applications that reach their proposed start time
-- before staff completes the initial review. This reuses the existing event
-- maintenance job, so no additional pg_cron job or idle polling is introduced.

begin;

alter table public."Event_Applications"
  add column if not exists "Auto_Rejected_At" timestamp without time zone;

create index if not exists idx_event_applications_pending_start
  on public."Event_Applications" ("Proposed_Start_At")
  where "Status" = 'Pending Staff Review'
    and "Auto_Rejected_At" is null;

-- The normal workflow trigger requires a signed-in staff actor. The narrowly
-- scoped maintenance function below sets this transaction-local flag, and the
-- trigger is skipped only when the row also carries the automatic marker.
drop trigger if exists trg_enforce_event_application_workflow
  on public."Event_Applications";

create trigger trg_enforce_event_application_workflow
  before update on public."Event_Applications"
  for each row
  when (
    coalesce(
      current_setting('strandshare.auto_reject_expired_event_applications', true),
      'off'
    ) <> 'on'
    or new."Auto_Rejected_At" is null
  )
  execute function public.enforce_event_application_workflow();

create or replace function public.lock_auto_rejected_event_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old."Auto_Rejected_At" is not null
    and coalesce(
      current_setting('strandshare.auto_reject_expired_event_applications', true),
      'off'
    ) <> 'on'
  then
    raise exception 'This application was automatically rejected because its proposed event date passed before staff review.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_lock_auto_rejected_event_application
  on public."Event_Applications";

create trigger trg_lock_auto_rejected_event_application
  before update or delete on public."Event_Applications"
  for each row
  execute function public.lock_auto_rejected_event_application();

create or replace function public.reject_expired_event_applications()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer := 0;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  perform set_config(
    'strandshare.auto_reject_expired_event_applications',
    'on',
    true
  );

  update public."Event_Applications"
  set
    "Status" = 'Rejected',
    "Staff_Rejection_Reason" =
      'Automatically rejected because the proposed event start date passed before staff review.',
    "Auto_Rejected_At" = v_now,
    "Updated_At" = v_now
  where public.normalize_flow_key("Status") = 'pendingstaffreview'
    and "Linked_Event_Request_ID" is null
    and "Proposed_Start_At" is not null
    and "Proposed_Start_At" <= v_now
    and "Auto_Rejected_At" is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

revoke all on function public.reject_expired_event_applications()
  from public, anon, authenticated;

-- Preserve the existing return value (number of approved requests ended), but
-- also close expired intake applications whenever the same job runs.
create or replace function public.mark_ended_event_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  perform public.reject_expired_event_applications();

  update public."Event_Requests"
  set "Status" = 'Ended', "Ended_At" = coalesce("Ended_At", now())
  where public.normalize_flow_key("Status") = 'approved'
    and "End_Date" is not null
    and "End_Date" <= timezone('Asia/Manila', now());

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

revoke all on function public.mark_ended_event_requests()
  from public, anon, authenticated;

comment on function public.reject_expired_event_applications()
  is 'Rejects unreviewed event applications after Proposed_Start_At; invoked by the existing event maintenance job.';

comment on column public."Event_Applications"."Auto_Rejected_At"
  is 'Manila timestamp when an unreviewed application was closed because its proposed start time passed.';

-- Apply the rule immediately to existing stale intake rows. Subsequent runs
-- are handled by strandshare-end-events every five minutes.
select public.reject_expired_event_applications();

commit;
