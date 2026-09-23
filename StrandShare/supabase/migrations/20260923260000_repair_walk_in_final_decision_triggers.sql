begin;

-- The registered-donor detail triggers expect Hair_Submissions.User_ID and an
-- account-backed donor. The dedicated walk-in review RPC already performs its
-- own authorization, RSVP, evidence, assessment, and final-state validation.
-- Skip only those registered-only effects while that RPC finalizes a walk-in.
-- The cut-inventory synchronization trigger is intentionally left enabled.
drop trigger if exists trg_guard_staff_hair_donation_approval
on public."Hair_Submission_Details";
create trigger trg_guard_staff_hair_donation_approval
before insert or update of "Status" on public."Hair_Submission_Details"
for each row
when (coalesce(current_setting('donivra.walk_in_manual_review', true), '') <> 'on')
execute function public.guard_staff_hair_donation_approval();

drop trigger if exists trg_enqueue_submission_detail_status_email
on public."Hair_Submission_Details";
create trigger trg_enqueue_submission_detail_status_email
after insert or update of "Status" on public."Hair_Submission_Details"
for each row
when (coalesce(current_setting('donivra.walk_in_manual_review', true), '') <> 'on')
execute function public.enqueue_submission_detail_status_email();

drop trigger if exists trg_finalize_hair_ai_review_comparison
on public."Hair_Submission_Details";
create trigger trg_finalize_hair_ai_review_comparison
after insert or update of "Status" on public."Hair_Submission_Details"
for each row
when (coalesce(current_setting('donivra.walk_in_manual_review', true), '') <> 'on')
execute function public.finalize_hair_ai_review_comparison();

drop trigger if exists trg_issue_donation_certificate_after_staff_approval
on public."Hair_Submission_Details";
create trigger trg_issue_donation_certificate_after_staff_approval
after insert or update of "Status" on public."Hair_Submission_Details"
for each row
when (coalesce(current_setting('donivra.walk_in_manual_review', true), '') <> 'on')
execute function public.issue_donation_certificate_after_staff_approval();

drop trigger if exists trg_registered_donor_hair_review_email
on public."Hair_Submission_Details";
create trigger trg_registered_donor_hair_review_email
after update of "Status" on public."Hair_Submission_Details"
for each row
when (coalesce(current_setting('donivra.walk_in_manual_review', true), '') <> 'on')
execute function public.queue_registered_donor_hair_review_email();

