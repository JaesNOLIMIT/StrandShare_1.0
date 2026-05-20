-- 103_simplify_hair_submission_details_ai_only.sql
-- Keep Hair_Submission_Details focused on analyzable hair attributes only.
-- Remove legacy owner/consent/QR/tracking columns that are no longer used.

begin;

-- Drop legacy trigger that depends on removed identifier columns.
drop trigger if exists trg_set_hair_item_identifiers on public."Hair_Submission_Details";

-- Drop indexes tied to removed columns.
drop index if exists public.idx_hair_submission_details_qr_token;
drop index if exists public.idx_hair_submission_details_hair_item_code;
drop index if exists public.idx_hair_submission_details_tracking_status;

-- Drop constraints tied to removed columns.
alter table public."Hair_Submission_Details"
  drop constraint if exists "Hair_Submission_Details_QR_Token_key",
  drop constraint if exists hair_submission_details_qr_token_key,
  drop constraint if exists "Hair_Submission_Details_Hair_Item_Code_key",
  drop constraint if exists hair_submission_details_hair_item_code_key,
  drop constraint if exists hair_submission_details_owner_type_check,
  drop constraint if exists hair_submission_details_input_method_check,
  drop constraint if exists hair_submission_details_qr_status_check,
  drop constraint if exists hair_submission_details_tracking_status_check;

-- Drop columns not needed for AI hair-detail review.
alter table public."Hair_Submission_Details"
  drop column if exists "Hair_Item_Code",
  drop column if exists "Hair_Owner_Type",
  drop column if exists "Hair_Owner_Display_Name",
  drop column if exists "Relationship_To_Submitter",
  drop column if exists "Input_Method",
  drop column if exists "Consent_Confirmed",
  drop column if exists "Consent_Confirmed_At",
  drop column if exists "QR_Token",
  drop column if exists "QR_Image_Path",
  drop column if exists "QR_Status",
  drop column if exists "QR_Generated_At",
  drop column if exists "Current_Tracking_Status";

-- Recreate RSVP scanner RPC without references to removed detail tracking columns.
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
  update public."Hair_Submissions"
  set
    "Event_Request_ID" = coalesce("Event_Request_ID", p_event_request_id),
    "Submission_Code" = coalesce(nullif("Submission_Code", ''), v_resolved_waybill),
    "Status" = case
      when v_status_key in ('', 'pending', 'draft') then 'Cut & Shipped'
      else "Status"
    end,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  update public."Hair_Submission_Details"
  set
    "Updated_By" = v_user.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'event_attendees.rsvp_scan',
    format(
      'Scanned RSVP for event_request_id=%s attendee_id=%s waybill=%s; submission_id=%s now status=%s',
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
    'waybill_code', v_resolved_waybill,
    'submission_status', v_submission."Status"
  );
end;
$fn$;

