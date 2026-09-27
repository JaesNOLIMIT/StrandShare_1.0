begin;

-- Vercel cannot start or reach the optional workstation AI process. Permit an
-- authenticated Specialist/Admin to stage the original wig image in the same
-- catalog bucket and complete the existing review flow manually.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wig_ai_filters',
  'wig_ai_filters',
  true,
  15728640,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_manage_wig_catalog_storage_object(
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    split_part(coalesce(p_object_name, ''), '/', 1) = auth.uid()::text
    and split_part(coalesce(p_object_name, ''), '/', 2) = 'wig-ai-filters'
    and exists (
      select 1
      from public.users actor
      where actor.auth_user_id = auth.uid()
        and actor.is_active is distinct from false
        and public.normalize_app_role(actor.role) in ('specialist', 'admin')
    );
$fn$;

revoke all on function public.can_manage_wig_catalog_storage_object(text)
from public, anon, authenticated;
grant execute on function public.can_manage_wig_catalog_storage_object(text)
to authenticated;

drop policy if exists wig_ai_filters_insert_specialist_admin on storage.objects;
create policy wig_ai_filters_insert_specialist_admin
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'wig_ai_filters'
  and public.can_manage_wig_catalog_storage_object(name)
  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
);

drop policy if exists wig_ai_filters_update_owner on storage.objects;
create policy wig_ai_filters_update_owner
on storage.objects
for update to authenticated
using (
  bucket_id = 'wig_ai_filters'
  and public.can_manage_wig_catalog_storage_object(name)
)
with check (
  bucket_id = 'wig_ai_filters'
  and public.can_manage_wig_catalog_storage_object(name)
  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
);

drop policy if exists wig_ai_filters_delete_owner on storage.objects;
create policy wig_ai_filters_delete_owner
on storage.objects
for delete to authenticated
using (
  bucket_id = 'wig_ai_filters'
  and public.can_manage_wig_catalog_storage_object(name)
);

create or replace function public.stage_manual_wig_catalog_review(
  p_filter_id integer,
  p_image_path text,
  p_duplicate_matches jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_filter public."Wig_AI_Filters"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  select * into v_filter
  from public."Wig_AI_Filters" filter_row
  where filter_row."Filter_ID" = p_filter_id
  for update;

  if v_actor.user_id is null
     or public.normalize_app_role(v_actor.role) not in ('specialist', 'admin')
     or v_filter."Filter_ID" is null
     or v_filter."Created_By_User_ID" is distinct from v_actor.user_id then
    raise exception 'Only the Specialist/Admin who started this review can stage its manual image.';
  end if;

  if nullif(trim(coalesce(p_image_path, '')), '') is null
     or p_image_path not like auth.uid()::text || '/wig-ai-filters/' || p_filter_id::text || '/%'
     or not public.can_manage_wig_catalog_storage_object(p_image_path) then
    raise exception 'Invalid manual wig catalog image path.';
  end if;

  if not exists (
    select 1
    from storage.objects object_row
    where object_row.bucket_id = 'wig_ai_filters'
      and object_row.name = p_image_path
      and lower(coalesce(object_row.metadata ->> 'mimetype', '')) in (
        'image/png', 'image/jpeg', 'image/webp'
      )
  ) then
    raise exception 'The uploaded wig image was not found.';
  end if;

  if p_duplicate_matches is null or jsonb_typeof(p_duplicate_matches) <> 'array' then
    raise exception 'Duplicate matches must be a JSON array.';
  end if;

  update public."Wig_AI_Filters"
  set
    "Status" = 'pending_review',
    "Source_Front_Path" = p_image_path,
    "Layer_Full_Wig_Path" = p_image_path,
    "Thumbnail_Path" = p_image_path,
    "AI_Model_Version" = 'manual-cloud-v1',
    "AI_Suggestions" = jsonb_build_object(
      '_meta', jsonb_build_object(
        'mode', 'manual-cloud',
        'message', 'AI was unavailable; all catalog attributes require staff verification.'
      )
    ),
    "Duplicate_Matches" = p_duplicate_matches,
    "Visual_Embedding" = null,
    "Processing_Started_At" = coalesce("Processing_Started_At", v_now),
    "Processing_Completed_At" = v_now,
    "Error_Message" = null
  where "Filter_ID" = p_filter_id
  returning * into v_filter;

  return jsonb_build_object('filter', to_jsonb(v_filter));
end;
$fn$;

revoke all on function public.stage_manual_wig_catalog_review(integer, text, jsonb)
from public, anon, authenticated;
grant execute on function public.stage_manual_wig_catalog_review(integer, text, jsonb)
to authenticated;

notify pgrst, 'reload schema';
commit;
