begin;

-- Event-scoped public walk-in intake. Times are compared as Manila wall-clock
-- timestamps because Event_Requests.Start_Date/End_Date use that convention.
create table if not exists public."Event_Walk_In_Intake" (
  "Event_Request_ID" integer primary key references public."Event_Requests"("Event_Request_ID") on delete cascade,
  "Public_Token" uuid not null default gen_random_uuid() unique,
  "Is_Open" boolean not null default false,
  "Opened_At" timestamp without time zone,
  "Closed_At" timestamp without time zone,
  "Updated_By_User_ID" integer references public.users(user_id) on delete set null,
  "Created_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  "Updated_At" timestamp without time zone not null default timezone('Asia/Manila', now())
);

alter table public."Event_Walk_In_Intake" enable row level security;
revoke all on public."Event_Walk_In_Intake" from public, anon, authenticated;

alter table public."Event_Attendees"
  add column if not exists "Is_Walk_In" boolean not null default false,
  add column if not exists "Walk_In_Full_Name" text,
  add column if not exists "Walk_In_Email" text,
  add column if not exists "Walk_In_Age" smallint,
  add column if not exists "Walk_In_Birthdate" date,
  add column if not exists "Guardian_Name" text,
  add column if not exists "Guardian_Relationship" text,
  add column if not exists "Guardian_Email" text,
  add column if not exists "Consent_Signer_Name" text,
  add column if not exists "Terms_Accepted_At" timestamp without time zone,
  add column if not exists "Privacy_Accepted_At" timestamp without time zone,
  add column if not exists "Consent_Version" text,
  add column if not exists "Walk_In_Registered_At" timestamp without time zone;

alter table public."Event_Attendees" drop constraint if exists event_attendees_walk_in_age_check;
alter table public."Event_Attendees" add constraint event_attendees_walk_in_age_check
  check ("Walk_In_Age" is null or "Walk_In_Age" between 1 and 120);

create unique index if not exists idx_event_attendees_walk_in_email
  on public."Event_Attendees" ("Event_Request_ID", lower("Walk_In_Email"))
  where "Is_Walk_In" is true and public.normalize_flow_key("Registration_Status") <> 'cancelled';

-- A walk-in intentionally has no application account. The attendee link is
-- the donor identity used throughout inventory and lifecycle notifications.
alter table public."Hair_Submissions" alter column "User_ID" drop not null;
alter table public."Cut_Hair_Inventory" alter column "Donor_User_ID" drop not null;
alter table public."Hair_Submissions" add column if not exists "Is_Walk_In" boolean not null default false;

-- Account submissions still require an eligible AI screening. Event walk-ins
-- deliberately have neither an account nor AI screening; Staff performs the
-- complete manual check after the attendee presents the QR waybill.
drop trigger if exists trg_guard_hair_submission_eligible_screening on public."Hair_Submissions";
create trigger trg_guard_hair_submission_eligible_screening
before insert or update of "AI_Screening_ID", "User_ID" on public."Hair_Submissions"
for each row
when (coalesce(new."Is_Walk_In", false) = false)
execute function public.guard_hair_submission_eligible_screening();

-- Assigned Staff uploads the on-site evidence photos through Supabase Storage.
-- The bucket is private; existing specialist/admin read access remains intact.
drop policy if exists hair_submissions_insert_staff on storage.objects;
create policy hair_submissions_insert_staff on storage.objects
for insert to authenticated with check (
  bucket_id = 'hair-submissions'
  and exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) = 'staff'
  )
);

drop policy if exists hair_submissions_select_staff on storage.objects;
create policy hair_submissions_select_staff on storage.objects
for select to authenticated using (
  bucket_id = 'hair-submissions'
  and exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) = 'staff'
  )
);

