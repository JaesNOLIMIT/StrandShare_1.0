begin;

create index if not exists patient_wig_safety_assessments_review_status_idx
  on public.patient_wig_safety_assessments (review_status, created_at desc);

alter table public.patient_wig_safety_assessments enable row level security;
grant select, insert, update on public.patient_wig_safety_assessments to authenticated;
grant usage, select on sequence public.patient_wig_safety_assessments_assessment_id_seq to authenticated;

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
  select * into v_actor from public.users actor
  where actor.auth_user_id = auth.uid() and actor.is_active is distinct from false limit 1;
  if v_actor.user_id is null then raise exception 'Active application user was not found'; end if;

  select * into v_request from public."Wig_Requests" request_row where request_row."Req_ID" = p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;

  if v_request."Requested_By" is distinct from v_actor.user_id
    and not exists (
      select 1 from public."Patients" patient
      where patient."Patient_ID" = v_request."Patient_ID" and patient."User_ID" = v_actor.user_id
    )
    and public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin')
  then
    raise exception 'You cannot update the safety assessment for this request';
  end if;

  if p_has_known_allergies is true and nullif(trim(coalesce(p_allergy_details, '')), '') is null then
    raise exception 'Allergy details are required when known allergies are selected';
  end if;
  if p_has_medical_restriction is true and nullif(trim(coalesce(p_medical_restriction_details, '')), '') is null then
    raise exception 'Medical restriction details are required';
  end if;

  insert into public.patient_wig_safety_assessments (
    req_id, has_known_allergies, allergy_details, has_sensitive_scalp,
    has_scalp_irritation, has_open_scalp_wounds, has_medical_restriction,
    medical_restriction_details, information_confirmed, confirmed_at,
    review_status, reviewed_by, reviewed_at, review_notes, updated_at
  ) values (
    p_req_id, p_has_known_allergies,
    case when p_has_known_allergies then nullif(trim(coalesce(p_allergy_details, '')), '') else null end,
    p_has_sensitive_scalp, p_has_scalp_irritation, p_has_open_scalp_wounds,
    p_has_medical_restriction,
    case when p_has_medical_restriction then nullif(trim(coalesce(p_medical_restriction_details, '')), '') else null end,
    p_information_confirmed, case when p_information_confirmed then now() else null end,
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

revoke all on function public.save_wig_request_safety_assessment(integer, boolean, text, boolean, boolean, boolean, boolean, text, boolean)
from public, anon;
grant execute on function public.save_wig_request_safety_assessment(integer, boolean, text, boolean, boolean, boolean, boolean, text, boolean)
to authenticated;

create or replace function public.review_wig_request_transactional(
  p_req_id integer,
  p_action text,
  p_wig_specification_id integer default null,
  p_reason text default null,
  p_safety_review_status text default null,
  p_safety_review_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_action text := public.normalize_flow_key(p_action);
  v_status_key text;
  v_target_wig_id integer;
  v_target_stock integer;
  v_next_stock integer;
  v_patient_user_id integer;
  v_message text;
  v_recipient integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin')
  then
    raise exception 'Only active staff or admin accounts can review wig requests';
  end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = p_req_id
  for update;

  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  v_status_key := public.normalize_flow_key(v_request."Status");

  if p_safety_review_status is not null then
    if p_safety_review_status not in ('Pending', 'Cleared', 'Needs Clarification', 'Requires Medical Clearance') then
      raise exception 'Invalid safety review status';
    end if;

    update public.patient_wig_safety_assessments
    set review_status = p_safety_review_status,
        reviewed_by = v_actor.user_id,
        reviewed_at = now(),
        review_notes = nullif(trim(coalesce(p_safety_review_notes, '')), ''),
        updated_at = now()
    where req_id = p_req_id;
  end if;

  if v_action = 'acceptallocated' then
    if v_status_key not in ('pending', 'pendingreview', 'acceptednowigavailable') then
      raise exception 'This request can no longer be allocated from stock';
    end if;
    if p_wig_specification_id is null then raise exception 'Choose the requested wig specification'; end if;
    if v_request."Requested_Wig_Specification_ID" is not null
      and v_request."Requested_Wig_Specification_ID" <> p_wig_specification_id
    then
      raise exception 'Allocated specification must match the requested specification';
    end if;

    select specification."Wig_ID", greatest(0, coalesce(wig."Stock_Count", 0))
    into v_target_wig_id, v_target_stock
    from public."Wig_Specifications" specification
    join public."Wigs" wig on wig."Wig_ID" = specification."Wig_ID"
    where specification."Wig_Specification_ID" = p_wig_specification_id
    for update of wig;

    if v_target_wig_id is null then raise exception 'Selected wig specification was not found'; end if;

    if v_request."Allocated_Wig_ID" is distinct from v_target_wig_id then
      if v_target_stock <= 0 then raise exception 'Selected wig is out of stock'; end if;

      if v_request."Allocated_Wig_ID" is not null then
        update public."Wigs"
        set "Stock_Count" = greatest(0, coalesce("Stock_Count", 0)) + 1,
            "Wig_Status" = 'available',
            "Updated_At" = timezone('Asia/Manila', now())
        where "Wig_ID" = v_request."Allocated_Wig_ID";
      end if;

      v_next_stock := v_target_stock - 1;
      perform set_config('wig.stock_reason', format('Reserved immediately for request %s', p_req_id), true);
      update public."Wigs"
      set "Stock_Count" = v_next_stock,
          "Wig_Status" = case when v_next_stock > 0 then 'available' else 'not available' end,
          "Updated_At" = timezone('Asia/Manila', now())
      where "Wig_ID" = v_target_wig_id;
    else
      v_next_stock := v_target_stock;
    end if;

    update public."Wig_Requests"
    set "Status" = 'Accepted - Wig Allocated',
        "Allocated_Wig_ID" = v_target_wig_id,
        "Approved_By" = v_actor.user_id,
        "Approved_At" = timezone('Asia/Manila', now()),
        "Fulfillment_Status" = 'catalog_allocated',
        "Status_Reason" = null,
        "Updated_At" = timezone('Asia/Manila', now())
    where "Req_ID" = p_req_id
    returning * into v_request;

    v_message := format('%s was accepted and a matching wig was reserved immediately.', coalesce(v_request."Request_Code", 'Your wig request'));

  elsif v_action = 'acceptproductionrequired' then
    if v_status_key not in ('pending', 'pendingreview', 'acceptednowigavailable') then
      raise exception 'This request can no longer be sent to production';
    end if;

    if v_request."Allocated_Wig_ID" is not null then
      update public."Wigs"
      set "Stock_Count" = greatest(0, coalesce("Stock_Count", 0)) + 1,
          "Wig_Status" = 'available',
          "Updated_At" = timezone('Asia/Manila', now())
      where "Wig_ID" = v_request."Allocated_Wig_ID";
    end if;

    update public."Wig_Requests"
    set "Status" = 'Accepted - In Production',
        "Allocated_Wig_ID" = null,
        "Approved_By" = v_actor.user_id,
        "Approved_At" = timezone('Asia/Manila', now()),
        "Is_Wish_Request" = true,
        "Fulfillment_Status" = 'awaiting_production',
        "Status_Reason" = nullif(trim(coalesce(p_reason, '')), ''),
        "Updated_At" = timezone('Asia/Manila', now())
    where "Req_ID" = p_req_id
    returning * into v_request;

    v_message := format('%s was accepted for priority production because matching stock is unavailable.', coalesce(v_request."Request_Code", 'Your wig request'));

  elsif v_action = 'reject' then
    if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'A rejection reason is required'; end if;
    if v_status_key not in ('pending', 'pendingreview', 'acceptednowigavailable') then
      raise exception 'This request can no longer be rejected';
    end if;

    if v_request."Allocated_Wig_ID" is not null then
      update public."Wigs"
      set "Stock_Count" = greatest(0, coalesce("Stock_Count", 0)) + 1,
          "Wig_Status" = 'available',
          "Updated_At" = timezone('Asia/Manila', now())
      where "Wig_ID" = v_request."Allocated_Wig_ID";
    end if;

    update public."Wig_Requests"
    set "Status" = 'Rejected',
        "Allocated_Wig_ID" = null,
        "Approved_By" = v_actor.user_id,
        "Approved_At" = timezone('Asia/Manila', now()),
        "Fulfillment_Status" = 'rejected',
        "Status_Reason" = trim(p_reason),
        "Updated_At" = timezone('Asia/Manila', now())
    where "Req_ID" = p_req_id
    returning * into v_request;

    v_message := format('%s was rejected. Reason: %s', coalesce(v_request."Request_Code", 'Your wig request'), trim(p_reason));
  else
    raise exception 'Unsupported wig-request decision';
  end if;

  select patient."User_ID" into v_patient_user_id
  from public."Patients" patient
  where patient."Patient_ID" = v_request."Patient_ID";

  for v_recipient in
    select distinct recipient_id
    from (values (v_request."Requested_By"), (v_patient_user_id)) recipients(recipient_id)
    where recipient_id is not null
  loop
    insert into public."Notification" (
      "User_ID", "Type", "Title", "Message", "Status", "Reference_Type", "Reference_ID", "Updated_At"
    ) values (
      v_recipient, 'Wig Request', 'Wig request updated', v_message, 'Unread', 'Wig_Requests', p_req_id::text,
      timezone('Asia/Manila', now())
    );
  end loop;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_actor.user_id, 'wig_requests.review_transactional',
    format('request_id=%s action=%s allocated_wig_id=%s', p_req_id, v_action, coalesce(v_request."Allocated_Wig_ID"::text, 'none')),
    v_actor.email, 'Wig_Requests', 'success'
  );

  return jsonb_build_object(
    'request', to_jsonb(v_request),
    'action', v_action,
    'remaining_stock', v_next_stock
  );
end;
$fn$;

revoke all on function public.review_wig_request_transactional(integer, text, integer, text, text, text)
from public, anon;
grant execute on function public.review_wig_request_transactional(integer, text, integer, text, text, text)
to authenticated;

create or replace function public.complete_wig_request_or_stock_from_bundle_scan(
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_result jsonb;
  v_bundle_id integer;
  v_request_id integer;
  v_wig_id integer;
  v_request public."Wig_Requests"%rowtype;
  v_current_stock integer;
  v_patient_user_id integer;
  v_message text;
  v_recipient integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('specialist', 'admin', 'superadmin') then
    raise exception 'Only active specialist or admin accounts can complete a bundle';
  end if;

  v_result := public.complete_wig_stock_from_bundle_scan(p_waybill_payload);
  v_bundle_id := nullif(v_result -> 'bundle' ->> 'Bundle_ID', '')::integer;
  v_wig_id := nullif(v_result -> 'wig' ->> 'Wig_ID', '')::integer;

  select bundle."Wig_Request_ID" into v_request_id
  from public."Hair_Submission_Bundles" bundle
  where bundle."Bundle_ID" = v_bundle_id;

  if v_request_id is null then
    return v_result || jsonb_build_object('direct_to_request', false);
  end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = v_request_id
  for update;

  perform set_config('wig.stock_reason', format('Reserved completed bundle %s directly for request %s', v_bundle_id, v_request_id), true);
  update public."Wigs"
  set "Stock_Count" = greatest(0, coalesce("Stock_Count", 0) - 1),
      "Wig_Status" = case when greatest(0, coalesce("Stock_Count", 0) - 1) > 0 then 'available' else 'not available' end,
      "Updated_At" = timezone('Asia/Manila', now())
  where "Wig_ID" = v_wig_id
  returning "Stock_Count" into v_current_stock;

  update public."Wig_Requests"
  set "Allocated_Wig_ID" = v_wig_id,
      "Status" = 'Accepted - Wig Allocated',
      "Fulfillment_Status" = 'fulfilled',
      "Fulfillment_Bundle_ID" = v_bundle_id,
      "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = v_request_id
  returning * into v_request;

  select patient."User_ID" into v_patient_user_id
  from public."Patients" patient
  where patient."Patient_ID" = v_request."Patient_ID";
  v_message := format('%s is complete and the newly produced wig has been reserved for this request.', coalesce(v_request."Request_Code", 'Your requested wig'));

  for v_recipient in
    select distinct recipient_id
    from (values (v_request."Requested_By"), (v_patient_user_id)) recipients(recipient_id)
    where recipient_id is not null
  loop
    insert into public."Notification" (
      "User_ID", "Type", "Title", "Message", "Status", "Reference_Type", "Reference_ID", "Updated_At"
    ) values (
      v_recipient, 'Wig Request', 'Requested wig completed', v_message, 'Unread', 'Wig_Requests', v_request_id::text,
      timezone('Asia/Manila', now())
    );
  end loop;

  return v_result || jsonb_build_object(
    'direct_to_request', true,
    'request', to_jsonb(v_request),
    'next_stock', v_current_stock
  );
end;
$fn$;

revoke all on function public.complete_wig_request_or_stock_from_bundle_scan(text) from public, anon;
grant execute on function public.complete_wig_request_or_stock_from_bundle_scan(text) to authenticated;

notify pgrst, 'reload schema';
commit;
