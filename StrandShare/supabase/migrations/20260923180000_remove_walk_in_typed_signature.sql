begin;

-- Checkbox acceptance of the published Terms and Privacy Notice is the walk-in
-- consent mechanism. Keep p_consent_signer_name in the RPC signature for
-- compatibility with already-deployed clients, but no longer require or store it.
create or replace function public.submit_event_walk_in_registration(
  p_public_token uuid,
  p_email text,
  p_age smallint,
  p_full_name text default null,
  p_birthdate date default null,
  p_guardian_name text default null,
  p_guardian_relationship text default null,
  p_guardian_email text default null,
  p_consent_signer_name text default null,
  p_terms_accepted boolean default false,
  p_privacy_accepted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_intake jsonb;
  v_event public."Event_Requests"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(trim(coalesce(p_full_name, '')), '');
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_age smallint;
begin
  v_intake := public.get_public_event_walk_in_intake(p_public_token);
  if coalesce((v_intake->>'is_open')::boolean, false) is not true then
    raise exception '%', coalesce(v_intake->>'message', 'Walk-in registration is closed.');
  end if;
  if v_email = '' or v_email not like '%_@_%._%' then raise exception 'Enter a valid email address.'; end if;
  if p_birthdate is null then raise exception 'Birthdate is required.'; end if;
  v_age := extract(year from age(v_now::date, p_birthdate))::smallint;
  if p_birthdate > v_now::date or v_age not between 1 and 120 then
    raise exception 'Enter a valid birthdate for a donor between 1 and 120 years old.';
  end if;
  if not coalesce(p_terms_accepted, false) or not coalesce(p_privacy_accepted, false) then
    raise exception 'Accept the Terms and Conditions and Privacy Notice to continue.';
  end if;
  if v_age < 18 and (
    nullif(trim(coalesce(p_guardian_name, '')), '') is null or
    nullif(trim(coalesce(p_guardian_relationship, '')), '') is null or
    nullif(trim(coalesce(p_guardian_email, '')), '') is null
  ) then raise exception 'Guardian name, relationship, and email are required for donors under 18.'; end if;
  if v_age < 18 and lower(trim(p_guardian_email)) not like '%_@_%._%' then
    raise exception 'Enter a valid guardian email address.';
  end if;

  select * into v_event from public."Event_Requests" event
  where event."Event_Request_ID" = (v_intake->>'event_request_id')::integer for update;

  if exists (
    select 1 from public."Event_Attendees" attendee
    where attendee."Event_Request_ID" = v_event."Event_Request_ID"
      and attendee."Is_Walk_In" is true
      and lower(trim(coalesce(attendee."Walk_In_Email", ''))) = v_email
      and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
  ) then raise exception 'This email is already registered as a walk-in for this program.'; end if;

  insert into public."Event_Attendees" (
    "Event_Request_ID", "User_ID", "Walk_In_Full_Name", "Walk_In_Email",
    "Registration_Status", "Attendance_Status", "Attendee_Type", "Is_Walk_In",
    "Walk_In_Age", "Walk_In_Birthdate", "Guardian_Name", "Guardian_Relationship",
    "Guardian_Email", "Consent_Signer_Name", "Terms_Accepted_At", "Privacy_Accepted_At",
    "Consent_Version", "Walk_In_Registered_At", "RSVP_Scanned_At", "Created_At", "Updated_At"
  ) values (
    v_event."Event_Request_ID", null,
    coalesce(v_name, 'Walk-in Donor'), v_email, 'Registered', 'Not Marked', 'Donor', true,
    v_age, p_birthdate, nullif(trim(coalesce(p_guardian_name, '')), ''),
    nullif(trim(coalesce(p_guardian_relationship, '')), ''),
    nullif(lower(trim(coalesce(p_guardian_email, ''))), ''), null,
    v_now, v_now, coalesce(v_intake->>'consent_version', 'walk-in-consent-2026-09'),
    v_now, null, v_now, v_now
  ) returning * into v_attendee;

  perform public.enqueue_smtp_email_outbox(
    'walk_in_registered:' || v_attendee."Event_Attendee_ID"::text,
    'Event_Attendees', v_attendee."Event_Attendee_ID", 'walk_in_registration_received',
    v_email, 'Walk-in registration received - ' || coalesce(v_event."Event_Name", 'Donivra Program'),
    'walk_in_registration_received',
    jsonb_build_object('recipient_name', v_attendee."Walk_In_Full_Name", 'event_name', v_event."Event_Name",
      'event_request_id', v_event."Event_Request_ID", 'event_attendee_id', v_attendee."Event_Attendee_ID",
      'registered_at', v_now, 'waybill_code', v_attendee."Waybill_Code",
      'message', 'Your walk-in donor registration and consent were received. Staff will record and review the donated hair separately.'),
    null
  );

  return jsonb_build_object('event_attendee_id', v_attendee."Event_Attendee_ID",
    'waybill_code', v_attendee."Waybill_Code", 'event_name', v_event."Event_Name",
    'email', v_attendee."Walk_In_Email", 'registered_at', v_now);
end;
$fn$;

-- Walk-ins become Present only after Staff completes the manual Hair Check.
-- Keeping this replacement in the follow-up migration also repairs databases
-- where the original walk-in migration has already been applied.
create or replace function public.staff_save_walk_in_hair_review(
  p_event_request_id integer, p_submission_id integer, p_decision text,
  p_declared_length numeric default null, p_declared_color text default null,
  p_declared_texture text default null, p_declared_density text default null,
  p_declared_condition text default null, p_is_chemically_treated boolean default false,
  p_is_colored boolean default false, p_is_bleached boolean default false,
  p_is_rebonded boolean default false, p_detail_notes text default null,
  p_rejection_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_actor public.users%rowtype; v_submission public."Hair_Submissions"%rowtype;
  v_attendee public."Event_Attendees"%rowtype; v_decision text:=public.normalize_flow_key(p_decision);
  v_now timestamp without time zone:=timezone('Asia/Manila',now()); v_details jsonb;
begin
  select * into v_actor from public.users u where u.auth_user_id=auth.uid() and u.is_active is distinct from false limit 1;
  select * into v_submission from public."Hair_Submissions" s where s."Submission_ID"=p_submission_id and s."Event_Request_ID"=p_event_request_id and s."Is_Walk_In" is true for update;
  select * into v_attendee from public."Event_Attendees" a where a."Event_Attendee_ID"=v_submission."Event_Attendee_ID" and a."Is_Walk_In" is true for update;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role)<>'staff' or v_submission."Submission_ID" is null
    or not exists(select 1 from public."Event_Requests" e where e."Event_Request_ID"=p_event_request_id and e."Assigned_Staff_User_ID"=v_actor.user_id) then
    raise exception 'Only the assigned Staff member can review this walk-in donation.';
  end if;
  if v_decision not in ('approved','rejected') then raise exception 'Walk-in hair can only be accepted or rejected.'; end if;
  if p_declared_length is null or p_declared_length < 0 then raise exception 'Enter the measured hair length.'; end if;
  if nullif(trim(coalesce(p_declared_condition,'')),'') is null then raise exception 'Select the hair condition.'; end if;
  if not exists(select 1 from public."Hair_Submission_Images" image join public."Hair_Submission_Details" detail
    on detail."Submission_Detail_ID"=image."Submission_Detail_ID" where detail."Submission_ID"=p_submission_id) then
    raise exception 'Upload at least one clear hair photo before the final decision.';
  end if;
  if v_decision='rejected' and nullif(trim(coalesce(p_rejection_reason,'')),'') is null then raise exception 'A rejection reason is required.'; end if;
  if exists(select 1 from public."Hair_Submission_Details" d where d."Submission_ID"=p_submission_id and public.is_hair_detail_final_status(d."Status")) then
    raise exception 'This walk-in hair decision is already final.';
  end if;
  update public."Hair_Submission_Details" set "Declared_Length"=p_declared_length,
    "Declared_Color"=nullif(trim(coalesce(p_declared_color,'')),''),"Declared_Texture"=nullif(trim(coalesce(p_declared_texture,'')),''),
    "Declared_Density"=nullif(trim(coalesce(p_declared_density,'')),''),"Declared_Condition"=trim(p_declared_condition),
    "Is_Chemically_Treated"=coalesce(p_is_chemically_treated,false),"Is_Colored"=coalesce(p_is_colored,false),
    "Is_Bleached"=coalesce(p_is_bleached,false),"Is_Rebonded"=coalesce(p_is_rebonded,false),
    "Detail_Notes"=nullif(trim(coalesce(p_detail_notes,'')),''),"Status"=case when v_decision='approved' then 'Approved' else 'Rejected' end,
    "Rejection_Reason"=case when v_decision='rejected' then trim(p_rejection_reason) end,"Updated_By"=v_actor.user_id,"Updated_At"=v_now
  where "Submission_ID"=p_submission_id;
  update public."Hair_Submissions" set "Status"=case when v_decision='approved' then 'Cut' else 'Cancelled' end,
    "Cut_At"=case when v_decision='approved' then coalesce("Cut_At",v_now) else "Cut_At" end,
    "Cut_By_User_ID"=case when v_decision='approved' then coalesce("Cut_By_User_ID",v_actor.user_id) else "Cut_By_User_ID" end,"Updated_At"=v_now
  where "Submission_ID"=p_submission_id returning * into v_submission;
  update public."Event_Attendees" set "Attendance_Status"='Present',
    "RSVP_Scanned_At"=coalesce("RSVP_Scanned_At",v_now),
    "RSVP_Scanned_By"=coalesce("RSVP_Scanned_By",v_actor.user_id),"Updated_At"=v_now
  where "Event_Attendee_ID"=v_attendee."Event_Attendee_ID"
  returning * into v_attendee;
  select coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) into v_details from public."Hair_Submission_Details" d where d."Submission_ID"=p_submission_id;
  perform public.enqueue_smtp_email_outbox('walk_in_hair_'||v_decision||':'||p_submission_id,'Hair_Submissions',p_submission_id,
    case when v_decision='approved' then 'walk_in_hair_accepted' else 'walk_in_hair_rejected' end,
    v_attendee."Walk_In_Email",case when v_decision='approved' then 'Donated hair accepted' else 'Hair review result' end,
    case when v_decision='approved' then 'walk_in_hair_accepted' else 'walk_in_hair_rejected' end,
    jsonb_build_object('recipient_name',v_attendee."Walk_In_Full_Name",'decision',case when v_decision='approved' then 'Accepted' else 'Rejected' end,
      'reason',case when v_decision='rejected' then trim(p_rejection_reason) else null end,'waybill_code',v_attendee."Waybill_Code"),v_actor.user_id);
  return jsonb_build_object('decision',case when v_decision='approved' then 'Approved' else 'Rejected' end,'attendee',to_jsonb(v_attendee),'submission',to_jsonb(v_submission),'details',v_details);
end;$fn$;

revoke all on function public.submit_event_walk_in_registration(uuid,text,smallint,text,date,text,text,text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.submit_event_walk_in_registration(uuid,text,smallint,text,date,text,text,text,text,boolean,boolean) to anon, authenticated;
revoke all on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text) from public, anon, authenticated;
grant execute on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
