-- 138_fix_hospital_logos_storage_policies.sql
-- Definitive fix for "Hospital logo upload blocked by Storage RLS policy".
--
-- Scope: the `hospital_logos` storage bucket ONLY. This migration does NOT
-- touch organization_logos, any other bucket, or any table -- so no other page
-- or table is affected.
--
-- Why this is needed even after 054:
--   * The public application flow writes to  applications/<file>            (anon/public)
--   * The admin Manage-Hospitals flow writes to <auth.uid()>/hospital-logo/.. (authenticated)
--   * Migration 053 only granted the `applications/` folder, and migration 010's
--     super_admin INSERT policy (which 053 never dropped) requires the role to
--     normalize to exactly "superadmin" -- a plain Admin account fails it.
--   * 054 added open INSERT/SELECT but no UPDATE (for upsert:true re-uploads) or
--     DELETE (for logo cleanup via storage.remove()), so those still fail.
--
-- This migration clears every leftover hospital_logos policy (named or
-- definition-referenced, including any hand-made restrictive one) and lays down
-- a clean, complete permissive set: public INSERT/SELECT, authenticated
-- UPDATE/DELETE. Safe and idempotent: re-running it is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Ensure the bucket exists and is public (read access for logo rendering)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('hospital_logos', 'hospital_logos', true)
on conflict (id) do update set public = excluded.public;

-- ---------------------------------------------------------------------------
-- 2. Drop EVERY storage.objects policy tied to hospital_logos.
--    Matches by policy NAME or by the policy DEFINITION (qual / with_check),
--    so leftover restrictive policies with non-obvious names are caught too.
--    Guard: never drop a policy that also references organization_logos, so
--    the organization logo flow is left completely untouched.
-- ---------------------------------------------------------------------------

do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname,
           coalesce(qual, '') || ' ' || coalesce(with_check, '') as definition
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        policyname ilike '%hospital_logos%'
        or coalesce(qual, '') ilike '%hospital_logos%'
        or coalesce(with_check, '') ilike '%hospital_logos%'
      )
  loop
    -- Protect any policy that also touches organization_logos (none should,
    -- but this keeps the migration strictly hospital_logos-only).
    if policy_record.policyname ilike '%organization_logos%'
       or policy_record.definition ilike '%organization_logos%' then
      continue;
    end if;
    execute format('drop policy if exists %I on storage.objects', policy_record.policyname);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Clean, complete permissive policy set for hospital_logos.
--    INSERT/SELECT to public  -> anon applicants + authenticated admins
--    UPDATE/DELETE to authenticated -> admin re-upload (upsert) + logo cleanup
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
-- 4. Sanity check: list what is now in place for hospital_logos.
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
