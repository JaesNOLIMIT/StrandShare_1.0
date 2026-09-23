begin;

-- Account donors must pass Hair Check before joining a program. Public walk-in
-- donors intentionally have no User_ID or prior AI screening; Staff performs
-- their manual hair review at the venue. Keep the event-state guard, then let
-- walk-ins bypass account ownership, private-access, and AI-screening checks.
create or replace function public.guard_event_attendee_access_and_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_event_request record;
  v_current_user_id integer;
  v_screening_id integer;
  v_evaluation jsonb;
begin
  select
    request."Event_Application_ID",
    request."Event_Visibility",
    request."Status"
  into v_event_request
  from public."Event_Requests" request
  where request."Event_Request_ID" = new."Event_Request_ID";

  if not found
     or public.normalize_flow_key(coalesce(v_event_request."Status", '')) <> 'approved' then
    raise exception 'This donation event is not available.';
  end if;

  if coalesce(new."Is_Walk_In", false) then
    if new."User_ID" is not null then
      raise exception 'A walk-in attendee cannot be linked to a registered user.';
    end if;
    return new;
  end if;

  v_current_user_id := public.current_app_user_id();
  if auth.uid() is not null
     and not public.current_app_user_is_staff()
     and new."User_ID" is distinct from v_current_user_id then
    raise exception 'You cannot register another user for this event.' using errcode = '42501';
  end if;

  if auth.uid() is not null and not public.current_app_user_is_staff() then
    if tg_op = 'INSERT' and (
      new."RSVP_Scanned_At" is not null
      or new."RSVP_Scanned_By" is not null
      or public.normalize_flow_key(coalesce(new."Attendance_Status", 'Not Marked')) <> 'notmarked'
    ) then
      raise exception 'Only staff can check in an event attendee.' using errcode = '42501';
    elsif tg_op = 'UPDATE' and (
      new."RSVP_Scanned_At" is distinct from old."RSVP_Scanned_At"
      or new."RSVP_Scanned_By" is distinct from old."RSVP_Scanned_By"
      or new."Attendance_Status" is distinct from old."Attendance_Status"
      or new."Waybill_Code" is distinct from old."Waybill_Code"
    ) then
      raise exception 'Only staff can update event check-in fields.' using errcode = '42501';
    end if;
  end if;

  if public.normalize_flow_key(coalesce(v_event_request."Event_Visibility", 'Public')) = 'private'
     and not exists (
       select 1
       from public."Private_Event_Access" access
       where access."Event_Application_ID" = v_event_request."Event_Application_ID"
         and access."User_ID" = new."User_ID"
     ) then
    raise exception 'Private event access is required before viewing or joining this event.'
      using errcode = '42501';
  end if;

  if public.normalize_flow_key(coalesce(new."Attendee_Type", 'Donor')) = 'donor'
     and not exists (
       select 1
       from public."Hair_Submissions" submission
       where submission."Event_Attendee_ID" = new."Event_Attendee_ID"
     ) then
    v_screening_id := public.latest_ai_screening_result_id_for_user(new."User_ID");
    v_evaluation := public.evaluate_ai_screening_against_wig_requirements(v_screening_id);

    if v_screening_id is null then
      raise exception 'The donor must complete Hair Check before joining this event.';
    elsif v_evaluation is null then
      raise exception 'The donor''s latest Hair Check could not be evaluated.';
    elsif coalesce((v_evaluation ->> 'configuration_error')::boolean, false) then
      raise exception 'Donation requirements are currently unavailable. Please try again later or contact the organization.';
    elsif not coalesce((v_evaluation ->> 'eligible')::boolean, false) then
      raise exception 'The donor''s latest Hair Check does not satisfy the current wig requirements: %',
        coalesce(v_evaluation ->> 'reasons', 'requirements not satisfied');
    end if;
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_event_attendee_access_and_eligibility() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
