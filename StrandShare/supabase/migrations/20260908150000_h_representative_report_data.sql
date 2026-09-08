begin;

-- Return one hospital-scoped report payload. Direct client joins across
-- Patients, users, user_details, Wig_Requests, and Release_Schedules can fail
-- independently under RLS and used to leave the whole Reports page empty.
create or replace function public.get_h_representative_report_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_hospital_id integer;
  v_hospital_name text;
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) <> 'hrepresentative'
  then
    raise exception 'Only an active H-Representative can access hospital reports.';
  end if;

  select assignment."Hospital_ID" into v_hospital_id
  from public."Hospital_Representative" assignment
  where assignment."User_ID" = v_actor.user_id
  order by assignment."Hospital_ID"
  limit 1;

  -- Newer H-Representative accounts are also linked as the hospital manager.
  if v_hospital_id is null then
    select hospital."Hospital_ID" into v_hospital_id
    from public."Hospitals" hospital
    where hospital."Created_By" = v_actor.user_id
    order by hospital."Hospital_ID"
    limit 1;
  end if;

  if v_hospital_id is null then
    raise exception 'No hospital assignment was found for this H-Representative account.';
  end if;

  select hospital."Hospital_Name" into v_hospital_name
  from public."Hospitals" hospital
  where hospital."Hospital_ID" = v_hospital_id;

  return jsonb_build_object(
    'hospital_id', v_hospital_id,
    'hospital_name', coalesce(v_hospital_name, ''),
    'release_workflow_available', true,
    'requests', coalesce((
      select jsonb_agg(to_jsonb(request_row) order by request_row."Request_Date" desc)
      from (
        select
          request."Req_ID",
          request."Patient_ID",
          request."Status",
          request."Request_Date",
          request."Updated_At",
          request."Status_Reason"
        from public."Wig_Requests" request
        where request."Hospital_ID" = v_hospital_id
      ) request_row
    ), '[]'::jsonb),
    'patients', coalesce((
      select jsonb_agg(to_jsonb(patient_row) order by patient_row."Patient_ID")
      from (
        select
          patient."Patient_ID",
          patient."Patient_Code",
          patient."Medical_Condition",
          patient."User_ID",
          patient."Date_of_Diagnosis",
          patient."Guardian",
          patient."Guardian_Contact_Number",
          patient."Created_At"
        from public."Patients" patient
        where patient."Hospital_ID" = v_hospital_id
      ) patient_row
    ), '[]'::jsonb),
    'patient_users', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', account.user_id,
          'email', account.email,
          'user_details', jsonb_build_object(
            'first_name', details.first_name,
            'middle_name', details.middle_name,
            'last_name', details.last_name,
            'suffix', details.suffix,
            'birthdate', details.birthdate,
            'gender', details.gender,
            'contact_number', details.contact_number
          )
        ) order by account.user_id
      )
      from public."Patients" patient
      join public.users account on account.user_id = patient."User_ID"
      left join public.user_details details on details.user_id = account.user_id
      where patient."Hospital_ID" = v_hospital_id
    ), '[]'::jsonb),
    'release_schedules', coalesce((
      select jsonb_agg(to_jsonb(schedule_row) order by schedule_row."Created_At" desc)
      from (
        select
          schedule."Release_Schedule_ID",
          schedule."Req_ID",
          schedule."Proposed_Release_Date",
          schedule."Hospital_Decision",
          schedule."Hospital_Decision_Reason",
          schedule."Is_Current",
          schedule."Created_At",
          schedule."Updated_At"
        from public."Release_Schedules" schedule
        join public."Wig_Requests" request on request."Req_ID" = schedule."Req_ID"
        where request."Hospital_ID" = v_hospital_id
      ) schedule_row
    ), '[]'::jsonb)
  );
end;
$fn$;

revoke all on function public.get_h_representative_report_data()
  from public, anon;
grant execute on function public.get_h_representative_report_data()
  to authenticated;

comment on function public.get_h_representative_report_data()
  is 'Returns the signed-in H-Representative report data, restricted to their assigned hospital.';

notify pgrst, 'reload schema';
commit;
