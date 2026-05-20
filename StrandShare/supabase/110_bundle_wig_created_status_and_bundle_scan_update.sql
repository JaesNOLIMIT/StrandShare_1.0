-- 110_bundle_wig_created_status_and_bundle_scan_update.sql
-- Final alignment:
-- - Hair_Submission_Bundles terminal status is Wig Created.
-- - complete_wig_stock_from_bundle_scan marks both bundle and linked submissions as Wig Created.
-- - Existing Wig Completed rows are normalized.

begin;

-- Drop old status checks first (some environments reject 'Wig Created').
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public."Hair_Submission_Bundles"'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%"Status"%'
  loop
    execute format('alter table public."Hair_Submission_Bundles" drop constraint if exists %I', v_constraint.conname);
  end loop;
end
$$;

-- Normalize legacy values.
update public."Hair_Submission_Bundles"
set "Status" = case
  when public.normalize_flow_key("Status") = 'draft' then 'Draft'
  when public.normalize_flow_key("Status") in ('inproduction', 'wiginproduction') then 'In Production'
  when public.normalize_flow_key("Status") in ('wigcompleted', 'wigcreated') then 'Wig Created'
  when public.normalize_flow_key("Status") = 'cancelled' then 'Cancelled'
  else 'In Production'
end;

alter table public."Hair_Submission_Bundles"
  add constraint hair_submission_bundles_status_check
  check (
    public.normalize_flow_key(coalesce("Status", '')) = any (
      array[
        'draft'::text,
        'inproduction'::text,
        'wigcreated'::text,
        'wigcompleted'::text,
        'cancelled'::text
      ]
    )
  );

-- Wig AI Studio bundle scan completion.
create or replace function public.complete_wig_stock_from_bundle_scan(
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
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_raw text := trim(coalesce(p_waybill_payload, ''));
  v_payload jsonb;
  v_bundle_id integer;
  v_waybill_code text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_spec public."Wig_Specifications"%rowtype;
  v_wig public."Wigs"%rowtype;
  v_prev_stock integer := 0;
  v_next_stock integer := 0;
  v_member_count integer := 0;
begin
  if v_raw = '' then
    raise exception 'Bundle waybill payload is required.';
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
    raise exception 'Only specialist/admin can complete wig stock from bundle scans.';
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
    begin
      v_bundle_id := nullif(trim(coalesce(
        v_payload ->> 'bundle_id',
        v_payload ->> 'Bundle_ID',
        v_payload -> 'data' ->> 'bundle_id',
        v_payload -> 'data' ->> 'Bundle_ID'
      )), '')::integer;
    exception
      when others then
        v_bundle_id := null;
    end;

    v_waybill_code := nullif(trim(coalesce(
      v_payload ->> 'bundle_waybill_code',
      v_payload ->> 'Bundle_Waybill_Code',
      v_payload ->> 'submission_code',
      v_payload ->> 'Submission_Code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'bundle_waybill_code',
      v_payload -> 'data' ->> 'Bundle_Waybill_Code',
      v_payload -> 'data' ->> 'submission_code',
      v_payload -> 'data' ->> 'Submission_Code'
    )), '');
  end if;

  if v_bundle_id is null and v_raw ~ '^[0-9]+$' then
    v_bundle_id := v_raw::integer;
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_bundle_id is not null then
    select *
    into v_bundle
    from public."Hair_Submission_Bundles" b
    where b."Bundle_ID" = v_bundle_id
    for update;
  end if;

  if v_bundle."Bundle_ID" is null and v_waybill_code is not null then
    select *
    into v_bundle
    from public."Hair_Submission_Bundles" b
    where upper(trim(coalesce(b."Bundle_Waybill_Code", ''))) = upper(trim(v_waybill_code))
    for update;
  end if;

  if v_bundle."Bundle_ID" is null then
    raise exception 'No bundle matched the scanned waybill payload.';
  end if;

  if public.normalize_flow_key(v_bundle."Status") = 'draft' then
    raise exception 'Bundle % is still Draft. Finalize it on Bundling first.', v_bundle."Bundle_ID";
  end if;

  if public.normalize_flow_key(v_bundle."Status") in ('wigcreated', 'wigcompleted') then
    raise exception 'Bundle % is already Wig Created.', v_bundle."Bundle_ID";
  end if;

  if v_bundle."Wig_Specification_ID" is null then
    raise exception 'Bundle % has no Wig_Specification_ID. Set it first before completing stock.', v_bundle."Bundle_ID";
  end if;

  select *
  into v_spec
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = v_bundle."Wig_Specification_ID"
  for update;

  if v_spec."Wig_Specification_ID" is null then
    raise exception 'Wig specification % from bundle % was not found.', v_bundle."Wig_Specification_ID", v_bundle."Bundle_ID";
  end if;

  if v_spec."Wig_ID" is null then
    raise exception 'Wig specification % is not linked to a Wig record.', v_spec."Wig_Specification_ID";
  end if;

  select *
  into v_wig
  from public."Wigs" w
  where w."Wig_ID" = v_spec."Wig_ID"
  for update;

  if v_wig."Wig_ID" is null then
    raise exception 'Wig % linked to specification % was not found.', v_spec."Wig_ID", v_spec."Wig_Specification_ID";
  end if;

  v_prev_stock := greatest(0, coalesce(v_wig."Stock_Count", 0));
  v_next_stock := v_prev_stock + 1;

  update public."Wigs"
  set
    "Stock_Count" = v_next_stock,
    "Wig_Status" = case when v_next_stock > 0 then 'available' else 'not available' end,
    "Updated_At" = v_now
  where "Wig_ID" = v_wig."Wig_ID"
  returning * into v_wig;

  update public."Hair_Submission_Bundles"
  set
    "Status" = 'Wig Created',
    "Wig_Completed_At" = coalesce("Wig_Completed_At", v_now),
    "Updated_At" = v_now
  where "Bundle_ID" = v_bundle."Bundle_ID"
  returning * into v_bundle;

  update public."Hair_Submissions"
  set
    "Status" = 'Wig Created',
    "Updated_At" = v_now
  where "Bundle_ID" = v_bundle."Bundle_ID"
    and public.normalize_flow_key("Status") <> 'wigcreated';

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = v_bundle."Bundle_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'wigs.complete_stock_from_bundle_scan',
    format(
      'bundle_id=%s bundle_waybill=%s wig_specification_id=%s wig_id=%s stock:%s->%s members=%s',
      v_bundle."Bundle_ID",
      coalesce(v_bundle."Bundle_Waybill_Code", 'N/A'),
      coalesce(v_bundle."Wig_Specification_ID"::text, 'N/A'),
      v_wig."Wig_ID",
      v_prev_stock,
      v_next_stock,
      v_member_count
    ),
    v_user.email,
    'Wigs',
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'wig', to_jsonb(v_wig),
    'wig_specification_id', v_spec."Wig_Specification_ID",
    'previous_stock', v_prev_stock,
    'next_stock', v_next_stock,
    'member_count', v_member_count
  );
end;
$fn$;

grant execute on function public.complete_wig_stock_from_bundle_scan(text) to authenticated;

commit;
