-- Make direct-patient appeal completion follow the normal pickup lifecycle.

begin;

alter table public.wig_release_appeals
  drop constraint if exists wig_release_appeals_return_status_check;
alter table public.wig_release_appeals
  add constraint wig_release_appeals_return_status_check check (
    return_status is null or return_status in (
      'Awaiting Return', 'In Transit', 'Return Received', 'Under Repair',
      'Ready for Pick-up', 'Ready for Re-release', 'Return Completed', 'Completed'
    )
  );

create or replace function public.staff_update_wig_return(
  p_appeal_id bigint,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_appeal public.wig_release_appeals%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_next_status text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin') then
    raise exception 'Only active staff or admin accounts can update returned wigs';
  end if;

  select * into v_appeal
  from public.wig_release_appeals
  where appeal_id = p_appeal_id
  for update;
  if v_appeal.appeal_id is null then raise exception 'After-release concern was not found'; end if;

  select * into v_request
  from public."Wig_Requests"
  where "Req_ID" = v_appeal.req_id
  for update;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;

  if v_action = 'receive' and v_appeal.return_status = 'In Transit' then
    v_next_status := case when v_appeal.requested_resolution = 'Return and Close' then 'Return Completed' else 'Return Received' end;
  elsif v_action = 'start_repair' and v_appeal.return_status = 'Return Received'
    and v_appeal.requested_resolution = 'Repair or Replace' then
    v_next_status := 'Under Repair';
  elsif v_action = 'complete_repair' and v_appeal.return_status = 'Under Repair'
    and v_appeal.requested_resolution = 'Repair or Replace' then
    v_next_status := case
      when v_request."Hospital_ID" is null then 'Ready for Pick-up'
      else 'Ready for Re-release'
    end;
  else
    raise exception 'That action is not valid for this concern and requested outcome';
  end if;

  update public.wig_release_appeals set
    return_status = v_next_status,
    return_received_at = case when v_action = 'receive' then v_now else return_received_at end,
    repair_started_at = case when v_action = 'start_repair' then v_now else repair_started_at end,
    repair_completed_at = case when v_action = 'complete_repair' then v_now else repair_completed_at end,
    return_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), return_note),
    return_updated_by = v_actor.user_id,
    updated_at = v_now
  where appeal_id = p_appeal_id
  returning * into v_appeal;

  if v_next_status in ('Ready for Pick-up', 'Ready for Re-release') then
    update public."Release_Schedules"
    set "Is_Current" = false, "Updated_At" = v_now
    where "Req_ID" = v_appeal.req_id and "Is_Current" = true;
  end if;

  return to_jsonb(v_appeal);
end;
$fn$;

revoke all on function public.staff_update_wig_return(bigint,text,text) from public,anon;
grant execute on function public.staff_update_wig_return(bigint,text,text) to authenticated;

create or replace function public.sync_wig_request_appeal_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now timestamp without time zone := timezone('Asia/Manila',now());
  v_request public."Wig_Requests"%rowtype;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
begin
  if new.return_status='Completed' then return new; end if;
  if new.status='Rejected' then
    update public."Wig_Requests" set "Status"='Released',"Status_Reason"='After-release concern was not accepted; the original release remains complete',"Updated_At"=v_now where "Req_ID"=new.req_id;
  elsif new.return_status='Return Completed' then
    select * into v_request from public."Wig_Requests" where "Req_ID"=new.req_id for update;
    if old.return_status is distinct from 'Return Completed' and v_request."Allocated_Wig_ID" is not null then
      perform set_config('wig.stock_reason',format('Returned wig from request %s restored to stock',new.req_id),true);
      update public."Wigs" set "Stock_Count"=greatest(0,coalesce("Stock_Count",0))+1,
        "Wig_Status"='available',"Updated_At"=v_now where "Wig_ID"=v_request."Allocated_Wig_ID";
      if v_request."Fulfillment_Bundle_ID" is not null then
        update public."Hair_Submission_Bundles" set "Allocated_To_Wig_Request_ID"=null,
          "Allocated_At"=null,"Allocated_By"=null,"Returned_To_Stock_At"=v_now,"Updated_At"=v_now
        where "Bundle_ID"=v_request."Fulfillment_Bundle_ID" returning * into v_bundle;
      end if;
    end if;
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='Returned - Completed',
      "Status_Reason"='Returned wig received and restored to available stock; request closed',"Updated_At"=v_now where "Req_ID"=new.req_id;
  elsif new.return_status='Ready for Pick-up' then
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='Ready for Pick-up',
      "Status_Reason"='Repair completed; ready for direct patient pickup',"Updated_At"=v_now where "Req_ID"=new.req_id;
  elsif new.return_status='Ready for Re-release' then
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='To Be Release',
      "Status_Reason"='Repair completed; waiting for a new release schedule',"Updated_At"=v_now where "Req_ID"=new.req_id;
  else
    update public."Wig_Requests" set "Status"='Appealed',"Status_Reason"=case
      when new.status='Pending Staff Review' then 'After-release concern awaiting Staff confirmation'
      when new.return_status='Awaiting Return' then 'Concern confirmed; waiting for wig return'
      when new.return_status='In Transit' then 'Wig return is in transit'
      when new.return_status='Return Received' then 'Returned wig waiting for repair or replacement'
      when new.return_status='Under Repair' then 'Returned wig is under repair or replacement'
      else 'After-release concern is active' end,"Updated_At"=v_now where "Req_ID"=new.req_id;
  end if;
  return new;
end;
$fn$;

create or replace function public.create_wig_release_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_released_at timestamp without time zone := coalesce(new."Updated_At", timezone('Asia/Manila', now()));
  v_cycle integer;
  v_terms text := 'By confirming receipt, the hospital representative acknowledges that the wig was received on behalf of the named patient. The wig must be inspected promptly. A problem may be reported within seven calendar days after staff confirms release and must include at least one clear photo. Staff confirms the reported problem before return instructions appear. The representative may request repair or replacement, or return the wig and close the request.';
begin
  if public.normalize_flow_key(new."Status") = 'released'
    and (tg_op = 'INSERT' or public.normalize_flow_key(old."Status") is distinct from 'released')
    and coalesce(new."Status_Reason", '') not like 'Appeal rejected;%'
    and coalesce(new."Status_Reason", '') not like 'After-release concern was not accepted;%'
  then
    select coalesce(max(release_cycle), 0) + 1 into v_cycle
    from public.wig_release_receipts where req_id = new."Req_ID";

    insert into public.wig_release_receipts (
      req_id, release_cycle, released_at, appeal_deadline,
      terms_version, terms_snapshot, updated_at
    ) values (
      new."Req_ID", v_cycle, v_released_at, v_released_at + interval '7 days',
      '2026-09-07-v3', v_terms, v_released_at
    );

    update public.wig_release_appeals
    set return_status = 'Completed', updated_at = v_released_at
    where req_id = new."Req_ID"
      and return_status in ('Ready for Pick-up', 'Ready for Re-release');
  end if;
  return new;
end;
$fn$;

-- Convert direct-patient concerns already waiting in the generic re-release
-- state. This update also fires the lifecycle trigger and restores the request
-- to Ready for Pick-up.
update public.wig_release_appeals appeal
set
  return_status = 'Ready for Pick-up',
  updated_at = timezone('Asia/Manila',now())
where appeal.return_status = 'Ready for Re-release'
  and exists (
    select 1
    from public."Wig_Requests" request
    where request."Req_ID" = appeal.req_id
      and request."Hospital_ID" is null
  );

notify pgrst, 'reload schema';

commit;
