begin;

-- Use Visitor consistently for non-donor attendees while preserving old rows
-- during the transition.
alter table public."Event_Attendees"
  disable trigger trg_guard_event_attendee_access_and_eligibility;

alter table public."Event_Attendees"
  drop constraint if exists "Event_Attendees_Attendee_Type_check";

update public."Event_Attendees"
set "Attendee_Type" = 'Visitor'
where public.normalize_flow_key("Attendee_Type") = 'voluntary';

alter table public."Event_Attendees"
  add constraint "Event_Attendees_Attendee_Type_check"
  check ("Attendee_Type" = any (array['Donor'::text, 'Visitor'::text]));

alter table public."Event_Attendees"
  enable trigger trg_guard_event_attendee_access_and_eligibility;

-- Successful is a final, Staff-confirmed state after the automatic Ended
-- state. It records exactly who completed the event.
alter table public."Event_Requests"
  add column if not exists "Successful_At" timestamp with time zone,
  add column if not exists "Successful_By_User_ID" integer;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_requests_successful_by_user_id_fkey'
      and conrelid = 'public."Event_Requests"'::regclass
  ) then
    alter table public."Event_Requests"
      add constraint event_requests_successful_by_user_id_fkey
      foreign key ("Successful_By_User_ID")
      references public.users(user_id) on delete set null;
  end if;
end;
$do$;

alter table public."Event_Requests"
  drop constraint if exists event_requests_status_check;

alter table public."Event_Requests"
  add constraint event_requests_status_check
  check (
    public.normalize_flow_key(coalesce("Status", '')) = any (
      array[
        'pendingadminapproval'::text,
        'appealed'::text,
        'approved'::text,
        'ended'::text,
        'successful'::text,
        'rejected'::text,
        'cancelled'::text
      ]
    )
  );

create index if not exists idx_event_requests_successful_at
  on public."Event_Requests" ("Successful_At" desc)
  where public.normalize_flow_key("Status") = 'successful';

