-- Repair Hair Intake & Review after Hair_Submissions.Submission_Code was removed.
-- Event attendee waybills are canonical; do not restore or duplicate the legacy
-- submission-level code.

begin;

create or replace function public.open_event_hair_intake_review(
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
  v_waybill text;
  v_attendee_id integer;
  v_user_id integer;
  v_details jsonb := '[]'::jsonb;
begin
  select * into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can open event hair intake review.';
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
    exception when others then
      v_payload := null;
    end;
  end if;

  if v_payload is not null then
    v_waybill := nullif(trim(coalesce(
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
      v_attendee_id := nullif(trim(coalesce(
        v_payload ->> 'Event_Attendee_ID',
        v_payload ->> 'event_attendee_id',
        v_payload -> 'data' ->> 'Event_Attendee_ID',
        v_payload -> 'data' ->> 'event_attendee_id'
      )), '')::integer;
    exception when others then
      v_attendee_id := null;
    end;

    begin
      v_user_id := nullif(trim(coalesce(
        v_payload ->> 'User_ID',
        v_payload ->> 'user_id',
        v_payload ->> 'userId',
        v_payload -> 'data' ->> 'User_ID',
        v_payload -> 'data' ->> 'user_id'
      )), '')::integer;
    exception when others then
      v_user_id := null;
    end;
  else
    v_waybill := nullif(v_raw, '');
  end if;

  select * into v_attendee
  from public."Event_Attendees" ea
  where ea."Event_Request_ID" = p_event_request_id
    and (
      (v_attendee_id is not null and ea."Event_Attendee_ID" = v_attendee_id)
      or (v_waybill is not null and upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(v_waybill))
      or (v_user_id is not null and ea."User_ID" = v_user_id)
    )
  order by
    case
      when ea."Event_Attendee_ID" = v_attendee_id then 0
      when upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(coalesce(v_waybill, '')) then 1
      else 2
    end
  limit 1;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'No attendee matched for this event and scan payload.';
  end if;

  if lower(trim(coalesce(v_attendee."Attendee_Type", 'Donor'))) = 'voluntary' then
    raise exception 'Voluntary attendees only require RSVP check-in; they have no hair intake review.';
  end if;

  if v_attendee."RSVP_Scanned_At" is null
     or public.normalize_flow_key(v_attendee."Attendance_Status") <> 'present' then
    raise exception 'RSVP Check-in must be completed before Hair Intake & Review.';
  end if;

  select * into v_submission
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" = p_event_request_id
    and (
      hs."Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
      or hs."User_ID" = v_attendee."User_ID"
    )
  order by
    case when hs."Event_Attendee_ID" = v_attendee."Event_Attendee_ID" then 0 else 1 end,
    hs."Submission_ID" desc
  limit 1;

  if v_submission."Submission_ID" is null then
    raise exception 'No linked hair submission found for this donor.';
  end if;

  if exists (
    select 1
    from public."Hair_Submission_Details" d
    where d."Submission_ID" = v_submission."Submission_ID"
      and public.is_hair_detail_final_status(d."Status")
  ) then
    raise exception 'Hair quality decision is already final and locked.';
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(d) order by d."Submission_Detail_ID"),
    '[]'::jsonb
  )
  into v_details
  from public."Hair_Submission_Details" d
  where d."Submission_ID" = v_submission."Submission_ID";

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details,
    'waybill_code', coalesce(
      nullif(trim(v_attendee."Waybill_Code"), ''),
      nullif(trim(v_waybill), '')
    ),
    'submission_status', v_submission."Status",
    'attendee_type', 'Donor',
    'requires_hair_review', true
  );
end;
$fn$;

revoke all on function public.open_event_hair_intake_review(integer, text)
  from public, anon;
grant execute on function public.open_event_hair_intake_review(integer, text)
  to authenticated;

comment on function public.open_event_hair_intake_review(integer, text)
  is 'Opens assigned-event donor hair review using Event_Attendees.Waybill_Code as the canonical waybill source.';

commit;
