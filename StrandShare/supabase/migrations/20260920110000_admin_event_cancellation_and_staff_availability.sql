begin;

-- Administrative program cancellation -------------------------------------------------
alter table public."Event_Requests"
  add column if not exists "Cancellation_Category" text,
  add column if not exists "Cancellation_Explanation" text,
  add column if not exists "Cancelled_At" timestamp without time zone,
  add column if not exists "Cancelled_By_User_ID" integer,
  add column if not exists "Cancelled_By_Role" text,
  add column if not exists "Cancelled_Assigned_Staff_User_ID" integer,
  add column if not exists "Cancellation_Emails_Queued" integer not null default 0,
  add column if not exists "Cancellation_Emails_Skipped" integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_cancelled_by_user_fkey'
  ) then
    alter table public."Event_Requests"
      add constraint event_requests_cancelled_by_user_fkey
      foreign key ("Cancelled_By_User_ID") references public.users(user_id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_cancelled_staff_fkey'
  ) then
    alter table public."Event_Requests"
      add constraint event_requests_cancelled_staff_fkey
      foreign key ("Cancelled_Assigned_Staff_User_ID") references public.users(user_id) on delete set null;
  end if;
end
$$;

alter table public."Event_Requests"
  drop constraint if exists event_requests_cancellation_category_check;
alter table public."Event_Requests"
  add constraint event_requests_cancellation_category_check check (
    "Cancellation_Category" is null or "Cancellation_Category" in (
      'Severe Weather or Natural Disaster',
      'Venue Unavailable',
      'Safety or Security Concern',
      'Insufficient Participants',
      'Organizer Request',
      'Operational or Staffing Issue',
      'Government or Local Authority Order',
      'Other'
    )
  );

alter table public."Event_Requests"
  drop constraint if exists event_requests_cancelled_by_role_check;
alter table public."Event_Requests"
  add constraint event_requests_cancelled_by_role_check check (
    "Cancelled_By_Role" is null or "Cancelled_By_Role" in ('Admin', 'Super Admin')
  );

-- Staff all-day availability -----------------------------------------------------------
create table if not exists public."Staff_Unavailability" (
  "Staff_Unavailability_ID" bigserial primary key,
  "Staff_User_ID" integer not null references public.users(user_id) on delete restrict,
  "Unavailability_Type" text not null,
  "Weekday" smallint,
  "Specific_Date" date,
  "Reason" text not null,
  "Is_Active" boolean not null default true,
  "Created_By_User_ID" integer not null references public.users(user_id) on delete restrict,
  "Created_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  "Removed_By_User_ID" integer references public.users(user_id) on delete set null,
  "Removed_At" timestamp without time zone,
  "Updated_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  constraint staff_unavailability_type_check check (
    "Unavailability_Type" in ('Recurring Weekday', 'Specific Date')
  ),
  constraint staff_unavailability_value_check check (
    ("Unavailability_Type" = 'Recurring Weekday' and "Weekday" between 0 and 6 and "Specific_Date" is null)
    or
    ("Unavailability_Type" = 'Specific Date' and "Specific_Date" is not null and "Weekday" is null)
  ),
  constraint staff_unavailability_reason_check check (length(trim("Reason")) > 0)
);

create unique index if not exists idx_staff_unavailability_active_weekday
  on public."Staff_Unavailability" ("Staff_User_ID", "Weekday")
  where "Is_Active" is true and "Unavailability_Type" = 'Recurring Weekday';

create unique index if not exists idx_staff_unavailability_active_date
  on public."Staff_Unavailability" ("Staff_User_ID", "Specific_Date")
  where "Is_Active" is true and "Unavailability_Type" = 'Specific Date';

create index if not exists idx_staff_unavailability_staff_history
  on public."Staff_Unavailability" ("Staff_User_ID", "Created_At" desc);

alter table public."Staff_Unavailability" enable row level security;

drop policy if exists staff_unavailability_select_admin_or_self on public."Staff_Unavailability";
create policy staff_unavailability_select_admin_or_self
on public."Staff_Unavailability"
for select
to authenticated
using (
  exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('admin', 'superadmin')
        or (
          public.normalize_app_role(actor.role) = 'staff'
          and actor.user_id = "Staff_Unavailability"."Staff_User_ID"
        )
      )
  )
);

