begin;

-- A safety assessment belongs to a Wig_Request, but Manage Patients creates a
-- patient before any request exists. Keep the latest confirmed intake here and
-- copy it into each request-specific assessment when a wig request is made.
create table if not exists public.patient_wig_safety_profiles (
  patient_id integer primary key references public."Patients" ("Patient_ID") on delete cascade,
  has_known_allergies boolean,
  allergy_details text,
  has_sensitive_scalp boolean,
  has_scalp_irritation boolean,
  has_open_scalp_wounds boolean,
  has_medical_restriction boolean,
  medical_restriction_details text,
  information_confirmed boolean not null default false,
  confirmed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.patient_wig_safety_profiles enable row level security;

create or replace function public.save_patient_wig_safety_profile(
  p_patient_id integer,
  p_has_known_allergies boolean,
  p_allergy_details text,
  p_has_sensitive_scalp boolean,
  p_has_scalp_irritation boolean,
  p_has_open_scalp_wounds boolean,
  p_has_medical_restriction boolean,
  p_medical_restriction_details text,
  p_information_confirmed boolean
)
returns public.patient_wig_safety_profiles
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_patient public."Patients"%rowtype;
  v_result public.patient_wig_safety_profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null then raise exception 'Active application user was not found'; end if;

  select * into v_patient from public."Patients" where "Patient_ID" = p_patient_id;
  if v_patient."Patient_ID" is null then raise exception 'Patient was not found'; end if;

  if v_patient."User_ID" is distinct from v_actor.user_id
    and not exists (
      select 1 from public."Hospital_Representative" representative
      where representative."User_ID" = v_actor.user_id
        and representative."Hospital_ID" = v_patient."Hospital_ID"
    )
    and public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin')
  then raise exception 'You cannot update the safety intake for this patient';
  end if;

  if p_has_known_allergies is true and nullif(trim(coalesce(p_allergy_details, '')), '') is null then
    raise exception 'Allergy details are required when known allergies are selected';
  end if;
  if p_has_medical_restriction is true and nullif(trim(coalesce(p_medical_restriction_details, '')), '') is null then
    raise exception 'Medical restriction details are required';
  end if;
  if p_information_confirmed is distinct from true then
    raise exception 'Confirm that the safety information was reviewed with the patient or guardian';
  end if;

  insert into public.patient_wig_safety_profiles (
    patient_id, has_known_allergies, allergy_details, has_sensitive_scalp,
    has_scalp_irritation, has_open_scalp_wounds, has_medical_restriction,
    medical_restriction_details, information_confirmed, confirmed_at, updated_at
  ) values (
    p_patient_id, p_has_known_allergies, nullif(trim(coalesce(p_allergy_details, '')), ''),
    p_has_sensitive_scalp, p_has_scalp_irritation, p_has_open_scalp_wounds,
    p_has_medical_restriction, nullif(trim(coalesce(p_medical_restriction_details, '')), ''),
    true, now(), now()
  )
  on conflict (patient_id) do update set
    has_known_allergies = excluded.has_known_allergies,
    allergy_details = excluded.allergy_details,
    has_sensitive_scalp = excluded.has_sensitive_scalp,
    has_scalp_irritation = excluded.has_scalp_irritation,
    has_open_scalp_wounds = excluded.has_open_scalp_wounds,
    has_medical_restriction = excluded.has_medical_restriction,
    medical_restriction_details = excluded.medical_restriction_details,
    information_confirmed = excluded.information_confirmed,
    confirmed_at = excluded.confirmed_at,
    updated_at = now()
  returning * into v_result;

  return v_result;
end;
$fn$;

create or replace function public.get_patient_wig_safety_profile(p_patient_id integer)
returns public.patient_wig_safety_profiles
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_patient public."Patients"%rowtype;
  v_result public.patient_wig_safety_profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  select * into v_patient from public."Patients" where "Patient_ID" = p_patient_id;

  if v_actor.user_id is null or v_patient."Patient_ID" is null then return null; end if;
  if v_patient."User_ID" is distinct from v_actor.user_id
    and not exists (
      select 1 from public."Hospital_Representative" representative
      where representative."User_ID" = v_actor.user_id
        and representative."Hospital_ID" = v_patient."Hospital_ID"
    )
    and public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin')
  then raise exception 'You cannot view the safety intake for this patient';
  end if;

  select * into v_result from public.patient_wig_safety_profiles where patient_id = p_patient_id;
  return v_result;
end;
$fn$;

-- Keep the patient-level intake current when a later request-specific answer
-- is saved. Staff-owned review fields deliberately remain request-specific.
create or replace function public.sync_request_safety_to_patient_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_patient_id integer;
begin
  select "Patient_ID" into v_patient_id
  from public."Wig_Requests" where "Req_ID" = new.req_id;
  if v_patient_id is null then return new; end if;

  insert into public.patient_wig_safety_profiles (
    patient_id, has_known_allergies, allergy_details, has_sensitive_scalp,
    has_scalp_irritation, has_open_scalp_wounds, has_medical_restriction,
    medical_restriction_details, information_confirmed, confirmed_at, updated_at
  ) values (
    v_patient_id, new.has_known_allergies, new.allergy_details, new.has_sensitive_scalp,
    new.has_scalp_irritation, new.has_open_scalp_wounds, new.has_medical_restriction,
    new.medical_restriction_details, new.information_confirmed, new.confirmed_at, now()
  )
  on conflict (patient_id) do update set
    has_known_allergies = excluded.has_known_allergies,
    allergy_details = excluded.allergy_details,
    has_sensitive_scalp = excluded.has_sensitive_scalp,
    has_scalp_irritation = excluded.has_scalp_irritation,
    has_open_scalp_wounds = excluded.has_open_scalp_wounds,
    has_medical_restriction = excluded.has_medical_restriction,
    medical_restriction_details = excluded.medical_restriction_details,
    information_confirmed = excluded.information_confirmed,
    confirmed_at = excluded.confirmed_at,
    updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists trg_sync_request_safety_to_patient_profile on public.patient_wig_safety_assessments;
create trigger trg_sync_request_safety_to_patient_profile
after insert or update
on public.patient_wig_safety_assessments
for each row execute function public.sync_request_safety_to_patient_profile();

-- Seed the profile from the newest existing request assessment per patient.
insert into public.patient_wig_safety_profiles (
  patient_id, has_known_allergies, allergy_details, has_sensitive_scalp,
  has_scalp_irritation, has_open_scalp_wounds, has_medical_restriction,
  medical_restriction_details, information_confirmed, confirmed_at, created_at, updated_at
)
select distinct on (request_row."Patient_ID")
  request_row."Patient_ID", assessment.has_known_allergies, assessment.allergy_details,
  assessment.has_sensitive_scalp, assessment.has_scalp_irritation,
  assessment.has_open_scalp_wounds, assessment.has_medical_restriction,
  assessment.medical_restriction_details, assessment.information_confirmed,
  assessment.confirmed_at, assessment.created_at, assessment.updated_at
from public.patient_wig_safety_assessments assessment
join public."Wig_Requests" request_row on request_row."Req_ID" = assessment.req_id
order by request_row."Patient_ID", assessment.updated_at desc
on conflict (patient_id) do nothing;

revoke all on function public.save_patient_wig_safety_profile(integer,boolean,text,boolean,boolean,boolean,boolean,text,boolean) from public, anon;
revoke all on function public.get_patient_wig_safety_profile(integer) from public, anon;
grant execute on function public.save_patient_wig_safety_profile(integer,boolean,text,boolean,boolean,boolean,boolean,text,boolean) to authenticated;
grant execute on function public.get_patient_wig_safety_profile(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
