-- 114_allow_internal_read_wig_ai_sources.sql
-- Allow internal roles to read wig_ai_sources for operational preview pages.

begin;

drop policy if exists wig_ai_sources_select_internal_roles on storage.objects;

create policy wig_ai_sources_select_internal_roles
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'wig_ai_sources'
    and exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and public.normalize_app_role(u.role) in ('admin', 'staff', 'specialist', 'h_representative')
    )
  );

commit;
