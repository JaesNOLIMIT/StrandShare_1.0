begin;

-- New registrations still require an active Approved program. Existing rows
-- need two narrowly scoped post-event updates, though: the lifecycle trigger
-- marks people who never checked in as No Show, and the manual hair-review RPC
-- touches Updated_At while preserving a checked-in attendee as Present.
create or replace function public.guard_event_attendee_access_and_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_event_request record;
  v_event_status text;
  v_current_user_id integer;
  v_screening_id integer;
  v_evaluation jsonb;
  v_is_no_show_transition boolean := false;
  v_is_checked_in_review_touch boolean := false;
begin
  select
    request."Event_Application_ID",
    request."Event_Visibility",
    request."Status"
  into v_event_request
  from public."Event_Requests" request
  where request."Event_Request_ID" = new."Event_Request_ID";

  if not found then
    raise exception 'This donation event is not available.';
  end if;

  v_event_status := public.normalize_flow_key(coalesce(v_event_request."Status", ''));

  if tg_op = 'UPDATE' and old."Event_Request_ID" is not distinct from new."Event_Request_ID" then
    v_is_no_show_transition :=
      v_event_status in ('ended', 'successful')
      and old."RSVP_Scanned_At" is null
      and new."RSVP_Scanned_At" is null
      and public.normalize_flow_key(coalesce(old."Attendance_Status", 'Not Marked')) <> 'present'
      and public.normalize_flow_key(coalesce(new."Attendance_Status", '')) = 'noshow'
      and (to_jsonb(new) - 'Attendance_Status' - 'Updated_At')
        = (to_jsonb(old) - 'Attendance_Status' - 'Updated_At');

    v_is_checked_in_review_touch :=
      v_event_status = 'ended'
      and old."RSVP_Scanned_At" is not null
      and new."RSVP_Scanned_At" is not distinct from old."RSVP_Scanned_At"
      and new."RSVP_Scanned_By" is not distinct from old."RSVP_Scanned_By"
      and public.normalize_flow_key(coalesce(old."Attendance_Status", '')) = 'present'
      and public.normalize_flow_key(coalesce(new."Attendance_Status", '')) = 'present'
      and (to_jsonb(new) - 'Updated_At') = (to_jsonb(old) - 'Updated_At');
  end if;

  if v_event_status <> 'approved'
     and not v_is_no_show_transition
     and not v_is_checked_in_review_touch then
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

  -- These lifecycle-only updates do not re-run registration-time private
  -- access or Hair Check eligibility rules against an existing attendee.
  if v_is_no_show_transition or v_is_checked_in_review_touch then
    return new;
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

revoke all on function public.guard_event_attendee_access_and_eligibility()
from public, anon, authenticated;

-- Ending a program closes RSVP check-in. Anyone who never checked in is a
-- no-show, while attendees already marked Present remain eligible for their
-- outstanding donor hair decision.
create or replace function public.mark_event_attendees_no_show_after_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if public.normalize_flow_key(new."Status") in ('ended', 'successful')
     and public.normalize_flow_key(old."Status") is distinct from public.normalize_flow_key(new."Status") then
    update public."Event_Attendees" attendee
    set
      "Attendance_Status" = 'No Show',
      "Updated_At" = timezone('Asia/Manila', now())
    where attendee."Event_Request_ID" = new."Event_Request_ID"
      and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      and attendee."RSVP_Scanned_At" is null
      and public.normalize_flow_key(attendee."Attendance_Status") <> 'present';
  end if;
  return new;
end;
$fn$;

revoke all on function public.mark_event_attendees_no_show_after_end()
from public, anon, authenticated;

drop trigger if exists trg_mark_event_attendees_no_show_after_end
on public."Event_Requests";
create trigger trg_mark_event_attendees_no_show_after_end
after update of "Status" on public."Event_Requests"
for each row
execute function public.mark_event_attendees_no_show_after_end();

-- Backfill programs that ended before this trigger was installed.
update public."Event_Attendees" attendee
set
  "Attendance_Status" = 'No Show',
  "Updated_At" = timezone('Asia/Manila', now())
