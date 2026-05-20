-- 109_staff_decision_lock_and_wig_ai_bundle_scan.sql
-- Aligns intake and production workflow to the latest agreed flow:
-- 1) Staff can edit Hair_Submission_Details before final decision.
-- 2) Final staff decision statuses: Approved / Rejected / Rejected Cut.
-- 3) Rejected and Rejected Cut both move Hair_Submissions to Cancelled.
-- 4) Bundling draft creation depends only on Wig_Specification_ID (no cap size column dependency).
-- 5) Wig AI Studio can scan bundle waybill and auto:
--      - increment Wigs.Stock_Count by 1 (same Wig_Specification_ID target)
--      - set Hair_Submission_Bundles.Status = Wig Completed
--      - set all linked Hair_Submissions.Status = Wig Created

begin;

-- ---------------------------------------------------------------------------
-- Hair_Submission_Details status: include Rejected Cut.
-- ---------------------------------------------------------------------------
alter table public."Hair_Submission_Details"
  alter column "Status" set default 'Pending';

update public."Hair_Submission_Details" hsd
set "Status" = case
  when public.normalize_flow_key(hsd."Status") = 'approved' then 'Approved'
  when public.normalize_flow_key(hsd."Status") in ('rejectedcut', 'rejectedandcut') then 'Rejected Cut'
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
      array['pending'::text, 'approved'::text, 'rejected'::text, 'rejectedcut'::text]
    )
  );

-- ---------------------------------------------------------------------------
-- Helper: returns true if detail status is final-locked.
-- ---------------------------------------------------------------------------
create or replace function public.is_hair_detail_final_status(p_status text)
returns boolean
language sql
immutable
as $fn$
  select public.normalize_flow_key(coalesce(p_status, '')) in ('approved', 'rejected', 'rejectedcut')
$fn$;

