begin;

-- Storage policies run as the authenticated caller. Checking public.users
-- directly from a storage policy can return no rows when users RLS is active,
-- even though the same Staff member is authorized by the workflow RPCs. Keep
-- the authorization check in a narrowly scoped security-definer function.
create or replace function public.can_manage_walk_in_hair_storage_object(
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    split_part(coalesce(p_object_name, ''), '/', 1) = 'walk-ins'
    and split_part(coalesce(p_object_name, ''), '/', 2) ~ '^[0-9]+$'
    and exists (
      select 1
      from public.users actor
      join public."Event_Requests" event
        on event."Assigned_Staff_User_ID" = actor.user_id
      join public."Hair_Submissions" submission
        on submission."Event_Request_ID" = event."Event_Request_ID"
      where actor.auth_user_id = auth.uid()
        and actor.is_active is distinct from false
        and public.normalize_app_role(actor.role) = 'staff'
        and submission."Is_Walk_In" is true
        and submission."Submission_ID" = case
          when split_part(coalesce(p_object_name, ''), '/', 2) ~ '^[0-9]+$'
            then split_part(p_object_name, '/', 2)::integer
          else null
        end
    );
$fn$;

revoke all on function public.can_manage_walk_in_hair_storage_object(text) from public, anon, authenticated;
grant execute on function public.can_manage_walk_in_hair_storage_object(text) to authenticated;

drop policy if exists hair_submissions_insert_staff on storage.objects;
create policy hair_submissions_insert_staff on storage.objects
for insert to authenticated
with check (
  bucket_id = 'hair-submissions'
  and public.can_manage_walk_in_hair_storage_object(name)
);

drop policy if exists hair_submissions_select_staff on storage.objects;
create policy hair_submissions_select_staff on storage.objects
for select to authenticated
using (
  bucket_id = 'hair-submissions'
  and public.can_manage_walk_in_hair_storage_object(name)
);

drop policy if exists hair_submissions_update_staff on storage.objects;
create policy hair_submissions_update_staff on storage.objects
for update to authenticated
using (
  bucket_id = 'hair-submissions'
  and public.can_manage_walk_in_hair_storage_object(name)
)
with check (
  bucket_id = 'hair-submissions'
  and public.can_manage_walk_in_hair_storage_object(name)
);

drop policy if exists hair_submissions_delete_staff on storage.objects;
create policy hair_submissions_delete_staff on storage.objects
for delete to authenticated
using (
  bucket_id = 'hair-submissions'
  and public.can_manage_walk_in_hair_storage_object(name)
);

-- Save image metadata behind the same assigned-Staff authorization used by
-- the walk-in assessment. This does not depend on the table's client RLS.
create or replace function public.staff_upsert_walk_in_hair_photo(
  p_submission_detail_id integer,
  p_file_path text,
  p_image_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_detail public."Hair_Submission_Details"%rowtype;
  v_image public."Hair_Submission_Images"%rowtype;
  v_old_file_path text;
  v_image_type text := initcap(public.normalize_flow_key(p_image_type));
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  select * into v_detail
  from public."Hair_Submission_Details" detail
  where detail."Submission_Detail_ID" = p_submission_detail_id;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = v_detail."Submission_ID";

  if v_actor.user_id is null
     or public.normalize_app_role(v_actor.role) <> 'staff'
     or v_detail."Submission_Detail_ID" is null
     or v_submission."Is_Walk_In" is not true
     or not exists (
       select 1 from public."Event_Requests" event
       where event."Event_Request_ID" = v_submission."Event_Request_ID"
         and event."Assigned_Staff_User_ID" = v_actor.user_id
     ) then
    raise exception 'Only the assigned Staff member can save this walk-in hair photo.';
  end if;
  if public.is_hair_detail_final_status(v_detail."Status") then
    raise exception 'Hair photos are locked after the final decision.';
  end if;
  if v_image_type is null or v_image_type not in ('Front', 'Side', 'Top') then
    raise exception 'Image type must be Front, Side, or Top.';
  end if;
  if nullif(trim(coalesce(p_file_path, '')), '') is null
     or length(p_file_path) > 255
     or p_file_path not like ('walk-ins/' || v_submission."Submission_ID"::text || '/%') then
    raise exception 'Invalid walk-in hair photo path.';
  end if;

  select * into v_image
  from public."Hair_Submission_Images" image
  where image."Submission_Detail_ID" = v_detail."Submission_Detail_ID"
    and public.normalize_flow_key(image."Image_Type") = public.normalize_flow_key(v_image_type)
  order by image."Image_ID"
  limit 1
  for update;

  if v_image."Image_ID" is null then
    insert into public."Hair_Submission_Images" (
      "Submission_Detail_ID", "File_Path", "Image_Type"
    ) values (
      v_detail."Submission_Detail_ID", trim(p_file_path), v_image_type
    )
    returning * into v_image;
  else
    v_old_file_path := v_image."File_Path";
    update public."Hair_Submission_Images"
    set "File_Path" = trim(p_file_path), "Image_Type" = v_image_type,
        "Uploaded_At" = timezone('Asia/Manila', now())
    where "Image_ID" = v_image."Image_ID"
    returning * into v_image;
  end if;

  return jsonb_build_object(
    'image', to_jsonb(v_image),
    'old_file_path', v_old_file_path
  );
end;
$fn$;

create or replace function public.staff_delete_walk_in_hair_photo(
  p_image_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_detail public."Hair_Submission_Details"%rowtype;
  v_image public."Hair_Submission_Images"%rowtype;
begin
  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  select * into v_image
  from public."Hair_Submission_Images" image
  where image."Image_ID" = p_image_id
  for update;

  select * into v_detail
  from public."Hair_Submission_Details" detail
  where detail."Submission_Detail_ID" = v_image."Submission_Detail_ID";

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = v_detail."Submission_ID";

  if v_actor.user_id is null
     or public.normalize_app_role(v_actor.role) <> 'staff'
     or v_image."Image_ID" is null
     or v_submission."Is_Walk_In" is not true
     or not exists (
       select 1 from public."Event_Requests" event
       where event."Event_Request_ID" = v_submission."Event_Request_ID"
         and event."Assigned_Staff_User_ID" = v_actor.user_id
     ) then
    raise exception 'Only the assigned Staff member can remove this walk-in hair photo.';
  end if;
  if public.is_hair_detail_final_status(v_detail."Status") then
    raise exception 'Hair photos are locked after the final decision.';
  end if;

  delete from public."Hair_Submission_Images"
  where "Image_ID" = v_image."Image_ID";

  return jsonb_build_object(
    'image_id', v_image."Image_ID",
    'file_path', v_image."File_Path",
    'image_type', v_image."Image_Type"
  );
end;
$fn$;

revoke all on function public.staff_upsert_walk_in_hair_photo(integer, text, text) from public, anon, authenticated;
grant execute on function public.staff_upsert_walk_in_hair_photo(integer, text, text) to authenticated;
revoke all on function public.staff_delete_walk_in_hair_photo(integer) from public, anon, authenticated;
grant execute on function public.staff_delete_walk_in_hair_photo(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