from public."Event_Requests" event
where event."Event_Request_ID" = attendee."Event_Request_ID"
  and public.normalize_flow_key(event."Status") in ('ended', 'successful')
  and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
  and attendee."RSVP_Scanned_At" is null
  and public.normalize_flow_key(attendee."Attendance_Status") <> 'present';

-- The first walk-in scan is still allowed only while the program is active.
-- This second-scan function may open/resume a review after Ended, but only for
-- an attendee whose RSVP scan already set Present before the deadline.
create or replace function public.staff_create_walk_in_hair_submission(
  p_event_attendee_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_event public."Event_Requests"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_details jsonb := '[]'::jsonb;
  v_images jsonb := '[]'::jsonb;
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  select * into v_attendee
  from public."Event_Attendees" attendee
  where attendee."Event_Attendee_ID" = p_event_attendee_id
  for update;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'Walk-in attendee was not found.';
  end if;

  select * into v_event
  from public."Event_Requests" event
  where event."Event_Request_ID" = v_attendee."Event_Request_ID";

  if v_actor.user_id is null
     or public.normalize_app_role(v_actor.role) <> 'staff'
     or v_event."Assigned_Staff_User_ID" is distinct from v_actor.user_id then
    raise exception 'Only the assigned Staff member can record this walk-in hair.';
  end if;
  if v_attendee."Is_Walk_In" is not true
     or public.normalize_flow_key(v_attendee."Attendee_Type") <> 'donor' then
    raise exception 'This action is only for public walk-in donors.';
  end if;
  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This walk-in registration is cancelled.';
  end if;
  if public.normalize_flow_key(v_event."Status") not in ('approved', 'ended') then
    raise exception 'Walk-in hair recording is available only for an active or ended program that is not yet closed as successful.';
  end if;
  if public.normalize_flow_key(v_attendee."Attendance_Status") <> 'present'
     or v_attendee."RSVP_Scanned_At" is null then
    raise exception 'This attendee did not complete RSVP Check-in before the program ended.';
  end if;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  order by submission."Submission_ID" desc
  limit 1;

  if v_submission."Submission_ID" is not null and (
    public.normalize_flow_key(v_submission."Status") in ('cut', 'cancelled', 'wiginproduction', 'wigcreated')
    or exists (
      select 1 from public."Hair_Submission_Details" detail
      where detail."Submission_ID" = v_submission."Submission_ID"
        and public.is_hair_detail_final_status(detail."Status")
    )
  ) then
    raise exception 'This walk-in hair review is already completed and cannot be opened again.';
  end if;

  if v_submission."Submission_ID" is null then
    insert into public."Hair_Submissions" (
      "User_ID", "Status", "Created_At", "Updated_At", "From_Event",
      "Event_Request_ID", "Event_Attendee_ID", "Is_Walk_In"
    ) values (
      null, 'Pending', v_now, v_now, true,
      v_attendee."Event_Request_ID", v_attendee."Event_Attendee_ID", true
    )
    returning * into v_submission;
  end if;

  if not exists (
    select 1 from public."Hair_Submission_Details" detail
    where detail."Submission_ID" = v_submission."Submission_ID"
  ) then
    insert into public."Hair_Submission_Details" (
      "Submission_ID", "Status", "Updated_By", "Created_At", "Updated_At"
    ) values (
      v_submission."Submission_ID", 'Pending', v_actor.user_id, v_now, v_now
    )
    on conflict ("Submission_ID") do nothing;
  end if;

  select coalesce(jsonb_agg(to_jsonb(detail) order by detail."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" detail
  where detail."Submission_ID" = v_submission."Submission_ID";

  select coalesce(jsonb_agg(to_jsonb(image) order by image."Image_ID"), '[]'::jsonb)
  into v_images
  from public."Hair_Submission_Images" image
  join public."Hair_Submission_Details" detail
    on detail."Submission_Detail_ID" = image."Submission_Detail_ID"
  where detail."Submission_ID" = v_submission."Submission_ID";

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details,
    'images', v_images,
    'waybill_code', v_attendee."Waybill_Code"
  );
end;
$fn$;

revoke all on function public.staff_create_walk_in_hair_submission(integer)
from public, anon, authenticated;
grant execute on function public.staff_create_walk_in_hair_submission(integer)
to authenticated;

notify pgrst, 'reload schema';
commit;