create or replace function public.get_public_event_walk_in_intake(p_public_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_event public."Event_Requests"%rowtype;
  v_intake public."Event_Walk_In_Intake"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_available boolean := false;
  v_message text;
begin
  select intake.* into v_intake
  from public."Event_Walk_In_Intake" intake
  where intake."Public_Token" = p_public_token;

  if v_intake."Event_Request_ID" is null then
    return jsonb_build_object('found', false, 'is_open', false, 'message', 'This walk-in link is invalid.');
  end if;

  select * into v_event from public."Event_Requests" event
  where event."Event_Request_ID" = v_intake."Event_Request_ID";

  v_available := v_intake."Is_Open"
    and public.normalize_flow_key(v_event."Status") = 'approved'
    and v_event."Cancelled_At" is null
    and v_event."Start_Date" is not null
    and v_now >= v_event."Start_Date"
    and v_now <= coalesce(v_event."End_Date", v_event."Start_Date");

  v_message := case
    when public.normalize_flow_key(v_event."Status") <> 'approved' or v_event."Cancelled_At" is not null
      then 'Walk-in registration is unavailable because this program is no longer active.'
    when v_event."Start_Date" is null or v_now < v_event."Start_Date"
      then 'Walk-in registration opens when the program starts.'
    when v_now > coalesce(v_event."End_Date", v_event."Start_Date")
      then 'Walk-in registration has closed because the program has ended.'
    when not v_intake."Is_Open" then 'Walk-in registration is currently closed by the assigned Staff member.'
    else 'Walk-in registration is open.'
  end;

  return jsonb_build_object(
    'found', true, 'is_open', v_available, 'message', v_message,
    'event_request_id', v_event."Event_Request_ID",
    'event_name', coalesce(v_event."Event_Name", 'Donivra Program'),
    'start_date', v_event."Start_Date", 'end_date', v_event."End_Date",
    'venue_name', coalesce(v_event."Venue_Name", ''),
    'venue_address', nullif(trim(concat_ws(', ', v_event."Street", v_event."Barangay",
      v_event."City_Municipality", v_event."Province", v_event."Region", v_event."Country")), ''),
    'consent_version', 'walk-in-consent-2026-09'
  );
end;
$fn$;

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

create or replace function public.staff_get_event_walk_in_intake(p_event_request_id integer)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_actor public.users%rowtype; v_event public."Event_Requests"%rowtype; v_intake public."Event_Walk_In_Intake"%rowtype;
begin
  select * into v_actor from public.users u where u.auth_user_id=auth.uid() and u.is_active is distinct from false limit 1;
  select * into v_event from public."Event_Requests" e where e."Event_Request_ID"=p_event_request_id;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role)<>'staff' or v_event."Assigned_Staff_User_ID" is distinct from v_actor.user_id then
    raise exception 'Only the assigned Staff member can manage walk-in intake.';
  end if;
  insert into public."Event_Walk_In_Intake"("Event_Request_ID") values(p_event_request_id)
  on conflict ("Event_Request_ID") do nothing;
  select * into v_intake from public."Event_Walk_In_Intake" i where i."Event_Request_ID"=p_event_request_id;
  return to_jsonb(v_intake) || public.get_public_event_walk_in_intake(v_intake."Public_Token");
end;$fn$;

create or replace function public.staff_set_event_walk_in_intake(p_event_request_id integer, p_is_open boolean)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_actor public.users%rowtype; v_event public."Event_Requests"%rowtype; v_intake public."Event_Walk_In_Intake"%rowtype;
  v_now timestamp without time zone:=timezone('Asia/Manila',now());
