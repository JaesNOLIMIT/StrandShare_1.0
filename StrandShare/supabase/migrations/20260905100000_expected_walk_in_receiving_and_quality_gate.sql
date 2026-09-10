begin;

-- Expected walk-in arrival is an estimate, not an appointment slot.
alter table public."Hair_Submission_Logistics"
  add column if not exists "Expected_Dropoff_Date" date,
  add column if not exists "Expected_Arrival_Time" time without time zone,
  add column if not exists "Checked_In_At" timestamp without time zone,
  add column if not exists "Completed_At" timestamp without time zone,
  add column if not exists "Cancelled_At" timestamp without time zone,
  add column if not exists "Cancellation_Source" text,
  add column if not exists "Cancellation_Reason" text;

alter table public."Hair_Submission_Logistics"
  drop constraint if exists hair_submission_logistics_cancellation_source_check;
alter table public."Hair_Submission_Logistics"
  add constraint hair_submission_logistics_cancellation_source_check
  check ("Cancellation_Source" is null or "Cancellation_Source" in ('Donor', 'Sender', 'Staff'));

create index if not exists idx_hair_logistics_expected_walk_ins
  on public."Hair_Submission_Logistics" ("Expected_Dropoff_Date", "Expected_Arrival_Time")
  where "Logistics_Type" = 'Walk-in Drop-off';

-- Preserve existing walk-in records created by the older appointment flow.
update public."Hair_Submission_Logistics" logistics
set
  "Expected_Dropoff_Date" = coalesce(logistics."Expected_Dropoff_Date", appointment."Appointment_Start_At"::date),
  "Expected_Arrival_Time" = coalesce(logistics."Expected_Arrival_Time", appointment."Appointment_Start_At"::time),
  "Checked_In_At" = coalesce(logistics."Checked_In_At", appointment."Checked_In_At"),
  "Completed_At" = coalesce(logistics."Completed_At", appointment."Completed_At"),
  "Cancelled_At" = coalesce(logistics."Cancelled_At", appointment."Cancelled_At"),
  "Cancellation_Reason" = coalesce(logistics."Cancellation_Reason", appointment."Cancellation_Reason"),
  "Dropoff_Status" = case
    when appointment."Status" in ('Confirmed', 'Rescheduled') then 'Expected'
    else appointment."Status"
  end,
  "Updated_At" = timezone('Asia/Manila', now())
from public."Salon_Donation_Appointments" appointment
where appointment."Hair_Submission_ID" = logistics."Submission_ID"
  and logistics."Logistics_Type" = 'Walk-in Drop-off';

update public."Hair_Submission_Logistics"
set "Dropoff_Status" = 'Expected', "Updated_At" = timezone('Asia/Manila', now())
where "Logistics_Type" = 'Walk-in Drop-off'
  and public.normalize_flow_key(coalesce("Dropoff_Status", '')) in ('scheduled', 'confirmed', 'rescheduled');

-- Pending is now meaningful for non-event hair: it has been created but the
-- physical hair has not yet been received. The old trigger changed it to Cut
-- immediately and therefore made Quality Check available too soon.
drop trigger if exists trg_normalize_non_event_submission_as_cut on public."Hair_Submissions";

