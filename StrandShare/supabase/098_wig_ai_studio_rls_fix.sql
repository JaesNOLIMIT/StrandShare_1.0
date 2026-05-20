-- 098_wig_ai_studio_rls_fix.sql
-- Fixes Specialist Wig AI Studio mutations blocked by RLS:
-- 1) Specialist/Admin can update Wigs stock and related wig rows.
-- 2) Rebuild Wig_AI_Filters update policy deterministically.

alter table if exists public."Wigs" enable row level security;
alter table if exists public."Wig_Specifications" enable row level security;
alter table if exists public."Wig_AI_Filters" enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'Wigs'
      and policyname = 'wigs_specialist_admin_all'
  ) then
    create policy wigs_specialist_admin_all
      on public."Wigs"
      for all
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      )
      with check (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'Wig_Specifications'
      and policyname = 'wig_specifications_specialist_admin_all'
  ) then
    create policy wig_specifications_specialist_admin_all
      on public."Wig_Specifications"
      for all
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      )
      with check (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

drop policy if exists wig_ai_filters_update_specialist_admin on public."Wig_AI_Filters";
create policy wig_ai_filters_update_specialist_admin
  on public."Wig_AI_Filters"
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and public.normalize_app_role(u.role) in ('specialist', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('specialist', 'admin')
    )
  );

drop policy if exists wig_ai_filters_insert_specialist_admin on storage.objects;
create policy wig_ai_filters_insert_specialist_admin
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'wig_ai_filters'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = 'wig-ai-filters'
    and lower(storage.extension(name)) in ('glb', 'gltf', 'png', 'jpg', 'jpeg', 'webp')
    and exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and public.normalize_app_role(u.role) in ('specialist', 'admin')
    )
  );

drop policy if exists wig_ai_filters_update_owner on storage.objects;
create policy wig_ai_filters_update_owner
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'wig_ai_filters'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = 'wig-ai-filters'
  )
  with check (
    bucket_id = 'wig_ai_filters'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = 'wig-ai-filters'
    and lower(storage.extension(name)) in ('glb', 'gltf', 'png', 'jpg', 'jpeg', 'webp')
  );
