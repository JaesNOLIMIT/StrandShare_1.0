begin;

create or replace function public.staff_complete_wig_release(p_req_id integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_schedule public."Release_Schedules"%rowtype;
  v_patient_user_id integer;
  v_recipient integer;
  v_completed_at timestamp without time zone := timezone('Asia/Manila', now());
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
    raise exception 'Only active staff or admin accounts can complete a wig release';
  end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = p_req_id
  for update;

  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if public.normalize_flow_key(v_request."Status") <> 'releasing' then
    raise exception 'Only a Releasing request can be marked Released';
  end if;
  if v_request."Allocated_Wig_ID" is null then
    raise exception 'The request has no allocated wig to release';
  end if;

  select * into v_schedule
  from public."Release_Schedules" schedule
  where schedule."Req_ID" = p_req_id
    and schedule."Is_Current" = true
  order by schedule."Release_Schedule_ID" desc
  limit 1
  for update;

  if v_schedule."Release_Schedule_ID" is null then
    raise exception 'The request has no current release schedule';
  end if;
  if public.normalize_flow_key(v_schedule."Hospital_Decision") <> 'approved' then
    raise exception 'The hospital must approve the release schedule before final release';
  end if;

  update public."Wig_Requests"
  set "Status" = 'Released',
      "Status_Reason" = null,
      "Updated_At" = v_completed_at
  where "Req_ID" = p_req_id
  returning * into v_request;

  update public."Release_Schedules"
  set "Updated_At" = v_completed_at
  where "Release_Schedule_ID" = v_schedule."Release_Schedule_ID"
  returning * into v_schedule;

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
      'Wig released',
      format('%s has been released successfully.', coalesce(v_request."Request_Code", 'Your wig request')),
      'Unread',
      'Wig_Requests',
      p_req_id::text,
      v_completed_at
    );
  end loop;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_actor.user_id,
    'wig_requests.complete_release',
    format('request_id=%s schedule_id=%s allocated_wig_id=%s', p_req_id, v_schedule."Release_Schedule_ID", v_request."Allocated_Wig_ID"),
    v_actor.email,
    'Wig_Requests',
    'success'
  );

  return jsonb_build_object(
    'request', to_jsonb(v_request),
    'schedule', to_jsonb(v_schedule),
    'completed_at', v_completed_at
  );
end;
$fn$;

revoke all on function public.staff_complete_wig_release(integer) from public, anon;
grant execute on function public.staff_complete_wig_release(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