create or replace function public.enforce_event_request_workflow()
returns trigger
language plpgsql
as $fn$
declare
  actor_user_id integer;
  actor_role_key text;
  old_status_key text;
  new_status_key text;
  visibility_key text;
  candidate_code text;
  attempt_count integer := 0;
  pending_review_count integer := 0;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  old_status_key := public.normalize_flow_key(old."Status");
  new_status_key := public.normalize_flow_key(new."Status");
  visibility_key := public.normalize_flow_key(coalesce(new."Event_Visibility", 'Public'));
  new."Event_Visibility" := case when visibility_key = 'private' then 'Private' else 'Public' end;

  if old_status_key is not distinct from new_status_key then
    if new."Event_Visibility" <> 'Private' then
      new."Private_Event_Code" := null;
      new."Private_Event_Code_Sent_At" := null;
    end if;
    new."Updated_At" := manila_now;
    return new;
  end if;

  if old_status_key = 'approved'
     and new_status_key = 'ended'
     and old."End_Date" is not null
     and old."End_Date" <= manila_now then
    new."Ended_At" := coalesce(new."Ended_At", now());
    new."Updated_At" := manila_now;
    return new;
  end if;

  select u.user_id, public.normalize_app_role(u.role)
  into actor_user_id, actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
    and u.is_active is distinct from false
  limit 1;

  if actor_user_id is null then
    raise exception 'Unable to resolve actor profile for program request workflow update.';
  end if;

  if actor_role_key = 'admin' then
    if old_status_key in ('pendingadminapproval', 'appealed')
       and new_status_key in ('approved', 'rejected') then
      new."Admin_Reviewer_User_ID" := actor_user_id;
      new."Admin_Reviewed_At" := manila_now;

      if new_status_key = 'rejected'
         and length(trim(coalesce(new."Admin_Decision_Reason", ''))) = 0 then
        raise exception 'Admin rejection reason is required for program requests.';
      end if;

      if new_status_key = 'approved' and new."Event_Visibility" = 'Private' then
        if nullif(trim(coalesce(new."Private_Event_Code", '')), '') is null then
          while attempt_count < 12 loop
            attempt_count := attempt_count + 1;
            candidate_code := public.generate_private_event_code();
            exit when not exists (
              select 1 from public."Event_Requests" er
              where er."Private_Event_Code" = candidate_code
                and er."Event_Request_ID" <> old."Event_Request_ID"
            );
          end loop;
          if candidate_code is null or exists (
            select 1 from public."Event_Requests" er
            where er."Private_Event_Code" = candidate_code
              and er."Event_Request_ID" <> old."Event_Request_ID"
          ) then
            raise exception 'Unable to generate unique private event code. Please retry.';
          end if;
          new."Private_Event_Code" := candidate_code;
        end if;
      end if;

      if new."Event_Visibility" <> 'Private' then
        new."Private_Event_Code" := null;
        new."Private_Event_Code_Sent_At" := null;
      end if;
    else
      raise exception 'Admin cannot change program request status from % to %.', old."Status", new."Status";
    end if;
  elsif actor_role_key = 'staff' then
    if old_status_key = 'pendingadminapproval' and new_status_key = 'cancelled' then
      null;
    elsif old_status_key = 'rejected' and new_status_key in ('appealed', 'pendingadminapproval') then
      new."Admin_Decision_Reason" := null;
      new."Admin_Reviewer_User_ID" := null;
      new."Admin_Reviewed_At" := null;
      if new."Event_Visibility" <> 'Private' then
        new."Private_Event_Code" := null;
        new."Private_Event_Code_Sent_At" := null;
      end if;
    elsif old_status_key = 'ended' and new_status_key = 'successful' then
      if old."Assigned_Staff_User_ID" is distinct from actor_user_id then
        raise exception 'Only the Staff member assigned to this event can mark it successful.';
      end if;

      select count(*)::integer into pending_review_count
      from public."Event_Attendees" attendee
      where attendee."Event_Request_ID" = old."Event_Request_ID"
        and public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
        and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
        and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
        and not exists (
          select 1
          from public."Hair_Submissions" submission
          join public."Hair_Submission_Details" detail
            on detail."Submission_ID" = submission."Submission_ID"
          where submission."Event_Request_ID" = old."Event_Request_ID"
            and (
              submission."Event_Attendee_ID" = attendee."Event_Attendee_ID"
              or (
                submission."Event_Attendee_ID" is null
                and submission."User_ID" = attendee."User_ID"
              )
            )
            and public.normalize_flow_key(detail."Status") in (
              'approved', 'rejected', 'rejectedcut'
            )
        );

      if pending_review_count > 0 then
        raise exception '% present donor hair review(s) must be completed before this event can be marked successful.', pending_review_count;
      end if;

      new."Successful_At" := coalesce(new."Successful_At", now());
      new."Successful_By_User_ID" := actor_user_id;
    else
      raise exception 'Staff cannot change program request status from % to %.', old."Status", new."Status";
    end if;
  else
    raise exception 'Only staff or admin can change program request status.';
  end if;

  new."Updated_At" := manila_now;
  return new;
end;
$fn$;

