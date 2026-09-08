begin;

-- Reaching the proposed start time is a cancellation, never a rejection.
-- The same rule applies while Staff is reviewing and while Admin is deciding.
alter table public."Event_Applications"
  add column if not exists "Auto_Rejected_At" timestamp without time zone,
  add column if not exists "Auto_Cancelled_At" timestamp without time zone,
  add column if not exists "Cancellation_Reason" text;

alter table public."Event_Requests"
  add column if not exists "Auto_Cancelled_At" timestamp without time zone,
  add column if not exists "Cancellation_Reason" text;

alter table public."Event_Applications"
  drop constraint if exists event_applications_status_check;
alter table public."Event_Applications"
  add constraint event_applications_status_check check (
    public.normalize_flow_key("Status") in (
      'pendingstaffreview', 'pendingadmindecision', 'approved', 'rejected',
      'appealed', 'withdrawn', 'closed', 'cancelled'
    )
  );

drop index if exists public.idx_event_applications_pending_start;
create index if not exists idx_event_applications_unfinished_start
  on public."Event_Applications" ("Proposed_Start_At")
  where "Auto_Cancelled_At" is null;

-- Maintenance updates do not have a signed-in Staff/Admin actor. Permit only
-- rows carrying the automatic-cancellation marker to bypass workflow guards.
drop trigger if exists trg_enforce_event_application_workflow
  on public."Event_Applications";
create trigger trg_enforce_event_application_workflow
  before update on public."Event_Applications"
  for each row
  when (
    coalesce(
      current_setting('strandshare.auto_cancel_expired_event_applications', true),
      'off'
    ) <> 'on'
    or new."Auto_Cancelled_At" is null
  )
  execute function public.enforce_event_application_workflow();

drop trigger if exists trg_enforce_event_request_workflow
  on public."Event_Requests";
create trigger trg_enforce_event_request_workflow
  before update on public."Event_Requests"
  for each row
  when (
    coalesce(
      current_setting('strandshare.auto_cancel_expired_event_applications', true),
      'off'
    ) <> 'on'
    or new."Auto_Cancelled_At" is null
  )
  execute function public.enforce_event_request_workflow();

create or replace function public.lock_auto_rejected_event_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (old."Auto_Cancelled_At" is not null or old."Auto_Rejected_At" is not null)
    and coalesce(
      current_setting('strandshare.auto_cancel_expired_event_applications', true),
      'off'
    ) <> 'on'
    and coalesce(
      current_setting('strandshare.auto_reject_expired_event_applications', true),
      'off'
    ) <> 'on'
  then
    raise exception 'This application was automatically cancelled because review was not completed before its proposed start time.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

create or replace function public.cancel_expired_event_applications()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer := 0;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_reason text := 'Cancelled by our team because Staff and Admin review were not completed before the proposed program start time.';
  v_application record;
  v_recipient_email text;
begin
  perform set_config(
    'strandshare.auto_cancel_expired_event_applications',
    'on',
    true
  );

  for v_application in
    update public."Event_Applications" application
    set
      "Status" = 'Cancelled',
      "Cancellation_Reason" = v_reason,
      "Auto_Cancelled_At" = v_now,
      "Updated_At" = v_now
    where public.normalize_flow_key(application."Status") in (
        'pendingstaffreview', 'pendingadmindecision', 'appealed'
      )
      and application."Proposed_Start_At" is not null
      and application."Proposed_Start_At" <= v_now
      and application."Auto_Cancelled_At" is null
      and (
        (
          public.normalize_flow_key(application."Status") = 'pendingstaffreview'
          and application."Linked_Event_Request_ID" is null
        )
        or exists (
          select 1
          from public."Event_Requests" request
          where request."Event_Application_ID" = application."Event_Application_ID"
            and public.normalize_flow_key(request."Status") in (
              'pendingadminapproval', 'appealed'
            )
        )
      )
    returning application.*
  loop
    v_count := v_count + 1;

    update public."Event_Requests" request
    set
      "Status" = 'Cancelled',
      "Cancellation_Reason" = v_reason,
      "Admin_Decision_Reason" = v_reason,
      "Auto_Cancelled_At" = v_now,
      "Updated_At" = v_now
    where request."Event_Application_ID" = v_application."Event_Application_ID"
      and public.normalize_flow_key(request."Status") in (
        'pendingadminapproval', 'appealed'
      );

    v_recipient_email := public.resolve_event_application_recipient_email(
      v_application."Applicant_Email",
      v_application."Preferred_Contact_Method",
      v_application."Preferred_Contact_Detail"
    );

    if v_recipient_email is not null then
      perform public.enqueue_smtp_email_outbox(
        'event_auto_cancelled:' || v_application."Event_Application_ID"::text,
        'Event_Applications',
        v_application."Event_Application_ID",
        'event_auto_cancelled',
        v_recipient_email,
        'Program Application Cancelled',
        'event_auto_cancelled',
        jsonb_build_object(
          'event_application_id', v_application."Event_Application_ID",
          'event_name', coalesce(v_application."Event_Name", ''),
          'proposed_start_at', v_application."Proposed_Start_At",
          'cancellation_reason', v_reason,
          'message', v_reason
        ),
        null
      );
    end if;
  end loop;

  return v_count;
