begin;

-- Reject every authenticated PostgREST request made by an inactive account.
-- This closes the access-token window that remains after an Auth user is
-- banned, because already-issued JWTs cannot otherwise be recalled instantly.
create or replace function public.enforce_active_account_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_auth_user_id uuid := auth.uid();
begin
  if v_auth_user_id is null then
    return;
  end if;

  if not exists (
    select 1
    from public.users account
    where account.auth_user_id = v_auth_user_id
      and account.is_active is distinct from false
  ) then
    raise insufficient_privilege using
      message = 'ACCOUNT_INACTIVE',
      detail = 'This account has been deactivated. Sign in with an active account.';
  end if;
end;
$fn$;

revoke all on function public.enforce_active_account_request() from public;
grant execute on function public.enforce_active_account_request() to anon, authenticated;

-- Supabase/PostgREST invokes this before each API request. Anonymous public
-- forms are unaffected because auth.uid() is null.
alter role authenticator set pgrst.db_pre_request = 'public.enforce_active_account_request';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
commit;