create or replace function public.mark_event_successful(p_event_request_id integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_event public."Event_Requests"%rowtype;
  v_pending integer := 0;
begin
  perform public.mark_ended_event_requests();

  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) <> 'staff' then
    raise exception 'Only an active Staff account can complete an event.';
  end if;

  select * into v_event
  from public."Event_Requests" event
  where event."Event_Request_ID" = p_event_request_id
  for update;

  if v_event."Event_Request_ID" is null then
    raise exception 'Event was not found.';
  end if;
  if v_event."Assigned_Staff_User_ID" is distinct from v_actor.user_id then
    raise exception 'Only the Staff member assigned to this event can mark it successful.';
  end if;
  if public.normalize_flow_key(v_event."Status") = 'successful' then
    return jsonb_build_object(
      'event_request_id', v_event."Event_Request_ID",
      'status', 'Successful',
      'successful_at', v_event."Successful_At",
      'already_successful', true
    );
  end if;
  if public.normalize_flow_key(v_event."Status") <> 'ended' then
    raise exception 'The event must be ended before it can be marked successful.';
  end if;

  select count(*)::integer into v_pending
  from public."Event_Attendees" attendee
  where attendee."Event_Request_ID" = v_event."Event_Request_ID"
    and public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
    and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
    and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
    and not exists (
      select 1
      from public."Hair_Submissions" submission
      join public."Hair_Submission_Details" detail
        on detail."Submission_ID" = submission."Submission_ID"
      where submission."Event_Request_ID" = v_event."Event_Request_ID"
        and (
          submission."Event_Attendee_ID" = attendee."Event_Attendee_ID"
          or (
            submission."Event_Attendee_ID" is null
            and submission."User_ID" = attendee."User_ID"
          )
        )
        and public.normalize_flow_key(detail."Status") in (
          'approved', 'rejected', 'rejectedcut'
        )
    );

  if v_pending > 0 then
    raise exception '% present donor hair review(s) still need a final decision.', v_pending;
  end if;

  update public."Event_Requests"
  set "Status" = 'Successful'
  where "Event_Request_ID" = v_event."Event_Request_ID"
  returning * into v_event;

  insert into public.audit_logs (
    user_id, action, description, user_email, resource, status, "time"
  ) values (
    v_actor.user_id,
    'event.marked_successful',
    format('Marked event %s (ER-%s) successful after all present donor reviews were completed.',
      coalesce(v_event."Event_Name", 'Untitled Event'), v_event."Event_Request_ID"),
    v_actor.email,
    'Event_Requests:' || v_event."Event_Request_ID"::text,
    'success',
    timezone('Asia/Manila', now())
  );

  return jsonb_build_object(
    'event_request_id', v_event."Event_Request_ID",
    'status', v_event."Status",
    'successful_at', v_event."Successful_At",
    'successful_by_user_id', v_event."Successful_By_User_ID",
    'pending_reviews', 0,
    'already_successful', false
  );
end;
$fn$;

revoke all on function public.mark_event_successful(integer) from public, anon;
grant execute on function public.mark_event_successful(integer) to authenticated;

