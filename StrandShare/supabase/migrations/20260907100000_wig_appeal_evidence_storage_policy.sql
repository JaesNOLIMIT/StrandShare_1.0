begin;

-- Hospital representatives already manage patient_assets in their own auth
-- folder. Appeal evidence uses a separate second-level folder that the prior
-- policy did not allow, which caused storage.objects RLS failures.
insert into storage.buckets (id, name, public)
values ('patient_assets', 'patient_assets', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists patient_assets_insert_wig_appeal_evidence on storage.objects;
create policy patient_assets_insert_wig_appeal_evidence
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'wig-appeals'
  and public.can_manage_patient_assets()
);

drop policy if exists patient_assets_update_wig_appeal_evidence on storage.objects;
create policy patient_assets_update_wig_appeal_evidence
on storage.objects
for update
to authenticated
using (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'wig-appeals'
  and public.can_manage_patient_assets()
)
with check (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'wig-appeals'
  and public.can_manage_patient_assets()
);

drop policy if exists patient_assets_delete_wig_appeal_evidence on storage.objects;
create policy patient_assets_delete_wig_appeal_evidence
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'patient_assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'wig-appeals'
  and public.can_manage_patient_assets()
);

commit;
