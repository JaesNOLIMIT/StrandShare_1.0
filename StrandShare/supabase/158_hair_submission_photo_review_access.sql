-- Hair-submission photos are stored in the private `hair-submissions` bucket.
-- Specialists and admins need read access so Quality Check can create short-lived
-- signed URLs without making donor photos public.

begin;

drop policy if exists hair_submissions_select_specialist_admin on storage.objects;

create policy hair_submissions_select_specialist_admin
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'hair-submissions'
    and exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and public.normalize_app_role(u.role) in ('specialist', 'admin')
    )
  );

commit;
