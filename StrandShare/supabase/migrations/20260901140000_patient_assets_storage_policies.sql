-- Ensure H-Representatives can upload patient pictures and medical documents
-- through the authenticated browser client. Paths are isolated by auth user id.

begin;

insert into storage.buckets (id, name, public)
values ('patient_assets', 'patient_assets', true)
on conflict (id) do update set public = excluded.public;

create or replace function public.can_manage_patient_assets()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and coalesce(u.is_active, true)
      and public.normalize_app_role(u.role) in ('hrepresentative', 'admin', 'superadmin')
  );
$fn$;

revoke all on function public.can_manage_patient_assets() from public, anon;
grant execute on function public.can_manage_patient_assets() to authenticated;

drop policy if exists patient_assets_insert_hstaff on storage.objects;
drop policy if exists patient_assets_update_hstaff on storage.objects;
drop policy if exists patient_assets_delete_hstaff on storage.objects;
drop policy if exists patient_assets_insert_h_representative on storage.objects;
drop policy if exists patient_assets_update_h_representative on storage.objects;
drop policy if exists patient_assets_delete_h_representative on storage.objects;
drop policy if exists patient_assets_select_public on storage.objects;

create policy patient_assets_insert_h_representative
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] in ('patient-picture', 'medical-document')
  and public.can_manage_patient_assets()
);

create policy patient_assets_update_h_representative
on storage.objects
for update
to authenticated
using (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] in ('patient-picture', 'medical-document')
  and public.can_manage_patient_assets()
)
with check (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] in ('patient-picture', 'medical-document')
  and public.can_manage_patient_assets()
);

create policy patient_assets_delete_h_representative
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] in ('patient-picture', 'medical-document')
  and public.can_manage_patient_assets()
);

create policy patient_assets_select_public
on storage.objects
for select
to public
using (bucket_id = 'patient_assets');

commit;
