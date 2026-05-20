-- 108_staff_quality_review_after_rsvp_scan.sql
-- Staff RSVP scan flow:
--   1) scan_event_attendee_rsvp only marks attendee present + resolves waybill
--   2) staff_review_hair_submission_quality applies quality decision
--      Approved -> Hair_Submissions.Status = Cut
--      Rejected -> Hair_Submissions.Status = Cancelled (reason required)
--   3) Hair_Submission_Details.Status normalized to Pending/Approved/Rejected

begin;

-- ---------------------------------------------------------------------------
-- Hair_Submission_Details status normalization and guardrails.
-- ---------------------------------------------------------------------------
alter table public."Hair_Submission_Details"
  add column if not exists "Updated_By" integer null,
  add column if not exists "Updated_At" timestamp without time zone null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hair_submission_details_updated_by_fkey'
      and conrelid = 'public."Hair_Submission_Details"'::regclass
  ) then
    alter table public."Hair_Submission_Details"
      add constraint hair_submission_details_updated_by_fkey
      foreign key ("Updated_By")
      references public.users(user_id)
      on delete set null;
  end if;
end
$$;

alter table public."Hair_Submission_Details"
  alter column "Status" set default 'Pending';

update public."Hair_Submission_Details" hsd
set "Status" = case
  when public.normalize_flow_key(hsd."Status") = 'approved' then 'Approved'
  when public.normalize_flow_key(hsd."Status") in ('rejected', 'cancelled') then 'Rejected'
  else 'Pending'
end,
"Updated_At" = coalesce(hsd."Updated_At", timezone('Asia/Manila', now()));

alter table public."Hair_Submission_Details"
  alter column "Status" set not null;

do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public."Hair_Submission_Details"'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%"Status"%'
  loop
    execute format('alter table public."Hair_Submission_Details" drop constraint if exists %I', v_constraint.conname);
  end loop;
end
$$;

alter table public."Hair_Submission_Details"
  add constraint hair_submission_details_status_check
  check (
    public.normalize_flow_key(coalesce("Status", '')) = any (
      array['pending'::text, 'approved'::text, 'rejected'::text]
    )
  );

