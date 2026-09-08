begin;

-- A completed bundle is the traceable physical wig. Catalog Wigs rows remain
-- reusable specification variants; their Stock_Count is derived from physical
-- bundles which have been scanned into stock and are not currently allocated.
alter table public."Hair_Submission_Bundles"
  add column if not exists "Stock_Added_At" timestamp without time zone,
  add column if not exists "Stock_Added_By" integer references public.users(user_id) on delete set null,
  add column if not exists "Allocated_To_Wig_Request_ID" integer references public."Wig_Requests"("Req_ID") on delete set null,
  add column if not exists "Allocated_At" timestamp without time zone,
  add column if not exists "Allocated_By" integer references public.users(user_id) on delete set null,
  add column if not exists "Returned_To_Stock_At" timestamp without time zone;

create unique index if not exists uq_wig_bundle_active_allocation
  on public."Hair_Submission_Bundles" ("Allocated_To_Wig_Request_ID")
  where "Allocated_To_Wig_Request_ID" is not null;

-- Allocated_To_Wig_Request_ID is now the only request link on a physical
-- bundle. Preserve an older value when that legacy column still exists, then
-- remove the duplicate column and its automatically dependent index/FK.
do $fn$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Hair_Submission_Bundles'
      and column_name = 'Wig_Request_ID'
  ) then
    execute $sql$
      update public."Hair_Submission_Bundles"
      set "Allocated_To_Wig_Request_ID" = coalesce(
        "Allocated_To_Wig_Request_ID",
        "Wig_Request_ID"
      )
      where "Wig_Request_ID" is not null
    $sql$;

    alter table public."Hair_Submission_Bundles"
      drop constraint if exists "Hair_Submission_Bundles_Wig_Request_fkey";
    drop index if exists public."idx_Hair_Submission_Bundles_Wig_Request_unique";
    alter table public."Hair_Submission_Bundles"
      drop column "Wig_Request_ID";
  end if;
end;
$fn$;

alter table public."Wig_Requests"
  add column if not exists "Expected_Release_Earliest_At" timestamp with time zone,
  add column if not exists "Expected_Release_Latest_At" timestamp with time zone,
  add column if not exists "Allocation_Scanned_At" timestamp without time zone,
  add column if not exists "Allocation_Scanned_By" integer references public.users(user_id) on delete set null;

-- Preserve already completed/allocated records when installing this migration.
update public."Hair_Submission_Bundles" bundle
set "Stock_Added_At" = coalesce(bundle."Wig_Completed_At", bundle."Updated_At", bundle."Created_At")
where public.normalize_flow_key(bundle."Status") in ('wigcreated', 'wigcompleted')
  and bundle."Stock_Added_At" is null;

update public."Hair_Submission_Bundles" bundle
set
  "Allocated_To_Wig_Request_ID" = request."Req_ID",
  "Allocated_At" = coalesce(request."Allocation_Scanned_At", request."Approved_At", request."Updated_At")
from public."Wig_Requests" request
where request."Fulfillment_Bundle_ID" = bundle."Bundle_ID"
  and public.normalize_flow_key(request."Status") not in ('returnedcompleted', 'rejected', 'cancelled')
  and bundle."Allocated_To_Wig_Request_ID" is null;

create or replace function public.resolve_wig_bundle_scan_id(p_payload text)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_raw text := trim(coalesce(p_payload, ''));
  v_payload jsonb;
  v_bundle_id integer;
  v_code text;
