begin;

-- Hospital representatives record the patient/guardian answers. Individual
-- answers are nullable (Not provided); the single accuracy confirmation is
-- stored separately in information_confirmed. Staff owns the review fields.
create or replace function public.save_wig_request_safety_assessment(
  p_req_id integer,
  p_has_known_allergies boolean,
  p_allergy_details text,
  p_has_sensitive_scalp boolean,
  p_has_scalp_irritation boolean,
  p_has_open_scalp_wounds boolean,
  p_has_medical_restriction boolean,
  p_medical_restriction_details text,
  p_information_confirmed boolean
)
returns public.patient_wig_safety_assessments
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_result public.patient_wig_safety_assessments%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;
  if v_actor.user_id is null then raise exception 'Active application user was not found'; end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;

  if v_request."Requested_By" is distinct from v_actor.user_id
    and not exists (
      select 1 from public."Hospital_Representative" representative
      where representative."User_ID" = v_actor.user_id
        and representative."Hospital_ID" = v_request."Hospital_ID"
    )
    and not exists (
      select 1 from public."Patients" patient
      where patient."Patient_ID" = v_request."Patient_ID"
        and patient."User_ID" = v_actor.user_id
    )
    and public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin')
  then
    raise exception 'You cannot update the safety assessment for this request';
  end if;

  if p_has_known_allergies is true
    and nullif(trim(coalesce(p_allergy_details, '')), '') is null
  then raise exception 'Allergy details are required when known allergies are selected';
  end if;
  if p_has_medical_restriction is true
    and nullif(trim(coalesce(p_medical_restriction_details, '')), '') is null
  then raise exception 'Medical restriction details are required';
  end if;

  insert into public.patient_wig_safety_assessments (
    req_id, has_known_allergies, allergy_details, has_sensitive_scalp,
    has_scalp_irritation, has_open_scalp_wounds, has_medical_restriction,
    medical_restriction_details, information_confirmed, confirmed_at,
    review_status, reviewed_by, reviewed_at, review_notes, updated_at
  ) values (
    p_req_id, p_has_known_allergies,
    nullif(trim(coalesce(p_allergy_details, '')), ''),
    p_has_sensitive_scalp, p_has_scalp_irritation, p_has_open_scalp_wounds,
    p_has_medical_restriction,
    nullif(trim(coalesce(p_medical_restriction_details, '')), ''),
    p_information_confirmed,
    case when p_information_confirmed then now() else null end,
    'Pending', null, null, null, now()
  )
  on conflict (req_id) do update set
    has_known_allergies = excluded.has_known_allergies,
    allergy_details = excluded.allergy_details,
    has_sensitive_scalp = excluded.has_sensitive_scalp,
    has_scalp_irritation = excluded.has_scalp_irritation,
    has_open_scalp_wounds = excluded.has_open_scalp_wounds,
    has_medical_restriction = excluded.has_medical_restriction,
    medical_restriction_details = excluded.medical_restriction_details,
    information_confirmed = excluded.information_confirmed,
    confirmed_at = excluded.confirmed_at,
    review_status = 'Pending',
    reviewed_by = null,
    reviewed_at = null,
    review_notes = null,
    updated_at = now()
  returning * into v_result;

  return v_result;
end;
$fn$;

revoke all on function public.save_wig_request_safety_assessment(
  integer, boolean, text, boolean, boolean, boolean, boolean, text, boolean
) from public, anon;
grant execute on function public.save_wig_request_safety_assessment(
  integer, boolean, text, boolean, boolean, boolean, boolean, text, boolean
) to authenticated;

notify pgrst, 'reload schema';
commit;
