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
  v_target_cap_size text;
  v_open_draft_count integer := 0;
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

  select count(*)::integer
  into v_open_draft_count
  from public."Hair_Submission_Bundles" b
  where b."Created_By" = v_user.user_id
    and public.normalize_flow_key(b."Status") = 'draft';

  if v_open_draft_count >= 3 then
    raise exception 'Maximum of 3 open drafts per specialist. Close or delete an existing draft first.';
  end if;

  select ws."Cap_Size"
  into v_target_cap_size
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = p_wig_specification_id
  limit 1;

  if not found then
    raise exception 'Wig specification % does not exist.', p_wig_specification_id;
  end if;

  if v_target_cap_size is null
    or public.normalize_flow_key(v_target_cap_size) not in ('small', 'medium', 'large') then
    raise exception 'Wig specification % must have cap size Small, Medium, or Large.', p_wig_specification_id;
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
    case
      when public.normalize_flow_key(v_target_cap_size) = 'small' then 'Small'
      when public.normalize_flow_key(v_target_cap_size) = 'medium' then 'Medium'
      when public.normalize_flow_key(v_target_cap_size) = 'large' then 'Large'
      else v_target_cap_size
    end
  )
  returning * into v_bundle;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.open_draft',
    format(
      'Opened bundle draft bundle_id=%s wig_specification_id=%s cap_size=%s',
      v_bundle."Bundle_ID",
      p_wig_specification_id,
      coalesce(v_bundle."Target_Cap_Size", 'N/A')
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return to_jsonb(v_bundle);
end;
$fn$;

create or replace function public.bundle_remove_waybill_from_draft(
  p_bundle_id integer,
  p_submission_id integer
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
  v_member_count integer := 0;
begin
  if p_bundle_id is null then
    raise exception 'Bundle_ID is required.';
  end if;

  if p_submission_id is null then
    raise exception 'Submission_ID is required.';
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
    raise exception 'Only specialist/admin can remove waybills from a draft bundle.';
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

  select *
  into v_submission
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = p_submission_id
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'Submission % not found.', p_submission_id;
  end if;

  if v_submission."Bundle_ID" is null then
    raise exception 'Submission % is not assigned to any bundle.', p_submission_id;
  end if;

  if v_submission."Bundle_ID" <> p_bundle_id then
    raise exception 'Submission % belongs to bundle %, not bundle %.', p_submission_id, v_submission."Bundle_ID", p_bundle_id;
  end if;

  if public.normalize_flow_key(v_submission."Status") <> 'cut' then
    raise exception 'Only Cut submissions can be removed from draft bundles. Current status: %', coalesce(v_submission."Status", 'N/A');
  end if;

  update public."Hair_Submissions"
  set
    "Bundle_ID" = null,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Submission_ID" = p_submission_id
    and "Bundle_ID" = p_bundle_id
  returning * into v_submission;

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  perform public.recompute_event_request_hair_collected_count(v_submission."Event_Request_ID");

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.remove_waybill_from_draft',
    format(
      'Removed submission_id=%s waybill=%s from bundle_id=%s (count=%s)',
      v_submission."Submission_ID",
      coalesce(v_submission."Submission_Code", 'N/A'),
      p_bundle_id,
      v_member_count
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'submission', to_jsonb(v_submission),
    'member_count', v_member_count
  );
end;
$fn$;

grant execute on function public.create_hair_bundle_draft(integer, text, text) to authenticated;
grant execute on function public.bundle_remove_waybill_from_draft(integer, integer) to authenticated;

commit;
