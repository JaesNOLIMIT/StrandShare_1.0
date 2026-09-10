begin;

-- Patient approval now sends credentials through the existing Supabase Auth
-- invitation template. This database finalizer creates the application records
-- only; it no longer queues a second, redundant SMTP acceptance message.
create or replace function public.finalize_patient_application_acceptance(
  p_application_id bigint,
  p_auth_user_id uuid,
  p_actor_user_id integer,
  p_patient_code text,
  p_patient_picture_path text,
  p_account_setup_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_application public."Patient_Applications"%rowtype;
  v_actor public.users%rowtype;
  v_user_id integer;
  v_patient_id integer;
begin
  select * into v_actor
  from public.users
  where user_id = p_actor_user_id
    and is_active is distinct from false;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) <> 'hrepresentative'
  then
    raise exception 'Only an active H-Representative can accept this application';
  end if;

  select * into v_application
  from public."Patient_Applications"
  where "Patient_Application_ID" = p_application_id
  for update;

  if v_application."Patient_Application_ID" is null then
    raise exception 'Application was not found';
  end if;

  if public.normalize_flow_key(v_application."Status") <> 'submitted' then
    raise exception 'This application has already been decided';
  end if;

  if not exists (
    select 1
    from public."Hospital_Representative" representative
    where representative."User_ID" = v_actor.user_id
      and representative."Hospital_ID" = v_application."Hospital_ID"
  ) then
    raise exception 'This application belongs to another hospital';
  end if;

  -- No email already registered for any Donivra role may be reused.
  if exists (
    select 1
    from public.users account
    where lower(trim(account.email)) = lower(trim(v_application."Applicant_Email"))
  ) then
    raise exception 'This email already belongs to an existing Donivra account';
  end if;

  insert into public.users (
    auth_user_id, email, role, is_active, created_at, updated_at
  ) values (
    p_auth_user_id,
    lower(trim(v_application."Applicant_Email")),
    'patient',
    true,
    timezone('Asia/Manila', now()),
    timezone('Asia/Manila', now())
  )
  returning user_id into v_user_id;

  insert into public.user_details (
    user_id, first_name, middle_name, last_name, suffix, birthdate, gender,
    contact_number, street, barangay, city, province, region, country,
    photo_path, joined_date, created_at, updated_at
  ) values (
    v_user_id,
    v_application."First_Name",
    v_application."Middle_Name",
    v_application."Last_Name",
    v_application."Suffix",
    v_application."Birthdate",
    v_application."Gender",
    v_application."Contact_Number",
    v_application."Street",
    v_application."Barangay",
    v_application."City",
    v_application."Province",
    v_application."Region",
    v_application."Country",
    p_patient_picture_path,
    current_date,
    timezone('Asia/Manila', now()),
    timezone('Asia/Manila', now())
  );

  insert into public."Patients" (
    "User_ID", "Hospital_ID", "Patient_Code", "Medical_Condition",
    "Patient_Picture", "Date_of_Diagnosis", "Guardian",
    "Guardian_Contact_Number", "Medical_Document", "Guardian_Relationship",
    "Medical_Document_Verification_Status", "Medical_Document_Verified_At",
    "Doctor_Name", "Condition_Category", "Other_Hair_Loss_Disease",
    "Condition_Stage_Severity", "Attending_Physician_Contact",
    "Treatment_Hospital_Clinic", "Treatment_Plan", "Current_Treatment_Status",
    "Allergies_Current_Medications", "Insurance_PhilHealth_Info",
    "Clinical_Special_Note", "Secondary_Guardian",
    "Secondary_Guardian_Relationship", "Secondary_Guardian_Contact_Number",
    "Created_By", "Created_At", "Updated_At"
  ) values (
    v_user_id,
    v_application."Hospital_ID",
    trim(p_patient_code),
    v_application."Medical_Condition",
    p_patient_picture_path,
    v_application."Date_of_Diagnosis",
    v_application."Guardian",
    v_application."Guardian_Contact_Number",
    v_application."Medical_Document_Path",
    v_application."Guardian_Relationship",
    'verified',
    now(),
    v_application."Doctor_Name",
    v_application."Condition_Category",
    case
      when v_application."Condition_Category" = 'Other Hair-Loss Disease'
        then v_application."Medical_Condition"
      else null
    end,
    v_application."Condition_Stage_Severity",
    v_application."Attending_Physician_Contact",
    v_application."Treatment_Hospital_Clinic",
    v_application."Treatment_Plan",
    v_application."Current_Treatment_Status",
    v_application."Allergies_Current_Medications",
    v_application."Insurance_PhilHealth_Info",
    v_application."Clinical_Special_Note",
    v_application."Secondary_Guardian",
    v_application."Secondary_Guardian_Relationship",
    v_application."Secondary_Guardian_Contact_Number",
    v_actor.user_id,
    timezone('Asia/Manila', now()),
    timezone('Asia/Manila', now())
  )
  returning "Patient_ID" into v_patient_id;

  insert into public.patient_wig_safety_profiles (
    patient_id, has_known_allergies, allergy_details, has_sensitive_scalp,
    has_scalp_irritation, has_open_scalp_wounds, has_medical_restriction,
    medical_restriction_details, information_confirmed, confirmed_at
  ) values (
    v_patient_id,
    v_application."Has_Known_Allergies",
    v_application."Allergy_Details",
    v_application."Has_Sensitive_Scalp",
    v_application."Has_Scalp_Irritation",
    v_application."Has_Open_Scalp_Wounds",
    v_application."Has_Medical_Restriction",
    v_application."Medical_Restriction_Details",
    v_application."Safety_Information_Confirmed",
    now()
  );

  update public."Patient_Applications"
  set
    "Status" = 'accepted',
    "Reviewed_At" = now(),
    "Reviewed_By" = v_actor.user_id,
    "Decision_Reason" = null,
    "Created_Patient_ID" = v_patient_id,
    "Patient_Picture_Path" = p_patient_picture_path,
    "Updated_At" = now()
  where "Patient_Application_ID" = v_application."Patient_Application_ID";

  insert into public.audit_logs (
    user_id, action, description, user_email, resource, status, "time"
  ) values (
    v_actor.user_id,
    'patient_application.accepted',
    format(
      'Accepted patient application %s and created patient %s. Credentials were sent by Supabase Auth invitation.',
      v_application."Application_Code",
      p_patient_code
    ),
    v_actor.email,
    'Patient_Applications:' || v_application."Patient_Application_ID"::text,
    'success',
    timezone('Asia/Manila', now())
  );

  return jsonb_build_object(
    'application_id', v_application."Patient_Application_ID",
    'patient_id', v_patient_id,
    'user_id', v_user_id,
    'patient_code', p_patient_code
  );
end;
$fn$;

revoke all on function public.finalize_patient_application_acceptance(bigint,uuid,integer,text,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_patient_application_acceptance(bigint,uuid,integer,text,text,text)
  to service_role;

comment on function public.finalize_patient_application_acceptance(bigint,uuid,integer,text,text,text) is
  'Creates an approved patient and relies on the Supabase Auth invitation for account credentials; p_account_setup_url is retained only for API compatibility.';

notify pgrst, 'reload schema';
commit;
