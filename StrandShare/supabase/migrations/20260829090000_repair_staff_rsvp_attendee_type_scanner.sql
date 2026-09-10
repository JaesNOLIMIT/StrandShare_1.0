-- Repair the deployed scanner wrapper's missing dependency.
-- Top-level numbered SQL files are not applied by `supabase db push`, so keep
-- this compatibility function in the migrations directory as well.

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
  v_actor public.users%rowtype;
  v_role_key text;
  v_attendee public."Event_Attendees"%rowtype;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_user_id_hint integer;
  v_attendee_id_hint integer;
  v_attendee_type text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_donor_result jsonb;
begin
  if p_event_request_id is null then
    raise exception 'Event_Request_ID is required.';
  end if;

  if v_raw = '' then
    raise exception 'Waybill payload is required.';
  end if;

  select * into v_actor
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_actor.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_actor.role);
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can scan RSVP attendance.';
  end if;

  if v_role_key = 'staff' and not exists (
    select 1
    from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_actor.user_id
  ) then
    raise exception 'You are not assigned to this event.';
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

  if v_waybill_code is null
     and v_user_id_hint is null
     and v_attendee_id_hint is null then
    raise exception 'No waybill code, attendee id, or user id detected from scan.';
  end if;

  select * into v_attendee
  from public."Event_Attendees" ea
  where ea."Event_Request_ID" = p_event_request_id
    and (
      (v_attendee_id_hint is not null and ea."Event_Attendee_ID" = v_attendee_id_hint)
      or (v_waybill_code is not null and upper(trim(coalesce(ea."Waybill_Code", ''))) = v_waybill_code)
      or (v_user_id_hint is not null and ea."User_ID" = v_user_id_hint)
    )
  order by
    case
      when ea."Event_Attendee_ID" = v_attendee_id_hint then 0
      when upper(trim(coalesce(ea."Waybill_Code", ''))) = coalesce(v_waybill_code, '') then 1
      else 2
    end
  limit 1;

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
    raise exception 'RSVP already scanned for this attendee.';
  end if;

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', null,
    'details', '[]'::jsonb,
    'waybill_code', v_attendee."Waybill_Code",
    'submission_status', null,
    'attendee_type', 'Voluntary',
    'requires_hair_review', false
  );
end;
$fn$;

revoke all on function public.scan_event_attendee_rsvp_by_type(integer, text) from public, anon;
grant execute on function public.scan_event_attendee_rsvp_by_type(integer, text) to authenticated;

comment on function public.scan_event_attendee_rsvp_by_type(integer, text)
  is 'Assigned-event RSVP scanner compatibility function for donor and voluntary attendees.';

commit;