begin
  select * into v_actor from public.users u where u.auth_user_id=auth.uid() and u.is_active is distinct from false limit 1;
  select * into v_event from public."Event_Requests" e where e."Event_Request_ID"=p_event_request_id for update;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role)<>'staff' or v_event."Assigned_Staff_User_ID" is distinct from v_actor.user_id then
    raise exception 'Only the assigned Staff member can manage walk-in intake.';
  end if;
  if p_is_open and (public.normalize_flow_key(v_event."Status")<>'approved' or v_event."Cancelled_At" is not null
    or v_now < v_event."Start_Date" or v_now > coalesce(v_event."End_Date",v_event."Start_Date")) then
    raise exception 'Walk-in intake can open only during the active program schedule (Manila time).';
  end if;
  insert into public."Event_Walk_In_Intake"("Event_Request_ID","Is_Open","Opened_At","Closed_At","Updated_By_User_ID","Updated_At")
  values(p_event_request_id,p_is_open,case when p_is_open then v_now end,case when not p_is_open then v_now end,v_actor.user_id,v_now)
  on conflict ("Event_Request_ID") do update set "Is_Open"=excluded."Is_Open",
    "Opened_At"=case when excluded."Is_Open" then v_now else public."Event_Walk_In_Intake"."Opened_At" end,
    "Closed_At"=case when excluded."Is_Open" then null else v_now end,
    "Updated_By_User_ID"=v_actor.user_id,"Updated_At"=v_now returning * into v_intake;
  return to_jsonb(v_intake) || public.get_public_event_walk_in_intake(v_intake."Public_Token");
end;$fn$;

create or replace function public.staff_create_walk_in_hair_submission(p_event_attendee_id integer)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_actor public.users%rowtype; v_attendee public."Event_Attendees"%rowtype;
  v_submission public."Hair_Submissions"%rowtype; v_detail public."Hair_Submission_Details"%rowtype;
  v_now timestamp without time zone:=timezone('Asia/Manila',now());
begin
  select * into v_actor from public.users u where u.auth_user_id=auth.uid() and u.is_active is distinct from false limit 1;
  select * into v_attendee from public."Event_Attendees" a where a."Event_Attendee_ID"=p_event_attendee_id for update;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role)<>'staff' or v_attendee."Is_Walk_In" is not true
    or not exists(select 1 from public."Event_Requests" e where e."Event_Request_ID"=v_attendee."Event_Request_ID" and e."Assigned_Staff_User_ID"=v_actor.user_id) then
    raise exception 'Only the assigned Staff member can create this walk-in hair submission.';
  end if;
  select * into v_submission from public."Hair_Submissions" s where s."Event_Attendee_ID"=p_event_attendee_id order by s."Submission_ID" desc limit 1;
  if v_submission."Submission_ID" is null then
    insert into public."Hair_Submissions"("User_ID","Status","Created_At","Updated_At","From_Event","Event_Request_ID","Event_Attendee_ID","Is_Walk_In")
    values(null,'Pending',v_now,v_now,true,v_attendee."Event_Request_ID",v_attendee."Event_Attendee_ID",true) returning * into v_submission;
    insert into public."Hair_Submission_Details"("Submission_ID","Status","Updated_By","Created_At","Updated_At")
    values(v_submission."Submission_ID",'Pending',v_actor.user_id,v_now,v_now) returning * into v_detail;
  else select * into v_detail from public."Hair_Submission_Details" d where d."Submission_ID"=v_submission."Submission_ID" order by d."Submission_Detail_ID" limit 1;
  end if;
  return jsonb_build_object('attendee',to_jsonb(v_attendee),'submission',to_jsonb(v_submission),'details',jsonb_build_array(to_jsonb(v_detail)),'waybill_code',v_attendee."Waybill_Code");
end;$fn$;

-- Make the existing Staff detail and decision RPCs resolve walk-ins by attendee
-- through a transaction-local user link is intentionally avoided. Dedicated
-- RPCs preserve the null User_ID invariant and enforce Accept/Reject only.
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
  -- Registration records consent and queues the donor for Staff review. Mark
  -- attendance only after that review is complete so the existing Hair Check
  -- gate does not reject a new walk-in attendee.
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

-- Do not create AI-vs-human comparison rows for manual walk-in submissions.
create or replace function public.capture_hair_ai_review_baseline()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_submission public."Hair_Submissions"%rowtype;
  v_screening public."AI_Screenings"%rowtype;
  v_submission_id integer := new."Submission_ID";
  v_values jsonb;
  v_is_ai boolean := false;
