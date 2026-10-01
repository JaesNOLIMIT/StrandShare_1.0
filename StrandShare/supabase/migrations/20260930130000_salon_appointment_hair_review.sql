-- Keep booked salon hair reviews in Receiving Schedule and independent
-- courier/drop-off hair reviews in Specialist Quality Check.

begin;

-- The September 29 repair accidentally restored the legacy non-event review
-- function, which requires a Cut parent record. Courier and drop-off hair is
-- intentionally Pending until the specialist reviews the physically received
-- item, so route this RPC back through the received-hair implementation.
create or replace function public.specialist_review_non_event_hair_quality_v2(
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
  v_result jsonb;
  v_decision text := public.normalize_flow_key(p_decision);
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if exists (
    select 1
    from public."Salon_Donation_Appointments" appointment
    where appointment."Hair_Submission_ID" = p_submission_id
  ) then
    raise exception 'Booked salon hair must be reviewed from Receiving Schedule.';
  end if;

  v_result := public.specialist_review_received_hair_quality(
    p_submission_id,
    p_decision,
    p_rejection_reason,
    p_detail_updates
  );

  update public."Hair_Submissions"
  set
    "Status" = case when v_decision = 'approved' then 'Available' else 'Rejected' end,
    "Cut_At" = null,
    "Cut_By_User_ID" = null,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id;

  -- Re-fire the final detail update after the parent reaches Available so the
  -- inventory synchronization trigger can insert approved physical hair.
  update public."Hair_Submission_Details"
  set "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
    and public.normalize_flow_key("Status") in ('approved', 'rejected');

  return v_result || jsonb_build_object(
    'submission', (
      select to_jsonb(submission)
      from public."Hair_Submissions" submission
      where submission."Submission_ID" = p_submission_id
    )
  );
end;
$fn$;

revoke all on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb)
  to authenticated;

comment on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb) is
  'Reviews physically received courier/drop-off hair only; booked salon hair is reviewed in Receiving Schedule.';

