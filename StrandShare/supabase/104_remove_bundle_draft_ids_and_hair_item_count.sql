-- 104_remove_bundle_draft_ids_and_hair_item_count.sql
-- Remove legacy draft JSON and cached hair count from Hair_Submission_Bundles.
-- Keep bundle flow driven by Hair_Submissions.Bundle_ID membership.

begin;

create or replace function public.create_hair_bundle_draft(
  p_wig_specification_id integer,
  p_cap_size_override text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
begin
  if p_wig_specification_id is null then
    raise exception 'Wig_Specification_ID is required.';
  end if;

  select *
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can open bundle drafts.';
  end if;

  if not exists (
    select 1
    from public."Wig_Specifications" ws
    where ws."Wig_Specification_ID" = p_wig_specification_id
  ) then
    raise exception 'Wig specification % does not exist.', p_wig_specification_id;
  end if;

  insert into public."Hair_Submission_Bundles" (
    "Created_By",
    "Status",
    "Notes",
    "Wig_Specification_ID",
    "Target_Cap_Size"
  )
  values (
    v_user.user_id,
    'Draft',
    nullif(trim(coalesce(p_notes, '')), ''),
    p_wig_specification_id,
    nullif(trim(coalesce(p_cap_size_override, '')), '')
  )
  returning * into v_bundle;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.open_draft',
    format(
      'Opened bundle draft bundle_id=%s wig_specification_id=%s cap_size_override=%s',
      v_bundle."Bundle_ID",
      p_wig_specification_id,
      coalesce(nullif(trim(coalesce(p_cap_size_override, '')), ''), 'N/A')
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return to_jsonb(v_bundle);
end;
$fn$;

create or replace function public.bundle_scan_add_waybill(
  p_bundle_id integer,
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_raw text := trim(coalesce(p_waybill_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_member_count integer := 0;
  v_status_key text;
begin
  if p_bundle_id is null then
    raise exception 'Bundle_ID is required.';
  end if;

  if v_raw = '' then
    raise exception 'Waybill payload is required.';
  end if;

  select *
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can scan waybills into a bundle.';
  end if;

  if left(v_raw, 1) = '{' then
    begin
      v_payload := v_raw::jsonb;
    exception
      when others then
        v_payload := null;
    end;
  end if;

  if v_payload is not null then
    v_waybill_code := nullif(trim(coalesce(
      v_payload ->> 'Waybill_Code',
      v_payload ->> 'waybill_code',
      v_payload ->> 'waybillCode',
      v_payload ->> 'Submission_Code',
      v_payload ->> 'submission_code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode',
      v_payload -> 'data' ->> 'Submission_Code',
      v_payload -> 'data' ->> 'submission_code'
    )), '');
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_waybill_code is null then
    raise exception 'No waybill code detected from scan payload.';
  end if;

  v_waybill_code := upper(v_waybill_code);

  select *
  into v_bundle
  from public."Hair_Submission_Bundles" b
  where b."Bundle_ID" = p_bundle_id
  for update;

  if v_bundle."Bundle_ID" is null then
    raise exception 'Bundle % not found.', p_bundle_id;
  end if;

  if public.normalize_flow_key(v_bundle."Status") <> 'draft' then
    raise exception 'Bundle % is not Draft. Current status: %', p_bundle_id, coalesce(v_bundle."Status", 'N/A');
  end if;

  select count(*)
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  if v_member_count >= 10 then
    raise exception 'Bundle already has 10 hairs. Close this bundle and open a new one.';
  end if;

  select *
  into v_submission
  from public."Hair_Submissions" hs
  where upper(trim(coalesce(hs."Submission_Code", ''))) = v_waybill_code
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'No hair submission matched waybill %.', v_waybill_code;
  end if;

  if v_submission."Bundle_ID" is not null then
    if v_submission."Bundle_ID" = p_bundle_id then
      raise exception 'Waybill % is already scanned in this bundle.', v_waybill_code;
    end if;
    raise exception 'Waybill % is already assigned to bundle %.', v_waybill_code, v_submission."Bundle_ID";
  end if;

  v_status_key := public.normalize_flow_key(v_submission."Status");
  if v_status_key in ('rejected', 'cancelled', 'wigcreated') then
    raise exception 'Waybill % cannot be bundled while status is %.', v_waybill_code, coalesce(v_submission."Status", 'N/A');
  end if;

  update public."Hair_Submissions"
  set
    "Bundle_ID" = p_bundle_id,
    "Status" = 'Bundled',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  perform public.recompute_event_request_hair_collected_count(v_submission."Event_Request_ID");

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.scan_waybill',
    format(
      'Scanned waybill %s into bundle_id=%s (submission_id=%s, count=%s)',
      v_waybill_code,
      p_bundle_id,
      v_submission."Submission_ID",
      v_member_count
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'submission', to_jsonb(v_submission),
    'member_count', v_member_count,
    'ready_to_close', (v_member_count between 8 and 10)
  );
end;
$fn$;

create or replace function public.bundle_close_draft(
  p_bundle_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_member_count integer := 0;
  v_code text;
begin
  if p_bundle_id is null then
    raise exception 'Bundle_ID is required.';
  end if;

  select *
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can close bundle drafts.';
  end if;

  select *
  into v_bundle
  from public."Hair_Submission_Bundles" b
  where b."Bundle_ID" = p_bundle_id
  for update;

  if v_bundle."Bundle_ID" is null then
    raise exception 'Bundle % not found.', p_bundle_id;
  end if;

  if public.normalize_flow_key(v_bundle."Status") <> 'draft' then
    raise exception 'Bundle % is not Draft. Current status: %', p_bundle_id, coalesce(v_bundle."Status", 'N/A');
  end if;

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  if v_member_count < 8 or v_member_count > 10 then
    raise exception 'Bundle must contain 8-10 hairs before closing. Current count: %.', v_member_count;
  end if;

  v_code := coalesce(
    nullif(trim(v_bundle."Bundle_Waybill_Code"), ''),
    public.get_bundle_waybill_code(v_bundle."Bundle_ID", v_bundle."Created_At")
  );

  update public."Hair_Submission_Bundles"
  set
    "Status" = 'In Production',
    "Bundle_Waybill_Code" = v_code,
    "Bundle_Waybill_Printed_At" = timezone('Asia/Manila', now()),
    "Bundle_Waybill_Printed_By" = v_user.user_id,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  update public."Hair_Submissions"
  set
    "Status" = 'Bundled',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
    and public.normalize_flow_key("Status") <> 'wigcreated';

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.close_draft',
    format(
      'Closed bundle_id=%s with %s hairs; waybill=%s',
      p_bundle_id,
      v_member_count,
      v_code
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'member_count', v_member_count
  );
end;
$fn$;

alter table public."Hair_Submission_Bundles"
  drop column if exists "Draft_Submission_IDs",
  drop column if exists "Hair_Item_Count";

grant execute on function public.create_hair_bundle_draft(integer, text, text) to authenticated;
grant execute on function public.bundle_scan_add_waybill(integer, text) to authenticated;
grant execute on function public.bundle_close_draft(integer) to authenticated;

commit;