begin
  select * into v_submission from public."Hair_Submissions" submission
  where submission."Submission_ID" = v_submission_id;
  if v_submission."Is_Walk_In" is true then return new; end if;

  select * into v_screening from public."AI_Screenings" screening
  where screening."AI_Screening_ID" = v_submission."AI_Screening_ID"
     or screening."Submission_ID" = v_submission_id
  order by case when screening."AI_Screening_ID" = v_submission."AI_Screening_ID" then 0 else 1 end,
    screening."Created_At" desc, screening."AI_Screening_ID" desc
  limit 1;

  if v_screening."AI_Screening_ID" is not null then
    v_is_ai := true;
    v_values := jsonb_build_object(
      'length',v_screening."Estimated_Length",'color',v_screening."Detected_Color",
      'texture',v_screening."Detected_Texture",'density',v_screening."Detected_Density",
      'condition',v_screening."Detected_Condition",'confidenceScore',v_screening."Confidence_Score",
      'decision',v_screening."Decision",'summary',v_screening."Summary",
      'visibleDamageNotes',v_screening."Visible_Damage_Notes");
  else
    v_values := jsonb_build_object(
      'length',new."Declared_Length",'color',new."Declared_Color",
      'texture',new."Declared_Texture",'density',new."Declared_Density",
      'condition',new."Declared_Condition");
  end if;

  insert into public."Hair_AI_Review_Comparisons"(
    "Submission_Detail_ID","Submission_ID","Event_Request_ID","AI_Values","Is_AI_Source"
  ) values (
    new."Submission_Detail_ID",v_submission_id,v_submission."Event_Request_ID",v_values,v_is_ai
  ) on conflict ("Submission_Detail_ID") do update set
    "AI_Values"=excluded."AI_Values","Is_AI_Source"=true,
    "Event_Request_ID"=excluded."Event_Request_ID","Updated_At"=now()
  where public."Hair_AI_Review_Comparisons"."Reviewed_At" is null
    and not public."Hair_AI_Review_Comparisons"."Is_AI_Source"
    and excluded."Is_AI_Source";
  return new;
end;$fn$;

-- Queue donor-safe lifecycle notices. No patient/request identity is included.
create or replace function public.queue_walk_in_donor_lifecycle_email()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_submission public."Hair_Submissions"%rowtype; v_attendee record;
  v_stage text; v_source_id integer; v_subject text;
begin
  if tg_table_name='Hair_Submissions' then
    if new."Bundle_ID" is null or new."Bundle_ID" is not distinct from old."Bundle_ID" then return new; end if;
    v_submission:=new; v_stage:='bundled'; v_source_id:=new."Bundle_ID"; v_subject:='Your donated hair was added to a bundle';
  elsif tg_table_name='Wigs' then
    if new."Bundle_ID" is null or (tg_op='UPDATE' and new."Bundle_ID" is not distinct from old."Bundle_ID" and new."Completed_At" is not distinct from old."Completed_At") then return new; end if;
    v_stage:='wig_created'; v_source_id:=new."Wig_ID"; v_subject:='A wig was created from donated hair';
  else return new; end if;
  for v_submission in select s.* from public."Hair_Submissions" s where (tg_table_name='Hair_Submissions' and s."Submission_ID"=new."Submission_ID") or (tg_table_name='Wigs' and s."Bundle_ID"=new."Bundle_ID") loop
    select a.*,coalesce(nullif(trim(a."Walk_In_Email"),''),nullif(trim(u.email),'')) as recipient_email,
      coalesce(nullif(trim(a."Walk_In_Full_Name"),''),nullif(trim(concat_ws(' ',d.first_name,d.middle_name,d.last_name,d.suffix)),''),nullif(trim(u.email),''),'Donor') as recipient_name
    into v_attendee from public."Event_Attendees" a left join public.users u on u.user_id=a."User_ID"
      left join public.user_details d on d.user_id=a."User_ID" where a."Event_Attendee_ID"=v_submission."Event_Attendee_ID";
    if nullif(trim(coalesce(v_attendee.recipient_email,'')),'') is null then continue; end if;
    perform public.enqueue_smtp_email_outbox('donor_'||v_stage||':'||v_submission."Submission_ID",tg_table_name,v_source_id,'walk_in_'||v_stage,
      v_attendee.recipient_email,v_subject,'walk_in_'||v_stage,jsonb_build_object('recipient_name',v_attendee.recipient_name,'waybill_code',v_attendee."Waybill_Code",
      'message',case when v_stage='bundled' then 'Your accepted hair has been added to a production bundle.' else 'A wig has been created using the bundle that includes your donated hair.' end),null);
  end loop;
  return new;
