begin;

-- The user reports an after-release concern and chooses the desired outcome.
-- Staff still confirms the concern before any return instructions are shown.
alter table public.wig_release_appeals
  add column if not exists requested_resolution text not null default 'Repair or Replace';

alter table public.wig_release_appeals
  drop constraint if exists wig_release_appeals_requested_resolution_check;
alter table public.wig_release_appeals
  add constraint wig_release_appeals_requested_resolution_check
  check (requested_resolution in ('Repair or Replace', 'Return and Close'));

alter table public.wig_release_appeals
  drop constraint if exists wig_release_appeals_return_status_check;
alter table public.wig_release_appeals
  add constraint wig_release_appeals_return_status_check check (
    return_status is null or return_status in (
      'Awaiting Return', 'In Transit', 'Return Received', 'Under Repair',
      'Ready for Re-release', 'Return Completed', 'Completed'
    )
  );

alter table public."Wig_Requests"
  drop constraint if exists wig_requests_status_check;
alter table public."Wig_Requests"
  add constraint wig_requests_status_check check (
    lower(coalesce("Status", '')) = any (array[
      'pending', 'accepted - wig allocated', 'accepted - in production',
      'ready for pick-up', 'to be release', 'releasing', 'released',
      'appealed', 'returned - completed', 'rejected', 'cancelled'
    ])
  );

-- The index is the concurrency-safe guarantee; the trigger below provides a
-- clearer message before an ordinary duplicate request reaches this index.
create unique index if not exists uq_wig_requests_one_active_per_patient
  on public."Wig_Requests" ("Patient_ID")
  where lower(coalesce("Status", '')) not in (
    'released', 'returned - completed', 'rejected', 'cancelled'
  );

create or replace function public.guard_one_active_wig_request_per_patient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (
    select 1
    from public."Wig_Requests" existing
    where existing."Patient_ID" = new."Patient_ID"
      and existing."Req_ID" is distinct from new."Req_ID"
      and public.normalize_flow_key(existing."Status") not in (
        'released', 'returnedcompleted', 'rejected', 'cancelled'
      )
  ) then
    raise exception 'This patient already has an ongoing wig request. Finish or close it before creating another request.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_one_active_wig_request_per_patient on public."Wig_Requests";
create trigger trg_guard_one_active_wig_request_per_patient
before insert or update of "Patient_ID"
on public."Wig_Requests"
for each row execute function public.guard_one_active_wig_request_per_patient();

drop function if exists public.hrep_submit_wig_release_appeal(integer,text,text,jsonb);
create function public.hrep_submit_wig_release_appeal(
  p_req_id integer,
  p_reason text,
  p_requested_resolution text,
  p_description text default null,
  p_evidence_paths jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_receipt public.wig_release_receipts%rowtype;
  v_appeal public.wig_release_appeals%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_photo_count integer;
begin
  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null then raise exception 'Authentication required'; end if;

  select * into v_request from public."Wig_Requests" where "Req_ID" = p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if public.normalize_flow_key(v_request."Status") <> 'released' then
    raise exception 'Only a Released wig request can report a new concern';
  end if;
  if exists (
    select 1 from public."Wig_Requests" active_request
    where active_request."Patient_ID" = v_request."Patient_ID"
      and active_request."Req_ID" <> v_request."Req_ID"
      and public.normalize_flow_key(active_request."Status") not in (
        'released', 'returnedcompleted', 'rejected', 'cancelled'
      )
  ) then
    raise exception 'This patient already has another ongoing wig request. Complete it before reopening an older release concern.';
  end if;
  if not exists (
    select 1 from public."Hospital_Representative" assignment
    where assignment."User_ID" = v_actor.user_id
      and assignment."Hospital_ID" = v_request."Hospital_ID"
  ) then raise exception 'You are not authorized for this hospital request'; end if;

  select * into v_receipt from public.wig_release_receipts
  where req_id = p_req_id order by release_cycle desc limit 1 for update;
  if v_receipt.receipt_id is null or v_receipt.terms_accepted_at is null then
    raise exception 'Confirm receipt and accept the terms before reporting a concern';
  end if;
  if v_now > v_receipt.appeal_deadline then raise exception 'The seven-day reporting period has ended'; end if;
  if trim(coalesce(p_reason, '')) not in ('Damaged on Receipt', 'Wrong Wig', 'Poor Fit', 'Other') then
    raise exception 'Choose one valid problem';
  end if;
  if trim(coalesce(p_requested_resolution, '')) not in ('Repair or Replace', 'Return and Close') then
    raise exception 'Choose Repair or Replace, or Return and Close';
  end if;
  if length(trim(coalesce(p_description, ''))) > 1000 then raise exception 'Additional details must be 1,000 characters or fewer'; end if;
  if jsonb_typeof(coalesce(p_evidence_paths, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_evidence_paths, '[]'::jsonb)) not between 1 and 4
  then raise exception 'Attach between one and four wig photos'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_evidence_paths) path(value)
    where path.value not like auth.uid()::text || '/wig-appeals/' || p_req_id::text || '/%'
  ) then raise exception 'Concern photos must come from your own request upload folder'; end if;

  select count(*) into v_photo_count
  from jsonb_array_elements_text(p_evidence_paths) path(value)
  join storage.objects object_row
    on object_row.bucket_id = 'patient_assets' and object_row.name = path.value
  where lower(coalesce(object_row.metadata ->> 'mimetype', '')) like 'image/%';
  if v_photo_count <> jsonb_array_length(p_evidence_paths) then
    raise exception 'Only uploaded image files can be attached';
  end if;

  insert into public.wig_release_appeals (
    receipt_id, req_id, submitted_by, reason, requested_resolution,
    description, evidence_paths, submitted_at, updated_at
  ) values (
    v_receipt.receipt_id, p_req_id, v_actor.user_id, trim(p_reason),
    trim(p_requested_resolution), trim(coalesce(p_description, '')),
    p_evidence_paths, v_now, v_now
  ) returning * into v_appeal;
  return to_jsonb(v_appeal);