-- Parent submission is finalized first. Therefore, when the approved detail
-- fires sync_cut_hair_inventory_from_detail, it sees Status=Cut and inserts the
-- physical inventory row in the same transaction.
create or replace function public.staff_save_walk_in_hair_review(
  p_event_request_id integer, p_submission_id integer, p_decision text,
  p_declared_length numeric default null, p_declared_color text default null,
  p_declared_texture text default null, p_declared_density text default null,
  p_declared_condition text default null, p_is_chemically_treated boolean default false,
  p_is_colored boolean default false, p_is_bleached boolean default false,
  p_is_rebonded boolean default false, p_detail_notes text default null,
  p_rejection_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_decision text := public.normalize_flow_key(p_decision);
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_details jsonb;
  v_photo_types text[];
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = p_submission_id
    and submission."Event_Request_ID" = p_event_request_id
    and submission."Is_Walk_In" is true
  for update;

  select * into v_attendee
  from public."Event_Attendees" attendee
  where attendee."Event_Attendee_ID" = v_submission."Event_Attendee_ID"
    and attendee."Is_Walk_In" is true
  for update;

  if v_actor.user_id is null
     or public.normalize_app_role(v_actor.role) <> 'staff'
     or v_submission."Submission_ID" is null
     or v_attendee."Event_Attendee_ID" is null
     or not exists (
       select 1 from public."Event_Requests" event
       where event."Event_Request_ID" = p_event_request_id
         and event."Assigned_Staff_User_ID" = v_actor.user_id
     ) then
    raise exception 'Only the assigned Staff member can review this walk-in donation.';
  end if;
  if public.normalize_flow_key(v_attendee."Attendance_Status") <> 'present'
     or v_attendee."RSVP_Scanned_At" is null then
    raise exception 'Complete walk-in RSVP Check-in before saving the hair assessment.';
  end if;
  if v_decision not in ('approved', 'rejected') then
    raise exception 'Walk-in hair can only be accepted or rejected.';
  end if;
  if p_declared_length is null or p_declared_length <= 0 then
    raise exception 'Enter a measured hair length greater than zero.';
  end if;
  if nullif(trim(coalesce(p_declared_color, '')), '') is null
     or nullif(trim(coalesce(p_declared_texture, '')), '') is null
     or nullif(trim(coalesce(p_declared_density, '')), '') is null
     or nullif(trim(coalesce(p_declared_condition, '')), '') is null then
    raise exception 'Complete length, color, hair pattern, density, and condition before the final decision.';
  end if;

  select coalesce(
    array_agg(distinct public.normalize_flow_key(image."Image_Type")),
    array[]::text[]
  )
  into v_photo_types
  from public."Hair_Submission_Images" image
  join public."Hair_Submission_Details" detail
    on detail."Submission_Detail_ID" = image."Submission_Detail_ID"
  where detail."Submission_ID" = p_submission_id;

  if not ('front' = any(v_photo_types))
     or not ('side' = any(v_photo_types))
     or not ('top' = any(v_photo_types)) then
    raise exception 'Upload the required Front, Side, and Top hair photos before the final decision.';
  end if;
  if v_decision = 'rejected'
     and nullif(trim(coalesce(p_rejection_reason, '')), '') is null then
    raise exception 'A rejection reason is required.';
  end if;
  if exists (
    select 1 from public."Hair_Submission_Details" detail
    where detail."Submission_ID" = p_submission_id
      and public.is_hair_detail_final_status(detail."Status")
  ) then
    raise exception 'This walk-in hair decision is already final.';
  end if;

  update public."Hair_Submissions"
  set
    "Status" = case when v_decision = 'approved' then 'Cut' else 'Cancelled' end,
    "Cut_At" = case
      when v_decision = 'approved' then coalesce("Cut_At", v_now)
      else "Cut_At"
    end,
    "Cut_By_User_ID" = case
      when v_decision = 'approved' then coalesce("Cut_By_User_ID", v_actor.user_id)
      else "Cut_By_User_ID"
    end,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
  returning * into v_submission;

  perform set_config('donivra.walk_in_manual_review', 'on', true);

  update public."Hair_Submission_Details"
  set
    "Declared_Length" = p_declared_length,
    "Declared_Color" = trim(p_declared_color),
    "Declared_Texture" = trim(p_declared_texture),
    "Declared_Density" = trim(p_declared_density),
    "Declared_Condition" = trim(p_declared_condition),
    "Is_Chemically_Treated" = coalesce(p_is_chemically_treated, false),
    "Is_Colored" = coalesce(p_is_colored, false),
    "Is_Bleached" = coalesce(p_is_bleached, false),
    "Is_Rebonded" = coalesce(p_is_rebonded, false),
    "Detail_Notes" = nullif(trim(coalesce(p_detail_notes, '')), ''),
    "Status" = case when v_decision = 'approved' then 'Approved' else 'Rejected' end,
    "Rejection_Reason" = case
      when v_decision = 'rejected' then trim(p_rejection_reason)
      else null
    end,
    "Updated_By" = v_actor.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id;

  if not found then
    raise exception 'Walk-in hair assessment details were not found.';
  end if;

  update public."Event_Attendees"
  set "Attendance_Status" = 'Present', "Updated_At" = v_now
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  select coalesce(jsonb_agg(to_jsonb(detail)), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" detail
  where detail."Submission_ID" = p_submission_id;

  perform public.enqueue_smtp_email_outbox(
    'walk_in_hair_' || v_decision || ':' || p_submission_id,
    'Hair_Submissions', p_submission_id,
    case when v_decision = 'approved' then 'walk_in_hair_accepted' else 'walk_in_hair_rejected' end,
    v_attendee."Walk_In_Email",
    case when v_decision = 'approved' then 'Donated hair accepted' else 'Hair review result' end,
    case when v_decision = 'approved' then 'walk_in_hair_accepted' else 'walk_in_hair_rejected' end,
    jsonb_build_object(
      'recipient_name', v_attendee."Walk_In_Full_Name",
      'decision', case when v_decision = 'approved' then 'Accepted' else 'Rejected' end,
      'reason', case when v_decision = 'rejected' then trim(p_rejection_reason) else null end,
      'waybill_code', v_attendee."Waybill_Code"
    ),
    v_actor.user_id
  );

  return jsonb_build_object(
    'decision', case when v_decision = 'approved' then 'Approved' else 'Rejected' end,
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details
  );
end;
$fn$;

revoke all on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text)
from public, anon, authenticated;
grant execute on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text)
to authenticated;

notify pgrst, 'reload schema';
commit;