end;$fn$;

create or replace function public.queue_registered_donor_hair_review_email()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare s public."Hair_Submissions"%rowtype; a record; v_status text:=public.normalize_flow_key(new."Status"); v_type text;
begin
  if not public.is_hair_detail_final_status(new."Status") or public.is_hair_detail_final_status(old."Status") then return new; end if;
  select * into s from public."Hair_Submissions" submission where submission."Submission_ID"=new."Submission_ID";
  if s."Submission_ID" is null or s."Is_Walk_In" is true then return new; end if;
  select attendee.*,u.email as recipient_email,
    coalesce(nullif(trim(concat_ws(' ',d.first_name,d.middle_name,d.last_name,d.suffix)),''),nullif(trim(u.email),''),'Donor') as recipient_name
  into a from public."Event_Attendees" attendee join public.users u on u.user_id=attendee."User_ID"
    left join public.user_details d on d.user_id=attendee."User_ID" where attendee."Event_Attendee_ID"=s."Event_Attendee_ID";
  if nullif(trim(coalesce(a.recipient_email,'')),'') is null then return new; end if;
  v_type:=case when v_status='approved' then 'walk_in_hair_accepted' else 'walk_in_hair_rejected' end;
  perform public.enqueue_smtp_email_outbox('donor_hair_review:'||s."Submission_ID",'Hair_Submissions',s."Submission_ID",v_type,
    a.recipient_email,case when v_status='approved' then 'Donated hair accepted' else 'Hair review result' end,v_type,
    jsonb_build_object('recipient_name',a.recipient_name,'decision',case when v_status='approved' then 'Accepted' else 'Rejected' end,
      'reason',new."Rejection_Reason",'waybill_code',a."Waybill_Code"),new."Updated_By");
  return new;
end;$fn$;

drop trigger if exists trg_registered_donor_hair_review_email on public."Hair_Submission_Details";
create trigger trg_registered_donor_hair_review_email after update of "Status" on public."Hair_Submission_Details"
for each row execute function public.queue_registered_donor_hair_review_email();

drop trigger if exists trg_walk_in_bundled_email on public."Hair_Submissions";
create trigger trg_walk_in_bundled_email after update of "Bundle_ID" on public."Hair_Submissions" for each row execute function public.queue_walk_in_donor_lifecycle_email();
drop trigger if exists trg_walk_in_wig_created_email on public."Wigs";
create trigger trg_walk_in_wig_created_email after insert or update of "Bundle_ID","Completed_At" on public."Wigs" for each row execute function public.queue_walk_in_donor_lifecycle_email();