create or replace function public.scan_event_attendee_rsvp_by_type(
  p_event_request_id integer,
  p_qr_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor public.users%rowtype;
  v_event public."Event_Requests"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_user_id_hint integer;
  v_attendee_id_hint integer;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_donor_result jsonb;
begin
  if p_event_request_id is null or v_raw = '' then
    raise exception 'An event and waybill payload are required.';
  end if;

  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) <> 'staff' then
    raise exception 'Only active Staff can scan event attendance.';
  end if;

  select * into v_event
  from public."Event_Requests" event
  where event."Event_Request_ID" = p_event_request_id;

  if v_event."Event_Request_ID" is null then
    raise exception 'Event was not found.';
  end if;
  if v_event."Assigned_Staff_User_ID" is distinct from v_actor.user_id then
    raise exception 'You are not assigned to this event.';
  end if;
  if public.normalize_flow_key(v_event."Status") <> 'approved' then
    raise exception 'RSVP scanning is available only while the assigned event is active.';
  end if;

  if left(v_raw, 1) = '{' then
    begin
      v_payload := v_raw::jsonb;
    exception when others then
      v_payload := null;
    end;
  end if;

  if v_payload is not null then
    v_waybill_code := nullif(upper(trim(coalesce(
      v_payload ->> 'Waybill_Code',
      v_payload ->> 'waybill_code',
      v_payload ->> 'waybillCode',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode'
    ))), '');
    begin
      v_user_id_hint := nullif(trim(coalesce(
        v_payload ->> 'User_ID',
        v_payload ->> 'user_id',
        v_payload ->> 'userId',
        v_payload -> 'data' ->> 'User_ID',
        v_payload -> 'data' ->> 'user_id'
      )), '')::integer;
    exception when others then
      v_user_id_hint := null;
    end;
    begin
      v_attendee_id_hint := nullif(trim(coalesce(
        v_payload ->> 'Event_Attendee_ID',
        v_payload ->> 'event_attendee_id',
        v_payload ->> 'eventAttendeeId',
        v_payload -> 'data' ->> 'Event_Attendee_ID',
        v_payload -> 'data' ->> 'event_attendee_id'
      )), '')::integer;
    exception when others then
      v_attendee_id_hint := null;
    end;
  else
    v_waybill_code := nullif(upper(v_raw), '');
  end if;

  select * into v_attendee
  from public."Event_Attendees" attendee
  where attendee."Event_Request_ID" = p_event_request_id
    and (
      (v_attendee_id_hint is not null and attendee."Event_Attendee_ID" = v_attendee_id_hint)
      or (v_waybill_code is not null and upper(trim(coalesce(attendee."Waybill_Code", ''))) = v_waybill_code)
      or (v_user_id_hint is not null and attendee."User_ID" = v_user_id_hint)
    )
  order by
    case
      when attendee."Event_Attendee_ID" = v_attendee_id_hint then 0
      when upper(trim(coalesce(attendee."Waybill_Code", ''))) = coalesce(v_waybill_code, '') then 1
      else 2
    end
  limit 1;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'No attendee matched for this event and scan payload.';
  end if;

  if public.normalize_flow_key(v_attendee."Attendee_Type") = 'donor' then
    v_donor_result := public.scan_event_attendee_rsvp(
      p_event_request_id,
      jsonb_build_object(
        'Waybill_Code', v_attendee."Waybill_Code",
        'User_ID', v_attendee."User_ID",
        'Event_Attendee_ID', v_attendee."Event_Attendee_ID"
      )::text
    );
    return coalesce(v_donor_result, '{}'::jsonb) || jsonb_build_object(
      'attendee_type', 'Donor',
      'requires_hair_review', true
    );
  end if;

  if public.normalize_flow_key(v_attendee."Attendee_Type") <> 'visitor' then
    raise exception 'This attendee type is not supported.';
  end if;
  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This attendee registration is cancelled.';
  end if;

  update public."Event_Attendees"
  set
    "Attendance_Status" = 'Present',
    "RSVP_Scanned_At" = v_now,
    "RSVP_Scanned_By" = v_actor.user_id,
    "Updated_At" = v_now
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
    and "RSVP_Scanned_At" is null
  returning * into v_attendee;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'RSVP already scanned for this visitor.';
  end if;

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', null,
    'details', '[]'::jsonb,
    'waybill_code', v_attendee."Waybill_Code",
    'submission_status', null,
    'attendee_type', 'Visitor',
    'requires_hair_review', false
  );
end;
$fn$;