-- Keep non-event scanner RPC aligned with simplified details schema.
create or replace function public.scan_non_event_hair_submission(
  p_qr_payload text,
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
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_submission_code text;
  v_user_id integer;
  v_submission public."Hair_Submissions"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_action text := 'created';
  v_message text := '';
begin
  if v_raw = '' then
    raise exception 'QR payload is required.';
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
  if v_role_key not in ('staff', 'specialist', 'admin') then
    raise exception 'Only staff/specialist/admin can scan non-event donation QR.';
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
    v_submission_code := nullif(trim(coalesce(
      v_payload ->> 'Submission_Code',
      v_payload ->> 'submission_code',
      v_payload ->> 'Waybill_Code',
      v_payload ->> 'waybill_code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Submission_Code',
      v_payload -> 'data' ->> 'submission_code',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code'
    )), '');

    begin
      v_user_id := nullif(trim(coalesce(
        v_payload ->> 'User_ID',
        v_payload ->> 'user_id',
        v_payload ->> 'userId',
        v_payload -> 'data' ->> 'User_ID',
        v_payload -> 'data' ->> 'user_id',
        v_payload -> 'data' ->> 'userId'
      )), '')::integer;
    exception
      when others then
        v_user_id := null;
    end;
  end if;

  if v_payload is null then
    if v_raw ~ '^[0-9]+$' then
      v_user_id := v_raw::integer;
    else
      v_submission_code := v_raw;
    end if;
  end if;

  if v_submission_code is not null then
    v_submission_code := upper(trim(v_submission_code));
  end if;

  if v_submission_code is not null then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where upper(trim(coalesce(hs."Submission_Code", ''))) = v_submission_code
    for update;

    if v_submission."Submission_ID" is not null then
      if v_submission."Event_Request_ID" is not null then
        raise exception 'Submission % belongs to an event donation. Use assigned event RSVP scanner.', v_submission_code;
      end if;

      if v_user_id is not null and v_submission."User_ID" is distinct from v_user_id then
        raise exception 'Scanned user id does not match owner of submission %.', v_submission_code;
      end if;

      if public.normalize_flow_key(v_submission."Status") in ('cancelled', 'rejected', 'wigcreated') then
        raise exception 'Submission % cannot be scanned while status is %.', v_submission_code, coalesce(v_submission."Status", 'N/A');
      end if;

      update public."Hair_Submissions"
      set
        "From_Event" = false,
        "Status" = case
          when public.normalize_flow_key("Status") in ('', 'pending', 'draft') then 'Cut & Shipped'
          else "Status"
        end,
        "Updated_At" = v_now
      where "Submission_ID" = v_submission."Submission_ID"
      returning * into v_submission;

      v_action := 'existing';
      v_message := format('Non-event donation linked to existing waybill %s.', coalesce(v_submission."Submission_Code", v_submission_code));
    end if;
  end if;

  if v_submission."Submission_ID" is null then
    if v_user_id is null or v_user_id <= 0 then
      raise exception 'No valid user id detected in QR payload.';
    end if;

    insert into public."Hair_Submissions" (
      "User_ID",
      "Status",
      "Created_At",
      "Updated_At",
      "Submission_Code",
      "Event_Request_ID",
      "From_Event"
    )
    values (
      v_user_id,
      'Cut & Shipped',
      v_now,
      v_now,
      nullif(v_submission_code, ''),
      null,
      false
    )
    returning * into v_submission;

    if coalesce(trim(v_submission."Submission_Code"), '') = '' then
      v_submission_code := 'HS-' || to_char(coalesce(v_submission."Created_At", v_now), 'YYYY') || '-' || lpad(v_submission."Submission_ID"::text, 6, '0');
      update public."Hair_Submissions"
      set "Submission_Code" = v_submission_code
      where "Submission_ID" = v_submission."Submission_ID"
      returning * into v_submission;
    end if;

    if not exists (
      select 1
      from public."Hair_Submission_Details" hsd
      where hsd."Submission_ID" = v_submission."Submission_ID"
    ) then
      insert into public."Hair_Submission_Details" (
        "Submission_ID",
        "Updated_By",
        "Updated_At"
      )
      values (
        v_submission."Submission_ID",
        v_user.user_id,
        v_now
      );
    end if;

    v_message := format('Non-event donation created with waybill %s.', v_submission."Submission_Code");
  end if;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submissions.scan_non_event',
    format(
      '%s submission_id=%s user_id=%s code=%s notes=%s',
      case when v_action = 'existing' then 'Updated existing non-event submission:' else 'Created non-event submission:' end,
      v_submission."Submission_ID",
      v_submission."User_ID",
      coalesce(v_submission."Submission_Code", 'N/A'),
      coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success'
  );

  return jsonb_build_object(
    'action', v_action,
    'message', v_message,
    'submission', to_jsonb(v_submission)
  );
end;
$fn$;

grant execute on function public.scan_event_attendee_rsvp(integer, text) to authenticated;
grant execute on function public.scan_non_event_hair_submission(text, text) to authenticated;

commit;