create or replace function public.queue_walk_in_bundle_assignment_email()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare s record; a record;
begin
  if new."Allocated_To_Wig_Request_ID" is null or new."Allocated_To_Wig_Request_ID" is not distinct from old."Allocated_To_Wig_Request_ID" then return new; end if;
  for s in select * from public."Hair_Submissions" x where x."Bundle_ID"=new."Bundle_ID" loop
    select x.*,coalesce(nullif(trim(x."Walk_In_Email"),''),nullif(trim(u.email),'')) recipient_email,
      coalesce(nullif(trim(x."Walk_In_Full_Name"),''),nullif(trim(concat_ws(' ',d.first_name,d.middle_name,d.last_name,d.suffix)),''),u.email,'Donor') recipient_name
    into a from public."Event_Attendees" x left join public.users u on u.user_id=x."User_ID" left join public.user_details d on d.user_id=x."User_ID" where x."Event_Attendee_ID"=s."Event_Attendee_ID";
    if nullif(trim(coalesce(a.recipient_email,'')),'') is null then continue; end if;
    perform public.enqueue_smtp_email_outbox('donor_wig_assigned:'||s."Submission_ID",'Hair_Submission_Bundles',new."Bundle_ID",'walk_in_wig_assigned',
      a.recipient_email,'A wig containing your donated hair was assigned','walk_in_wig_assigned',jsonb_build_object('recipient_name',a.recipient_name,'waybill_code',a."Waybill_Code",
      'message','A wig made from a bundle containing your donated hair has been assigned. Recipient information remains private.'),null);
  end loop; return new;
end;$fn$;
drop trigger if exists trg_walk_in_wig_assigned_email on public."Hair_Submission_Bundles";
create trigger trg_walk_in_wig_assigned_email after update of "Allocated_To_Wig_Request_ID" on public."Hair_Submission_Bundles" for each row execute function public.queue_walk_in_bundle_assignment_email();

create or replace function public.queue_walk_in_wig_released_email()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare s record; a record;
begin
  if public.normalize_flow_key(new."Status")<>'released' or public.normalize_flow_key(old."Status")='released' then return new; end if;
  for s in select hs.* from public."Hair_Submission_Bundles" b join public."Hair_Submissions" hs on hs."Bundle_ID"=b."Bundle_ID"
    where b."Allocated_To_Wig_Request_ID"=new."Req_ID" loop
    select x.*,coalesce(nullif(trim(x."Walk_In_Email"),''),nullif(trim(u.email),'')) recipient_email,
      coalesce(nullif(trim(x."Walk_In_Full_Name"),''),nullif(trim(concat_ws(' ',d.first_name,d.middle_name,d.last_name,d.suffix)),''),u.email,'Donor') recipient_name
    into a from public."Event_Attendees" x left join public.users u on u.user_id=x."User_ID" left join public.user_details d on d.user_id=x."User_ID" where x."Event_Attendee_ID"=s."Event_Attendee_ID";
    if nullif(trim(coalesce(a.recipient_email,'')),'') is null then continue; end if;
    perform public.enqueue_smtp_email_outbox('donor_wig_released:'||s."Submission_ID",'Wig_Requests',new."Req_ID",'walk_in_wig_released',
      a.recipient_email,'A wig containing your donated hair was released','walk_in_wig_released',jsonb_build_object('recipient_name',a.recipient_name,'waybill_code',a."Waybill_Code",
      'message','A wig made from a bundle containing your donated hair has been released. Recipient information remains private.'),null);
  end loop; return new;
end;$fn$;
drop trigger if exists trg_walk_in_wig_released_email on public."Wig_Requests";
create trigger trg_walk_in_wig_released_email after update of "Status" on public."Wig_Requests" for each row execute function public.queue_walk_in_wig_released_email();

-- Registered-account lifecycle SQL joins users, so queue the equivalent
-- program messages separately for unregistered walk-in attendees.
create or replace function public.queue_walk_in_program_lifecycle_email()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare a record; v_status text:=public.normalize_flow_key(new."Status"); v_old_status text:=public.normalize_flow_key(old."Status");
  v_type text; v_template text; v_subject text;
