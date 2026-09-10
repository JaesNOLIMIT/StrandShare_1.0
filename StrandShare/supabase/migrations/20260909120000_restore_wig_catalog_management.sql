begin;

create or replace function public.manage_wig_catalog_item(
  p_wig_id integer,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_wig public."Wigs"%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_filter_id integer;
  v_spec_id integer;
  v_reference_count bigint := 0;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('specialist', 'admin', 'superadmin')
  then
    raise exception 'Only active Specialist or Admin accounts can manage wig catalog items';
  end if;

  if v_action not in ('activate', 'deactivate', 'delete') then
    raise exception 'Action must be activate, deactivate, or delete';
  end if;

  select * into v_wig
  from public."Wigs" wig
  where wig."Wig_ID" = p_wig_id
  for update;

  if v_wig."Wig_ID" is null then
    raise exception 'Wig catalog item was not found';
  end if;

  if v_action in ('activate', 'deactivate') then
    if v_action = 'deactivate' then
      update public."Wig_AI_Filters"
      set
        "Is_Active" = false,
        "Status" = case when "Status" = 'approved' then 'superseded' else "Status" end,
        "Updated_At" = v_now
      where "Wig_ID" = v_wig."Wig_ID";
    else
      select filter."Filter_ID" into v_filter_id
      from public."Wig_AI_Filters" filter
      where filter."Wig_ID" = v_wig."Wig_ID"
        and filter."Status" in ('approved', 'superseded')
      order by filter."Is_Active" desc, filter."Created_At" desc, filter."Filter_ID" desc
      limit 1
      for update;

      if v_filter_id is null then
        raise exception 'This wig has no approved phone filter to activate';
      end if;

      update public."Wig_AI_Filters"
      set
        "Is_Active" = true,
        "Status" = 'approved',
        "Updated_At" = v_now
      where "Filter_ID" = v_filter_id;
    end if;

    insert into public.audit_logs (
      user_id, action, description, user_email, resource, status, "time"
    ) values (
      v_actor.user_id,
      'wig_catalog.visibility_changed',
      format(
        '%s wig catalog item %s (wig_id=%s).',
        initcap(v_action),
        coalesce(v_wig."Wig_Code", v_wig."Wig_Name", '#' || v_wig."Wig_ID"::text),
        v_wig."Wig_ID"
      ),
      v_actor.email,
      'Wigs:' || v_wig."Wig_ID"::text,
      'success',
      v_now
    );

    return jsonb_build_object(
      'wig_id', v_wig."Wig_ID",
      'wig_code', v_wig."Wig_Code",
      'action', v_action,
      'is_active', v_action = 'activate',
      'deleted', false
    );
  end if;

  if greatest(0, coalesce(v_wig."Stock_Count", 0)) > 0 then
    raise exception 'This wig cannot be deleted while physical stock remains. Deactivate it instead';
  end if;

  select specification."Wig_Specification_ID" into v_spec_id
  from public."Wig_Specifications" specification
  where specification."Wig_ID" = v_wig."Wig_ID"
  limit 1;

  select count(*)::bigint into v_reference_count
  from public."Wig_Requests" request
  where request."Requested_Wig_ID" = v_wig."Wig_ID"
    or request."Allocated_Wig_ID" = v_wig."Wig_ID"
    or (v_spec_id is not null and request."Requested_Wig_Specification_ID" = v_spec_id);

  if v_reference_count > 0 then
    raise exception 'This wig cannot be deleted because it is referenced by % wig request(s). Deactivate it instead', v_reference_count;
  end if;

  if v_spec_id is not null then
    select count(*)::bigint into v_reference_count
    from public."Hair_Submission_Bundles" bundle
    where bundle."Wig_Specification_ID" = v_spec_id;

    if v_reference_count > 0 then
      raise exception 'This wig cannot be deleted because it has % production bundle record(s). Deactivate it instead', v_reference_count;
    end if;
  end if;

  select count(*)::bigint into v_reference_count
  from public."Cut_Hair_Inventory" inventory
  where inventory."Wig_ID" = v_wig."Wig_ID";

  if v_reference_count > 0 then
    raise exception 'This wig cannot be deleted because it has inventory history. Deactivate it instead';
  end if;

  if to_regclass('public.wig_allocations') is not null then
    execute 'select count(*)::bigint from public.wig_allocations where wig_id = $1'
      into v_reference_count
      using v_wig."Wig_ID";
    if v_reference_count > 0 then
      raise exception 'This wig cannot be deleted because it has allocation history. Deactivate it instead';
    end if;
  end if;

  insert into public.audit_logs (
    user_id, action, description, user_email, resource, status, "time"
  ) values (
    v_actor.user_id,
    'wig_catalog.item_deleted',
    format(
      'Deleted unused zero-stock wig catalog item %s (wig_id=%s).',
      coalesce(v_wig."Wig_Code", v_wig."Wig_Name", '#' || v_wig."Wig_ID"::text),
      v_wig."Wig_ID"
    ),
    v_actor.email,
    'Wigs:' || v_wig."Wig_ID"::text,
    'success',
    v_now
  );

  delete from public."Wigs"
  where "Wig_ID" = v_wig."Wig_ID";

  return jsonb_build_object(
    'wig_id', v_wig."Wig_ID",
    'wig_code', v_wig."Wig_Code",
    'action', v_action,
    'is_active', false,
    'deleted', true
  );
end;
$fn$;

revoke all on function public.manage_wig_catalog_item(integer, text) from public, anon;
grant execute on function public.manage_wig_catalog_item(integer, text) to authenticated;

comment on function public.manage_wig_catalog_item(integer, text) is
  'Activates or deactivates the phone filter for a wig variant, or safely deletes an unused zero-stock variant.';

notify pgrst, 'reload schema';
commit;
