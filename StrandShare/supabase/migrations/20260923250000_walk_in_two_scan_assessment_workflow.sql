begin;

-- Staff may replace or remove an on-site evidence photo before the assessment
-- is finalized. The application still limits this UI to assigned Staff and
-- walk-in records; these storage policies match the existing insert/read role.
drop policy if exists hair_submissions_update_staff on storage.objects;
create policy hair_submissions_update_staff on storage.objects
for update to authenticated
using (
  bucket_id = 'hair-submissions'
  and exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) = 'staff'
  )
)
with check (
  bucket_id = 'hair-submissions'
  and exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) = 'staff'
  )
);

drop policy if exists hair_submissions_delete_staff on storage.objects;
create policy hair_submissions_delete_staff on storage.objects
for delete to authenticated
using (
  bucket_id = 'hair-submissions'
  and exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) = 'staff'
  )
);

-- Public walk-ins use the same emailed waybill twice. The first scan records
-- attendance only. The second scan, in Hair Outcome Review mode, creates or
-- resumes the manual assessment. Registered donors continue through the
-- existing scan_event_attendee_operation function unchanged.
create or replace function public.staff_check_in_walk_in_attendee(
  p_event_request_id integer,
  p_event_attendee_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_event public."Event_Requests"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_already_checked_in boolean := false;
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  select * into v_event
  from public."Event_Requests" event
  where event."Event_Request_ID" = p_event_request_id;

  select * into v_attendee
  from public."Event_Attendees" attendee
  where attendee."Event_Attendee_ID" = p_event_attendee_id
    and attendee."Event_Request_ID" = p_event_request_id
  for update;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'Walk-in attendee was not found for this program.';
  end if;
  if v_actor.user_id is null
     or public.normalize_app_role(v_actor.role) <> 'staff'
     or v_event."Assigned_Staff_User_ID" is distinct from v_actor.user_id then
    raise exception 'Only the assigned Staff member can check in this walk-in donor.';
  end if;
  if v_attendee."Is_Walk_In" is not true
     or public.normalize_flow_key(v_attendee."Attendee_Type") <> 'donor' then
    raise exception 'This check-in action is only for public walk-in donors.';
  end if;
  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This walk-in registration is cancelled.';
  end if;
  if public.normalize_flow_key(v_event."Status") <> 'approved' then
    raise exception 'Walk-in RSVP check-in is available only while the program is active.';
  end if;

  v_already_checked_in := public.normalize_flow_key(v_attendee."Attendance_Status") = 'present'
    and v_attendee."RSVP_Scanned_At" is not null;

  update public."Event_Attendees"
  set
    "Attendance_Status" = 'Present',
    "RSVP_Scanned_At" = coalesce("RSVP_Scanned_At", v_now),
    "RSVP_Scanned_By" = coalesce("RSVP_Scanned_By", v_actor.user_id),
    "Updated_At" = v_now
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'waybill_code', v_attendee."Waybill_Code",
    'already_checked_in', v_already_checked_in
  );
end;
$fn$;

-- The manual record can only be opened after the first (RSVP) scan. This
-- remains idempotent, so a repeated second scan resumes the same submission.
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
  if public.normalize_flow_key(v_attendee."Attendance_Status") <> 'present'
     or v_attendee."RSVP_Scanned_At" is null then
    raise exception 'Complete walk-in RSVP Check-in before starting Hair Outcome Review.';
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

-- A completed manual review requires the five human assessment fields and one
-- photo for each required view. This function is walk-in-only, so registered
-- donor AI comparison and approval behavior is not changed.
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
  select * into v_actor from public.users actor
  where actor.auth_user_id = auth.uid() and actor.is_active is distinct from false limit 1;
  select * into v_submission from public."Hair_Submissions" submission
  where submission."Submission_ID" = p_submission_id
    and submission."Event_Request_ID" = p_event_request_id
    and submission."Is_Walk_In" is true for update;
  select * into v_attendee from public."Event_Attendees" attendee
  where attendee."Event_Attendee_ID" = v_submission."Event_Attendee_ID"
    and attendee."Is_Walk_In" is true for update;

  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) <> 'staff'
     or v_submission."Submission_ID" is null
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

  select coalesce(array_agg(distinct public.normalize_flow_key(image."Image_Type")), array[]::text[])
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
  if v_decision = 'rejected' and nullif(trim(coalesce(p_rejection_reason, '')), '') is null then
    raise exception 'A rejection reason is required.';
  end if;
  if exists (
    select 1 from public."Hair_Submission_Details" detail
    where detail."Submission_ID" = p_submission_id
      and public.is_hair_detail_final_status(detail."Status")
  ) then
    raise exception 'This walk-in hair decision is already final.';
  end if;

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
    "Rejection_Reason" = case when v_decision = 'rejected' then trim(p_rejection_reason) end,
    "Updated_By" = v_actor.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id;

  update public."Hair_Submissions"
  set
    "Status" = case when v_decision = 'approved' then 'Cut' else 'Cancelled' end,
    "Cut_At" = case when v_decision = 'approved' then coalesce("Cut_At", v_now) else "Cut_At" end,
    "Cut_By_User_ID" = case when v_decision = 'approved' then coalesce("Cut_By_User_ID", v_actor.user_id) else "Cut_By_User_ID" end,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
  returning * into v_submission;

  update public."Event_Attendees"
  set "Attendance_Status" = 'Present', "Updated_At" = v_now
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  select coalesce(jsonb_agg(to_jsonb(detail)), '[]'::jsonb) into v_details
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

revoke all on function public.staff_check_in_walk_in_attendee(integer, integer) from public, anon, authenticated;
grant execute on function public.staff_check_in_walk_in_attendee(integer, integer) to authenticated;
revoke all on function public.staff_create_walk_in_hair_submission(integer) from public, anon, authenticated;
grant execute on function public.staff_create_walk_in_hair_submission(integer) to authenticated;
revoke all on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text) from public, anon, authenticated;
grant execute on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
