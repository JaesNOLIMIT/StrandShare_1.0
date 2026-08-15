-- Link an out-of-stock hospital wig request to one specialist bundle draft.
-- A completed linked bundle is reserved directly for the request and does not
-- increase general catalog stock.

begin;

alter table public."Wig_Requests"
  add column if not exists "Requested_Wig_Specification_ID" integer null,
  add column if not exists "Requested_Cap_Size" text null,
  add column if not exists "Is_Wish_Request" boolean not null default false,
  add column if not exists "Fulfillment_Status" character varying(50) not null default 'catalog_review',
  add column if not exists "Fulfillment_Bundle_ID" integer null;

alter table public."Hair_Submission_Bundles"
  add column if not exists "Wig_Request_ID" integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'Wig_Requests_Requested_Wig_Specification_fkey'
      and conrelid = 'public."Wig_Requests"'::regclass
  ) then
    alter table public."Wig_Requests"
      add constraint "Wig_Requests_Requested_Wig_Specification_fkey"
      foreign key ("Requested_Wig_Specification_ID")
      references public."Wig_Specifications" ("Wig_Specification_ID")
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'Wig_Requests_Fulfillment_Bundle_fkey'
      and conrelid = 'public."Wig_Requests"'::regclass
  ) then
    alter table public."Wig_Requests"
      add constraint "Wig_Requests_Fulfillment_Bundle_fkey"
      foreign key ("Fulfillment_Bundle_ID")
      references public."Hair_Submission_Bundles" ("Bundle_ID")
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'Hair_Submission_Bundles_Wig_Request_fkey'
      and conrelid = 'public."Hair_Submission_Bundles"'::regclass
  ) then
    alter table public."Hair_Submission_Bundles"
      add constraint "Hair_Submission_Bundles_Wig_Request_fkey"
      foreign key ("Wig_Request_ID")
      references public."Wig_Requests" ("Req_ID")
      on delete set null;
  end if;
end
$$;

create index if not exists "idx_Wig_Requests_Fulfillment_Status"
  on public."Wig_Requests" ("Fulfillment_Status", "Request_Date" desc);

create index if not exists "idx_Wig_Requests_Requested_Specification"
  on public."Wig_Requests" ("Requested_Wig_Specification_ID");

create unique index if not exists "idx_Hair_Submission_Bundles_Wig_Request_unique"
  on public."Hair_Submission_Bundles" ("Wig_Request_ID")
  where "Wig_Request_ID" is not null;

update public."Wig_Requests" wr
set
  "Requested_Wig_Specification_ID" = ws."Wig_Specification_ID",
  "Requested_Cap_Size" = ws."Cap_Size"::text
from public."Wig_Specifications" ws
where wr."Requested_Wig_Specification_ID" is null
  and wr."Requested_Wig_ID" = ws."Wig_ID";