create or replace function public.staff_review_salon_appointment_hair(
  p_appointment_id integer,
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
  v_appointment public."Salon_Donation_Appointments"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_detail public."Hair_Submission_Details"%rowtype;
  v_logistics public."Hair_Submission_Logistics"%rowtype;
  v_decision text := public.normalize_flow_key(p_decision);
  v_updates jsonb := coalesce(p_detail_updates, '{}'::jsonb);
  v_reason text := nullif(trim(coalesce(p_rejection_reason, '')), '');
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_length numeric;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin') then
    raise exception 'Only active staff or admin accounts can review salon appointment hair.';
  end if;

  if v_decision not in ('approved', 'rejected', 'rejectedcut') then
    raise exception 'Decision must be Approved, Rejected, or Rejected Cut.';
  end if;
  if v_decision in ('rejected', 'rejectedcut') and v_reason is null then
    raise exception 'A rejection reason is required.';
  end if;
  if jsonb_typeof(v_updates) <> 'object' then
    raise exception 'Detail updates must be an object.';
  end if;
  if v_updates ? 'declaredLength' then
    begin
      v_length := nullif(trim(v_updates ->> 'declaredLength'), '')::numeric;
    exception when invalid_text_representation then
      raise exception 'Hair length must be a number.';
    end;
    if v_length is not null and (v_length <= 0 or v_length > 999.99) then
      raise exception 'Hair length must be greater than 0 and no more than 999.99 inches.';
    end if;
  end if;

  select * into v_appointment
  from public."Salon_Donation_Appointments" appointment
  where appointment."Appointment_ID" = p_appointment_id
  for update;

  if v_appointment."Appointment_ID" is null then
    raise exception 'Salon appointment was not found.';
  end if;
  if v_appointment."Status" in ('Cancelled', 'No Show') then
    raise exception 'Cancelled and no-show appointments cannot be reviewed.';
  end if;
  if v_appointment."Hair_Submission_ID" is null then
    raise exception 'This appointment has no hair waybill. Ask the donor to refresh the booking before review.';
  end if;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = v_appointment."Hair_Submission_ID"
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'The appointment hair submission was not found.';
  end if;
  if coalesce(v_submission."From_Event", true) then
    raise exception 'Event hair must be reviewed from Assigned Program Operations.';
  end if;
  if v_submission."Bundle_ID" is not null then
    raise exception 'Bundled hair can no longer be reviewed.';
  end if;

  select * into v_detail
  from public."Hair_Submission_Details" detail
  where detail."Submission_ID" = v_submission."Submission_ID"
  order by detail."Submission_Detail_ID" desc
  limit 1
  for update;

  if v_detail."Submission_Detail_ID" is not null
    and public.normalize_flow_key(v_detail."Status") in ('approved', 'rejected', 'rejectedcut') then
    raise exception 'This appointment hair review is already final.';
  end if;

  if v_detail."Submission_Detail_ID" is null then
    insert into public."Hair_Submission_Details" (
      "Submission_ID", "Declared_Length", "Declared_Color", "Declared_Texture",
      "Declared_Density", "Declared_Condition", "Is_Chemically_Treated",
      "Is_Colored", "Is_Bleached", "Is_Rebonded", "Detail_Notes",
      "Status", "Created_At", "Updated_By", "Updated_At"
    ) values (
      v_submission."Submission_ID",
      nullif(trim(coalesce(v_appointment."Hair_Details" ->> 'declaredLength', '')), '')::numeric,
      nullif(trim(coalesce(v_appointment."Hair_Details" ->> 'declaredColor', '')), ''),
      nullif(trim(coalesce(v_appointment."Hair_Details" ->> 'declaredTexture', '')), ''),
      nullif(trim(coalesce(v_appointment."Hair_Details" ->> 'declaredDensity', '')), ''),
      nullif(trim(coalesce(v_appointment."Hair_Details" ->> 'declaredCondition', '')), ''),
      coalesce((v_appointment."Hair_Details" ->> 'isChemicallyTreated')::boolean, false),
      coalesce((v_appointment."Hair_Details" ->> 'isColored')::boolean, false),
      coalesce((v_appointment."Hair_Details" ->> 'isBleached')::boolean, false),
      coalesce((v_appointment."Hair_Details" ->> 'isRebonded')::boolean, false),
      nullif(trim(coalesce(v_appointment."Hair_Details" ->> 'detailNotes', '')), ''),
      'Pending', v_now, v_actor.user_id, v_now
    ) returning * into v_detail;
  end if;

  -- Scanning/reviewing the booked donor is the physical receiving event.
  select * into v_logistics
  from public."Hair_Submission_Logistics" logistics
  where logistics."Submission_ID" = v_submission."Submission_ID"
  order by logistics."Submission_Logistics_ID" desc
  limit 1
  for update;

  if v_logistics."Submission_Logistics_ID" is null then
    insert into public."Hair_Submission_Logistics" (
      "Submission_ID", "Logistics_Type", "Shipment_Status", "Received_By",
      "Received_At", "Notes", "Created_At", "Updated_By", "Updated_At"
    ) values (
      v_submission."Submission_ID", 'Salon Appointment', 'Received', v_actor.user_id,
      v_now, 'Received during booked salon appointment.', v_now, v_actor.user_id, v_now
    ) returning * into v_logistics;
  else
    update public."Hair_Submission_Logistics"
    set
      "Dropoff_Status" = case
        when lower(coalesce("Logistics_Type", '')) like '%dropoff%'
          or lower(coalesce("Logistics_Type", '')) like '%walk-in%'
        then 'Completed'
        else "Dropoff_Status"
      end,
      "Shipment_Status" = case
        when lower(coalesce("Logistics_Type", '')) not like '%dropoff%'
          and lower(coalesce("Logistics_Type", '')) not like '%walk-in%'
        then 'Received'
        else "Shipment_Status"
      end,
      "Checked_In_At" = coalesce("Checked_In_At", v_now),
      "Completed_At" = coalesce("Completed_At", v_now),
      "Received_By" = v_actor.user_id,
      "Received_At" = coalesce("Received_At", v_now),
      "Updated_By" = v_actor.user_id,
      "Updated_At" = v_now
    where "Submission_Logistics_ID" = v_logistics."Submission_Logistics_ID"
    returning * into v_logistics;
  end if;

  -- Set the parent first. The detail trigger sees Cut only for Approved and
  -- therefore creates inventory for approval, never for either rejection.
  update public."Hair_Submissions"
  set
    "Status" = case when v_decision = 'approved' then 'Cut' else 'Rejected' end,
    "Cut_At" = case when v_decision in ('approved', 'rejectedcut') then v_now else null end,
    "Cut_By_User_ID" = case when v_decision in ('approved', 'rejectedcut') then v_actor.user_id else null end,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  update public."Hair_Submission_Details"
  set
    "Declared_Length" = case when v_updates ? 'declaredLength' then v_length else "Declared_Length" end,
    "Declared_Color" = case when v_updates ? 'declaredColor' then nullif(trim(v_updates ->> 'declaredColor'), '') else "Declared_Color" end,
    "Declared_Texture" = case when v_updates ? 'declaredTexture' then nullif(trim(v_updates ->> 'declaredTexture'), '') else "Declared_Texture" end,
    "Declared_Density" = case when v_updates ? 'declaredDensity' then nullif(trim(v_updates ->> 'declaredDensity'), '') else "Declared_Density" end,
    "Declared_Condition" = case when v_updates ? 'declaredCondition' then nullif(trim(v_updates ->> 'declaredCondition'), '') else "Declared_Condition" end,
    "Is_Chemically_Treated" = case when v_updates ? 'isChemicallyTreated' then coalesce((v_updates ->> 'isChemicallyTreated')::boolean, false) else "Is_Chemically_Treated" end,
    "Is_Colored" = case when v_updates ? 'isColored' then coalesce((v_updates ->> 'isColored')::boolean, false) else "Is_Colored" end,
    "Is_Bleached" = case when v_updates ? 'isBleached' then coalesce((v_updates ->> 'isBleached')::boolean, false) else "Is_Bleached" end,
    "Is_Rebonded" = case when v_updates ? 'isRebonded' then coalesce((v_updates ->> 'isRebonded')::boolean, false) else "Is_Rebonded" end,
    "Detail_Notes" = case when v_updates ? 'detailNotes' then nullif(trim(v_updates ->> 'detailNotes'), '') else "Detail_Notes" end,
    "Status" = case
      when v_decision = 'approved' then 'Approved'
      when v_decision = 'rejectedcut' then 'Rejected Cut'
      else 'Rejected'
    end,
    "Rejection_Reason" = case when v_decision in ('rejected', 'rejectedcut') then v_reason else null end,
    "Updated_By" = v_actor.user_id,
    "Updated_At" = v_now
  where "Submission_Detail_ID" = v_detail."Submission_Detail_ID"
  returning * into v_detail;

  update public."Salon_Donation_Appointments"
  set
    "Status" = 'Completed',
    "Hair_Details" = jsonb_build_object(
      'declaredLength', v_detail."Declared_Length",
      'declaredColor', v_detail."Declared_Color",
      'declaredTexture', v_detail."Declared_Texture",
      'declaredDensity', v_detail."Declared_Density",
      'declaredCondition', v_detail."Declared_Condition",
      'isChemicallyTreated', coalesce(v_detail."Is_Chemically_Treated", false),
      'isColored', coalesce(v_detail."Is_Colored", false),
      'isBleached', coalesce(v_detail."Is_Bleached", false),
      'isRebonded', coalesce(v_detail."Is_Rebonded", false),
      'detailNotes', v_detail."Detail_Notes"
    ),
    "Checked_In_At" = coalesce("Checked_In_At", v_now),
    "Completed_At" = v_now,
    "Updated_At" = v_now
  where "Appointment_ID" = v_appointment."Appointment_ID"
  returning * into v_appointment;

  return jsonb_build_object(
    'decision', v_detail."Status",
    'appointment', to_jsonb(v_appointment),
    'submission', to_jsonb(v_submission),
    'details', to_jsonb(v_detail),
    'inventory_added', v_decision = 'approved'
  );
end;
$fn$;

revoke all on function public.staff_review_salon_appointment_hair(integer,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_review_salon_appointment_hair(integer,text,text,jsonb)
  to authenticated;

comment on function public.staff_review_salon_appointment_hair(integer,text,text,jsonb) is
  'Receives and reviews booked salon appointment hair. Approved hair is synchronized into Cut_Hair_Inventory.';

-- Restore real appointment slots. The expected-arrival migration temporarily
-- treated salon bookings as one-minute estimates and skipped capacity. Staff
-- controls for duration, buffer, grace period, and donors per time are once
-- again enforced by get_salon_available_slots.
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
  v_details public.user_details%rowtype;
  v_screening public."AI_Screenings"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_appointment public."Salon_Donation_Appointments"%rowtype;
  v_requirements public.wig_requirements%rowtype;
  v_guardian_consent public.guardian_consents%rowtype;
  v_slot record;
  v_waybill text;
  v_today date := timezone('Asia/Manila', now())::date;
  v_is_minor boolean := false;
  v_consent_document_id integer;
begin
  if auth.uid() is null then raise exception 'A signed-in donor account is required.'; end if;
  if p_start_at is null then raise exception 'Select an appointment time.'; end if;
  if nullif(trim(coalesce(p_contact_name, '')), '') is null
    or nullif(trim(coalesce(p_contact_number, '')), '') is null then
    raise exception 'Contact name and contact number are required.';
  end if;
  if jsonb_typeof(coalesce(p_hair_details, '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_screening_answers, '{}'::jsonb)) <> 'object' then
    raise exception 'Hair details and screening answers must be objects.';
  end if;

  select * into v_user
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;
  if v_user.user_id is null then raise exception 'Active donor account was not found.'; end if;

  select * into v_details from public.user_details detail
  where detail.user_id = v_user.user_id limit 1;
  v_is_minor := v_details.birthdate is not null
    and v_details.birthdate > (v_today - interval '18 years')::date;

  select * into v_slot
  from public.get_salon_available_slots(p_start_at::date, p_start_at::date) slot
  where slot."Slot_Start_At" = p_start_at
  limit 1;
  if v_slot."Slot_Start_At" is null then
    raise exception 'The selected time is not part of the salon appointment schedule.';
  end if;
  if p_start_at::date < v_today + v_slot."Minimum_Booking_Notice_Days" then
    raise exception 'Appointments must be booked at least % day(s) ahead.', v_slot."Minimum_Booking_Notice_Days";
  end if;
  if p_start_at::date > v_today + v_slot."Maximum_Booking_Days" then
    raise exception 'Appointments may be booked only % days ahead.', v_slot."Maximum_Booking_Days";
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_start_at::text, 0));
  if (
    select count(*)
    from public."Salon_Donation_Appointments" appointment
    where appointment."Appointment_Start_At" = p_start_at
      and appointment."Status" in ('Confirmed', 'Rescheduled', 'Checked In')
  ) >= v_slot."Capacity" then
    raise exception 'This appointment time has just become fully booked. Select another time.';
  end if;
  if exists (
    select 1 from public."Salon_Donation_Appointments" appointment
    where appointment."User_ID" = v_user.user_id
      and appointment."Appointment_Start_At"::date = p_start_at::date
      and appointment."Status" in ('Confirmed', 'Rescheduled', 'Checked In')
  ) then
    raise exception 'You already have an active salon appointment on this date.';
  end if;

  if p_guardian_consent_id is not null then
    select * into v_guardian_consent
    from public.guardian_consents consent
    where consent.guardian_consent_id = p_guardian_consent_id
      and consent.user_id = v_user.user_id;
    if v_guardian_consent.guardian_consent_id is null then
      raise exception 'The selected guardian consent does not belong to this donor.';
    end if;
  end if;
  if v_is_minor then
    select document.legal_document_id into v_consent_document_id
    from public.legal_documents document
    where document.document_type = 'consent_for_minors'
      and coalesce(document.is_active, false)
      and coalesce(document.effective_at, document.created_at) <= timezone('Asia/Manila', now())
    order by coalesce(document.effective_at, document.created_at) desc,
      document.legal_document_id desc
    limit 1;
  end if;

  select * into v_requirements from public.wig_requirements
  order by "Wig_Requirement_ID" limit 1;
  select screening.* into v_screening
  from public."AI_Screenings" screening
  where screening."User_ID" = v_user.user_id
    and screening."Estimated_Length" >= coalesce(v_requirements."Minimum_Hair_Length", 0)
    and public.normalize_flow_key(screening."Improvement_Tracking_Status") = 'readyfordonation'
    and not exists (
      select 1 from public."Hair_Submissions" used
      where used."AI_Screening_ID" = screening."AI_Screening_ID"
        and public.normalize_flow_key(used."Status") <> 'cancelled'
    )
  order by screening."Created_At" desc, screening."AI_Screening_ID" desc
  limit 1;
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
    v_user.user_id, 'Pending', false,
    nullif(trim(coalesce(p_donor_notes, '')), ''),
    v_screening."AI_Screening_ID", v_waybill
  ) returning * into v_submission;

  update public."AI_Screenings"
  set "Submission_ID" = v_submission."Submission_ID"
  where "AI_Screening_ID" = v_screening."AI_Screening_ID";

  insert into public."Hair_Submission_Logistics" (
    "Submission_ID", "Logistics_Type", "Shipment_Status", "Notes", "Created_At", "Updated_At"
  ) values (
    v_submission."Submission_ID", 'Salon Appointment', 'Scheduled',
    'Hair will be received during the booked salon appointment.',
    timezone('Asia/Manila', now()), timezone('Asia/Manila', now())
  );

  insert into public."Salon_Donation_Appointments" (
    "User_ID", "Appointment_Start_At", "Appointment_End_At", "Status",
    "Contact_Name", "Contact_Email", "Contact_Number", "Hair_Details",
    "Screening_Answers", "Donor_Notes", "Is_Minor", "Guardian_Consent_ID",
    "Consent_Legal_Document_ID", "Hair_Submission_ID", "Booking_Source"
  ) values (
    v_user.user_id, p_start_at, v_slot."Slot_End_At", 'Confirmed',
    trim(p_contact_name), nullif(trim(coalesce(p_contact_email, '')), ''),
    trim(p_contact_number), coalesce(p_hair_details, '{}'::jsonb),
    coalesce(p_screening_answers, '{}'::jsonb),
    nullif(trim(coalesce(p_donor_notes, '')), ''), v_is_minor,
    p_guardian_consent_id, v_consent_document_id,
    v_submission."Submission_ID", 'Mobile'
  ) returning * into v_appointment;

  return jsonb_build_object(
    'appointment', to_jsonb(v_appointment),
    'submission', to_jsonb(v_submission),
    'waybill_code', v_submission."Waybill_Code",
    'remaining_capacity', greatest(v_slot."Remaining_Capacity" - 1, 0),
    'guardian_consent_required', v_is_minor and p_guardian_consent_id is null,
    'expected_arrival_is_appointment', true
  );
end;
$fn$;

revoke all on function public.book_salon_donation_appointment(
  timestamp without time zone,text,text,text,jsonb,jsonb,text,integer
) from public, anon, authenticated;
grant execute on function public.book_salon_donation_appointment(
  timestamp without time zone,text,text,text,jsonb,jsonb,text,integer
) to authenticated;

comment on function public.book_salon_donation_appointment(
  timestamp without time zone,text,text,text,jsonb,jsonb,text,integer
) is 'Books a capacity-controlled salon appointment and creates its scannable pending hair submission.';

notify pgrst, 'reload schema';

commit;
