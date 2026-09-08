begin;

-- Secure fallback for account activation/deactivation when the browser has
-- been deployed before the admin-account-management Edge Function update.
create or replace function public.admin_set_user_account_active(
  p_user_id integer,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
begin
  select * into v_actor
  from public.users
  where auth_user_id = auth.uid()
    and is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('admin', 'superadmin')
  then
    raise exception 'Only an active Admin can change account access.';
  end if;

  select * into v_target
  from public.users
  where user_id = p_user_id
  for update;

  if v_target.user_id is null then
    raise exception 'User account was not found.';
  end if;
  if v_target.user_id = v_actor.user_id and p_is_active is false then
    raise exception 'You cannot deactivate your own signed-in Admin account.';
  end if;

  update public.users
  set is_active = p_is_active,
      updated_at = timezone('Asia/Manila', now())
  where user_id = p_user_id
  returning * into v_target;

  return jsonb_build_object(
    'user_id', v_target.user_id,
    'is_active', v_target.is_active,
    'auth_user_id', v_target.auth_user_id
  );
end;
$fn$;

revoke all on function public.admin_set_user_account_active(integer, boolean) from public, anon;
grant execute on function public.admin_set_user_account_active(integer, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
