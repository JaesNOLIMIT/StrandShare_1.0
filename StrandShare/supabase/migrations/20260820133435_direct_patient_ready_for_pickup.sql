begin;

alter table public."Wig_Requests"
  drop constraint if exists wig_requests_status_check;

alter table public."Wig_Requests"
  add constraint wig_requests_status_check check (
    lower(coalesce("Status", '')) = any (array[
      'pending',
      'accepted - wig allocated',
      'accepted - in production',
      'ready for pick-up',
      'to be release',
      'releasing',
      'released',
      'rejected',
      'cancelled'
    ])
  );

create or replace function public.normalize_direct_patient_ready_for_pickup()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new."Hospital_ID" is null
    and public.normalize_flow_key(new."Status") = 'acceptedwigallocated'
    and new."Allocated_Wig_ID" is not null
  then
    new."Status" := 'Ready for Pick-up';
  elsif new."Hospital_ID" is not null
    and public.normalize_flow_key(new."Status") = 'readyforpickup'
  then
    new."Status" := 'Accepted - Wig Allocated';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_00_normalize_direct_patient_ready_for_pickup on public."Wig_Requests";
create trigger trg_00_normalize_direct_patient_ready_for_pickup
before insert or update of "Hospital_ID", "Status", "Allocated_Wig_ID" on public."Wig_Requests"
for each row execute function public.normalize_direct_patient_ready_for_pickup();

create or replace function public.guard_allocated_wig_request_has_wig()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_status_key text := public.normalize_flow_key(new."Status");
begin
  if v_status_key in ('acceptedwigallocated', 'readyforpickup')
    and new."Allocated_Wig_ID" is null
  then
    raise exception '% requires an allocated wig', new."Status";
  end if;

  if v_status_key = 'readyforpickup' and new."Hospital_ID" is not null then
    raise exception 'Ready for Pick-up is only valid for a patient request without a hospital';
  end if;

  return new;
end;
$fn$;

update public."Wig_Requests"
set "Status" = 'Accepted - Wig Allocated',
    "Updated_At" = timezone('Asia/Manila', now())
where "Hospital_ID" is null
  and "Allocated_Wig_ID" is not null
  and public.normalize_flow_key("Status") = 'acceptedwigallocated';

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
  v_is_direct_pickup boolean;
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

  v_is_direct_pickup := v_request."Hospital_ID" is null;

  if v_is_direct_pickup then
    if public.normalize_flow_key(v_request."Status") <> 'readyforpickup' then
      raise exception 'Only a Ready for Pick-up request can be marked Released';
    end if;
  elsif public.normalize_flow_key(v_request."Status") <> 'releasing' then
    raise exception 'Only a Releasing request can be marked Released';
  end if;

  if v_request."Allocated_Wig_ID" is null then
    raise exception 'The request has no allocated wig to release';
  end if;

  if not v_is_direct_pickup then
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
  end if;

  update public."Wig_Requests"
  set "Status" = 'Released',
      "Status_Reason" = null,
      "Updated_At" = v_completed_at
  where "Req_ID" = p_req_id
  returning * into v_request;

  if v_schedule."Release_Schedule_ID" is not null then
    update public."Release_Schedules"
    set "Updated_At" = v_completed_at
    where "Release_Schedule_ID" = v_schedule."Release_Schedule_ID"
    returning * into v_schedule;
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
      v_recipient,
      'Wig Request',
      case when v_is_direct_pickup then 'Wig picked up' else 'Wig released' end,
      format('%s has been %s successfully.',
        coalesce(v_request."Request_Code", 'Your wig request'),
        case when v_is_direct_pickup then 'picked up' else 'released' end),
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
    format(
      'request_id=%s schedule_id=%s allocated_wig_id=%s pickup_mode=%s',
      p_req_id,
      coalesce(v_schedule."Release_Schedule_ID"::text, 'none'),
      v_request."Allocated_Wig_ID",
      case when v_is_direct_pickup then 'direct_patient' else 'hospital' end
    ),
    v_actor.email,
    'Wig_Requests',
    'success'
  );

  return jsonb_build_object(
    'request', to_jsonb(v_request),
    'schedule', case
      when v_schedule."Release_Schedule_ID" is null then null
      else to_jsonb(v_schedule)
    end,
    'pickup_mode', case when v_is_direct_pickup then 'direct_patient' else 'hospital' end,
    'completed_at', v_completed_at
  );
end;
$fn$;

revoke all on function public.staff_complete_wig_release(integer) from public, anon;
grant execute on function public.staff_complete_wig_release(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