-- A successful event is fully closed: neither RSVP nor hair-review QR scans
-- can be started after the assigned Staff member confirms completion.
create or replace function public.scan_event_attendee_operation(
  p_event_request_id integer,
  p_qr_payload text,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_mode text := public.normalize_flow_key(p_mode);
  v_event public."Event_Requests"%rowtype;
  v_payload jsonb;
  v_waybill text;
  v_attendee_id integer;
  v_user_id integer;
  v_attendee_type text;
begin
  perform public.mark_ended_event_requests();
  select * into v_event
  from public."Event_Requests" event
  where event."Event_Request_ID" = p_event_request_id;

  if v_event."Event_Request_ID" is null then
    raise exception 'Event was not found.';
  end if;
  if public.normalize_flow_key(v_event."Status") = 'successful' then
    raise exception 'This event is successful and fully closed. QR scanning is no longer available.';
  end if;

  if v_mode in ('rsvp', 'rsvpcheckin', 'checkin') then
    if public.normalize_flow_key(v_event."Status") = 'ended'
       or (v_event."End_Date" is not null
           and v_event."End_Date" <= timezone('Asia/Manila', now())) then
      raise exception 'This event has ended. New RSVP check-ins are closed.';
    end if;
    return public.scan_event_attendee_rsvp_by_type(p_event_request_id, p_qr_payload)
      || jsonb_build_object('scan_mode', 'rsvp');
  elsif v_mode in ('hairreview', 'hairintake', 'hairintakereview') then
    if left(trim(coalesce(p_qr_payload, '')), 1) = '{' then
      begin
        v_payload := trim(p_qr_payload)::jsonb;
      exception when others then
        v_payload := null;
      end;
    end if;
    if v_payload is not null then
      v_waybill := nullif(trim(coalesce(
        v_payload ->> 'Waybill_Code', v_payload ->> 'waybill_code',
        v_payload ->> 'waybillCode', v_payload ->> 'code', v_payload ->> 'value',
        v_payload -> 'data' ->> 'Waybill_Code',
        v_payload -> 'data' ->> 'waybill_code',
        v_payload -> 'data' ->> 'waybillCode'
      )), '');
      begin
        v_attendee_id := nullif(trim(coalesce(
          v_payload ->> 'Event_Attendee_ID', v_payload ->> 'event_attendee_id',
          v_payload -> 'data' ->> 'Event_Attendee_ID',
          v_payload -> 'data' ->> 'event_attendee_id'
        )), '')::integer;
      exception when others then v_attendee_id := null;
      end;
      begin
        v_user_id := nullif(trim(coalesce(
          v_payload ->> 'User_ID', v_payload ->> 'user_id',
          v_payload ->> 'userId', v_payload -> 'data' ->> 'User_ID',
          v_payload -> 'data' ->> 'user_id'
        )), '')::integer;
      exception when others then v_user_id := null;
      end;
    else
      v_waybill := nullif(trim(coalesce(p_qr_payload, '')), '');
    end if;

    select attendee."Attendee_Type" into v_attendee_type
    from public."Event_Attendees" attendee
    where attendee."Event_Request_ID" = p_event_request_id
      and (
        (v_attendee_id is not null and attendee."Event_Attendee_ID" = v_attendee_id)
        or (v_waybill is not null and upper(trim(coalesce(attendee."Waybill_Code", ''))) = upper(v_waybill))
        or (v_user_id is not null and attendee."User_ID" = v_user_id)
      )
    order by
      case
        when attendee."Event_Attendee_ID" = v_attendee_id then 0
        when upper(trim(coalesce(attendee."Waybill_Code", ''))) = upper(coalesce(v_waybill, '')) then 1
        else 2
      end
    limit 1;

    if public.normalize_flow_key(v_attendee_type) in ('visitor', 'voluntary') then
      raise exception 'Visitors only require RSVP check-in; they have no hair intake review.';
    end if;

    return public.open_event_hair_intake_review(p_event_request_id, p_qr_payload)
      || jsonb_build_object('scan_mode', 'hair_review');
  end if;

  raise exception 'Scanner mode must be RSVP Check-in or Hair Intake & Review.';
end;
$fn$;

revoke all on function public.scan_event_attendee_operation(integer, text, text)
  from public, anon;
grant execute on function public.scan_event_attendee_operation(integer, text, text)
  to authenticated;

-- Keep lower-level scanner helpers private so every client scan must pass the
-- lifecycle lock in scan_event_attendee_operation().
revoke execute on function public.scan_event_attendee_rsvp_by_type(integer, text)
  from authenticated;
revoke execute on function public.open_event_hair_intake_review(integer, text)
  from authenticated;

create or replace function public.get_event_operations_summary(p_event_request_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role text;
  v_result jsonb;
begin
  select * into v_user
  from public.users account
  where account.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role := public.normalize_app_role(v_user.role);
  if v_role not in ('admin', 'specialist') and not exists (
    select 1 from public."Event_Requests" event
    where event."Event_Request_ID" = p_event_request_id
      and event."Assigned_Staff_User_ID" = v_user.user_id
      and v_role = 'staff'
  ) then
    raise exception 'You do not have access to this event summary.';
  end if;

  with attendee_stats as (
    select
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as registered,
      count(*) filter (
        where attendee."RSVP_Scanned_At" is not null
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
      )::integer as present,
      count(*) filter (
        where public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
      )::integer as donors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Attendee_Type") in ('visitor', 'voluntary')
      )::integer as visitors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
          and not exists (
            select 1
            from public."Hair_Submissions" submission
            join public."Hair_Submission_Details" detail
              on detail."Submission_ID" = submission."Submission_ID"
            where submission."Event_Request_ID" = p_event_request_id
              and (
                submission."Event_Attendee_ID" = attendee."Event_Attendee_ID"
                or (
                  submission."Event_Attendee_ID" is null
                  and submission."User_ID" = attendee."User_ID"
                )
              )
              and public.normalize_flow_key(detail."Status") in (
                'approved', 'rejected', 'rejectedcut'
              )
          )
      )::integer as pending_reviews
    from public."Event_Attendees" attendee
    where attendee."Event_Request_ID" = p_event_request_id
  ), decisions as (
    select
      count(*) filter (where public.normalize_flow_key(latest."Status") = 'approved')::integer as accepted,
      count(*) filter (where public.normalize_flow_key(latest."Status") = 'rejected')::integer as rejected,
      count(*) filter (where public.normalize_flow_key(latest."Status") = 'rejectedcut')::integer as rejected_cut
    from public."Hair_Submissions" submission
    left join lateral (
      select detail."Status"
      from public."Hair_Submission_Details" detail
      where detail."Submission_ID" = submission."Submission_ID"
      order by detail."Submission_Detail_ID" desc
      limit 1
    ) latest on true
    where submission."Event_Request_ID" = p_event_request_id
  ), inventory_stats as (
    select count(*)::integer as inventory_added
    from public."Cut_Hair_Inventory" inventory
    where inventory."Event_Request_ID" = p_event_request_id
  ), ai_stats as (
    select
      count(*) filter (
        where comparison."Is_AI_Source" and comparison."Reviewed_At" is not null
      )::integer as ai_reviews,
      coalesce(sum(cardinality(comparison."Changed_Fields")) filter (
        where comparison."Is_AI_Source"
      ), 0)::integer as ai_corrections,
      coalesce(sum(cardinality(comparison."Critical_Changed_Fields")) filter (
        where comparison."Is_AI_Source"
      ), 0)::integer as critical_corrections,
      round(avg(comparison."AI_Accuracy_Percent") filter (
        where comparison."Is_AI_Source" and comparison."Reviewed_At" is not null
      ), 2) as ai_accuracy
    from public."Hair_AI_Review_Comparisons" comparison
    where comparison."Event_Request_ID" = p_event_request_id
  ), event_state as (
    select event."Status", event."Successful_At", event."Successful_By_User_ID"
    from public."Event_Requests" event
    where event."Event_Request_ID" = p_event_request_id
  )
  select jsonb_build_object(
    'registered', attendee.registered,
    'present', attendee.present,
    'no_show', greatest(attendee.registered - attendee.present, 0),
    'donors', attendee.donors,
    'visitors', attendee.visitors,
    'accepted', decision.accepted,
    'approved_cut', decision.accepted,
    'rejected', decision.rejected,
    'rejected_cut', decision.rejected_cut,
    'pending', attendee.pending_reviews,
    'pending_reviews', attendee.pending_reviews,
    'inventory_added', inventory.inventory_added,
    'ai_reviews', ai.ai_reviews,
    'ai_corrections', ai.ai_corrections,
    'critical_corrections', ai.critical_corrections,
    'ai_accuracy_percent', ai.ai_accuracy,
    'event_status', event_state."Status",
    'successful_at', event_state."Successful_At",
    'successful_by_user_id', event_state."Successful_By_User_ID",
    'can_mark_successful', (
      v_role = 'staff'
      and public.normalize_flow_key(event_state."Status") = 'ended'
      and attendee.pending_reviews = 0
    )
  ) into v_result
  from attendee_stats attendee
  cross join decisions decision
  cross join inventory_stats inventory
  cross join ai_stats ai
  cross join event_state;

  return coalesce(v_result, '{}'::jsonb);
end;
$fn$;

revoke all on function public.get_event_operations_summary(integer) from public, anon;
grant execute on function public.get_event_operations_summary(integer) to authenticated;

comment on column public."Event_Requests"."Successful_At" is
  'Final completion time recorded when the assigned Staff member confirms an ended event as successful.';
comment on function public.mark_event_successful(integer) is
  'Finalizes an ended event only for its assigned Staff member after every present donor hair review has a final decision.';

notify pgrst, 'reload schema';
commit;
