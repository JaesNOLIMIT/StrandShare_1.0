begin;

-- Staff need to read the current schedule after the privileged scheduling RPC
-- creates it. H-Representative access remains constrained by its own policy.
drop policy if exists release_schedules_select_staff on public."Release_Schedules";
create policy release_schedules_select_staff
on public."Release_Schedules"
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin')
  )
);

-- Release_Schedules is linked to a hospital through Req_ID -> Wig_Requests.
-- The table intentionally has no Hospital_ID column, so do not insert one.
create or replace function public.staff_schedule_wig_release(
  p_req_id integer,
  p_proposed_release_date timestamp with time zone,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_schedule public."Release_Schedules"%rowtype;
  v_local_release_date timestamp without time zone;
  v_patient_user_id integer;
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
    raise exception 'Only active staff or admin accounts can schedule a wig release';
  end if;

  if p_proposed_release_date is null then raise exception 'Release date is required'; end if;
  v_local_release_date := timezone('Asia/Manila', p_proposed_release_date);
  if v_local_release_date::date < (timezone('Asia/Manila', now())::date + 3) then
    raise exception 'The earliest release schedule is three calendar days from today';
  end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = p_req_id
  for update;

  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if public.normalize_flow_key(v_request."Status") not in ('acceptedwigallocated', 'toberelease') then
    raise exception 'Only an allocated wig request can be scheduled for release';
  end if;
  if v_request."Allocated_Wig_ID" is null then
    raise exception 'A wig must be allocated before release scheduling';
  end if;
  if v_request."Hospital_ID" is null then raise exception 'The request has no assigned hospital'; end if;

  perform schedule."Release_Schedule_ID"
  from public."Release_Schedules" schedule
  where schedule."Req_ID" = p_req_id
    and schedule."Is_Current" = true
  order by schedule."Release_Schedule_ID"
  for update;

  update public."Release_Schedules"
  set "Is_Current" = false,
      "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = p_req_id
    and "Is_Current" = true;

  insert into public."Release_Schedules" (
    "Req_ID", "Proposed_Release_Date", "Proposed_By", "Proposal_Note",
    "Hospital_Decision", "Is_Current", "Created_At", "Updated_At"
  ) values (
    p_req_id, v_local_release_date, v_actor.user_id,
    nullif(trim(coalesce(p_note, '')), ''), 'Pending', true,
    timezone('Asia/Manila', now()), timezone('Asia/Manila', now())
  ) returning * into v_schedule;

  update public."Wig_Requests"
  set "Status" = 'To Be Release',
      "Status_Reason" = null,
      "Updated_At" = timezone('Asia/Manila', now())
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
      'Release schedule proposed',
      format('%s is proposed for release on %s and is awaiting hospital confirmation.', coalesce(v_request."Request_Code", 'Your wig request'), to_char(v_local_release_date, 'Mon DD, YYYY HH12:MI AM')),
      'Unread',
      'Wig_Requests',
      p_req_id::text,
      timezone('Asia/Manila', now())
    );
  end loop;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_actor.user_id,
    'wig_requests.schedule_release',
    format('request_id=%s schedule_id=%s proposed_release=%s', p_req_id, v_schedule."Release_Schedule_ID", v_local_release_date),
    v_actor.email,
    'Wig_Requests',
    'success'
  );

  return jsonb_build_object('request', to_jsonb(v_request), 'schedule', to_jsonb(v_schedule));
end;
$fn$;

revoke all on function public.staff_schedule_wig_release(integer, timestamp with time zone, text) from public, anon;
grant execute on function public.staff_schedule_wig_release(integer, timestamp with time zone, text) to authenticated;

notify pgrst, 'reload schema';
commit;