begin
  if v_status=v_old_status or v_status not in ('ended','successful','cancelled') then return new; end if;
  v_type:=case when v_status='ended' then 'program_ended' when v_status='successful' then 'program_successful_attendee' else 'program_cancelled_attendee' end;
  v_template:=v_type;
  v_subject:=case when v_status='ended' then 'Program Ended - '||coalesce(new."Event_Name",'Donivra Program')
    when v_status='successful' then 'Your Participation Certificate - '||coalesce(new."Event_Name",'Donivra Program')
    else 'Program Cancelled - '||coalesce(new."Event_Name",'Donivra Program') end;
  for a in select attendee.* from public."Event_Attendees" attendee where attendee."Event_Request_ID"=new."Event_Request_ID"
    and attendee."Is_Walk_In" is true and public.normalize_flow_key(attendee."Registration_Status")<>'cancelled'
    and nullif(trim(coalesce(attendee."Walk_In_Email",'')),'') is not null loop
    perform public.enqueue_smtp_email_outbox('walk_in_program_'||v_status||':'||new."Event_Request_ID"||':'||a."Event_Attendee_ID",
      'Event_Requests',new."Event_Request_ID",v_type,a."Walk_In_Email",v_subject,v_template,
      jsonb_build_object('recipient_name',a."Walk_In_Full_Name",'recipient_role','Walk-in Donor','event_name',new."Event_Name",
        'start_date',new."Start_Date",'end_date',new."End_Date",'venue_name',coalesce(new."Venue_Name",''),
        'cancellation_category',new."Cancellation_Category",'cancellation_explanation',new."Cancellation_Explanation",
        'certificate_kind',case when v_status='successful' then 'participant' else null end,
        'certificate_id',case when v_status='successful' then 'DPA-'||new."Event_Request_ID"||'-'||a."Event_Attendee_ID" else null end,
        'certificate_issued_at',case when v_status='successful' then coalesce(new."Successful_At",timezone('Asia/Manila',now())) else null end),
      case when v_status='successful' then new."Successful_By_User_ID" else null end);
  end loop; return new;
end;$fn$;
drop trigger if exists trg_walk_in_program_lifecycle_email on public."Event_Requests";
create trigger trg_walk_in_program_lifecycle_email after update of "Status" on public."Event_Requests" for each row execute function public.queue_walk_in_program_lifecycle_email();

-- Extend the existing SMTP allow-list.
alter table public."SMTP_Email_Outbox" drop constraint if exists smtp_email_outbox_notification_type_check;
alter table public."SMTP_Email_Outbox" add constraint smtp_email_outbox_notification_type_check check (
  public.normalize_flow_key(coalesce("Notification_Type",'')) = any(array[
    'eventapplicationreceived','staffrejected','staffendorsedpendingadmin','adminapproved','adminrejected',
    'partnerhospitalapproved','partnerhospitalrejected','partnerhospitalaccessenabled','partnerhospitalaccessdisabled',
    'eventautocancelled','patientapplicationotp','patientapplicationsubmitted','patientapplicationaccepted','patientapplicationrejected',
    'programended','programsuccessfulapplicant','programsuccessfulattendee','programcancelledapplicant','programcancelledattendee',
    'walkinregistrationreceived','walkinhairaccepted','walkinhairrejected','walkinbundled','walkinwigcreated','walkinwigassigned','walkinwigreleased'
  ]::text[])
);

revoke all on function public.get_public_event_walk_in_intake(uuid) from public, anon, authenticated;
revoke all on function public.submit_event_walk_in_registration(uuid,text,smallint,text,date,text,text,text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.get_public_event_walk_in_intake(uuid) to anon, authenticated;
grant execute on function public.submit_event_walk_in_registration(uuid,text,smallint,text,date,text,text,text,text,boolean,boolean) to anon, authenticated;
grant execute on function public.staff_get_event_walk_in_intake(integer) to authenticated;
grant execute on function public.staff_set_event_walk_in_intake(integer,boolean) to authenticated;
grant execute on function public.staff_create_walk_in_hair_submission(integer) to authenticated;
grant execute on function public.staff_save_walk_in_hair_review(integer,integer,text,numeric,text,text,text,text,boolean,boolean,boolean,boolean,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