create or replace function public.create_wig_request_with_spec(
  p_hospital_id integer,
  p_patient_id integer,
  p_wig_specification_id integer,
  p_special_notes text default null,
  p_preferred_color text default null,
  p_preferred_length text default null,
  p_hair_texture text default null,
  p_cap_size text default null,
  p_style_preference text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor_user_id integer;
  v_actor_role text;
  v_req_id integer;
  v_spec public."Wig_Specifications"%rowtype;
  v_wig public."Wigs"%rowtype;
  v_is_wish boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select u.user_id, public.normalize_app_role(u.role)
  into v_actor_user_id, v_actor_role
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(v_actor_user_id, 0) <= 0 then raise exception 'Unable to resolve actor user'; end if;
  if v_actor_role not in ('h_representative', 'staff', 'admin') then
    raise exception 'Not authorized to submit wig request';
  end if;

  if v_actor_role = 'h_representative' and not exists (
    select 1 from public."Hospital_Representative" hr
    where hr."User_ID" = v_actor_user_id and hr."Hospital_ID" = p_hospital_id
  ) then
    raise exception 'You are not assigned to this hospital';
  end if;

  if not exists (
    select 1 from public."Patients" p
    where p."Patient_ID" = p_patient_id and p."Hospital_ID" = p_hospital_id
  ) then
    raise exception 'Selected patient is not linked to the selected hospital';
  end if;

  select * into v_spec
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = p_wig_specification_id;

  if v_spec."Wig_Specification_ID" is null or v_spec."Wig_ID" is null then
    raise exception 'Selected wig specification does not exist or is not linked to a wig';
  end if;

  select * into v_wig from public."Wigs" w where w."Wig_ID" = v_spec."Wig_ID";
  if v_wig."Wig_ID" is null then raise exception 'Selected catalog wig does not exist'; end if;

  v_is_wish := greatest(0, coalesce(v_wig."Stock_Count", 0)) = 0
    or public.normalize_flow_key(v_wig."Wig_Status") <> 'available';

  insert into public."Wig_Requests" (
    "Hospital_ID", "Patient_ID", "Status", "Requested_By", "Requested_Wig_ID",
    "Requested_Wig_Specification_ID", "Requested_Cap_Size", "Is_Wish_Request",
    "Fulfillment_Status", "Request_Date", "Updated_At", "Status_Reason"
  ) values (
    p_hospital_id, p_patient_id, 'Pending', v_actor_user_id, v_spec."Wig_ID",
    v_spec."Wig_Specification_ID", coalesce(nullif(trim(p_cap_size), ''), v_spec."Cap_Size"::text),
    v_is_wish, case when v_is_wish then 'awaiting_review' else 'catalog_available' end,
    timezone('Asia/Manila', now()), timezone('Asia/Manila', now()),
    case when coalesce(p_special_notes, '') like 'SSMETA:%' then p_special_notes else null end
  ) returning "Req_ID" into v_req_id;

  insert into public."Wig_Request_Specifications" (
    "Req_ID", "Preferred_Color", "Preferred_Length", "Hair_Texture", "Cap_Size",
    "Style_Preference", "Special_Notes"
  ) values (
    v_req_id,
    coalesce(nullif(trim(p_preferred_color), ''), v_spec."Hair_Color"),
    coalesce(nullif(trim(p_preferred_length), ''), v_spec."Hair_Length"::text),
    coalesce(nullif(trim(p_hair_texture), ''), v_spec."Hair_Texture"),
    coalesce(nullif(trim(p_cap_size), ''), v_spec."Cap_Size"::text),
    coalesce(nullif(trim(p_style_preference), ''), v_spec."Style"),
    nullif(trim(coalesce(p_special_notes, '')), '')
  )
  on conflict ("Req_ID") do update set
    "Preferred_Color" = excluded."Preferred_Color",
    "Preferred_Length" = excluded."Preferred_Length",
    "Hair_Texture" = excluded."Hair_Texture",
    "Cap_Size" = excluded."Cap_Size",
    "Style_Preference" = excluded."Style_Preference",
    "Special_Notes" = excluded."Special_Notes";

  return v_req_id;
end;
$fn$;

grant execute on function public.create_wig_request_with_spec(
  integer, integer, integer, text, text, text, text, text, text
) to authenticated;

create or replace function public.create_wig_request_bundle_draft(
  p_wig_request_id integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_open_count integer;
begin
  select * into v_user from public.users u where u.auth_user_id = auth.uid() limit 1;
  if v_user.user_id is null or public.normalize_app_role(v_user.role) not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can open a requested wig draft.';
  end if;

  select * into v_request
  from public."Wig_Requests" wr
  where wr."Req_ID" = p_wig_request_id
  for update;

  if v_request."Req_ID" is null then raise exception 'Wig request % was not found.', p_wig_request_id; end if;
  if not coalesce(v_request."Is_Wish_Request", false) then raise exception 'This request was not submitted as an out-of-stock wish.'; end if;
  if v_request."Requested_Wig_Specification_ID" is null then raise exception 'This request has no selected wig specification.'; end if;
  if v_request."Fulfillment_Bundle_ID" is not null then raise exception 'This request already has bundle draft %.', v_request."Fulfillment_Bundle_ID"; end if;
  if public.normalize_flow_key(v_request."Status") not in ('acceptednowigavailable', 'inproduction') then
    raise exception 'Request must be accepted with no wig stock before opening production.';
  end if;

  select count(*)::integer into v_open_count
  from public."Hair_Submission_Bundles" b
  where b."Created_By" = v_user.user_id and public.normalize_flow_key(b."Status") = 'draft';
  if v_open_count >= 3 then raise exception 'Maximum of 3 open drafts per specialist. Close or delete an existing draft first.'; end if;

  insert into public."Hair_Submission_Bundles" (
    "Created_By", "Status", "Notes", "Wig_Specification_ID", "Wig_Request_ID"
  ) values (
    v_user.user_id, 'Draft',
    concat_ws(E'\n', nullif(trim(coalesce(p_notes, '')), ''), 'Patient request ' || coalesce(v_request."Request_Code", 'WR-' || v_request."Req_ID"::text)),
    v_request."Requested_Wig_Specification_ID", v_request."Req_ID"
  ) returning * into v_bundle;

  update public."Wig_Requests" set
    "Fulfillment_Bundle_ID" = v_bundle."Bundle_ID",
    "Fulfillment_Status" = 'draft_open',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = v_request."Req_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (v_user.user_id, 'wig_requests.open_fulfillment_draft',
    format('request_id=%s bundle_id=%s wig_specification_id=%s', v_request."Req_ID", v_bundle."Bundle_ID", v_bundle."Wig_Specification_ID"),
    v_user.email, 'Wig_Requests', 'success');

  return jsonb_build_object('bundle', to_jsonb(v_bundle), 'request', to_jsonb(v_request));
end;
$fn$;

grant execute on function public.create_wig_request_bundle_draft(integer, text) to authenticated;

create or replace function public.sync_wig_request_from_bundle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key text;
begin
  if new."Wig_Request_ID" is null then return new; end if;
  v_key := public.normalize_flow_key(new."Status");

  update public."Wig_Requests" set
    "Fulfillment_Bundle_ID" = new."Bundle_ID",
    "Fulfillment_Status" = case
      when v_key = 'draft' then 'draft_open'
      when v_key = 'inproduction' then 'in_production'
      when v_key in ('wigcreated', 'wigcompleted') then 'ready_for_release'
      else "Fulfillment_Status"
    end,
    "Status" = case when v_key = 'inproduction' then 'In Production' else "Status" end,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = new."Wig_Request_ID";
  return new;
end;
$fn$;

drop trigger if exists trg_sync_wig_request_from_bundle on public."Hair_Submission_Bundles";
create trigger trg_sync_wig_request_from_bundle
after insert or update of "Status" on public."Hair_Submission_Bundles"
for each row execute function public.sync_wig_request_from_bundle();

create or replace function public.reset_wig_request_after_bundle_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old."Wig_Request_ID" is not null then
    update public."Wig_Requests" set
      "Fulfillment_Bundle_ID" = null,
      "Fulfillment_Status" = 'awaiting_production',
      "Status" = case when public.normalize_flow_key("Status") = 'inproduction' then 'Accepted - No Wig Available' else "Status" end,
      "Updated_At" = timezone('Asia/Manila', now())
    where "Req_ID" = old."Wig_Request_ID";
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_reset_wig_request_after_bundle_delete on public."Hair_Submission_Bundles";
create trigger trg_reset_wig_request_after_bundle_delete
after delete on public."Hair_Submission_Bundles"
for each row execute function public.reset_wig_request_after_bundle_delete();

create or replace function public.complete_wig_request_or_stock_from_bundle_scan(
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_result jsonb;
  v_bundle_id integer;
  v_request_id integer;
  v_wig_id integer;
  v_request public."Wig_Requests"%rowtype;
  v_current_stock integer;
begin
  v_result := public.complete_wig_stock_from_bundle_scan(p_waybill_payload);
  v_bundle_id := nullif(v_result -> 'bundle' ->> 'Bundle_ID', '')::integer;
  v_wig_id := nullif(v_result -> 'wig' ->> 'Wig_ID', '')::integer;

  select b."Wig_Request_ID" into v_request_id
  from public."Hair_Submission_Bundles" b
  where b."Bundle_ID" = v_bundle_id;

  if v_request_id is null then
    return v_result || jsonb_build_object('direct_to_request', false);
  end if;

  select * into v_request
  from public."Wig_Requests" wr
  where wr."Req_ID" = v_request_id
  for update;

  perform set_config('wig.stock_reason', format('Reserved completed bundle %s directly for request %s', v_bundle_id, v_request_id), true);
  update public."Wigs" set
    "Stock_Count" = greatest(0, coalesce("Stock_Count", 0) - 1),
    "Wig_Status" = case when greatest(0, coalesce("Stock_Count", 0) - 1) > 0 then 'available' else 'not available' end,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Wig_ID" = v_wig_id
  returning "Stock_Count" into v_current_stock;

  update public."Wig_Requests" set
    "Allocated_Wig_ID" = v_wig_id,
    "Status" = 'To Be Release',
    "Fulfillment_Status" = 'ready_for_release',
    "Fulfillment_Bundle_ID" = v_bundle_id,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = v_request_id
  returning * into v_request;

  return v_result || jsonb_build_object(
    'direct_to_request', true,
    'request', to_jsonb(v_request),
    'next_stock', v_current_stock
  );
end;
$fn$;

grant execute on function public.complete_wig_request_or_stock_from_bundle_scan(text) to authenticated;

notify pgrst, 'reload schema';

commit;
