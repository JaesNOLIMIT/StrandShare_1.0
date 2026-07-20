-- 139_fix_hospital_logos_storage_policies.sql
-- Strong follow-up fix for hospital logo uploads when older storage policies
-- were not removed cleanly or when the project was restored out of order.
--
-- Scope: the `hospital_logos` storage bucket ONLY.
-- This is safe to run multiple times.

-- ---------------------------------------------------------------------------
-- 1. Ensure the bucket exists and is public for logo rendering.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('hospital_logos', 'hospital_logos', true)
on conflict (id) do update set public = excluded.public;

-- ---------------------------------------------------------------------------
-- 2. Drop every storage.objects policy that mentions hospital_logos.
--    We match by policy name and by policy definition so restrictive leftovers
--    from older migrations cannot survive under a different name.
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
        policyname ilike '%hospital_logos%'
        or coalesce(qual, '') ilike '%hospital_logos%'
        or coalesce(with_check, '') ilike '%hospital_logos%'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', policy_record.policyname);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Re-create the simplest working policy set.
--    Public insert covers both anon applicants and signed-in admins.
--    Authenticated update/delete covers re-uploads and cleanup.
-- ---------------------------------------------------------------------------

create policy hospital_logos_insert_public
  on storage.objects
  for insert
  to public
  with check (bucket_id = 'hospital_logos');

create policy hospital_logos_select_public
  on storage.objects
  for select
  to public
  using (bucket_id = 'hospital_logos');

create policy hospital_logos_update_authenticated
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'hospital_logos')
  with check (bucket_id = 'hospital_logos');

create policy hospital_logos_delete_authenticated
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'hospital_logos');

-- ---------------------------------------------------------------------------
-- 4. Sanity check for SQL Editor output.
-- ---------------------------------------------------------------------------

do $$
declare
  policy_record record;
begin
  raise notice '--- storage.objects policies for hospital_logos ---';
  for policy_record in
    select policyname, cmd, permissive, roles
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname ilike '%hospital_logos%'
    order by policyname
  loop
    raise notice '% | cmd=% | permissive=% | roles=%',
      policy_record.policyname,
      policy_record.cmd,
      policy_record.permissive,
      policy_record.roles;
  end loop;
end
$$;