end;
$fn$;

-- Keep the former function name as a compatibility alias for any existing
-- callers, but it now cancels and never rejects.
create or replace function public.reject_expired_event_applications()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return public.cancel_expired_event_applications();
end;
$fn$;

create or replace function public.mark_ended_event_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  perform public.cancel_expired_event_applications();

  update public."Event_Requests"
  set "Status" = 'Ended', "Ended_At" = coalesce("Ended_At", now())
  where public.normalize_flow_key("Status") = 'approved'
    and "End_Date" is not null
    and "End_Date" <= timezone('Asia/Manila', now());

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- Previously auto-rejected rows are corrected to the new cancellation rule.
select set_config('strandshare.auto_cancel_expired_event_applications', 'on', true);
select set_config('strandshare.auto_reject_expired_event_applications', 'on', true);

update public."Event_Applications"
set
  "Status" = 'Cancelled',
  "Cancellation_Reason" = 'Cancelled by our team because Staff and Admin review were not completed before the proposed program start time.',
  "Auto_Cancelled_At" = coalesce("Auto_Rejected_At", timezone('Asia/Manila', now())),
  "Updated_At" = timezone('Asia/Manila', now())
where "Auto_Rejected_At" is not null
  and public.normalize_flow_key("Status") = 'rejected';

-- Cancelled applications are terminal and must not block a later submission.
create or replace function public.enforce_one_active_event_application_per_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_email text := lower(trim(coalesce(new."Applicant_Email", '')));
  v_status text := public.normalize_flow_key(new."Status");
begin
  if v_email = '' or v_status in ('approved', 'rejected', 'cancelled') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  if exists (
    select 1 from public."Event_Applications" application
    where lower(trim(coalesce(application."Applicant_Email", ''))) = v_email
      and application."Event_Application_ID" is distinct from new."Event_Application_ID"
      and public.normalize_flow_key(application."Status") not in (
        'approved', 'rejected', 'cancelled'
      )
  ) then
    raise exception 'An active program application already exists for this email. Complete or close it before submitting another application.';
  end if;
  return new;
end;
$fn$;

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
    select 1 from public."Event_Applications" application
    where lower(trim(coalesce(application."Applicant_Email", ''))) = v_email
      and public.normalize_flow_key(application."Status") not in (
        'approved', 'rejected', 'cancelled'
      )
  ) then
    raise exception 'An active program application already exists for this email. Complete or close it before submitting another application.';
  end if;
  return true;
end;
$fn$;

revoke all on function public.cancel_expired_event_applications()
  from public, anon, authenticated;
revoke all on function public.reject_expired_event_applications()
  from public, anon, authenticated;
revoke all on function public.mark_ended_event_requests()
  from public, anon, authenticated;

comment on function public.cancel_expired_event_applications()
  is 'Cancels unfinished Staff/Admin program reviews when Proposed_Start_At is reached and queues an applicant notice.';
comment on function public.reject_expired_event_applications()
  is 'Compatibility alias; unfinished program reviews are now cancelled rather than rejected.';
comment on column public."Event_Applications"."Auto_Cancelled_At"
  is 'Manila timestamp when an unfinished application was cancelled at its proposed start time.';

select public.cancel_expired_event_applications();

notify pgrst, 'reload schema';
commit;