-- ---------------------------------------------------------------------------
-- RSVP scan RPC: attendance present + waybill link only.
-- ---------------------------------------------------------------------------
create or replace function public.scan_event_attendee_rsvp(
  p_event_request_id integer,
  p_qr_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_attendee public."Event_Attendees"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_user_id_hint integer;
  v_resolved_waybill text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_notes text;
  v_scan_stamp text;
  v_matches integer := 0;
  v_status_key text;
  v_details jsonb := '[]'::jsonb;
begin
  if p_event_request_id is null then
    raise exception 'Event_Request_ID is required.';
  end if;

  select *
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can scan RSVP attendance.';
  end if;

  if v_role_key = 'staff' and not exists (
    select 1
    from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_user.user_id
  ) then
    raise exception 'You are not assigned to this event.';
  end if;

  if v_raw <> '' and left(v_raw, 1) = '{' then
    begin
      v_payload := v_raw::jsonb;
    exception
      when others then
        v_payload := null;
    end;
  end if;

  if v_payload is not null then
    v_waybill_code := nullif(trim(coalesce(
      v_payload ->> 'Waybill_Code',
      v_payload ->> 'waybill_code',
      v_payload ->> 'waybillCode',
      v_payload ->> 'submission_code',
      v_payload ->> 'Submission_Code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode',
      v_payload -> 'data' ->> 'submission_code',
      v_payload -> 'data' ->> 'Submission_Code'
    )), '');

    begin
      v_user_id_hint := nullif(trim(coalesce(
        v_payload ->> 'User_ID',
        v_payload ->> 'user_id',
        v_payload ->> 'userId',
        v_payload -> 'data' ->> 'User_ID',
        v_payload -> 'data' ->> 'user_id',
        v_payload -> 'data' ->> 'userId'
      )), '')::integer;
    exception
      when others then
        v_user_id_hint := null;
    end;
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_waybill_code is null and v_user_id_hint is null then
    raise exception 'No waybill code or user id detected from scan.';
  end if;

  if v_waybill_code is not null then
    select count(*)
    into v_matches
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = p_event_request_id
      and upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(v_waybill_code);

    if v_matches > 1 then
      raise exception 'Multiple attendees found for waybill % in this event.', v_waybill_code;
    elsif v_matches = 1 then
      select *
      into v_attendee
      from public."Event_Attendees" ea
      where ea."Event_Request_ID" = p_event_request_id
        and upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(v_waybill_code)
      limit 1;
    end if;
  end if;

  if v_attendee."Event_Attendee_ID" is null and v_user_id_hint is not null then
    select count(*)
    into v_matches
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = p_event_request_id
      and ea."User_ID" = v_user_id_hint;

    if v_matches > 1 then
      raise exception 'Multiple attendees found for user % in this event. Scan attendee waybill QR instead.', v_user_id_hint;
    elsif v_matches = 1 then
      select *
      into v_attendee
      from public."Event_Attendees" ea
      where ea."Event_Request_ID" = p_event_request_id
        and ea."User_ID" = v_user_id_hint
      limit 1;
    end if;
  end if;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'No attendee matched for this event and scan payload.';
  end if;

  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This attendee registration is cancelled.';
  end if;

  if v_attendee."RSVP_Scanned_At" is not null then
    raise exception 'RSVP already scanned for this attendee.';
  end if;

  v_resolved_waybill := nullif(trim(coalesce(v_attendee."Waybill_Code", v_waybill_code)), '');
  if v_resolved_waybill is null then
    raise exception 'No attendee waybill code is assigned yet.';
  end if;

  v_scan_stamp := '[RSVP_SCAN ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || ' by User#' || v_user.user_id || ']';
  v_notes := trim(coalesce(v_attendee."Notes", ''));
  if v_notes = '' then
    v_notes := v_scan_stamp;
  else
    v_notes := v_notes || E'\n' || v_scan_stamp;
  end if;

  update public."Event_Attendees"
  set
    "Attendance_Status" = 'Present',
    "RSVP_Scanned_At" = v_now,
    "RSVP_Scanned_By" = v_user.user_id,
    "Updated_At" = v_now,
    "Notes" = v_notes
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  select count(*)
  into v_matches
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" = p_event_request_id
    and hs."User_ID" = v_attendee."User_ID";

  if v_matches > 1 then
    raise exception 'Multiple hair submissions found for attendee user % in event %.', v_attendee."User_ID", p_event_request_id;
  elsif v_matches = 1 then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."Event_Request_ID" = p_event_request_id
      and hs."User_ID" = v_attendee."User_ID"
    limit 1;
  end if;

  if v_submission."Submission_ID" is null then
    select count(*)
    into v_matches
    from public."Hair_Submissions" hs
    where upper(trim(coalesce(hs."Submission_Code", ''))) = upper(v_resolved_waybill);

    if v_matches > 1 then
      raise exception 'Multiple hair submissions matched waybill %. Please fix duplicate Submission_Code values.', v_resolved_waybill;
    elsif v_matches = 1 then
      select *
      into v_submission
      from public."Hair_Submissions" hs
      where upper(trim(coalesce(hs."Submission_Code", ''))) = upper(v_resolved_waybill)
      limit 1;
    end if;
  end if;

  if v_submission."Submission_ID" is null then
    raise exception 'No linked hair submission found. RSVP on mobile must insert Hair_Submissions first.';
  end if;

  v_status_key := public.normalize_flow_key(v_submission."Status");
  if v_status_key = 'cancelled' then
    raise exception 'Linked hair submission is cancelled.';
  end if;
  if v_status_key in ('wiginproduction', 'wigcreated') then
    raise exception 'Linked hair submission is already in % status.', v_submission."Status";
  end if;

  update public."Hair_Submissions"
  set
    "Event_Request_ID" = coalesce("Event_Request_ID", p_event_request_id),
    "Submission_Code" = coalesce(nullif("Submission_Code", ''), v_resolved_waybill),
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  if not exists (
    select 1
    from public."Hair_Submission_Details" hsd
    where hsd."Submission_ID" = v_submission."Submission_ID"
  ) then
    insert into public."Hair_Submission_Details" (
      "Submission_ID",
      "Status",
      "Updated_By",
      "Updated_At"
    )
    values (
      v_submission."Submission_ID",
      'Pending',
      v_user.user_id,
      v_now
    );
  end if;

  update public."Hair_Submission_Details"
  set
    "Status" = case
      when public.normalize_flow_key(coalesce("Status", '')) in ('approved', 'rejected') then "Status"
      else 'Pending'
    end,
    "Updated_By" = coalesce("Updated_By", v_user.user_id),
    "Updated_At" = coalesce("Updated_At", v_now)
  where "Submission_ID" = v_submission."Submission_ID";

  select coalesce(jsonb_agg(to_jsonb(hsd) order by hsd."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" hsd
  where hsd."Submission_ID" = v_submission."Submission_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'event_attendees.rsvp_scan',
    format(
      'Scanned RSVP for event_request_id=%s attendee_id=%s waybill=%s; submission_id=%s status=%s (quality pending)',
      p_event_request_id,
      v_attendee."Event_Attendee_ID",
      coalesce(v_resolved_waybill, 'N/A'),
      v_submission."Submission_ID",
      coalesce(v_submission."Status", 'N/A')
    ),
    v_user.email,
    'Event_Attendees',
    'success'
  );

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details,
    'waybill_code', v_resolved_waybill,
    'submission_status', v_submission."Status"
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Staff quality review decision after RSVP scan.
-- ---------------------------------------------------------------------------
create or replace function public.staff_review_hair_submission_quality(
  p_event_request_id integer,
  p_submission_id integer,
  p_decision text,
  p_rejection_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_submission public."Hair_Submissions"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_decision_key text := public.normalize_flow_key(p_decision);
  v_rejection_reason text := nullif(trim(coalesce(p_rejection_reason, '')), '');
  v_submission_status_key text;
  v_notes text;
  v_stamp text;
  v_details jsonb := '[]'::jsonb;
begin
  if p_event_request_id is null then
    raise exception 'Event_Request_ID is required.';
  end if;
  if p_submission_id is null then
    raise exception 'Submission_ID is required.';
  end if;
  if v_decision_key not in ('approved', 'rejected') then
    raise exception 'Decision must be Approved or Rejected.';
  end if;
  if v_decision_key = 'rejected' and v_rejection_reason is null then
    raise exception 'Rejection reason is required when decision is Rejected.';
  end if;

  select *
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can review hair quality at event intake.';
  end if;

  if v_role_key = 'staff' and not exists (
    select 1
    from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_user.user_id
  ) then
    raise exception 'You are not assigned to this event.';
  end if;

  select *
  into v_submission
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = p_submission_id
    and hs."Event_Request_ID" = p_event_request_id
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'Submission % is not linked to event %.', p_submission_id, p_event_request_id;
  end if;

  select *
  into v_attendee
  from public."Event_Attendees" ea
  where ea."Event_Request_ID" = p_event_request_id
    and ea."User_ID" = v_submission."User_ID"
  for update;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'No event attendee linked to this submission/user for the selected event.';
  end if;

  if v_attendee."RSVP_Scanned_At" is null then
    raise exception 'RSVP must be scanned first before quality review.';
  end if;

  if public.normalize_flow_key(v_attendee."Attendance_Status") <> 'present' then
    raise exception 'Attendee attendance status must be Present before quality review.';
  end if;

  v_submission_status_key := public.normalize_flow_key(v_submission."Status");
  if v_submission_status_key in ('wiginproduction', 'wigcreated') then
    raise exception 'Submission is already % and can no longer be reviewed at intake.', v_submission."Status";
  end if;
  if v_submission_status_key = 'cancelled' and v_decision_key = 'approved' then
    raise exception 'Cancelled submissions cannot be approved.';
  end if;

  if v_decision_key = 'approved' then
    update public."Hair_Submissions"
    set
      "Status" = 'Cut',
      "Cut_At" = coalesce("Cut_At", v_now),
      "Cut_By_User_ID" = coalesce("Cut_By_User_ID", v_user.user_id),
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID"
    returning * into v_submission;

    update public."Hair_Submission_Details"
    set
      "Status" = 'Approved',
      "Rejection_Reason" = null,
      "Updated_By" = v_user.user_id,
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID";
  else
    update public."Hair_Submissions"
    set
      "Status" = 'Cancelled',
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID"
    returning * into v_submission;

    update public."Hair_Submission_Details"
    set
      "Status" = 'Rejected',
      "Rejection_Reason" = v_rejection_reason,
      "Updated_By" = v_user.user_id,
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID";
  end if;

  if not exists (
    select 1
    from public."Hair_Submission_Details" hsd
    where hsd."Submission_ID" = v_submission."Submission_ID"
  ) then
    insert into public."Hair_Submission_Details" (
      "Submission_ID",
      "Status",
      "Rejection_Reason",
      "Updated_By",
      "Updated_At"
    )
    values (
      v_submission."Submission_ID",
      case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
      case when v_decision_key = 'approved' then null else v_rejection_reason end,
      v_user.user_id,
      v_now
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(hsd) order by hsd."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" hsd
  where hsd."Submission_ID" = v_submission."Submission_ID";

  v_stamp := case
    when v_decision_key = 'approved' then '[QUALITY_APPROVED ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || ' by User#' || v_user.user_id || ']'
    else '[QUALITY_REJECTED ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || ' by User#' || v_user.user_id || ' reason=' || coalesce(v_rejection_reason, 'N/A') || ']'
  end;

  v_notes := trim(coalesce(v_attendee."Notes", ''));
  if v_notes = '' then
    v_notes := v_stamp;
  else
    v_notes := v_notes || E'\n' || v_stamp;
  end if;

  update public."Event_Attendees"
  set
    "Updated_At" = v_now,
    "Notes" = v_notes
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submissions.staff_quality_review',
    format(
      'event_request_id=%s submission_id=%s attendee_id=%s decision=%s resulting_status=%s reason=%s',
      p_event_request_id,
      v_submission."Submission_ID",
      v_attendee."Event_Attendee_ID",
      case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
      coalesce(v_submission."Status", 'N/A'),
      coalesce(v_rejection_reason, 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success'
  );

  return jsonb_build_object(
    'decision', case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details
  );
end;
$fn$;

grant execute on function public.scan_event_attendee_rsvp(integer, text) to authenticated;
grant execute on function public.staff_review_hair_submission_quality(integer, integer, text, text) to authenticated;

commit;
