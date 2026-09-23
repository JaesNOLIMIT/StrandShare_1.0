begin;

-- Walk-ins have no account or AI screening. Keep the normal eligibility guard
-- for every other submission while allowing the dedicated manual Staff flow.
drop trigger if exists trg_guard_hair_submission_eligible_screening on public."Hair_Submissions";
create trigger trg_guard_hair_submission_eligible_screening
before insert or update of "AI_Screening_ID", "User_ID" on public."Hair_Submissions"
for each row
when (coalesce(new."Is_Walk_In", false) = false)
execute function public.guard_hair_submission_eligible_screening();

-- The legacy event-donation guard requires an account donor to have mobile
-- RSVP and completed check-in. Public walk-ins cannot satisfy that rule; the
-- dedicated RPC below performs their equivalent authorization and validation.
drop trigger if exists trg_guard_hair_submission_donation_mode on public."Hair_Submissions";
create trigger trg_guard_hair_submission_donation_mode
before insert or update of "From_Event", "Event_Request_ID", "Event_Attendee_ID", "Waybill_Code"
on public."Hair_Submissions"
for each row
when (coalesce(new."Is_Walk_In", false) = false)
execute function public.guard_hair_submission_donation_mode();

-- Current Hair_Submissions uses From_Event; Donation_Source was removed.
-- Locking the attendee makes this idempotent even if Staff double-clicks or
-- scans the QR while the first request is still being processed.
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
  if v_attendee."Is_Walk_In" is not true then
    raise exception 'This action is only for public walk-in donors.';
  end if;
  if public.normalize_flow_key(v_attendee."Attendee_Type") <> 'donor' then
    raise exception 'Only a walk-in donor can have a hair review.';
  end if;
  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This walk-in registration is cancelled.';
  end if;
  if public.normalize_flow_key(v_event."Status") <> 'approved' then
    raise exception 'Walk-in hair recording is available only while the program is active.';
  end if;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  order by submission."Submission_ID" desc
  limit 1;

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