end;
$fn$;

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
  select * into v_appeal from public.wig_release_appeals where appeal_id = p_appeal_id for update;
  if v_appeal.appeal_id is null then raise exception 'After-release concern was not found'; end if;

  if v_action = 'receive' and v_appeal.return_status = 'In Transit' then
    v_next_status := case when v_appeal.requested_resolution = 'Return and Close' then 'Return Completed' else 'Return Received' end;
  elsif v_action = 'start_repair' and v_appeal.return_status = 'Return Received'
    and v_appeal.requested_resolution = 'Repair or Replace' then v_next_status := 'Under Repair';
  elsif v_action = 'complete_repair' and v_appeal.return_status = 'Under Repair'
    and v_appeal.requested_resolution = 'Repair or Replace' then v_next_status := 'Ready for Re-release';
  else raise exception 'That action is not valid for this concern and requested outcome';
  end if;

  update public.wig_release_appeals set
    return_status = v_next_status,
    return_received_at = case when v_action = 'receive' then v_now else return_received_at end,
    repair_started_at = case when v_action = 'start_repair' then v_now else repair_started_at end,
    repair_completed_at = case when v_action = 'complete_repair' then v_now else repair_completed_at end,
    return_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), return_note),
    return_updated_by = v_actor.user_id, updated_at = v_now
  where appeal_id = p_appeal_id returning * into v_appeal;

  if v_next_status = 'Ready for Re-release' then
    update public."Release_Schedules" set "Is_Current" = false, "Updated_At" = v_now
    where "Req_ID" = v_appeal.req_id and "Is_Current" = true;
  end if;
  return to_jsonb(v_appeal);
end;
$fn$;

-- Rejecting a concern restores Released without creating another receipt.
-- A new receipt cycle is created only after a repaired/replacement wig is
-- actually handed over again.
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
    where req_id = new."Req_ID" and return_status = 'Ready for Re-release';
  end if;
  return new;
end;
$fn$;

create or replace function public.sync_wig_request_appeal_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if new.return_status = 'Completed' then return new; end if;
  if new.status = 'Rejected' then
    update public."Wig_Requests" set "Status"='Released',
      "Status_Reason"='After-release concern was not accepted; the original release remains complete', "Updated_At"=v_now
    where "Req_ID"=new.req_id;
  elsif new.return_status = 'Return Completed' then
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now
    where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='Returned - Completed',
      "Status_Reason"='Returned wig received; request closed without repair or re-release', "Updated_At"=v_now
    where "Req_ID"=new.req_id;
  elsif new.return_status = 'Ready for Re-release' then
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now
    where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='To Be Release',
      "Status_Reason"='Repair completed; waiting for a new release schedule', "Updated_At"=v_now
    where "Req_ID"=new.req_id;
  else
    update public."Wig_Requests" set "Status"='Appealed',
      "Status_Reason"=case
        when new.status='Pending Staff Review' then 'After-release concern awaiting Staff confirmation'
        when new.return_status='Awaiting Return' then 'Concern confirmed; waiting for wig return'
        when new.return_status='In Transit' then 'Wig return is in transit'
        when new.return_status='Return Received' then 'Returned wig waiting for repair or replacement'
        when new.return_status='Under Repair' then 'Returned wig is under repair or replacement'
        else 'After-release concern is active' end,
      "Updated_At"=v_now where "Req_ID"=new.req_id;
  end if;
  return new;
end;
$fn$;

revoke all on function public.hrep_submit_wig_release_appeal(integer,text,text,text,jsonb) from public,anon;
grant execute on function public.hrep_submit_wig_release_appeal(integer,text,text,text,jsonb) to authenticated;
revoke all on function public.staff_update_wig_return(bigint,text,text) from public,anon;
grant execute on function public.staff_update_wig_return(bigint,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