create or replace function public.validate_walk_in_expected_arrival(
  p_expected_date date,
  p_expected_time time without time zone
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := timezone('Asia/Manila', now())::date;
  v_hours public."Salon_Operating_Hours"%rowtype;
  v_override public."Salon_Schedule_Overrides"%rowtype;
  v_open time;
  v_close time;
  v_break_start time;
  v_break_end time;
  v_min_days integer;
  v_max_days integer;
begin
  if p_expected_date is null or p_expected_time is null then
    raise exception 'Expected drop-off date and arrival time are required.';
  end if;

  select * into v_hours
  from public."Salon_Operating_Hours"
  where "Day_Group" = case when extract(isodow from p_expected_date) between 1 and 5 then 'Weekday' else 'Weekend' end
  limit 1;
  if v_hours."Operating_Hours_ID" is null then raise exception 'Salon operating hours are not configured.'; end if;

  v_min_days := coalesce(v_hours."Minimum_Booking_Notice_Days", 0);
  v_max_days := coalesce(v_hours."Maximum_Booking_Days", 30);
  if p_expected_date < v_today + v_min_days then
    raise exception 'Expected arrival must be at least % day(s) from today.', v_min_days;
  end if;
  if p_expected_date > v_today + v_max_days then
    raise exception 'Expected arrival may be selected only % days ahead.', v_max_days;
  end if;

  select * into v_override from public."Salon_Schedule_Overrides"
  where "Override_Date" = p_expected_date limit 1;
  if v_override."Schedule_Override_ID" is not null then
    if v_override."Is_Closed" then raise exception 'The salon is closed on the selected date.'; end if;
    v_open := v_override."Opening_Time";
    v_close := v_override."Closing_Time";
    v_break_start := v_override."Break_Start_Time";
    v_break_end := v_override."Break_End_Time";
  else
    if not v_hours."Is_Open" then raise exception 'The salon is closed on the selected date.'; end if;
    v_open := v_hours."Opening_Time";
    v_close := v_hours."Closing_Time";
    v_break_start := v_hours."Break_Start_Time";
    v_break_end := v_hours."Break_End_Time";
  end if;

  if p_expected_time < v_open or p_expected_time >= v_close then
    raise exception 'Expected arrival must be within salon receiving hours (% to %).', v_open, v_close;
  end if;
  if v_break_start is not null and p_expected_time >= v_break_start and p_expected_time < v_break_end then
    raise exception 'Expected arrival cannot be during the salon break (% to %).', v_break_start, v_break_end;
  end if;

  return jsonb_build_object('valid', true, 'opening_time', v_open, 'closing_time', v_close,
    'break_start_time', v_break_start, 'break_end_time', v_break_end,
    'schedule_source', case when v_override."Schedule_Override_ID" is null then 'Regular hours' else 'Date override' end);
end;
$fn$;

create or replace function public.book_salon_donation_appointment(
  p_start_at timestamp without time zone,
  p_contact_name text,
  p_contact_email text,
  p_contact_number text,
  p_hair_details jsonb default '{}'::jsonb,
  p_screening_answers jsonb default '{}'::jsonb,
  p_donor_notes text default null,
  p_guardian_consent_id integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user public.users%rowtype;
  v_screening public."AI_Screenings"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_appointment public."Salon_Donation_Appointments"%rowtype;
  v_requirements public.wig_requirements%rowtype;
  v_waybill text;
begin
  if auth.uid() is null then raise exception 'A signed-in donor account is required.'; end if;
  if p_start_at is null then raise exception 'Select an expected drop-off date and arrival time.'; end if;
  perform public.validate_walk_in_expected_arrival(p_start_at::date, p_start_at::time);
  if nullif(trim(coalesce(p_contact_name, '')), '') is null or nullif(trim(coalesce(p_contact_number, '')), '') is null then
    raise exception 'Contact name and contact number are required.';
  end if;

  select * into v_user from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_user.user_id is null then raise exception 'Active donor account was not found.'; end if;
  select * into v_requirements from public.wig_requirements order by "Wig_Requirement_ID" limit 1;

  select ai.* into v_screening
  from public."AI_Screenings" ai
  where ai."User_ID" = v_user.user_id
    and ai."Estimated_Length" >= coalesce(v_requirements."Minimum_Hair_Length", 0)
    and public.normalize_flow_key(ai."Improvement_Tracking_Status") = 'readyfordonation'
    and not exists (
      select 1 from public."Hair_Submissions" used
      where used."AI_Screening_ID" = ai."AI_Screening_ID"
        and public.normalize_flow_key(used."Status") <> 'cancelled'
    )
  order by ai."Created_At" desc, ai."AI_Screening_ID" desc limit 1;
  if v_screening."AI_Screening_ID" is null then
    raise exception 'No eligible AI screening matches the current wig requirements. Complete a new screening first.';
  end if;

  loop
    v_waybill := public.generate_waybill_code();
    exit when not exists (
      select 1 from public."Hair_Submissions" existing
      where existing."Waybill_Code" = v_waybill
    );
  end loop;

  insert into public."Hair_Submissions" (
    "User_ID", "Status", "From_Event", "Donor_Notes", "AI_Screening_ID", "Waybill_Code"
  ) values (
    v_user.user_id, 'Pending', false, nullif(trim(coalesce(p_donor_notes, '')), ''),
    v_screening."AI_Screening_ID", v_waybill
  ) returning * into v_submission;

  update public."AI_Screenings" set "Submission_ID" = v_submission."Submission_ID"
  where "AI_Screening_ID" = v_screening."AI_Screening_ID";

  insert into public."Hair_Submission_Logistics" (
    "Submission_ID", "Logistics_Type", "Dropoff_Status", "Expected_Dropoff_Date",
    "Expected_Arrival_Time", "Dropoff_Window", "Notes", "Updated_At"
  ) values (
    v_submission."Submission_ID", 'Walk-in Drop-off', 'Expected', p_start_at::date,
    p_start_at::time, to_char(p_start_at::time, 'HH12:MI AM'),
    'Expected arrival is an estimate and not a reserved appointment.', timezone('Asia/Manila', now())
  );

  -- Keep the legacy row for existing mobile/history consumers. It points to
  -- the submission created above; it is no longer used for slot capacity.
  insert into public."Salon_Donation_Appointments" (
    "User_ID", "Appointment_Start_At", "Appointment_End_At", "Status", "Contact_Name",
    "Contact_Email", "Contact_Number", "Hair_Details", "Screening_Answers", "Donor_Notes",
    "Guardian_Consent_ID", "Hair_Submission_ID", "Booking_Source"
  ) values (
    v_user.user_id, p_start_at, p_start_at + interval '1 minute', 'Confirmed', trim(p_contact_name),
    nullif(trim(coalesce(p_contact_email, '')), ''), trim(p_contact_number), coalesce(p_hair_details, '{}'::jsonb),
    coalesce(p_screening_answers, '{}'::jsonb), nullif(trim(coalesce(p_donor_notes, '')), ''),
    p_guardian_consent_id, v_submission."Submission_ID", 'Mobile'
  ) returning * into v_appointment;

  return jsonb_build_object('appointment', to_jsonb(v_appointment), 'submission', to_jsonb(v_submission),
    'waybill_code', v_submission."Waybill_Code", 'expected_arrival_is_appointment', false);
end;
$fn$;

create or replace function public.update_walk_in_expected_arrival(
  p_submission_id integer,
  p_expected_date date,
  p_expected_time time without time zone
)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_actor public.users%rowtype; v_submission public."Hair_Submissions"%rowtype; v_logistics public."Hair_Submission_Logistics"%rowtype;
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  select * into v_submission from public."Hair_Submissions" where "Submission_ID" = p_submission_id for update;
  if v_submission."Submission_ID" is null then raise exception 'Hair submission was not found.'; end if;
  if v_submission."User_ID" <> v_actor.user_id and public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin') then raise exception 'You cannot change this expected arrival.'; end if;
  if public.normalize_flow_key(v_submission."Status") = 'cancelled' then raise exception 'Cancelled donations cannot be reopened. Start a new walk-in donation.'; end if;
  perform public.validate_walk_in_expected_arrival(p_expected_date, p_expected_time);
  update public."Hair_Submission_Logistics" set "Expected_Dropoff_Date"=p_expected_date, "Expected_Arrival_Time"=p_expected_time,
    "Dropoff_Window"=to_char(p_expected_time,'HH12:MI AM'), "Updated_At"=timezone('Asia/Manila',now())
  where "Submission_ID"=p_submission_id and "Logistics_Type"='Walk-in Drop-off' and "Dropoff_Status"='Expected' returning * into v_logistics;
  if v_logistics."Submission_Logistics_ID" is null then raise exception 'Only an active expected walk-in can be changed.'; end if;
  update public."Salon_Donation_Appointments" set "Appointment_Start_At"=p_expected_date+p_expected_time,
    "Appointment_End_At"=p_expected_date+p_expected_time+interval '1 minute', "Status"='Rescheduled', "Updated_At"=timezone('Asia/Manila',now())
  where "Hair_Submission_ID"=p_submission_id;
  return jsonb_build_object('submission',to_jsonb(v_submission),'logistics',to_jsonb(v_logistics));
end $fn$;

create or replace function public.staff_update_walk_in_donation(
  p_submission_id integer, p_action text, p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor public.users%rowtype; v_submission public."Hair_Submissions"%rowtype;
  v_logistics public."Hair_Submission_Logistics"%rowtype; v_action text:=public.normalize_flow_key(p_action);
  v_now timestamp without time zone:=timezone('Asia/Manila',now()); v_close time; v_override public."Salon_Schedule_Overrides"%rowtype; v_hours public."Salon_Operating_Hours"%rowtype;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin') then raise exception 'Only active staff/admin can update walk-in receiving.'; end if;
  select * into v_submission from public."Hair_Submissions" where "Submission_ID"=p_submission_id for update;
  select * into v_logistics from public."Hair_Submission_Logistics" where "Submission_ID"=p_submission_id and "Logistics_Type"='Walk-in Drop-off' for update;
  if v_logistics."Submission_Logistics_ID" is null then raise exception 'Walk-in logistics record was not found.'; end if;
  if v_logistics."Dropoff_Status" in ('Completed','No Show','Cancelled') then raise exception 'This walk-in is final and cannot be reopened.'; end if;

  if v_action='checkin' then
    if v_logistics."Dropoff_Status" <> 'Expected' then raise exception 'Only an expected walk-in can be checked in.'; end if;
    update public."Hair_Submission_Logistics" set "Dropoff_Status"='Checked In', "Checked_In_At"=v_now,
      "Updated_By"=v_actor.user_id, "Updated_At"=v_now where "Submission_Logistics_ID"=v_logistics."Submission_Logistics_ID" returning * into v_logistics;
  elsif v_action='complete' then
    if v_logistics."Dropoff_Status" <> 'Checked In' then raise exception 'Check in the donor before completing receiving.'; end if;
    update public."Hair_Submission_Logistics" set "Dropoff_Status"='Completed', "Completed_At"=v_now, "Received_At"=v_now,
      "Received_By"=v_actor.user_id, "Updated_By"=v_actor.user_id, "Notes"=coalesce(nullif(trim(coalesce(p_notes,'')),''),"Notes"), "Updated_At"=v_now
    where "Submission_Logistics_ID"=v_logistics."Submission_Logistics_ID" returning * into v_logistics;
    update public."Hair_Submissions" set "Status"='Pending', "Cut_At"=null, "Cut_By_User_ID"=null, "Updated_At"=v_now
    where "Submission_ID"=p_submission_id returning * into v_submission;
    insert into public."Hair_Submission_Details" (
      "Submission_ID","Declared_Length","Declared_Color","Declared_Texture","Declared_Density",
      "Declared_Condition","Status","Created_At","Updated_By","Updated_At"
    )
    select p_submission_id, ai."Estimated_Length", ai."Detected_Color", ai."Detected_Texture",
      ai."Detected_Density", ai."Detected_Condition", 'Pending', v_now, v_actor.user_id, v_now
    from public."AI_Screenings" ai
    where ai."AI_Screening_ID" = v_submission."AI_Screening_ID"
    on conflict ("Submission_ID") do nothing;
  elsif v_action in ('noshow','cancel') then
    if nullif(trim(coalesce(p_notes,'')),'') is null then raise exception 'A cancellation or no-show reason is required.'; end if;
    if v_action='noshow' then
      select * into v_override from public."Salon_Schedule_Overrides" where "Override_Date"=v_logistics."Expected_Dropoff_Date" limit 1;
      select * into v_hours from public."Salon_Operating_Hours" where "Day_Group"=case when extract(isodow from v_logistics."Expected_Dropoff_Date") between 1 and 5 then 'Weekday' else 'Weekend' end limit 1;
      v_close:=coalesce(v_override."Closing_Time",v_hours."Closing_Time");
      if timezone('Asia/Manila',now()) < v_logistics."Expected_Dropoff_Date"+v_close then raise exception 'No Show is allowed only after the receiving period has ended.'; end if;
    end if;
    update public."Hair_Submission_Logistics" set "Dropoff_Status"=case when v_action='noshow' then 'No Show' else 'Cancelled' end,
      "Cancelled_At"=v_now, "Cancellation_Source"='Staff', "Cancellation_Reason"=trim(p_notes), "Updated_By"=v_actor.user_id, "Updated_At"=v_now
    where "Submission_Logistics_ID"=v_logistics."Submission_Logistics_ID" returning * into v_logistics;
    update public."Hair_Submissions" set "Status"='Cancelled',"Updated_At"=v_now where "Submission_ID"=p_submission_id returning * into v_submission;
  else raise exception 'Action must be check_in, complete, no_show, or cancel.';
  end if;
  update public."Salon_Donation_Appointments" set "Status"=case v_action when 'checkin' then 'Checked In' when 'complete' then 'Completed' when 'noshow' then 'No Show' else 'Cancelled' end,
    "Checked_In_At"=case when v_action='checkin' then v_now else "Checked_In_At" end, "Completed_At"=case when v_action='complete' then v_now else "Completed_At" end,
    "Cancelled_At"=case when v_action in ('noshow','cancel') then v_now else "Cancelled_At" end, "Cancellation_Reason"=case when v_action in ('noshow','cancel') then trim(p_notes) else "Cancellation_Reason" end,
    "Updated_At"=v_now where "Hair_Submission_ID"=p_submission_id;
  return jsonb_build_object('submission',to_jsonb(v_submission),'logistics',to_jsonb(v_logistics));
end $fn$;

create or replace function public.cancel_walk_in_donation(p_submission_id integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_actor public.users%rowtype; v_submission public."Hair_Submissions"%rowtype; v_logistics public."Hair_Submission_Logistics"%rowtype; v_now timestamp without time zone:=timezone('Asia/Manila',now());
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() and is_active is distinct from false limit 1;
  select * into v_submission from public."Hair_Submissions" where "Submission_ID"=p_submission_id for update;
  if v_submission."User_ID" <> v_actor.user_id then raise exception 'You cannot cancel this donation.'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Cancellation reason is required.'; end if;
  update public."Hair_Submission_Logistics" set "Dropoff_Status"='Cancelled',"Cancelled_At"=v_now,"Cancellation_Source"='Donor',"Cancellation_Reason"=trim(p_reason),"Updated_At"=v_now
  where "Submission_ID"=p_submission_id and "Logistics_Type"='Walk-in Drop-off' and "Dropoff_Status"='Expected' returning * into v_logistics;
  if v_logistics."Submission_Logistics_ID" is null then raise exception 'Only an expected walk-in can be cancelled.'; end if;
  update public."Hair_Submissions" set "Status"='Cancelled',"Updated_At"=v_now where "Submission_ID"=p_submission_id returning * into v_submission;
  return jsonb_build_object('submission',to_jsonb(v_submission),'logistics',to_jsonb(v_logistics));
end $fn$;

create or replace function public.is_hair_submission_physically_received(p_submission_id integer)
returns boolean language sql stable security definer set search_path='' as $fn$
  select exists (
    select 1 from public."Hair_Submission_Logistics" l
    where l."Submission_ID"=p_submission_id and (
      ((lower(l."Logistics_Type") like '%walk-in%' or lower(l."Logistics_Type") like '%dropoff%')
        and public.normalize_flow_key(l."Dropoff_Status")='completed' and coalesce(l."Completed_At",l."Received_At") is not null)
      or (lower(l."Logistics_Type") not like '%walk-in%' and lower(l."Logistics_Type") not like '%dropoff%' and
        (l."Received_At" is not null or public.normalize_flow_key(l."Shipment_Status") in ('received','completed','delivered')))
    )
  )
$fn$;

create or replace function public.enforce_received_before_hair_quality_review()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if public.normalize_flow_key(new."Status") in ('approved','rejected','rejectedcut')
    and exists (
      select 1 from public."Hair_Submissions" submission
      where submission."Submission_ID" = new."Submission_ID"
        and coalesce(submission."From_Event", false) = false
    )
    and not public.is_hair_submission_physically_received(new."Submission_ID") then
    raise exception 'Hair must be physically received before quality verification.';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_enforce_received_before_hair_quality_review on public."Hair_Submission_Details";
create trigger trg_enforce_received_before_hair_quality_review before insert or update of "Status" on public."Hair_Submission_Details"
for each row execute function public.enforce_received_before_hair_quality_review();

-- Non-event Quality Check follows the same human-vs-AI review model as the
-- event workflow. Received hair stays Pending until the specialist decides.
-- Approval advances the physical inventory to Cut; rejection is stored only
-- as a quality result and is never misreported as a donor cancellation.
create or replace function public.specialist_review_received_hair_quality(
  p_submission_id integer,
  p_decision text,
  p_rejection_reason text default null,
  p_detail_updates jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_detail public."Hair_Submission_Details"%rowtype;
  v_decision text := public.normalize_flow_key(p_decision);
  v_updates jsonb := coalesce(p_detail_updates, '{}'::jsonb);
  v_reason text := nullif(trim(coalesce(p_rejection_reason, '')), '');
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if v_decision not in ('approved', 'rejected') then raise exception 'Decision must be Approved or Rejected.'; end if;
  if v_decision = 'rejected' and v_reason is null then raise exception 'Rejection reason is required.'; end if;
  if jsonb_typeof(v_updates) <> 'object' then raise exception 'Detail updates must be an object.'; end if;

  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('specialist','admin','superadmin') then
    raise exception 'Only an active specialist/admin can review received hair.';
  end if;

  select * into v_submission from public."Hair_Submissions"
  where "Submission_ID" = p_submission_id for update;
  if v_submission."Submission_ID" is null then raise exception 'Hair submission was not found.'; end if;
  if coalesce(v_submission."From_Event", true) then raise exception 'Use Assigned Event Operations for event hair.'; end if;
  if v_submission."Bundle_ID" is not null then raise exception 'Bundled hair can no longer be reviewed.'; end if;
  if public.normalize_flow_key(v_submission."Status") not in ('pending','cut') then
    raise exception 'Only Pending received hair can be reviewed.';
  end if;
  if not public.is_hair_submission_physically_received(p_submission_id) then
    raise exception 'Hair must be physically received before quality verification.';
  end if;

  insert into public."Hair_Submission_Details" (
    "Submission_ID","Declared_Length","Declared_Color","Declared_Texture","Declared_Density",
    "Declared_Condition","Status","Created_At","Updated_By","Updated_At"
  )
  select v_submission."Submission_ID", ai."Estimated_Length", ai."Detected_Color", ai."Detected_Texture",
    ai."Detected_Density", ai."Detected_Condition", 'Pending', v_now, v_actor.user_id, v_now
  from public."AI_Screenings" ai
  where ai."AI_Screening_ID" = v_submission."AI_Screening_ID"
  on conflict ("Submission_ID") do nothing;

  -- Also support a legitimate manual submission with no linked AI baseline.
  insert into public."Hair_Submission_Details" ("Submission_ID","Status","Created_At","Updated_By","Updated_At")
  values (v_submission."Submission_ID",'Pending',v_now,v_actor.user_id,v_now)
  on conflict ("Submission_ID") do nothing;

  select * into v_detail from public."Hair_Submission_Details"
  where "Submission_ID" = v_submission."Submission_ID" for update;
  if public.normalize_flow_key(v_detail."Status") <> 'pending' then
    raise exception 'This quality review is already final.';
  end if;

  update public."Hair_Submission_Details"
  set
    "Declared_Length" = case when v_updates ? 'declaredLength' then nullif(v_updates->>'declaredLength','')::numeric else "Declared_Length" end,
    "Declared_Color" = case when v_updates ? 'declaredColor' then nullif(trim(v_updates->>'declaredColor'),'') else "Declared_Color" end,
    "Declared_Texture" = case when v_updates ? 'declaredTexture' then nullif(trim(v_updates->>'declaredTexture'),'') else "Declared_Texture" end,
    "Declared_Density" = case when v_updates ? 'declaredDensity' then nullif(trim(v_updates->>'declaredDensity'),'') else "Declared_Density" end,
    "Declared_Condition" = case when v_updates ? 'declaredCondition' then nullif(trim(v_updates->>'declaredCondition'),'') else "Declared_Condition" end,
    "Is_Chemically_Treated" = case when v_updates ? 'isChemicallyTreated' then coalesce((v_updates->>'isChemicallyTreated')::boolean,false) else "Is_Chemically_Treated" end,
    "Is_Colored" = case when v_updates ? 'isColored' then coalesce((v_updates->>'isColored')::boolean,false) else "Is_Colored" end,
    "Is_Bleached" = case when v_updates ? 'isBleached' then coalesce((v_updates->>'isBleached')::boolean,false) else "Is_Bleached" end,
    "Is_Rebonded" = case when v_updates ? 'isRebonded' then coalesce((v_updates->>'isRebonded')::boolean,false) else "Is_Rebonded" end,
    "Detail_Notes" = case when v_updates ? 'detailNotes' then nullif(trim(v_updates->>'detailNotes'),'') else "Detail_Notes" end,
    "Status" = case when v_decision='approved' then 'Approved' else 'Rejected' end,
    "Rejection_Reason" = case when v_decision='rejected' then v_reason else null end,
    "Updated_By" = v_actor.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_detail;

  if v_decision = 'approved' then
    update public."Hair_Submissions"
    set "Status"='Cut', "Cut_At"=coalesce("Cut_At",v_now), "Cut_By_User_ID"=v_actor.user_id, "Updated_At"=v_now
    where "Submission_ID"=v_submission."Submission_ID" returning * into v_submission;
  end if;

  return jsonb_build_object('decision',v_detail."Status",'submission',to_jsonb(v_submission),'details',jsonb_build_array(to_jsonb(v_detail)));
end;
$fn$;

revoke all on function public.validate_walk_in_expected_arrival(date,time without time zone) from public,anon;
revoke all on function public.update_walk_in_expected_arrival(integer,date,time without time zone) from public,anon;
revoke all on function public.staff_update_walk_in_donation(integer,text,text) from public,anon;
revoke all on function public.cancel_walk_in_donation(integer,text) from public,anon;
revoke all on function public.specialist_review_received_hair_quality(integer,text,text,jsonb) from public,anon;
grant execute on function public.validate_walk_in_expected_arrival(date,time without time zone) to authenticated;
grant execute on function public.update_walk_in_expected_arrival(integer,date,time without time zone) to authenticated;
grant execute on function public.staff_update_walk_in_donation(integer,text,text) to authenticated;
grant execute on function public.cancel_walk_in_donation(integer,text) to authenticated;
grant execute on function public.specialist_review_received_hair_quality(integer,text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