begin
  if v_raw = '' then raise exception 'Wig QR or bundle waybill code is required'; end if;
  if left(v_raw, 1) = '{' then
    begin v_payload := v_raw::jsonb; exception when others then v_payload := null; end;
  end if;
  if v_payload is not null then
    begin
      v_bundle_id := nullif(trim(coalesce(
        v_payload ->> 'bundle_id', v_payload ->> 'Bundle_ID',
        v_payload -> 'data' ->> 'bundle_id', v_payload -> 'data' ->> 'Bundle_ID'
      )), '')::integer;
    exception when others then v_bundle_id := null;
    end;
    v_code := nullif(trim(coalesce(
      v_payload ->> 'bundle_waybill_code', v_payload ->> 'Bundle_Waybill_Code',
      v_payload ->> 'wig_code', v_payload ->> 'code', v_payload ->> 'value',
      v_payload -> 'data' ->> 'bundle_waybill_code',
      v_payload -> 'data' ->> 'Bundle_Waybill_Code',
      v_payload -> 'data' ->> 'code', v_payload -> 'data' ->> 'value'
    )), '');
  end if;
  if v_bundle_id is null and v_raw ~ '^[0-9]+$' then v_bundle_id := v_raw::integer; end if;
  if v_code is null then v_code := v_raw; end if;
  if v_bundle_id is null then
    select bundle."Bundle_ID" into v_bundle_id
    from public."Hair_Submission_Bundles" bundle
    where upper(trim(coalesce(bundle."Bundle_Waybill_Code", ''))) = upper(trim(v_code))
    limit 1;
  end if;
  if v_bundle_id is null then raise exception 'No physical wig matched the scanned QR'; end if;
  return v_bundle_id;
end;
$fn$;