revoke insert, update, delete on public."Staff_Unavailability" from anon, authenticated;
grant select on public."Staff_Unavailability" to authenticated;

create or replace function public.find_staff_unavailability_conflict(
  p_staff_user_id integer,
  p_start_at timestamp without time zone,
  p_end_at timestamp without time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_entry public."Staff_Unavailability"%rowtype;
  v_end_at timestamp without time zone := coalesce(p_end_at, p_start_at);
begin
  if p_staff_user_id is null or p_start_at is null then
    return null;
  end if;

  select entry.* into v_entry
  from public."Staff_Unavailability" entry
  where entry."Staff_User_ID" = p_staff_user_id
    and entry."Is_Active" is true
    and (
      (
        entry."Unavailability_Type" = 'Specific Date'
        and entry."Specific_Date" between p_start_at::date and v_end_at::date
      )
      or
      (
        entry."Unavailability_Type" = 'Recurring Weekday'
        and exists (
          select 1
          from generate_series(p_start_at::date, v_end_at::date, interval '1 day') day_value
          where extract(dow from day_value)::smallint = entry."Weekday"
        )
      )
    )
  order by case when entry."Unavailability_Type" = 'Specific Date' then 0 else 1 end,
           entry."Specific_Date" nulls last,
           entry."Created_At"
  limit 1;

  if v_entry."Staff_Unavailability_ID" is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_entry."Staff_Unavailability_ID",
    'type', v_entry."Unavailability_Type",
    'weekday', v_entry."Weekday",
    'specific_date', v_entry."Specific_Date",
    'reason', v_entry."Reason"
  );
end;
$fn$;

create or replace function public.guard_event_staff_availability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_conflict jsonb;
  v_assigned_event record;
begin
  if public.normalize_flow_key(new."Status") = 'approved'
     and new."Assigned_Staff_User_ID" is not null
     and (
       tg_op = 'INSERT'
       or old."Assigned_Staff_User_ID" is distinct from new."Assigned_Staff_User_ID"
       or old."Start_Date" is distinct from new."Start_Date"
       or old."End_Date" is distinct from new."End_Date"
       or public.normalize_flow_key(old."Status") is distinct from public.normalize_flow_key(new."Status")
     )
  then
    select event."Event_Request_ID", event."Event_Name" into v_assigned_event
    from public."Event_Requests" event
    where event."Assigned_Staff_User_ID" = new."Assigned_Staff_User_ID"
      and event."Event_Request_ID" is distinct from new."Event_Request_ID"
      and public.normalize_flow_key(event."Status") = 'approved'
      and event."Start_Date" <= coalesce(new."End_Date", new."Start_Date")
      and coalesce(event."End_Date", event."Start_Date") >= new."Start_Date"
    order by event."Start_Date"
    limit 1;
    if v_assigned_event."Event_Request_ID" is not null then
      raise exception 'The selected Staff member is already assigned to "%" during this program schedule.',
        coalesce(v_assigned_event."Event_Name", 'another approved program');
    end if;

    v_conflict := public.find_staff_unavailability_conflict(
      new."Assigned_Staff_User_ID", new."Start_Date", new."End_Date"
    );
    if v_conflict is not null then
      raise exception 'The selected Staff member is unavailable for this program (%: %).',
        v_conflict->>'type', v_conflict->>'reason';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_event_staff_availability on public."Event_Requests";
create trigger trg_guard_event_staff_availability
before insert or update of "Assigned_Staff_User_ID", "Start_Date", "End_Date", "Status"
on public."Event_Requests"
for each row execute function public.guard_event_staff_availability();

