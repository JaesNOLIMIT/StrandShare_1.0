begin;

alter table public."Wig_Requests"
  drop constraint if exists wig_requests_status_check;

create or replace function public.normalize_wig_request_production_status()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if public.normalize_flow_key(new."Status") in (
    'acceptednowigavailable',
    'acceptedinproduction',
    'inproduction'
  ) then
    new."Status" := 'Accepted - In Production';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_normalize_wig_request_production_status on public."Wig_Requests";
create trigger trg_normalize_wig_request_production_status
before insert or update of "Status" on public."Wig_Requests"
for each row execute function public.normalize_wig_request_production_status();

update public."Wig_Requests"
set "Status" = 'Accepted - In Production',
    "Updated_At" = timezone('Asia/Manila', now())
where public.normalize_flow_key("Status") in (
  'acceptednowigavailable',
  'acceptedinproduction',
  'inproduction'
);

alter table public."Wig_Requests"
  add constraint wig_requests_status_check check (
    lower(coalesce("Status", '')) = any (array[
      'pending',
      'accepted - wig allocated',
      'accepted - in production',
      'to be release',
      'releasing',
      'released',
      'rejected',
      'cancelled'
    ])
  );

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
    or public.normalize_app_role(v_user.role) not in ('specialist', 'admin', 'superadmin')
  then
    raise exception 'Only active specialist or admin accounts can open a requested-wig draft';
  end if;

  select * into v_request
  from public."Wig_Requests" request_row
  where request_row."Req_ID" = p_wig_request_id
  for update;

  if v_request."Req_ID" is null then raise exception 'Wig request % was not found', p_wig_request_id; end if;
  if v_request."Requested_Wig_Specification_ID" is null then raise exception 'This request has no selected wig specification'; end if;
  if v_request."Fulfillment_Bundle_ID" is not null then raise exception 'This request already has bundle draft %', v_request."Fulfillment_Bundle_ID"; end if;
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
    "Created_By", "Status", "Notes", "Wig_Specification_ID", "Wig_Request_ID"
  ) values (
    v_user.user_id,
    'Draft',
    concat_ws(E'\n', nullif(trim(coalesce(p_notes, '')), ''), 'Priority patient request ' || coalesce(v_request."Request_Code", 'WR-' || v_request."Req_ID"::text)),
    v_request."Requested_Wig_Specification_ID",
    v_request."Req_ID"
  ) returning * into v_bundle;

  update public."Wig_Requests"
  set "Is_Wish_Request" = true,
      "Fulfillment_Bundle_ID" = v_bundle."Bundle_ID",
      "Fulfillment_Status" = 'draft_open',
      "Updated_At" = timezone('Asia/Manila', now())
  where "Req_ID" = v_request."Req_ID"
  returning * into v_request;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'wig_requests.open_fulfillment_draft',
    format('request_id=%s bundle_id=%s wig_specification_id=%s', v_request."Req_ID", v_bundle."Bundle_ID", v_bundle."Wig_Specification_ID"),
    v_user.email,
    'Wig_Requests',
    'success'
  );

  return jsonb_build_object('bundle', to_jsonb(v_bundle), 'request', to_jsonb(v_request));
end;
$fn$;

revoke all on function public.create_wig_request_bundle_draft(integer, text) from public, anon;
grant execute on function public.create_wig_request_bundle_draft(integer, text) to authenticated;

notify pgrst, 'reload schema';
commit;