-- Both roles may complete the physical scan. Specialist adds stock and alerts
-- Staff. Staff may use the same scan as the first half of immediate allocation.
create or replace function public.complete_wig_stock_from_bundle_scan(p_waybill_payload text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_role text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_spec public."Wig_Specifications"%rowtype;
  v_wig public."Wigs"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_previous integer;
  v_next integer;
  v_members integer;
  v_staff_id integer;
begin
  select * into v_actor from public.users actor
  where actor.auth_user_id = auth.uid() and actor.is_active is distinct from false limit 1;
  v_role := public.normalize_app_role(v_actor.role);
  if v_actor.user_id is null or v_role not in ('staff','specialist','admin','superadmin') then
    raise exception 'Only active Staff, Specialist, or Admin accounts can scan completed wigs';
  end if;

  select * into v_bundle from public."Hair_Submission_Bundles" bundle
  where bundle."Bundle_ID" = public.resolve_wig_bundle_scan_id(p_waybill_payload) for update;
  if public.normalize_flow_key(v_bundle."Status") in ('wigcreated','wigcompleted')
     or v_bundle."Stock_Added_At" is not null then
    raise exception 'This completed wig is already in stock. Do not scan it again';
  end if;
  if public.normalize_flow_key(v_bundle."Status") <> 'inproduction' then
    raise exception 'The bundle must be In Production before its completed wig can be scanned';
  end if;
  if v_bundle."Wig_Specification_ID" is null then
    raise exception 'The bundle has no exact wig specification';
  end if;

  select * into v_spec from public."Wig_Specifications" specification
  where specification."Wig_Specification_ID" = v_bundle."Wig_Specification_ID";
  select * into v_wig from public."Wigs" wig where wig."Wig_ID" = v_spec."Wig_ID" for update;
  if v_wig."Wig_ID" is null then raise exception 'The bundle specification is not linked to a catalog wig'; end if;

  v_previous := greatest(0, coalesce(v_wig."Stock_Count", 0));
  v_next := v_previous + 1;
  perform set_config('wig.stock_reason', format('Physical bundle %s scanned into stock', v_bundle."Bundle_ID"), true);
  update public."Wigs" set "Stock_Count"=v_next, "Wig_Status"='available', "Updated_At"=v_now
  where "Wig_ID"=v_wig."Wig_ID" returning * into v_wig;
  update public."Hair_Submission_Bundles" set
    "Status"='Wig Created', "Wig_Completed_At"=coalesce("Wig_Completed_At",v_now),
    "Stock_Added_At"=v_now, "Stock_Added_By"=v_actor.user_id, "Updated_At"=v_now
  where "Bundle_ID"=v_bundle."Bundle_ID" returning * into v_bundle;
  update public."Hair_Submissions" set "Status"='Wig Created', "Updated_At"=v_now
  where "Bundle_ID"=v_bundle."Bundle_ID" and public.normalize_flow_key("Status") <> 'wigcreated';
  select count(*)::integer into v_members from public."Hair_Submissions"
  where "Bundle_ID"=v_bundle."Bundle_ID";

  if v_role = 'specialist' then
    for v_staff_id in
      select account.user_id from public.users account
      where account.is_active is distinct from false
        and public.normalize_app_role(account.role) = 'staff'
    loop
      insert into public."Notification" (
        "User_ID","Type","Title","Message","Status","Reference_Type","Reference_ID","Updated_At"
      ) values (
        v_staff_id,'Wig Stock','Completed wig ready for allocation',
        format('Bundle %s was scanned by Specialist and is now available. Staff must scan it before approving a matching request.', coalesce(v_bundle."Bundle_Waybill_Code", '#' || v_bundle."Bundle_ID"::text)),
        'Unread','Hair_Submission_Bundles',v_bundle."Bundle_ID"::text,v_now
      );
    end loop;
  end if;

  return jsonb_build_object(
    'bundle',to_jsonb(v_bundle),'wig',to_jsonb(v_wig),'wig_specification',to_jsonb(v_spec),
    'previous_stock',v_previous,'next_stock',v_next,'member_count',v_members,
    'stock_only',true,'staff_notification_sent',v_role='specialist'
  );
end;
$fn$;

-- Compatibility entry point used by older Specialist screens. It is now
-- deliberately stock-only; patient allocation always requires the Staff RPC.
create or replace function public.complete_wig_request_or_stock_from_bundle_scan(p_waybill_payload text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return public.complete_wig_stock_from_bundle_scan(p_waybill_payload)
    || jsonb_build_object('direct_to_request',false);
end;
$fn$;

-- Production drafts reserve the same physical bundle through the canonical
-- allocation key. There is no second Wig_Request_ID relationship anymore.
create or replace function public.create_wig_request_bundle_draft(
  p_wig_request_id integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_open_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_user
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if v_user.user_id is null
    or public.normalize_app_role(v_user.role) not in ('specialist','admin','superadmin')
  then
    raise exception 'Only active Specialist or Admin accounts can open a requested-wig draft';
  end if;

  select * into v_request
  from public."Wig_Requests" request
  where request."Req_ID" = p_wig_request_id
  for update;

  if v_request."Req_ID" is null then
    raise exception 'Wig request % was not found', p_wig_request_id;
  end if;
  if v_request."Requested_Wig_Specification_ID" is null then
    raise exception 'This request has no selected wig specification';
  end if;
  if v_request."Fulfillment_Bundle_ID" is not null then
    raise exception 'This request already has bundle draft %', v_request."Fulfillment_Bundle_ID";
  end if;
  if public.normalize_flow_key(v_request."Status") <> 'acceptedinproduction' then
    raise exception 'Request must be accepted for production before opening a draft';
  end if;

  select count(*)::integer into v_open_count
  from public."Hair_Submission_Bundles" bundle
  where bundle."Created_By" = v_user.user_id
    and public.normalize_flow_key(bundle."Status") = 'draft';

  if v_open_count >= 3 then
    raise exception 'Maximum of 3 open drafts per specialist. Close or delete an existing draft first';
  end if;

  insert into public."Hair_Submission_Bundles" (
    "Created_By", "Status", "Notes", "Wig_Specification_ID",
    "Allocated_To_Wig_Request_ID"
  ) values (
    v_user.user_id,
    'Draft',
    concat_ws(
      E'\n',
      nullif(trim(coalesce(p_notes, '')), ''),
      'Priority patient request ' || coalesce(
        v_request."Request_Code",
        'WR-' || v_request."Req_ID"::text
      )
    ),
    v_request."Requested_Wig_Specification_ID",
    v_request."Req_ID"
  ) returning * into v_bundle;

  update public."Wig_Requests"
  set
    "Is_Wish_Request" = true,
    "Fulfillment_Bundle_ID" = v_bundle."Bundle_ID",
    "Fulfillment_Status" = 'draft_open',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = v_request."Req_ID"
  returning * into v_request;

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'request', to_jsonb(v_request)
  );
end;
$fn$;

create or replace function public.sync_wig_request_from_bundle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_key text;
begin
  if new."Allocated_To_Wig_Request_ID" is null then return new; end if;
  v_key := public.normalize_flow_key(new."Status");

  update public."Wig_Requests"
  set
    "Fulfillment_Bundle_ID" = new."Bundle_ID",
    "Fulfillment_Status" = case
      when v_key = 'draft' then 'draft_open'
      when v_key = 'inproduction' then 'in_production'
      when v_key in ('wigcreated','wigcompleted') then 'ready_for_allocation'
      else "Fulfillment_Status"
    end,
    "Status" = case
      when v_key = 'inproduction' then 'Accepted - In Production'
      else "Status"
    end,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = new."Allocated_To_Wig_Request_ID";

  return new;
end;
$fn$;

drop trigger if exists trg_sync_wig_request_from_bundle
  on public."Hair_Submission_Bundles";
create trigger trg_sync_wig_request_from_bundle
after insert or update of "Status" on public."Hair_Submission_Bundles"
for each row execute function public.sync_wig_request_from_bundle();

create or replace function public.reset_wig_request_after_bundle_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if old."Allocated_To_Wig_Request_ID" is not null then
    update public."Wig_Requests"
    set
      "Fulfillment_Bundle_ID" = null,
      "Fulfillment_Status" = 'awaiting_production',
      "Status" = case
        when public.normalize_flow_key("Status") = 'acceptedinproduction'
          then 'Accepted - No Wig Available'
        else "Status"
      end,
      "Updated_At" = timezone('Asia/Manila', now())
    where "Req_ID" = old."Allocated_To_Wig_Request_ID";
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_reset_wig_request_after_bundle_delete
  on public."Hair_Submission_Bundles";
create trigger trg_reset_wig_request_after_bundle_delete
after delete on public."Hair_Submission_Bundles"
for each row execute function public.reset_wig_request_after_bundle_delete();

create or replace function public.preview_wig_request_bundle_scan(p_req_id integer, p_waybill_payload text)
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
  select * into v_actor from public.users actor
  where actor.auth_user_id=auth.uid() and actor.is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin') then
    raise exception 'Only active Staff or Admin accounts can validate wig allocation scans';
  end if;
  select * into v_request from public."Wig_Requests" request
  where request."Req_ID"=p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  select * into v_bundle from public."Hair_Submission_Bundles" bundle
  where bundle."Bundle_ID"=public.resolve_wig_bundle_scan_id(p_waybill_payload);
  select * into v_requested from public."Wig_Specifications" specification
  where specification."Wig_Specification_ID"=v_request."Requested_Wig_Specification_ID";
  select * into v_actual from public."Wig_Specifications" specification
  where specification."Wig_Specification_ID"=v_bundle."Wig_Specification_ID";
  if v_requested."Wig_Specification_ID" is null then raise exception 'The request has no valid wig specification'; end if;
  if v_actual."Wig_Specification_ID" is null then raise exception 'The scanned wig has no valid wig specification'; end if;
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
  select coalesce(bool_and((field ->> 'match')::boolean),false) into v_all_match
  from jsonb_array_elements(v_fields) field;
  v_available := (
    (v_status in ('wigcreated','wigcompleted') and v_bundle."Stock_Added_At" is not null)
    or (v_status='inproduction' and v_bundle."Allocated_To_Wig_Request_ID"=p_req_id)
  ) and (v_bundle."Allocated_To_Wig_Request_ID" is null or v_bundle."Allocated_To_Wig_Request_ID"=p_req_id);
  return jsonb_build_object(
    'request_id',p_req_id,'bundle_id',v_bundle."Bundle_ID",'bundle_code',v_bundle."Bundle_Waybill_Code",
    'bundle_status',v_bundle."Status",'requested_specification_id',v_requested."Wig_Specification_ID",
    'actual_specification_id',v_actual."Wig_Specification_ID",'fields',v_fields,
    'all_match',v_all_match,'available',v_available,
    'can_allocate',v_all_match and v_available and public.normalize_flow_key(v_request."Status") in ('pending','pendingreview','acceptedinproduction','acceptednowigavailable')
  );
end;
$fn$;

create or replace function public.get_available_physical_wig_counts()
returns table("Wig_Specification_ID" integer, "Available_Count" bigint)
language sql
security definer
set search_path = ''
stable
as $fn$
  select bundle."Wig_Specification_ID",count(*)::bigint
  from public."Hair_Submission_Bundles" bundle
  where public.normalize_flow_key(bundle."Status") in ('wigcreated','wigcompleted')
    and bundle."Stock_Added_At" is not null
    and bundle."Allocated_To_Wig_Request_ID" is null
  group by bundle."Wig_Specification_ID";
$fn$;

create or replace function public.allocate_scanned_wig_to_request(
  p_req_id integer,
  p_waybill_payload text,
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
  v_preview jsonb;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_spec public."Wig_Specifications"%rowtype;
  v_wig public."Wigs"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_patient_user integer;
  v_recipient integer;
begin
  select * into v_actor from public.users actor
  where actor.auth_user_id=auth.uid() and actor.is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin') then
    raise exception 'Only active Staff or Admin accounts can allocate a scanned wig';
  end if;
  if p_safety_review_status is not null then
    if p_safety_review_status not in ('Pending','Cleared','Needs Clarification','Requires Medical Clearance') then
      raise exception 'Invalid safety review status';
    end if;
    update public.patient_wig_safety_assessments set
      review_status=p_safety_review_status,reviewed_by=v_actor.user_id,reviewed_at=now(),
      review_notes=nullif(trim(coalesce(p_safety_review_notes,'')),''),updated_at=now()
    where req_id=p_req_id;
  end if;
  v_preview := public.preview_wig_request_bundle_scan(p_req_id,p_waybill_payload);
  if not coalesce((v_preview ->> 'all_match')::boolean,false) then
    raise exception 'The scanned wig does not match every requested specification';
  end if;
  if not coalesce((v_preview ->> 'available')::boolean,false) then
    raise exception 'The scanned physical wig is not available for this request';
  end if;
  if not coalesce((v_preview ->> 'can_allocate')::boolean,false) then
    raise exception 'This request is not at a valid Staff allocation step';
  end if;
  select * into v_bundle from public."Hair_Submission_Bundles" bundle
  where bundle."Bundle_ID"=(v_preview ->> 'bundle_id')::integer for update;
  if v_bundle."Allocated_To_Wig_Request_ID" is not null
    and v_bundle."Allocated_To_Wig_Request_ID" <> p_req_id
  then
    raise exception 'This physical wig has already been allocated to another request';
  end if;
  if public.normalize_flow_key(v_bundle."Status")='inproduction' then
    perform public.complete_wig_stock_from_bundle_scan(p_waybill_payload);
    select * into v_bundle from public."Hair_Submission_Bundles" bundle
    where bundle."Bundle_ID"=(v_preview ->> 'bundle_id')::integer for update;
  end if;
  select * into v_spec from public."Wig_Specifications" specification
  where specification."Wig_Specification_ID"=v_bundle."Wig_Specification_ID";
  select * into v_wig from public."Wigs" wig where wig."Wig_ID"=v_spec."Wig_ID" for update;
  if greatest(0,coalesce(v_wig."Stock_Count",0)) < 1 then raise exception 'The scanned wig is not recorded in available stock'; end if;

  perform set_config('wig.stock_reason',format('Scanned bundle %s allocated to request %s',v_bundle."Bundle_ID",p_req_id),true);
  update public."Wigs" set "Stock_Count"=greatest(0,"Stock_Count"-1),
    "Wig_Status"=case when greatest(0,"Stock_Count"-1)>0 then 'available' else 'not available' end,
    "Updated_At"=v_now where "Wig_ID"=v_wig."Wig_ID" returning * into v_wig;
  update public."Hair_Submission_Bundles" set
    "Allocated_To_Wig_Request_ID"=p_req_id,"Allocated_At"=v_now,"Allocated_By"=v_actor.user_id,
    "Returned_To_Stock_At"=null,"Updated_At"=v_now
  where "Bundle_ID"=v_bundle."Bundle_ID";
  update public."Wig_Requests" set
    "Status"='Accepted - Wig Allocated',"Allocated_Wig_ID"=v_wig."Wig_ID",
    "Fulfillment_Bundle_ID"=v_bundle."Bundle_ID","Fulfillment_Status"='scanned_wig_allocated',
    "Approved_By"=v_actor.user_id,"Approved_At"=v_now,"Allocation_Scanned_At"=v_now,
    "Allocation_Scanned_By"=v_actor.user_id,"Status_Reason"=null,"Updated_At"=v_now
  where "Req_ID"=p_req_id returning * into v_request;

  select patient."User_ID" into v_patient_user from public."Patients" patient
  where patient."Patient_ID"=v_request."Patient_ID";
  for v_recipient in select distinct id from (values(v_request."Requested_By"),(v_patient_user)) r(id) where id is not null loop
    insert into public."Notification" ("User_ID","Type","Title","Message","Status","Reference_Type","Reference_ID","Updated_At")
    values (v_recipient,'Wig Request','Wig allocated',
      format('%s was approved after Staff scanned and verified a wig matching every requested specification.',coalesce(v_request."Request_Code",'Your wig request')),
      'Unread','Wig_Requests',p_req_id::text,v_now);
  end loop;
  return v_preview || jsonb_build_object('request',to_jsonb(v_request),'bundle',to_jsonb(v_bundle),'wig',to_jsonb(v_wig));
end;
$fn$;

-- PH-time display is handled by clients; timestamptz stores the absolute
-- instant. Pending estimates use today. Approval recalculates from Approved_At.
create or replace function public.set_wig_request_expected_release_window()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_has_stock boolean;
  v_base timestamp with time zone;
  v_status text := public.normalize_flow_key(new."Status");
begin
  if tg_op='INSERT' or new."Requested_Wig_Specification_ID" is distinct from old."Requested_Wig_Specification_ID" then
    select exists(
      select 1 from public."Hair_Submission_Bundles" bundle
      where bundle."Wig_Specification_ID"=new."Requested_Wig_Specification_ID"
        and public.normalize_flow_key(bundle."Status") in ('wigcreated','wigcompleted')
        and bundle."Stock_Added_At" is not null
        and bundle."Allocated_To_Wig_Request_ID" is null
    ) into v_has_stock;
    v_base := now();
    new."Expected_Release_Earliest_At" := v_base + case when v_has_stock then interval '7 days' else interval '1 month' end;
    new."Expected_Release_Latest_At" := v_base + case when v_has_stock then interval '14 days' else interval '2 months' end;
    new."Expected_Release_At" := new."Expected_Release_Latest_At";
    new."Expected_Release_Note" := case when v_has_stock
      then 'Estimated receipt: 1-2 weeks from request. Staff recalculates this window when approved.'
      else 'Estimated receipt: 1-2 months from request while a matching wig is produced. Staff recalculates this window when approved.' end;
    new."Expected_Release_Updated_At" := now();
  end if;
  if tg_op='UPDATE' and (new."Status" is distinct from old."Status" or new."Approved_At" is distinct from old."Approved_At")
    and v_status in ('acceptedwigallocated','acceptedinproduction') then
    v_base := coalesce(new."Approved_At" at time zone 'Asia/Manila',now());
    new."Expected_Release_Earliest_At" := v_base + case when v_status='acceptedwigallocated' then interval '3 days' else interval '1 month' end;
    new."Expected_Release_Latest_At" := v_base + case when v_status='acceptedwigallocated' then interval '9 days' else interval '2 months' end;
    new."Expected_Release_At" := new."Expected_Release_Latest_At";
    new."Expected_Release_Note" := case when v_status='acceptedwigallocated'
      then 'Approved with a matching scanned wig. Expected release is 3-9 days after Staff approval.'
      else 'Approved for production. Distribute or release within 1-2 months of approval.' end;
    new."Expected_Release_Updated_At" := now();
    new."Expected_Release_Updated_By" := new."Approved_By";
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_set_wig_request_expected_release_window on public."Wig_Requests";
create trigger trg_set_wig_request_expected_release_window
before insert or update of "Requested_Wig_Specification_ID","Status","Approved_At" on public."Wig_Requests"
for each row execute function public.set_wig_request_expected_release_window();

-- Preserve the existing Staff-only protection while allowing this migration's
-- one-time backfill. SQL Editor/migration sessions have no auth.uid(), so the
-- old guard otherwise rejects the maintenance update below.
create or replace function public.guard_wig_request_expected_release_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_is_changed boolean;
begin
  if coalesce(
    current_setting('strandshare.backfill_wig_expected_release', true),
    'off'
  ) = 'on' then
    return new;
  end if;

  -- Initial request estimates are system-generated during INSERT. Manual or
  -- workflow changes after creation remain Staff/Admin-only.
  if tg_op = 'INSERT' then
    return new;
  end if;

  v_is_changed :=
    new."Expected_Release_At" is distinct from old."Expected_Release_At"
    or new."Expected_Release_Earliest_At" is distinct from old."Expected_Release_Earliest_At"
    or new."Expected_Release_Latest_At" is distinct from old."Expected_Release_Latest_At"
    or new."Expected_Release_Note" is distinct from old."Expected_Release_Note"
    or new."Expected_Release_Updated_At" is distinct from old."Expected_Release_Updated_At"
    or new."Expected_Release_Updated_By" is distinct from old."Expected_Release_Updated_By";

  if not v_is_changed then
    return new;
  end if;

  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin')
  then
    raise exception 'Only authorized Staff or Admin can update the expected wig release schedule';
  end if;

  return new;
end;
$fn$;

select set_config('strandshare.backfill_wig_expected_release','on',true);

update public."Wig_Requests" request
set
  "Expected_Release_Earliest_At" = (
    coalesce(
      case when public.normalize_flow_key(request."Status") in ('acceptedwigallocated','acceptedinproduction') then request."Approved_At" end,
      request."Request_Date",timezone('Asia/Manila',now())
    ) at time zone 'Asia/Manila'
  ) + case
    when public.normalize_flow_key(request."Status")='acceptedwigallocated' then interval '3 days'
    when public.normalize_flow_key(request."Status")='acceptedinproduction' then interval '1 month'
    when exists(
      select 1 from public."Hair_Submission_Bundles" bundle
      where bundle."Wig_Specification_ID"=request."Requested_Wig_Specification_ID"
        and public.normalize_flow_key(bundle."Status") in ('wigcreated','wigcompleted')
        and bundle."Stock_Added_At" is not null
        and bundle."Allocated_To_Wig_Request_ID" is null
    ) then interval '7 days' else interval '1 month' end,
  "Expected_Release_Latest_At" = (
    coalesce(
      case when public.normalize_flow_key(request."Status") in ('acceptedwigallocated','acceptedinproduction') then request."Approved_At" end,
      request."Request_Date",timezone('Asia/Manila',now())
    ) at time zone 'Asia/Manila'
  ) + case
    when public.normalize_flow_key(request."Status")='acceptedwigallocated' then interval '9 days'
    when public.normalize_flow_key(request."Status")='acceptedinproduction' then interval '2 months'
    when exists(
      select 1 from public."Hair_Submission_Bundles" bundle
      where bundle."Wig_Specification_ID"=request."Requested_Wig_Specification_ID"
        and public.normalize_flow_key(bundle."Status") in ('wigcreated','wigcompleted')
        and bundle."Stock_Added_At" is not null
        and bundle."Allocated_To_Wig_Request_ID" is null
    ) then interval '14 days' else interval '2 months' end,
  "Expected_Release_Note" = case
    when public.normalize_flow_key(request."Status")='acceptedwigallocated' then 'Approved with a matching scanned wig. Expected release is 3-9 days after Staff approval.'
    when public.normalize_flow_key(request."Status")='acceptedinproduction' then 'Approved for production. Distribute or release within 1-2 months of approval.'
    else 'Initial expected receipt window; Staff recalculates it from the approval date.' end,
  "Expected_Release_Updated_At"=now()
where request."Expected_Release_Earliest_At" is null
   or request."Expected_Release_Latest_At" is null;

update public."Wig_Requests"
set "Expected_Release_At"="Expected_Release_Latest_At"
where "Expected_Release_Latest_At" is not null;

select set_config('strandshare.backfill_wig_expected_release','off',true);

-- A permanent Return and Close restores only the physical wig. Consumed hair
-- stays consumed. Repair/Replace and cancelled/deleted bundles restore nothing.
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
  elsif new.return_status='Ready for Re-release' then
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='To Be Release',"Status_Reason"='Repair completed; waiting for a new release schedule',"Updated_At"=v_now where "Req_ID"=new.req_id;
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

-- Remove historical/manual counts from the source of truth. Only scanned,
-- completed and currently unallocated physical bundles count as stock.
with physical_stock as (
  select specification."Wig_ID",count(bundle."Bundle_ID")::integer as quantity
  from public."Wig_Specifications" specification
  left join public."Hair_Submission_Bundles" bundle
    on bundle."Wig_Specification_ID"=specification."Wig_Specification_ID"
   and public.normalize_flow_key(bundle."Status") in ('wigcreated','wigcompleted')
   and bundle."Stock_Added_At" is not null
   and bundle."Allocated_To_Wig_Request_ID" is null
  group by specification."Wig_ID"
)
update public."Wigs" wig set "Stock_Count"=physical_stock.quantity,
  "Wig_Status"=case when physical_stock.quantity>0 then 'available' else 'not available' end,
  "Updated_At"=timezone('Asia/Manila',now())
from physical_stock where physical_stock."Wig_ID"=wig."Wig_ID";

revoke all on function public.resolve_wig_bundle_scan_id(text) from public,anon;
revoke all on function public.complete_wig_stock_from_bundle_scan(text) from public,anon;
revoke all on function public.complete_wig_request_or_stock_from_bundle_scan(text) from public,anon;
revoke all on function public.create_wig_request_bundle_draft(integer,text) from public,anon;
revoke all on function public.preview_wig_request_bundle_scan(integer,text) from public,anon;
revoke all on function public.get_available_physical_wig_counts() from public,anon;
revoke all on function public.allocate_scanned_wig_to_request(integer,text,text,text) from public,anon;
grant execute on function public.complete_wig_stock_from_bundle_scan(text) to authenticated;
grant execute on function public.complete_wig_request_or_stock_from_bundle_scan(text) to authenticated;
grant execute on function public.create_wig_request_bundle_draft(integer,text) to authenticated;
grant execute on function public.preview_wig_request_bundle_scan(integer,text) to authenticated;
grant execute on function public.get_available_physical_wig_counts() to authenticated;
grant execute on function public.allocate_scanned_wig_to_request(integer,text,text,text) to authenticated;

-- Manual quantity edits would break the one-scan/one-physical-wig rule.
revoke execute on function public.adjust_wig_catalog_stock(integer,integer,text) from authenticated;

comment on column public."Hair_Submission_Bundles"."Allocated_To_Wig_Request_ID" is
  'The request currently holding this physical completed wig; cleared only after a permanent returned-wig close.';
comment on column public."Wig_Requests"."Expected_Release_Latest_At" is
  'Latest expected PH release/receipt date: initially 1-2 weeks with stock, then 9 days after Staff allocation approval; 2 months for production.';

notify pgrst,'reload schema';
commit;