-- ---------------------------------------------------------------------------
-- Staff can update detail fields only before final decision.
-- ---------------------------------------------------------------------------
create or replace function public.staff_update_hair_submission_details(
  p_event_request_id integer,
  p_submission_id integer,
  p_declared_length numeric default null,
  p_declared_color text default null,
  p_declared_texture text default null,
  p_declared_density text default null,
  p_declared_condition text default null,
  p_is_chemically_treated boolean default null,
  p_is_colored boolean default null,
  p_is_bleached boolean default null,
  p_is_rebonded boolean default null,
  p_detail_notes text default null
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
  v_has_final_decision boolean := false;
  v_details jsonb := '[]'::jsonb;
begin
  if p_event_request_id is null then
    raise exception 'Event_Request_ID is required.';
  end if;
  if p_submission_id is null then
    raise exception 'Submission_ID is required.';
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
    raise exception 'Only staff/admin can update hair details at event intake.';
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
    raise exception 'RSVP must be scanned first before updating hair details.';
  end if;

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

  select exists (
    select 1
    from public."Hair_Submission_Details" hsd
    where hsd."Submission_ID" = v_submission."Submission_ID"
      and public.is_hair_detail_final_status(hsd."Status")
  )
  into v_has_final_decision;

  if v_has_final_decision then
    raise exception 'Hair details are locked after final staff decision.';
  end if;

  update public."Hair_Submission_Details"
  set
    "Declared_Length" = p_declared_length,
    "Declared_Color" = nullif(trim(coalesce(p_declared_color, '')), ''),
    "Declared_Texture" = nullif(trim(coalesce(p_declared_texture, '')), ''),
    "Declared_Density" = nullif(trim(coalesce(p_declared_density, '')), ''),
    "Declared_Condition" = nullif(trim(coalesce(p_declared_condition, '')), ''),
    "Is_Chemically_Treated" = coalesce(p_is_chemically_treated, "Is_Chemically_Treated"),
    "Is_Colored" = coalesce(p_is_colored, "Is_Colored"),
    "Is_Bleached" = coalesce(p_is_bleached, "Is_Bleached"),
    "Is_Rebonded" = coalesce(p_is_rebonded, "Is_Rebonded"),
    "Detail_Notes" = case
      when p_detail_notes is null then "Detail_Notes"
      else nullif(trim(p_detail_notes), '')
    end,
    "Status" = 'Pending',
    "Rejection_Reason" = null,
    "Updated_By" = v_user.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID";

  select coalesce(jsonb_agg(to_jsonb(hsd) order by hsd."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" hsd
  where hsd."Submission_ID" = v_submission."Submission_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submissions.staff_update_details',
    format(
      'event_request_id=%s submission_id=%s attendee_id=%s detail_count=%s',
      p_event_request_id,
      v_submission."Submission_ID",
      v_attendee."Event_Attendee_ID",
      jsonb_array_length(v_details)
    ),
    v_user.email,
    'Hair_Submission_Details',
    'success'
  );

  return jsonb_build_object(
    'submission', to_jsonb(v_submission),
    'details', v_details
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- RSVP scan: keep details pending unless already final.
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
      when public.is_hair_detail_final_status("Status") then "Status"
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
-- Staff final quality decision (locked once final).
-- Decision values: Approved / Rejected / Rejected Cut
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
  v_has_final_decision boolean := false;
begin
  if p_event_request_id is null then
    raise exception 'Event_Request_ID is required.';
  end if;
  if p_submission_id is null then
    raise exception 'Submission_ID is required.';
  end if;
  if v_decision_key not in ('approved', 'rejected', 'rejectedcut') then
    raise exception 'Decision must be Approved, Rejected, or Rejected Cut.';
  end if;
  if v_decision_key in ('rejected', 'rejectedcut') and v_rejection_reason is null then
    raise exception 'Rejection reason is required when decision is Rejected or Rejected Cut.';
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

  select exists (
    select 1
    from public."Hair_Submission_Details" hsd
    where hsd."Submission_ID" = v_submission."Submission_ID"
      and public.is_hair_detail_final_status(hsd."Status")
  )
  into v_has_final_decision;

  if v_has_final_decision then
    raise exception 'Hair quality decision is already final and locked.';
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
  elsif v_decision_key = 'rejectedcut' then
    update public."Hair_Submissions"
    set
      "Status" = 'Cancelled',
      "Cut_At" = coalesce("Cut_At", v_now),
      "Cut_By_User_ID" = coalesce("Cut_By_User_ID", v_user.user_id),
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID"
    returning * into v_submission;

    update public."Hair_Submission_Details"
    set
      "Status" = 'Rejected Cut',
      "Rejection_Reason" = v_rejection_reason,
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

  select coalesce(jsonb_agg(to_jsonb(hsd) order by hsd."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" hsd
  where hsd."Submission_ID" = v_submission."Submission_ID";

  v_stamp := case
    when v_decision_key = 'approved' then '[QUALITY_APPROVED ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || ' by User#' || v_user.user_id || ']'
    when v_decision_key = 'rejectedcut' then '[QUALITY_REJECTED_CUT ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || ' by User#' || v_user.user_id || ' reason=' || coalesce(v_rejection_reason, 'N/A') || ']'
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
      case
        when v_decision_key = 'approved' then 'Approved'
        when v_decision_key = 'rejectedcut' then 'Rejected Cut'
        else 'Rejected'
      end,
      coalesce(v_submission."Status", 'N/A'),
      coalesce(v_rejection_reason, 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success'
  );

  return jsonb_build_object(
    'decision', case
      when v_decision_key = 'approved' then 'Approved'
      when v_decision_key = 'rejectedcut' then 'Rejected Cut'
      else 'Rejected'
    end,
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Bundle draft creation: use only Wig_Specification_ID (ignore cap size column).
-- Keep signature compatible with existing UI calls.
-- ---------------------------------------------------------------------------
create or replace function public.create_hair_bundle_draft(
  p_wig_specification_id integer,
  p_cap_size_override text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_open_draft_count integer := 0;
begin
  if p_wig_specification_id is null then
    raise exception 'Wig_Specification_ID is required.';
  end if;

  if not exists (
    select 1
    from public."Wig_Specifications" ws
    where ws."Wig_Specification_ID" = p_wig_specification_id
  ) then
    raise exception 'Wig specification % does not exist.', p_wig_specification_id;
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
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can open bundle drafts.';
  end if;

  select count(*)::integer
  into v_open_draft_count
  from public."Hair_Submission_Bundles" b
  where b."Created_By" = v_user.user_id
    and public.normalize_flow_key(b."Status") = 'draft';

  if v_open_draft_count >= 3 then
    raise exception 'Maximum of 3 open drafts per specialist. Close or delete an existing draft first.';
  end if;

  insert into public."Hair_Submission_Bundles" (
    "Created_By",
    "Status",
    "Notes",
    "Wig_Specification_ID"
  )
  values (
    v_user.user_id,
    'Draft',
    nullif(trim(coalesce(p_notes, '')), ''),
    p_wig_specification_id
  )
  returning * into v_bundle;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.open_draft',
    format(
      'Opened bundle draft bundle_id=%s wig_specification_id=%s',
      v_bundle."Bundle_ID",
      p_wig_specification_id
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return to_jsonb(v_bundle);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Wig AI Studio bundle scan:
-- +1 stock on matching wig by bundle.Wig_Specification_ID,
-- bundle -> Wig Completed,
-- linked submissions -> Wig Created.
-- ---------------------------------------------------------------------------
create or replace function public.complete_wig_stock_from_bundle_scan(
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_raw text := trim(coalesce(p_waybill_payload, ''));
  v_payload jsonb;
  v_bundle_id integer;
  v_waybill_code text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_spec public."Wig_Specifications"%rowtype;
  v_wig public."Wigs"%rowtype;
  v_prev_stock integer := 0;
  v_next_stock integer := 0;
  v_member_count integer := 0;
begin
  if v_raw = '' then
    raise exception 'Bundle waybill payload is required.';
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
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can complete wig stock from bundle scans.';
  end if;

  if left(v_raw, 1) = '{' then
    begin
      v_payload := v_raw::jsonb;
    exception
      when others then
        v_payload := null;
    end;
  end if;

  if v_payload is not null then
    begin
      v_bundle_id := nullif(trim(coalesce(
        v_payload ->> 'bundle_id',
        v_payload ->> 'Bundle_ID',
        v_payload -> 'data' ->> 'bundle_id',
        v_payload -> 'data' ->> 'Bundle_ID'
      )), '')::integer;
    exception
      when others then
        v_bundle_id := null;
    end;

    v_waybill_code := nullif(trim(coalesce(
      v_payload ->> 'bundle_waybill_code',
      v_payload ->> 'Bundle_Waybill_Code',
      v_payload ->> 'submission_code',
      v_payload ->> 'Submission_Code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'bundle_waybill_code',
      v_payload -> 'data' ->> 'Bundle_Waybill_Code',
      v_payload -> 'data' ->> 'submission_code',
      v_payload -> 'data' ->> 'Submission_Code'
    )), '');
  end if;

  if v_bundle_id is null and v_raw ~ '^[0-9]+$' then
    v_bundle_id := v_raw::integer;
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_bundle_id is not null then
    select *
    into v_bundle
    from public."Hair_Submission_Bundles" b
    where b."Bundle_ID" = v_bundle_id
    for update;
  end if;

  if v_bundle."Bundle_ID" is null and v_waybill_code is not null then
    select *
    into v_bundle
    from public."Hair_Submission_Bundles" b
    where upper(trim(coalesce(b."Bundle_Waybill_Code", ''))) = upper(trim(v_waybill_code))
    for update;
  end if;

  if v_bundle."Bundle_ID" is null then
    raise exception 'No bundle matched the scanned waybill payload.';
  end if;

  if public.normalize_flow_key(v_bundle."Status") = 'draft' then
    raise exception 'Bundle % is still Draft. Finalize it on Bundling first.', v_bundle."Bundle_ID";
  end if;

  if public.normalize_flow_key(v_bundle."Status") = 'wigcompleted' then
    raise exception 'Bundle % is already Wig Completed.', v_bundle."Bundle_ID";
  end if;

  if v_bundle."Wig_Specification_ID" is null then
    raise exception 'Bundle % has no Wig_Specification_ID. Set it first before completing stock.', v_bundle."Bundle_ID";
  end if;

  select *
  into v_spec
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = v_bundle."Wig_Specification_ID"
  for update;

  if v_spec."Wig_Specification_ID" is null then
    raise exception 'Wig specification % from bundle % was not found.', v_bundle."Wig_Specification_ID", v_bundle."Bundle_ID";
  end if;

  if v_spec."Wig_ID" is null then
    raise exception 'Wig specification % is not linked to a Wig record.', v_spec."Wig_Specification_ID";
  end if;

  select *
  into v_wig
  from public."Wigs" w
  where w."Wig_ID" = v_spec."Wig_ID"
  for update;

  if v_wig."Wig_ID" is null then
    raise exception 'Wig % linked to specification % was not found.', v_spec."Wig_ID", v_spec."Wig_Specification_ID";
  end if;

  v_prev_stock := greatest(0, coalesce(v_wig."Stock_Count", 0));
  v_next_stock := v_prev_stock + 1;

  update public."Wigs"
  set
    "Stock_Count" = v_next_stock,
    "Wig_Status" = case when v_next_stock > 0 then 'available' else 'not available' end,
    "Updated_At" = v_now
  where "Wig_ID" = v_wig."Wig_ID"
  returning * into v_wig;

  update public."Hair_Submission_Bundles"
  set
    "Status" = 'Wig Completed',
    "Wig_Completed_At" = coalesce("Wig_Completed_At", v_now),
    "Updated_At" = v_now
  where "Bundle_ID" = v_bundle."Bundle_ID"
  returning * into v_bundle;

  update public."Hair_Submissions"
  set
    "Status" = 'Wig Created',
    "Updated_At" = v_now
  where "Bundle_ID" = v_bundle."Bundle_ID"
    and public.normalize_flow_key("Status") <> 'wigcreated';

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = v_bundle."Bundle_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'wigs.complete_stock_from_bundle_scan',
    format(
      'bundle_id=%s bundle_waybill=%s wig_specification_id=%s wig_id=%s stock:%s->%s members=%s',
      v_bundle."Bundle_ID",
      coalesce(v_bundle."Bundle_Waybill_Code", 'N/A'),
      coalesce(v_bundle."Wig_Specification_ID"::text, 'N/A'),
      v_wig."Wig_ID",
      v_prev_stock,
      v_next_stock,
      v_member_count
    ),
    v_user.email,
    'Wigs',
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'wig', to_jsonb(v_wig),
    'wig_specification_id', v_spec."Wig_Specification_ID",
    'previous_stock', v_prev_stock,
    'next_stock', v_next_stock,
    'member_count', v_member_count
  );
end;
$fn$;

grant execute on function public.staff_update_hair_submission_details(
  integer, integer, numeric, text, text, text, text, boolean, boolean, boolean, boolean, text
) to authenticated;
grant execute on function public.scan_event_attendee_rsvp(integer, text) to authenticated;
grant execute on function public.staff_review_hair_submission_quality(integer, integer, text, text) to authenticated;
grant execute on function public.create_hair_bundle_draft(integer, text, text) to authenticated;
grant execute on function public.complete_wig_stock_from_bundle_scan(text) to authenticated;

commit;