create or replace function public.admin_add_staff_unavailability(
  p_staff_user_ids integer[],
  p_unavailability_type text,
  p_weekday smallint default null,
  p_specific_date date default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_staff public.users%rowtype;
  v_staff_id integer;
  v_event record;
  v_inserted integer := 0;
  v_type text := trim(coalesce(p_unavailability_type, ''));
  v_reason text := trim(coalesce(p_reason, ''));
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null or coalesce(public.normalize_app_role(v_actor.role), '') not in ('admin', 'superadmin') then
    raise exception 'Only an active Admin can manage Staff availability.';
  end if;
  if coalesce(array_length(p_staff_user_ids, 1), 0) = 0 then
    raise exception 'Select at least one Staff member.';
  end if;
  if length(v_reason) < 3 then
    raise exception 'A reason is required.';
  end if;
  if v_type not in ('Recurring Weekday', 'Specific Date') then
    raise exception 'Choose Recurring Weekday or Specific Date.';
  end if;
  if v_type = 'Recurring Weekday' and (p_weekday is null or p_weekday not between 0 and 6) then
    raise exception 'Choose a valid recurring weekday.';
  end if;
  if v_type = 'Specific Date' and p_specific_date is null then
    raise exception 'Choose a specific date.';
  end if;
  if v_type = 'Specific Date' and p_specific_date < v_now::date then
    raise exception 'A day off cannot be added in the past.';
  end if;

  foreach v_staff_id in array p_staff_user_ids loop
    select * into v_staff from public.users account
    where account.user_id = v_staff_id
      and account.is_active is distinct from false
      and public.normalize_app_role(account.role) = 'staff';
    if v_staff.user_id is null then
      raise exception 'Staff account % was not found or is inactive.', v_staff_id;
    end if;

    select event."Event_Request_ID", event."Event_Name", event."Start_Date", event."End_Date"
    into v_event
    from public."Event_Requests" event
    where event."Assigned_Staff_User_ID" = v_staff_id
      and public.normalize_flow_key(event."Status") = 'approved'
      and coalesce(event."End_Date", event."Start_Date") >= v_now
      and (
        (v_type = 'Specific Date' and p_specific_date between event."Start_Date"::date and coalesce(event."End_Date", event."Start_Date")::date)
        or
        (v_type = 'Recurring Weekday' and exists (
          select 1
          from generate_series(greatest(event."Start_Date"::date, v_now::date), coalesce(event."End_Date", event."Start_Date")::date, interval '1 day') day_value
          where extract(dow from day_value)::smallint = p_weekday
        ))
      )
    order by event."Start_Date"
    limit 1;

    if v_event."Event_Request_ID" is not null then
      raise exception 'Cannot add this day off. Staff account % is assigned to "%" on %.',
        v_staff_id, coalesce(v_event."Event_Name", 'Untitled Program'), v_event."Start_Date"::date;
    end if;

    if not exists (
      select 1 from public."Staff_Unavailability" entry
      where entry."Staff_User_ID" = v_staff_id
        and entry."Is_Active" is true
        and entry."Unavailability_Type" = v_type
        and (entry."Weekday" is not distinct from case when v_type = 'Recurring Weekday' then p_weekday else null end)
        and (entry."Specific_Date" is not distinct from case when v_type = 'Specific Date' then p_specific_date else null end)
    ) then
      insert into public."Staff_Unavailability" (
        "Staff_User_ID", "Unavailability_Type", "Weekday", "Specific_Date",
        "Reason", "Created_By_User_ID", "Created_At", "Updated_At"
      ) values (
        v_staff_id, v_type,
        case when v_type = 'Recurring Weekday' then p_weekday else null end,
        case when v_type = 'Specific Date' then p_specific_date else null end,
        v_reason, v_actor.user_id, v_now, v_now
      );
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('created_count', v_inserted, 'requested_count', array_length(p_staff_user_ids, 1));
end;
$fn$;

create or replace function public.admin_remove_staff_unavailability(p_staff_unavailability_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_entry public."Staff_Unavailability"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;
  if v_actor.user_id is null or coalesce(public.normalize_app_role(v_actor.role), '') not in ('admin', 'superadmin') then
    raise exception 'Only an active Admin can manage Staff availability.';
  end if;

  update public."Staff_Unavailability" entry
  set "Is_Active" = false,
      "Removed_By_User_ID" = v_actor.user_id,
      "Removed_At" = v_now,
      "Updated_At" = v_now
  where entry."Staff_Unavailability_ID" = p_staff_unavailability_id
    and entry."Is_Active" is true
  returning * into v_entry;

  if v_entry."Staff_Unavailability_ID" is null then
    raise exception 'This day-off entry was not found or was already removed.';
  end if;
  return to_jsonb(v_entry);
end;
$fn$;

create or replace function public.admin_approve_event_request(
  p_event_request_id integer,
  p_staff_user_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_event public."Event_Requests"%rowtype;
  v_staff public.users%rowtype;
  v_conflict jsonb;
  v_assigned_event record;
begin
  select * into v_actor from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;
  if v_actor.user_id is null or coalesce(public.normalize_app_role(v_actor.role), '') not in ('admin', 'superadmin') then
    raise exception 'Only an active Admin can approve program requests.';
  end if;

  select * into v_event from public."Event_Requests" event
  where event."Event_Request_ID" = p_event_request_id for update;
  if v_event."Event_Request_ID" is null then raise exception 'Program request was not found.'; end if;
  if public.normalize_flow_key(v_event."Status") not in ('pendingadminapproval', 'appealed') then
    raise exception 'Only pending or appealed program requests can be approved.';
  end if;

  select * into v_staff from public.users account
  where account.user_id = p_staff_user_id
    and account.is_active is distinct from false
    and public.normalize_app_role(account.role) = 'staff';
  if v_staff.user_id is null then raise exception 'Select an active Staff account.'; end if;

  select event."Event_Request_ID", event."Event_Name" into v_assigned_event
  from public."Event_Requests" event
  where event."Assigned_Staff_User_ID" = p_staff_user_id
    and event."Event_Request_ID" <> p_event_request_id
    and public.normalize_flow_key(event."Status") = 'approved'
    and event."Start_Date" <= coalesce(v_event."End_Date", v_event."Start_Date")
    and coalesce(event."End_Date", event."Start_Date") >= v_event."Start_Date"
  order by event."Start_Date"
  limit 1;
  if v_assigned_event."Event_Request_ID" is not null then
    raise exception 'The selected Staff member is already assigned to "%" during this program schedule.',
      coalesce(v_assigned_event."Event_Name", 'another approved program');
  end if;

  v_conflict := public.find_staff_unavailability_conflict(p_staff_user_id, v_event."Start_Date", v_event."End_Date");
  if v_conflict is not null then
    raise exception 'The selected Staff member is unavailable for this program (%: %).',
      v_conflict->>'type', v_conflict->>'reason';
  end if;

  update public."Event_Requests"
  set "Status" = 'Approved', "Assigned_Staff_User_ID" = p_staff_user_id,
      "Admin_Decision_Reason" = null
  where "Event_Request_ID" = p_event_request_id
  returning * into v_event;
  return to_jsonb(v_event);
end;
$fn$;

-- Add the cancellation message types to the existing SMTP allow-list.
alter table public."SMTP_Email_Outbox"
  drop constraint if exists smtp_email_outbox_notification_type_check;
alter table public."SMTP_Email_Outbox"
  add constraint smtp_email_outbox_notification_type_check check (
    public.normalize_flow_key(coalesce("Notification_Type", '')) = any (array[
      'eventapplicationreceived'::text, 'staffrejected'::text,
      'staffendorsedpendingadmin'::text, 'adminapproved'::text, 'adminrejected'::text,
      'partnerhospitalapproved'::text, 'partnerhospitalrejected'::text,
      'partnerhospitalaccessenabled'::text, 'partnerhospitalaccessdisabled'::text,
      'eventautocancelled'::text, 'patientapplicationotp'::text,
      'patientapplicationsubmitted'::text, 'patientapplicationaccepted'::text,
      'patientapplicationrejected'::text, 'programended'::text,
      'programsuccessfulapplicant'::text, 'programsuccessfulattendee'::text,
      'programcancelledapplicant'::text, 'programcancelledattendee'::text
    ])
  );

-- The existing workflow triggers continue to protect every normal client update.
-- Only this authenticated, admin-only RPC can enable the transaction-local bypass.
drop trigger if exists trg_enforce_event_request_workflow on public."Event_Requests";
create trigger trg_enforce_event_request_workflow
before update on public."Event_Requests"
for each row
when (
  (coalesce(current_setting('strandshare.auto_cancel_expired_event_applications', true), 'off') <> 'on'
    or new."Auto_Cancelled_At" is null)
  and coalesce(current_setting('strandshare.admin_cancel_event', true), 'off') <> 'on'
)
execute function public.enforce_event_request_workflow();

drop trigger if exists trg_enforce_event_application_workflow on public."Event_Applications";
create trigger trg_enforce_event_application_workflow
before update on public."Event_Applications"
for each row
when (
  (coalesce(current_setting('strandshare.auto_cancel_expired_event_applications', true), 'off') <> 'on'
    or new."Auto_Cancelled_At" is null)
  and coalesce(current_setting('strandshare.admin_cancel_event', true), 'off') <> 'on'
)
execute function public.enforce_event_application_workflow();

create or replace function public.admin_cancel_approved_event(
  p_event_request_id integer,
  p_reason_category text,
  p_explanation text,
  p_confirmation_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_event public."Event_Requests"%rowtype;
  v_application public."Event_Applications"%rowtype;
  v_attendee record;
  v_applicant_email text;
  v_applicant_name text;
  v_address text;
  v_common jsonb;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_queued integer := 0;
  v_attendee_queued integer := 0;
  v_skipped integer := 0;
  v_applicant_queued boolean := false;
begin
  select * into v_actor from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;
  if v_actor.user_id is null or coalesce(public.normalize_app_role(v_actor.role), '') not in ('admin', 'superadmin') then
    raise exception 'Only an active Admin can cancel an approved program.';
  end if;
  if trim(coalesce(p_confirmation_text, '')) <> 'CANCEL' then
    raise exception 'Type CANCEL exactly to confirm permanent cancellation.';
  end if;
  if trim(coalesce(p_reason_category, '')) not in (
    'Severe Weather or Natural Disaster', 'Venue Unavailable',
    'Safety or Security Concern', 'Insufficient Participants', 'Organizer Request',
    'Operational or Staffing Issue', 'Government or Local Authority Order', 'Other'
  ) then raise exception 'Choose a valid cancellation reason.'; end if;
  if length(trim(coalesce(p_explanation, ''))) < 10 then
    raise exception 'Provide a detailed cancellation explanation (at least 10 characters).';
  end if;

  select * into v_event from public."Event_Requests" event
  where event."Event_Request_ID" = p_event_request_id for update;
  if v_event."Event_Request_ID" is null then raise exception 'Program request was not found.'; end if;
  if public.normalize_flow_key(v_event."Status") <> 'approved' then
    raise exception 'Only approved programs can be cancelled.';
  end if;
  if v_event."Start_Date" is null or v_event."Start_Date" <= v_now then
    raise exception 'A program cannot be cancelled after it has started.';
  end if;

  select * into v_application from public."Event_Applications" application
  where application."Event_Application_ID" = v_event."Event_Application_ID" limit 1;
  v_applicant_email := public.resolve_event_application_recipient_email(
    v_application."Applicant_Email", v_application."Preferred_Contact_Method",
    v_application."Preferred_Contact_Detail"
  );
  v_applicant_name := coalesce(nullif(trim(concat_ws(' ',
    v_application."Applicant_First_Name", v_application."Applicant_Middle_Name",
    v_application."Applicant_Last_Name"
  )), ''), 'Program Applicant');
  v_address := nullif(trim(concat_ws(', ', v_event."Street", v_event."Barangay",
    v_event."City_Municipality", v_event."Province", v_event."Region", v_event."Country")), '');

  perform set_config('strandshare.admin_cancel_event', 'on', true);
  update public."Event_Requests"
  set "Status" = 'Cancelled',
      "Cancellation_Category" = trim(p_reason_category),
      "Cancellation_Explanation" = trim(p_explanation),
      "Cancellation_Reason" = trim(p_reason_category) || ': ' || trim(p_explanation),
      "Cancelled_At" = v_now,
      "Cancelled_By_User_ID" = v_actor.user_id,
      "Cancelled_By_Role" = case when public.normalize_app_role(v_actor.role) = 'superadmin' then 'Super Admin' else 'Admin' end,
      "Cancelled_Assigned_Staff_User_ID" = "Assigned_Staff_User_ID",
      "Assigned_Staff_User_ID" = null,
      "Updated_At" = v_now
  where "Event_Request_ID" = p_event_request_id
  returning * into v_event;

  update public."Event_Applications"
  set "Status" = 'Cancelled',
      "Cancellation_Reason" = trim(p_reason_category) || ': ' || trim(p_explanation),
      "Updated_At" = v_now
  where "Event_Application_ID" = v_event."Event_Application_ID";

  v_common := jsonb_build_object(
    'event_request_id', v_event."Event_Request_ID",
    'program_name', coalesce(v_event."Event_Name", 'Untitled Program'),
    'event_name', coalesce(v_event."Event_Name", 'Untitled Program'),
    'start_date', v_event."Start_Date", 'end_date', v_event."End_Date",
    'venue_name', coalesce(v_event."Venue_Name", ''),
    'venue_address', coalesce(v_address, ''),
    'cancellation_category', trim(p_reason_category),
    'cancellation_explanation', trim(p_explanation),
    'cancelled_at', v_now,
    'cancelled_by', 'Donivra',
    'reschedule_message', 'Please apply again if you wish for rescheduling.'
  );

  if v_applicant_email is not null then
    perform public.enqueue_smtp_email_outbox(
      'program_cancelled:applicant:' || v_event."Event_Request_ID"::text,
      'Event_Requests', v_event."Event_Request_ID", 'program_cancelled_applicant',
      v_applicant_email, 'Program Cancelled - ' || coalesce(v_event."Event_Name", 'Donivra Program'),
      'program_cancelled_applicant',
      v_common || jsonb_build_object('recipient_name', v_applicant_name, 'recipient_role', 'Applicant'),
      v_actor.user_id
    );
    v_applicant_queued := true;
    v_queued := v_queued + 1;
  end if;

  for v_attendee in
    select attendee."Event_Attendee_ID", account.email,
      coalesce(nullif(trim(concat_ws(' ', detail.first_name, detail.middle_name, detail.last_name, detail.suffix)), ''),
        nullif(trim(account.email), ''), 'Participant') as full_name,
      attendee."Attendee_Type"
    from public."Event_Attendees" attendee
    left join public.users account on account.user_id = attendee."User_ID"
    left join public.user_details detail on detail.user_id = attendee."User_ID"
    where attendee."Event_Request_ID" = v_event."Event_Request_ID"
      and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
  loop
    if nullif(trim(coalesce(v_attendee.email, '')), '') is null
       or v_attendee.email not like '%_@_%._%' then
      v_skipped := v_skipped + 1;
    else
      perform public.enqueue_smtp_email_outbox(
        'program_cancelled:attendee:' || v_event."Event_Request_ID"::text || ':' || v_attendee."Event_Attendee_ID"::text,
        'Event_Requests', v_event."Event_Request_ID", 'program_cancelled_attendee',
        lower(trim(v_attendee.email)), 'Program Cancelled - ' || coalesce(v_event."Event_Name", 'Donivra Program'),
        'program_cancelled_attendee',
        v_common || jsonb_build_object(
          'recipient_name', v_attendee.full_name,
          'recipient_role', coalesce(v_attendee."Attendee_Type", 'Attendee')
        ), v_actor.user_id
      );
      v_attendee_queued := v_attendee_queued + 1;
      v_queued := v_queued + 1;
    end if;
  end loop;

  update public."Event_Requests"
  set "Cancellation_Emails_Queued" = v_queued,
      "Cancellation_Emails_Skipped" = v_skipped,
      "Updated_At" = v_now
  where "Event_Request_ID" = v_event."Event_Request_ID";

  return jsonb_build_object(
    'event_request_id', v_event."Event_Request_ID", 'status', v_event."Status",
    'cancelled_at', v_event."Cancelled_At", 'applicant_queued', v_applicant_queued,
    'attendee_queued', v_attendee_queued, 'queued_count', v_queued,
    'skipped_attendees', v_skipped
  );
end;
$fn$;

create or replace function public.admin_retry_event_cancellation_emails(p_event_request_id integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_count integer;
begin
  select * into v_actor from public.users account
  where account.auth_user_id = auth.uid() and account.is_active is distinct from false limit 1;
  if v_actor.user_id is null or coalesce(public.normalize_app_role(v_actor.role), '') not in ('admin', 'superadmin') then
    raise exception 'Only an active Admin can retry cancellation emails.';
  end if;
  if not exists (select 1 from public."Event_Requests" event
    where event."Event_Request_ID" = p_event_request_id
      and public.normalize_flow_key(event."Status") = 'cancelled'
      and event."Cancelled_At" is not null) then
    raise exception 'The cancelled program was not found.';
  end if;

  update public."SMTP_Email_Outbox" mail
  set "Status" = 'Pending', "Attempt_Count" = 0, "Last_Error" = null,
      "Next_Attempt_At" = timezone('Asia/Manila', now()),
      "Processed_By_User_ID" = null, "Updated_At" = timezone('Asia/Manila', now())
  where mail."Source_Table" = 'Event_Requests'
    and mail."Source_ID" = p_event_request_id
    and public.normalize_flow_key(mail."Notification_Type") in ('programcancelledapplicant', 'programcancelledattendee')
    and public.normalize_flow_key(mail."Status") = 'failed';
  get diagnostics v_count = row_count;
  return jsonb_build_object('retried_count', v_count);
end;
$fn$;

create or replace function public.guard_cancelled_event_attendee_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_event_id integer := case when tg_op = 'DELETE' then old."Event_Request_ID" else new."Event_Request_ID" end;
begin
  if auth.uid() is not null and exists (
    select 1 from public."Event_Requests" event
    where event."Event_Request_ID" = v_event_id
      and public.normalize_flow_key(event."Status") = 'cancelled'
  ) then
    raise exception 'This program was cancelled by Donivra. Registration and attendance operations are closed.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

create or replace function public.lock_admin_cancelled_event_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if old."Cancelled_At" is not null
     and coalesce(current_setting('strandshare.admin_cancel_event', true), 'off') <> 'on' then
    raise exception 'This program was permanently cancelled by Donivra and cannot be changed.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

drop trigger if exists trg_lock_admin_cancelled_event_request on public."Event_Requests";
create trigger trg_lock_admin_cancelled_event_request
before update or delete on public."Event_Requests"
for each row execute function public.lock_admin_cancelled_event_request();

drop trigger if exists trg_guard_cancelled_event_attendee_changes on public."Event_Attendees";
create trigger trg_guard_cancelled_event_attendee_changes
before insert or update or delete on public."Event_Attendees"
for each row execute function public.guard_cancelled_event_attendee_changes();

revoke all on function public.find_staff_unavailability_conflict(integer, timestamp without time zone, timestamp without time zone) from public, anon, authenticated;
revoke all on function public.admin_add_staff_unavailability(integer[], text, smallint, date, text) from public, anon, authenticated;
revoke all on function public.admin_remove_staff_unavailability(bigint) from public, anon, authenticated;
revoke all on function public.admin_approve_event_request(integer, integer) from public, anon, authenticated;
revoke all on function public.admin_cancel_approved_event(integer, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_retry_event_cancellation_emails(integer) from public, anon, authenticated;

grant execute on function public.admin_add_staff_unavailability(integer[], text, smallint, date, text) to authenticated;
grant execute on function public.admin_remove_staff_unavailability(bigint) to authenticated;
grant execute on function public.admin_approve_event_request(integer, integer) to authenticated;
grant execute on function public.admin_cancel_approved_event(integer, text, text, text) to authenticated;
grant execute on function public.admin_retry_event_cancellation_emails(integer) to authenticated;

comment on table public."Staff_Unavailability" is
  'All-day Staff recurring weekdays and specific dates, retained as an auditable soft-delete history in Manila time.';
comment on function public.admin_cancel_approved_event(integer, text, text, text) is
  'Permanently cancels a future approved program, releases Staff, and queues applicant/attendee email notices.';

notify pgrst, 'reload schema';
commit;
