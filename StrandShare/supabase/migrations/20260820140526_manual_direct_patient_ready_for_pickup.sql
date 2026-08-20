begin;

drop trigger if exists trg_00_normalize_direct_patient_ready_for_pickup on public."Wig_Requests";
drop function if exists public.normalize_direct_patient_ready_for_pickup();

update public."Wig_Requests"
set "Status" = 'Accepted - Wig Allocated',
    "Updated_At" = timezone('Asia/Manila', now())
where "Hospital_ID" is null
  and "Allocated_Wig_ID" is not null
  and public.normalize_flow_key("Status") = 'readyforpickup';

create or replace function public.staff_mark_wig_ready_for_pickup(p_req_id integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_patient_user_id integer;
  v_recipient integer;
  v_updated_at timestamp without time zone := timezone('Asia/Manila', now());
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
    raise exception 'Only active staff or admin accounts can mark a wig ready for pick-up';
  end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = p_req_id
  for update;

  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if v_request."Hospital_ID" is not null then
    raise exception 'Ready for Pick-up is only available for a patient request without a hospital';
  end if;
  if public.normalize_flow_key(v_request."Status") <> 'acceptedwigallocated' then
    raise exception 'Only an Accepted - Wig Allocated request can be marked Ready for Pick-up';
  end if;
  if v_request."Allocated_Wig_ID" is null then
    raise exception 'The request has no allocated wig';
  end if;

  update public."Wig_Requests"
  set "Status" = 'Ready for Pick-up',
      "Status_Reason" = null,
      "Updated_At" = v_updated_at
  where "Req_ID" = p_req_id
  returning * into v_request;

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
      v_recipient,
      'Wig Request',
      'Wig ready for pick-up',
      format('%s is ready for pick-up.', coalesce(v_request."Request_Code", 'Your wig request')),
      'Unread',
      'Wig_Requests',
      p_req_id::text,
      v_updated_at
    );
  end loop;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_actor.user_id,
    'wig_requests.mark_ready_for_pickup',
    format('request_id=%s allocated_wig_id=%s pickup_mode=direct_patient', p_req_id, v_request."Allocated_Wig_ID"),
    v_actor.email,
    'Wig_Requests',
    'success'
  );

  return jsonb_build_object(
    'request', to_jsonb(v_request),
    'updated_at', v_updated_at
  );
end;
$fn$;

revoke all on function public.staff_mark_wig_ready_for_pickup(integer) from public, anon;
grant execute on function public.staff_mark_wig_ready_for_pickup(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
