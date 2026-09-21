begin;

alter table public.users
  add column if not exists font_size_preference text not null default 'default';

alter table public.users
  drop constraint if exists users_font_size_preference_check;
alter table public.users
  add constraint users_font_size_preference_check check (
    font_size_preference in ('small', 'default', 'large', 'extra_large')
  );

create or replace function public.update_my_font_size_preference(
  p_font_size_preference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_preference text := replace(replace(lower(trim(coalesce(p_font_size_preference, ''))), ' ', '_'), '-', '_');
begin
  if v_preference not in ('small', 'default', 'large', 'extra_large') then
    raise exception 'Choose Small, Default, Large, or Extra Large.';
  end if;

  update public.users account
  set font_size_preference = v_preference,
      updated_at = timezone('Asia/Manila', now())
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  returning * into v_actor;

  if v_actor.user_id is null then
    raise exception 'An active user account was not found.';
  end if;

  return jsonb_build_object(
    'user_id', v_actor.user_id,
    'font_size_preference', v_actor.font_size_preference
  );
end;
$fn$;

revoke all on function public.update_my_font_size_preference(text)
  from public, anon, authenticated;
grant execute on function public.update_my_font_size_preference(text)
  to authenticated;

comment on column public.users.font_size_preference is
  'Per-account text scale for authenticated Donivra workspaces; public pages are unaffected.';

notify pgrst, 'reload schema';
commit;
