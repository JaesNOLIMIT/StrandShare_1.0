-- 089_wig_ai_filter_storage.sql
-- Two storage buckets that back the Wig_AI_Filters table:
--   wig_ai_sources -- PRIVATE. Raw reference photos uploaded by the specialist
--                     (front / side, optional top / back). Only specialists
--                     and super admins can read or write. Mobile users never
--                     see these.
--   wig_ai_filters -- PUBLIC read. Final generated .glb mesh + thumbnail.
--                     The mobile RN app downloads the .glb of the active
--                     filter via the public URL. Writes are restricted to
--                     specialists / super admins.
--
-- Path convention for both buckets (matches existing convention from
-- 044_completed_wigs_storage_policies.sql):
--   <auth.uid()>/<bucket-folder>/<scope>/<filename>
-- Where <scope> can be a Wig_ID (approved records) or a draft/filter scope
-- before approval.
-- e.g. wig_ai_sources path:  abc-123-def/wig-ai-sources/draft-ab12/front.png
--      wig_ai_filters path:  abc-123-def/wig-ai-filters/filter-44/v1/full_wig.png

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from storage.buckets where id = 'wig_ai_sources') then
    update storage.buckets
      set name = 'wig_ai_sources', public = false
      where id = 'wig_ai_sources';
  else
    insert into storage.buckets (id, name, public)
    values ('wig_ai_sources', 'wig_ai_sources', false);
  end if;
end
$$;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'wig_ai_filters') then
    update storage.buckets
      set name = 'wig_ai_filters', public = true
      where id = 'wig_ai_filters';
  else
    insert into storage.buckets (id, name, public)
    values ('wig_ai_filters', 'wig_ai_filters', true);
  end if;
end
$$;

-- ===========================================================================
-- wig_ai_sources  (PRIVATE bucket)
-- ===========================================================================

-- INSERT: specialist / admin can upload under their own folder.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_sources_insert_specialist_admin'
  ) then
    create policy wig_ai_sources_insert_specialist_admin
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'wig_ai_sources'
        and (storage.foldername(name))[1] = auth.uid()::text
        and (storage.foldername(name))[2] = 'wig-ai-sources'
        and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
        and exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

-- SELECT: specialist / admin only (private bucket -- no public read).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_sources_select_specialist_admin'
  ) then
    create policy wig_ai_sources_select_specialist_admin
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'wig_ai_sources'
        and exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

-- UPDATE: uploader (folder owner) can replace their own files.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_sources_update_owner'
  ) then
    create policy wig_ai_sources_update_owner
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'wig_ai_sources'
        and (storage.foldername(name))[1] = auth.uid()::text
        and (storage.foldername(name))[2] = 'wig-ai-sources'
      )
      with check (
        bucket_id = 'wig_ai_sources'
        and (storage.foldername(name))[1] = auth.uid()::text
        and (storage.foldername(name))[2] = 'wig-ai-sources'
        and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
      );
  end if;
end
$$;

-- DELETE: uploader (folder owner) can delete their own files.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_sources_delete_owner'
  ) then
    create policy wig_ai_sources_delete_owner
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'wig_ai_sources'
        and (storage.foldername(name))[1] = auth.uid()::text
        and (storage.foldername(name))[2] = 'wig-ai-sources'
      );
  end if;
end
$$;

-- ===========================================================================
-- wig_ai_filters  (PUBLIC-read bucket)
-- ===========================================================================

-- INSERT: specialist / admin can upload generated .glb / thumbnail.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_filters_insert_specialist_admin'
  ) then
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
  end if;
end
$$;

-- SELECT: bucket is public above, so anonymous reads are allowed (matches
-- the completed_wigs / wig_request_previews convention). The mobile app
-- fetches GLBs without needing a session.

-- UPDATE: uploader can replace their own files.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_filters_update_owner'
  ) then
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
  end if;
end
$$;

-- DELETE: uploader can delete their own files.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'wig_ai_filters_delete_owner'
  ) then
    create policy wig_ai_filters_delete_owner
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'wig_ai_filters'
        and (storage.foldername(name))[1] = auth.uid()::text
        and (storage.foldername(name))[2] = 'wig-ai-filters'
      );
  end if;
end
$$;
