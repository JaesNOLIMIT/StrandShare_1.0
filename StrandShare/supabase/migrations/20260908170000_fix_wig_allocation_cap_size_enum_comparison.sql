begin;

-- Wig_Specifications.Cap_Size is a public.wig_cap_size enum. Coalescing the
-- enum directly with an empty string makes PostgreSQL cast '' to that enum and
-- fail before the scan comparison can be returned. Compare its text form so
-- null/legacy values produce a normal match or mismatch instead of an error.
create or replace function public.preview_wig_request_bundle_scan(
  p_req_id integer,
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_requested public."Wig_Specifications"%rowtype;
  v_actual public."Wig_Specifications"%rowtype;
  v_status text;
  v_fields jsonb;
  v_all_match boolean;
  v_available boolean;
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin')
  then
    raise exception 'Only active Staff or Admin accounts can validate wig allocation scans';
  end if;

  select * into v_request
  from public."Wig_Requests" request
  where request."Req_ID" = p_req_id;

  if v_request."Req_ID" is null then
    raise exception 'Wig request was not found';
  end if;

  select * into v_bundle
  from public."Hair_Submission_Bundles" bundle
  where bundle."Bundle_ID" = public.resolve_wig_bundle_scan_id(p_waybill_payload);

  select * into v_requested
  from public."Wig_Specifications" specification
  where specification."Wig_Specification_ID" = v_request."Requested_Wig_Specification_ID";

  select * into v_actual
  from public."Wig_Specifications" specification
  where specification."Wig_Specification_ID" = v_bundle."Wig_Specification_ID";

  if v_requested."Wig_Specification_ID" is null then
    raise exception 'The request has no valid wig specification';
  end if;
  if v_actual."Wig_Specification_ID" is null then
    raise exception 'The scanned wig has no valid wig specification';
  end if;

  v_status := public.normalize_flow_key(v_bundle."Status");
  v_fields := jsonb_build_array(
    jsonb_build_object('key','style','label','Style','requested',v_requested."Style",'actual',v_actual."Style",'match',lower(trim(coalesce(v_requested."Style",'')))=lower(trim(coalesce(v_actual."Style",'')))),
    jsonb_build_object('key','color','label','Hair color','requested',v_requested."Hair_Color",'actual',v_actual."Hair_Color",'match',lower(trim(coalesce(v_requested."Hair_Color",'')))=lower(trim(coalesce(v_actual."Hair_Color",'')))),
    jsonb_build_object('key','length','label','Hair length','requested',v_requested."Hair_Length",'actual',v_actual."Hair_Length",'match',v_requested."Hair_Length" is not distinct from v_actual."Hair_Length"),
    jsonb_build_object('key','texture','label','Hair texture','requested',v_requested."Hair_Texture",'actual',v_actual."Hair_Texture",'match',lower(trim(coalesce(v_requested."Hair_Texture",'')))=lower(trim(coalesce(v_actual."Hair_Texture",'')))),
    jsonb_build_object('key','density','label','Hair density','requested',v_requested."Hair_Density",'actual',v_actual."Hair_Density",'match',lower(trim(coalesce(v_requested."Hair_Density",'')))=lower(trim(coalesce(v_actual."Hair_Density",'')))),
    jsonb_build_object(
      'key','cap_size',
      'label','Cap size',
      'requested',v_requested."Cap_Size"::text,
      'actual',v_actual."Cap_Size"::text,
      'match',lower(trim(coalesce(v_requested."Cap_Size"::text,'')))
        = lower(trim(coalesce(v_actual."Cap_Size"::text,'')))
    )
  );

  select coalesce(bool_and((field ->> 'match')::boolean), false)
  into v_all_match
  from jsonb_array_elements(v_fields) field;

  v_available := (
    (
      v_status in ('wigcreated','wigcompleted')
      and v_bundle."Stock_Added_At" is not null
    )
    or (
      v_status = 'inproduction'
      and v_bundle."Allocated_To_Wig_Request_ID" = p_req_id
    )
  )
  and (
    v_bundle."Allocated_To_Wig_Request_ID" is null
    or v_bundle."Allocated_To_Wig_Request_ID" = p_req_id
  );

  return jsonb_build_object(
    'request_id',p_req_id,
    'bundle_id',v_bundle."Bundle_ID",
    'bundle_code',v_bundle."Bundle_Waybill_Code",
    'bundle_status',v_bundle."Status",
    'requested_specification_id',v_requested."Wig_Specification_ID",
    'actual_specification_id',v_actual."Wig_Specification_ID",
    'fields',v_fields,
    'all_match',v_all_match,
    'available',v_available,
    'can_allocate',v_all_match
      and v_available
      and public.normalize_flow_key(v_request."Status") in (
        'pending','pendingreview','acceptedinproduction','acceptednowigavailable'
      )
  );
end;
$fn$;

revoke all on function public.preview_wig_request_bundle_scan(integer,text)
  from public, anon;
grant execute on function public.preview_wig_request_bundle_scan(integer,text)
  to authenticated;

comment on function public.preview_wig_request_bundle_scan(integer,text)
  is 'Safely compares a scanned physical wig with every requested specification, including enum cap size values.';

notify pgrst, 'reload schema';
commit;
