begin;

create table if not exists public.hair_analysis_reference_images (
  reference_image_id bigint generated always as identity primary key,
  reference_category text not null,
  reference_value text not null,
  title text not null,
  description text null,
  storage_bucket text not null default 'hair-analysis-reference-images',
  storage_path text not null,
  use_for_ai boolean not null default true,
  use_for_donor_ui boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hair_analysis_reference_images_unique_path unique (storage_bucket, storage_path),
  constraint hair_analysis_reference_images_category_check check (
    reference_category in ('texture', 'visible_oiliness', 'visible_flaking', 'visible_condition', 'density')
  )
);

create index if not exists idx_hair_analysis_reference_images_active_usage
  on public.hair_analysis_reference_images (reference_category, reference_value, sort_order)
  where is_active = true;

alter table public.hair_analysis_reference_images enable row level security;

create or replace function public.can_manage_hair_analysis_reference_images()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.users account
    where account.auth_user_id = auth.uid()
      and account.is_active is distinct from false
      and public.normalize_app_role(account.role) in ('admin', 'superadmin', 'staff', 'specialist')
  );
$fn$;

revoke all on function public.can_manage_hair_analysis_reference_images() from public, anon;
grant execute on function public.can_manage_hair_analysis_reference_images() to authenticated;

drop policy if exists hair_analysis_reference_images_donor_read on public.hair_analysis_reference_images;
create policy hair_analysis_reference_images_donor_read
  on public.hair_analysis_reference_images
  for select
  to authenticated
  using (
    (is_active = true and use_for_donor_ui = true)
    or public.can_manage_hair_analysis_reference_images()
  );

drop policy if exists hair_analysis_reference_images_manager_insert on public.hair_analysis_reference_images;
create policy hair_analysis_reference_images_manager_insert
  on public.hair_analysis_reference_images
  for insert
  to authenticated
  with check (
    public.can_manage_hair_analysis_reference_images()
    and storage_bucket = 'hair-analysis-reference-images'
    and is_active = true
    and use_for_ai = true
    and use_for_donor_ui = true
  );

drop policy if exists hair_analysis_reference_images_manager_update on public.hair_analysis_reference_images;
create policy hair_analysis_reference_images_manager_update
  on public.hair_analysis_reference_images
  for update
  to authenticated
  using (public.can_manage_hair_analysis_reference_images())
  with check (
    public.can_manage_hair_analysis_reference_images()
    and storage_bucket = 'hair-analysis-reference-images'
    and is_active = true
    and use_for_ai = true
    and use_for_donor_ui = true
  );

drop policy if exists hair_analysis_reference_images_manager_delete on public.hair_analysis_reference_images;
create policy hair_analysis_reference_images_manager_delete
  on public.hair_analysis_reference_images
  for delete
  to authenticated
  using (public.can_manage_hair_analysis_reference_images());

create or replace function public.guard_last_hair_analysis_reference_image()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if not exists (
    select 1
    from public.hair_analysis_reference_images reference
    where reference.reference_category = old.reference_category
      and reference.reference_value = old.reference_value
      and reference.reference_image_id <> old.reference_image_id
  ) then
    raise exception 'The last reference photo for this value cannot be deleted. Replace it instead.';
  end if;

  return old;
end;
$fn$;

drop trigger if exists trg_guard_last_hair_analysis_reference_image
  on public.hair_analysis_reference_images;
create trigger trg_guard_last_hair_analysis_reference_image
before delete on public.hair_analysis_reference_images
for each row execute function public.guard_last_hair_analysis_reference_image();

create or replace function public.set_hair_analysis_reference_image_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_set_hair_analysis_reference_image_updated_at
  on public.hair_analysis_reference_images;
create trigger trg_set_hair_analysis_reference_image_updated_at
before update on public.hair_analysis_reference_images
for each row execute function public.set_hair_analysis_reference_image_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hair-analysis-reference-images',
  'hair-analysis-reference-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists hair_analysis_reference_objects_read on storage.objects;
create policy hair_analysis_reference_objects_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'hair-analysis-reference-images'
    and (
      public.can_manage_hair_analysis_reference_images()
      or exists (
        select 1
        from public.hair_analysis_reference_images reference
        where reference.is_active = true
          and reference.use_for_donor_ui = true
          and reference.storage_bucket = storage.objects.bucket_id
          and reference.storage_path = storage.objects.name
      )
    )
  );

drop policy if exists hair_analysis_reference_objects_insert on storage.objects;
create policy hair_analysis_reference_objects_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'hair-analysis-reference-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
    and public.can_manage_hair_analysis_reference_images()
  );

drop policy if exists hair_analysis_reference_objects_update on storage.objects;
create policy hair_analysis_reference_objects_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'hair-analysis-reference-images'
    and public.can_manage_hair_analysis_reference_images()
  )
  with check (
    bucket_id = 'hair-analysis-reference-images'
    and public.can_manage_hair_analysis_reference_images()
  );

drop policy if exists hair_analysis_reference_objects_delete on storage.objects;
create policy hair_analysis_reference_objects_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'hair-analysis-reference-images'
    and public.can_manage_hair_analysis_reference_images()
  );

comment on table public.hair_analysis_reference_images is
  'Staff-curated private reference-photo library. Admin, Staff, and Specialist may upload, replace, and safely delete photos.';
comment on column public.hair_analysis_reference_images.use_for_ai is
  'Reserved for server-side analyzer use; manager uploads default to enabled.';
comment on column public.hair_analysis_reference_images.use_for_donor_ui is
  'Allows authenticated donor clients to request a short-lived preview URL.';

notify pgrst, 'reload schema';
commit;
