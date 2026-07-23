-- 146_lock_staff_rejections_and_limit_active_event_applications.sql
-- 1) A staff-rejected intake is final and cannot be reopened or edited.
-- 2) One non-terminal event application is allowed per normalized email.
-- 3) Approved or rejected applications do not prevent a new submission.
-- 4) Repair a missing first resubmission count where an appeal is active.

begin;

create or replace function public.lock_staff_rejected_event_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old_status text;
begin
  v_old_status := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));

  if v_old_status = 'rejected'
    and coalesce(old."Linked_Event_Request_ID", 0) = 0
    and coalesce(old."Staff_Rejected_By_User_ID", 0) > 0
  then
    raise exception 'This application was rejected by staff and is permanently closed. Submit a new application instead.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_lock_staff_rejected_event_application on public."Event_Applications";
create trigger trg_lock_staff_rejected_event_application
before update on public."Event_Applications"
for each row execute function public.lock_staff_rejected_event_application();

-- Reassert the existing rejection-email trigger so every successful staff
-- rejection queues its applicant notification.
drop trigger if exists trg_enqueue_event_application_smtp_notifications on public."Event_Applications";
create trigger trg_enqueue_event_application_smtp_notifications
after update on public."Event_Applications"
for each row execute function public.enqueue_event_application_smtp_notifications();

create or replace function public.enforce_one_active_event_application_per_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_email text;
  v_status text;
begin
  v_email := lower(trim(coalesce(new."Applicant_Email", '')));
  v_status := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));

  if v_email = '' or v_status in ('approved', 'rejected') then
    return new;
  end if;

  -- Serialize submissions for the same normalized email so simultaneous
  -- requests cannot both pass the existence check.
  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  if exists (
    select 1
    from public."Event_Applications" ea
    where lower(trim(coalesce(ea."Applicant_Email", ''))) = v_email
      and ea."Event_Application_ID" is distinct from new."Event_Application_ID"
      and lower(replace(replace(replace(coalesce(ea."Status", ''), '_', ''), ' ', ''), '-', ''))
        not in ('approved', 'rejected')
  ) then
    raise exception 'An active program application already exists for this email. You can submit another application after the current one is approved or rejected.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_one_active_event_application_per_email on public."Event_Applications";
create trigger trg_one_active_event_application_per_email
before insert on public."Event_Applications"
for each row execute function public.enforce_one_active_event_application_per_email();

create or replace function public.assert_event_application_email_available(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_authenticated_email text := lower(trim(coalesce(auth.jwt()->>'email', '')));
begin
  if auth.uid() is null or v_authenticated_email = '' or v_authenticated_email <> v_email then
    raise exception 'Verify this email address before checking application availability.';
  end if;

  if exists (
    select 1
    from public."Event_Applications" ea
    where lower(trim(coalesce(ea."Applicant_Email", ''))) = v_email
      and lower(replace(replace(replace(coalesce(ea."Status", ''), '_', ''), ' ', ''), '-', ''))
        not in ('approved', 'rejected')
  ) then
    raise exception 'An active program application already exists for this email. You can submit another application after the current one is approved or rejected.';
  end if;

  return true;
end;
$fn$;

revoke all on function public.assert_event_application_email_available(text) from public;
grant execute on function public.assert_event_application_email_available(text) to authenticated;

-- Migration 134 stopped incrementing the application counter when it replaced
-- the request/application sync function. Migration 145 increments all future
-- appeals atomically. Backfill the observable active-appeal case once.
update public."Event_Applications" ea
set
  "Resubmission_Count" = 1,
  "Updated_At" = timezone('Asia/Manila', now())
from public."Event_Requests" er
where er."Event_Application_ID" = ea."Event_Application_ID"
  and lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', '')) = 'appealed'
  and coalesce(ea."Resubmission_Count", 0) = 0;

commit;
