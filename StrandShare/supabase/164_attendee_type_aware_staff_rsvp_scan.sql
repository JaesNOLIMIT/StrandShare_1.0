-- 164_attendee_type_aware_staff_rsvp_scan.sql
-- Route staff RSVP scans by Event_Attendees.Attendee_Type:
--   Donor     -> preserve the existing RSVP + hair-quality-review flow.
--   Voluntary -> mark RSVP attendance only; no Hair_Submissions row is required.

begin;

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
  v_user public.users%rowtype;
  v_role_key text;
  v_attendee public."Event_Attendees"%rowtype;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_user_id_hint integer;
  v_attendee_id_hint integer;
  v_matches integer := 0;
  v_attendee_type text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_notes text;
  v_scan_stamp text;
  v_donor_result jsonb;
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
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode'
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

    begin
      v_attendee_id_hint := nullif(trim(coalesce(
        v_payload ->> 'Event_Attendee_ID',
        v_payload ->> 'event_attendee_id',
        v_payload ->> 'eventAttendeeId',
        v_payload -> 'data' ->> 'Event_Attendee_ID',
        v_payload -> 'data' ->> 'event_attendee_id',
        v_payload -> 'data' ->> 'eventAttendeeId'
      )), '')::integer;
    exception
      when others then
        v_attendee_id_hint := null;
    end;
  end if;

  if v_payload is null and v_raw <> '' then
    v_waybill_code := v_raw;
  end if;

  if v_waybill_code is null
    and v_user_id_hint is null
    and v_attendee_id_hint is null then
    raise exception 'No waybill code, attendee id, or user id detected from scan.';
  end if;

  if v_attendee_id_hint is not null then
    select *
    into v_attendee
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = p_event_request_id
      and ea."Event_Attendee_ID" = v_attendee_id_hint
    limit 1;
  end if;

  if v_attendee."Event_Attendee_ID" is null and v_waybill_code is not null then
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

  v_attendee_type := case
    when lower(trim(coalesce(v_attendee."Attendee_Type", 'Donor'))) = 'voluntary'
      then 'Voluntary'
    else 'Donor'
  end;

  if v_attendee_type = 'Donor' then
    v_donor_result := public.scan_event_attendee_rsvp(
      p_event_request_id,
      jsonb_build_object(
        'Waybill_Code', nullif(trim(coalesce(v_attendee."Waybill_Code", v_waybill_code)), ''),
        'User_ID', v_attendee."User_ID"
      )::text
    );

    return coalesce(v_donor_result, '{}'::jsonb) || jsonb_build_object(
      'attendee_type', 'Donor',
      'requires_hair_review', true
    );
  end if;

  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This attendee registration is cancelled.';
  end if;

  if v_attendee."RSVP_Scanned_At" is not null then
    raise exception 'RSVP already scanned for this attendee.';
  end if;

  -- Lock immediately before the write so two simultaneous scans cannot both pass.
  select *
  into v_attendee
  from public."Event_Attendees" ea
  where ea."Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  for update;

  if v_attendee."RSVP_Scanned_At" is not null then
    raise exception 'RSVP already scanned for this attendee.';
  end if;

  v_now := timezone('Asia/Manila', now());
  v_scan_stamp := '[RSVP_SCAN ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS')
    || ' by User#' || v_user.user_id || ']';
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

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'event_attendees.rsvp_scan',
    format(
      'Scanned RSVP for voluntary attendee event_request_id=%s attendee_id=%s (attendance only)',
      p_event_request_id,
      v_attendee."Event_Attendee_ID"
    ),
    v_user.email,
    'Event_Attendees',
    'success'
  );

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', null,
    'details', '[]'::jsonb,
    'waybill_code', nullif(trim(coalesce(v_attendee."Waybill_Code", v_waybill_code)), ''),
    'submission_status', null,
    'attendee_type', 'Voluntary',
    'requires_hair_review', false
  );
end;
$fn$;

revoke all on function public.scan_event_attendee_rsvp_by_type(integer, text) from public;
revoke all on function public.scan_event_attendee_rsvp_by_type(integer, text) from anon;
grant execute on function public.scan_event_attendee_rsvp_by_type(integer, text) to authenticated;

comment on function public.scan_event_attendee_rsvp_by_type(integer, text)
  is 'Assigned-staff RSVP scanner. Donors use the existing hair-review flow; Voluntary attendees are checked in once without requiring hair details.';

commit;
