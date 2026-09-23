begin;

-- The first RSVP scan is single-use for public walk-ins. A repeated scan is
-- blocked rather than silently rewriting Updated_At or presenting it as a new
-- check-in. Registered attendees continue through their existing scanner RPC.
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
  if exists (
    select 1
    from public."Hair_Submissions" submission
    left join public."Hair_Submission_Details" detail
      on detail."Submission_ID" = submission."Submission_ID"
    where submission."Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
      and (
        public.normalize_flow_key(submission."Status") in ('cut', 'cancelled', 'wiginproduction', 'wigcreated')
        or public.is_hair_detail_final_status(detail."Status")
      )
  ) then
    raise exception 'This walk-in donation is already completed. Its QR cannot be scanned again.';
  end if;
  if public.normalize_flow_key(v_attendee."Attendance_Status") = 'present'
     and v_attendee."RSVP_Scanned_At" is not null then
    raise exception 'RSVP Check-in is already complete. Use Hair Outcome Review for the second scan.';
  end if;

  update public."Event_Attendees"
  set
    "Attendance_Status" = 'Present',
    "RSVP_Scanned_At" = v_now,
    "RSVP_Scanned_By" = v_actor.user_id,
    "Updated_At" = v_now
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'waybill_code', v_attendee."Waybill_Code",
    'already_checked_in', false
  );
end;
$fn$;

-- The second scan may resume a pending assessment, but can never reopen an
-- Approved/Rejected detail or a Cut/Cancelled submission.
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

-- Inventory needs the walk-in identity fallback without granting broad direct
-- access to Event_Attendees. Registered donor identity still comes from
-- user_details in the existing UI.
create or replace function public.get_cut_hair_inventory_attendee_context(
  p_event_attendee_ids integer[]
)
returns table (
  event_attendee_id integer,
  event_request_id integer,
  user_id integer,
  waybill_code text,
  is_walk_in boolean,
  walk_in_full_name text,
  walk_in_email text
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_role_key text;
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  v_role_key := public.normalize_app_role(v_actor.role);
  if v_actor.user_id is null or v_role_key not in ('admin', 'staff', 'specialist') then
    raise exception 'You are not authorized to view cut-hair inventory attendee details.';
  end if;

  return query
  select distinct
    attendee."Event_Attendee_ID",
    attendee."Event_Request_ID",
    attendee."User_ID",
    nullif(upper(trim(coalesce(attendee."Waybill_Code", ''))), '')::text,
    coalesce(attendee."Is_Walk_In", false),
    nullif(trim(coalesce(attendee."Walk_In_Full_Name", '')), '')::text,
    nullif(lower(trim(coalesce(attendee."Walk_In_Email", ''))), '')::text
  from public."Event_Attendees" attendee
  join public."Cut_Hair_Inventory" inventory
    on inventory."Event_Attendee_ID" = attendee."Event_Attendee_ID"
  where attendee."Event_Attendee_ID" = any(coalesce(p_event_attendee_ids, array[]::integer[]))
    and (
      v_role_key in ('admin', 'specialist')
      or exists (
        select 1 from public."Event_Requests" event
        where event."Event_Request_ID" = attendee."Event_Request_ID"
          and event."Assigned_Staff_User_ID" = v_actor.user_id
      )
    );
end;
$fn$;

revoke all on function public.staff_check_in_walk_in_attendee(integer, integer) from public, anon, authenticated;
grant execute on function public.staff_check_in_walk_in_attendee(integer, integer) to authenticated;
revoke all on function public.staff_create_walk_in_hair_submission(integer) from public, anon, authenticated;
grant execute on function public.staff_create_walk_in_hair_submission(integer) to authenticated;
revoke all on function public.get_cut_hair_inventory_attendee_context(integer[]) from public, anon, authenticated;
grant execute on function public.get_cut_hair_inventory_attendee_context(integer[]) to authenticated;

notify pgrst, 'reload schema';
commit;
