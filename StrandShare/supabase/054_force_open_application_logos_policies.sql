-- 054_force_open_application_logos_policies.sql
-- Nuclear-option migration: drop EVERY existing policy on storage.objects
-- that mentions organization_logos or hospital_logos (whether or not we
-- created it), then add the simplest possible permissive policies.
--
-- Run this when 053 was applied but RLS still blocks uploads, usually because
-- a leftover restrictive policy from an earlier migration is still attached.
-- Safe and idempotent: re-running it is a no-op.

-- ---------------------------------------------------------------------------
-- Ensure both buckets exist and are public
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('organization_logos', 'organization_logos', true)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('hospital_logos', 'hospital_logos', true)
on conflict (id) do update set public = excluded.public;

-- ---------------------------------------------------------------------------
-- Drop EVERY policy on storage.objects that references either bucket name,
-- either in policy name OR in policy definition (qual/with_check). This
-- catches restrictive policies with generic names.
-- ---------------------------------------------------------------------------

do $$
declare
  policy_record record;
begin
  for policy_record in
    select
      policyname,
      coalesce(qual, '') as qual,
      coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        policyname ilike '%organization_logos%'
        or policyname ilike '%hospital_logos%'
        or coalesce(qual, '') ilike '%organization_logos%'
        or coalesce(qual, '') ilike '%hospital_logos%'
        or coalesce(with_check, '') ilike '%organization_logos%'
        or coalesce(with_check, '') ilike '%hospital_logos%'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', policy_record.policyname);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Simplest possible permissive policies. No folder check, no extension check.
-- ---------------------------------------------------------------------------

create policy organization_logos_open_insert
  on storage.objects
  for insert
  to public
  with check (bucket_id = 'organization_logos');

create policy organization_logos_open_select
  on storage.objects
  for select
  to public
  using (bucket_id = 'organization_logos');

create policy hospital_logos_open_insert
  on storage.objects
  for insert
  to public
  with check (bucket_id = 'hospital_logos');

create policy hospital_logos_open_select
  on storage.objects
  for select
  to public
  using (bucket_id = 'hospital_logos');

-- ---------------------------------------------------------------------------
-- Sanity check: list what's now in place so you can verify in SQL Editor output.
-- ---------------------------------------------------------------------------

do $$
declare
  policy_record record;
begin
  raise notice '--- storage.objects policies for application logo buckets ---';
  for policy_record in
    select policyname, cmd, permissive, roles, qual, with_check
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        policyname ilike '%organization_logos%'
        or policyname ilike '%hospital_logos%'
        or coalesce(qual, '') ilike '%organization_logos%'
        or coalesce(qual, '') ilike '%hospital_logos%'
        or coalesce(with_check, '') ilike '%organization_logos%'
        or coalesce(with_check, '') ilike '%hospital_logos%'
      )
    order by policyname
  loop
    raise notice '% | cmd=% | permissive=% | roles=% | using=% | with_check=%',
      policy_record.policyname,
      policy_record.cmd,
      policy_record.permissive,
      policy_record.roles,
      policy_record.qual,
      policy_record.with_check;
  end loop;
end
$$;
