-- A hair removed from a draft bundle becomes available Cut inventory again.
-- Keep both Hair_Submissions and Cut_Hair_Inventory synchronized even on
-- deployments where an older lifecycle trigger is still installed.

begin;

create or replace function public.restore_cut_status_before_bundle_removal()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if old."Bundle_ID" is not null and new."Bundle_ID" is null then
    new."Status" := 'Cut';
    new."Updated_At" := timezone('Asia/Manila', now());
  end if;
  return new;
end;
$fn$;

create or replace function public.restore_cut_inventory_after_bundle_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old."Bundle_ID" is not null and new."Bundle_ID" is null then
    update public."Cut_Hair_Inventory"
    set
      "Bundle_ID" = null,
      "Wig_ID" = null,
      "Status" = 'Cut',
      "Bundled_At" = null,
      "Wig_Created_At" = null,
      "Updated_At" = now()
    where "Submission_ID" = new."Submission_ID";
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_restore_cut_status_before_bundle_removal
  on public."Hair_Submissions";
create trigger trg_restore_cut_status_before_bundle_removal
before update of "Bundle_ID"
on public."Hair_Submissions"
for each row
execute function public.restore_cut_status_before_bundle_removal();

drop trigger if exists trg_restore_cut_inventory_after_bundle_removal
  on public."Hair_Submissions";
create trigger trg_restore_cut_inventory_after_bundle_removal
after update of "Bundle_ID"
on public."Hair_Submissions"
for each row
execute function public.restore_cut_inventory_after_bundle_removal();

-- Replace the older removal RPC, which incorrectly required the submission
-- itself to have Status = Cut. While attached to a draft, the removable state
-- is Cut_Hair_Inventory.Status = Bundling.
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
  v_actor public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_inventory_status text;
  v_member_count integer := 0;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if p_bundle_id is null or p_submission_id is null then
    raise exception 'Bundle_ID and Submission_ID are required.';
  end if;

  select * into v_actor
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_actor.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_actor.role);
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can remove waybills from a draft bundle.';
  end if;

  select * into v_bundle
  from public."Hair_Submission_Bundles" b
  where b."Bundle_ID" = p_bundle_id
  for update;

  if v_bundle."Bundle_ID" is null then
    raise exception 'Bundle % not found.', p_bundle_id;
  end if;

  if public.normalize_flow_key(v_bundle."Status") <> 'draft' then
    raise exception 'Only hairs in a Draft bundle can be removed. Bundle % is currently %.',
      p_bundle_id, coalesce(v_bundle."Status", 'N/A');
  end if;

  select * into v_submission
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = p_submission_id
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'Submission % not found.', p_submission_id;
  end if;

  if v_submission."Bundle_ID" is distinct from p_bundle_id then
    raise exception 'Submission % is not assigned to draft bundle %.', p_submission_id, p_bundle_id;
  end if;

  select chi."Status"
  into v_inventory_status
  from public."Cut_Hair_Inventory" chi
  where chi."Submission_ID" = p_submission_id
  for update;

  if public.normalize_flow_key(v_inventory_status) <> 'bundling' then
    raise exception 'Only Bundling-status hair can be removed from a draft. Current inventory status: %.',
      coalesce(v_inventory_status, 'Missing');
  end if;

  update public."Hair_Submissions"
  set
    "Bundle_ID" = null,
    "Status" = 'Cut',
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
    and "Bundle_ID" = p_bundle_id
  returning * into v_submission;

  -- Keep this explicit as well as trigger-backed for older deployments.
  update public."Cut_Hair_Inventory"
  set
    "Bundle_ID" = null,
    "Wig_ID" = null,
    "Status" = 'Cut',
    "Bundled_At" = null,
    "Wig_Created_At" = null,
    "Updated_At" = now()
  where "Submission_ID" = p_submission_id;

  select count(*)::integer into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set "Updated_At" = v_now
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  if v_submission."Event_Request_ID" is not null then
    perform public.recompute_event_request_hair_collected_count(v_submission."Event_Request_ID");
  end if;

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'submission', to_jsonb(v_submission),
    'inventory_status', 'Cut',
    'member_count', v_member_count
  );
end;
$fn$;

revoke all on function public.bundle_remove_waybill_from_draft(integer, integer) from public, anon;
grant execute on function public.bundle_remove_waybill_from_draft(integer, integer) to authenticated;

-- Repair any rows already left stale by the previous removal behavior.
update public."Cut_Hair_Inventory" chi
set
  "Bundle_ID" = null,
  "Wig_ID" = null,
  "Status" = 'Cut',
  "Bundled_At" = null,
  "Wig_Created_At" = null,
  "Updated_At" = now()
from public."Hair_Submissions" hs
where hs."Submission_ID" = chi."Submission_ID"
  and hs."Bundle_ID" is null
  and chi."Status" = 'Bundling';

commit;
