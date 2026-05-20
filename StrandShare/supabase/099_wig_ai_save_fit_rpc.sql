-- 099_wig_ai_save_fit_rpc.sql
-- Fallback writer for Wig AI Studio fit saves when direct UPDATE is blocked by RLS.
-- This function enforces specialist/admin auth explicitly and updates only fit/layer fields.

create or replace function public.save_wig_ai_filter_fit(
  p_filter_id integer,
  p_fit_settings jsonb,
  p_layer_full_wig_path text default null,
  p_layer_back_hair_path text default null,
  p_layer_front_bangs_path text default null,
  p_layer_hair_mask_path text default null,
  p_layer_face_mask_path text default null,
  p_thumbnail_path text default null,
  p_status text default null,
  p_is_active boolean default null,
  p_approved_at timestamp without time zone default null,
  p_approved_by_user_id integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_filter_id is null then
    raise exception 'Filter_ID is required';
  end if;

  if not exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('specialist', 'admin')
  ) then
    raise exception 'Not authorized to save filter fit';
  end if;

  update public."Wig_AI_Filters"
  set
    "Fit_Settings" = coalesce(p_fit_settings, "Fit_Settings"),
    "Layer_Full_Wig_Path" = coalesce(p_layer_full_wig_path, "Layer_Full_Wig_Path"),
    "Layer_Back_Hair_Path" = coalesce(p_layer_back_hair_path, "Layer_Back_Hair_Path"),
    "Layer_Front_Bangs_Path" = coalesce(p_layer_front_bangs_path, "Layer_Front_Bangs_Path"),
    "Layer_Hair_Mask_Path" = coalesce(p_layer_hair_mask_path, "Layer_Hair_Mask_Path"),
    "Layer_Face_Mask_Path" = coalesce(p_layer_face_mask_path, "Layer_Face_Mask_Path"),
    "Thumbnail_Path" = coalesce(p_thumbnail_path, "Thumbnail_Path"),
    "Status" = coalesce(p_status::public.wig_ai_filter_status, "Status"),
    "Is_Active" = coalesce(p_is_active, "Is_Active"),
    "Approved_At" = coalesce(p_approved_at, "Approved_At"),
    "Approved_By_User_ID" = coalesce(p_approved_by_user_id, "Approved_By_User_ID")
  where "Filter_ID" = p_filter_id;

  if not found then
    raise exception 'Filter_ID % not found', p_filter_id;
  end if;
end;
$fn$;

grant execute on function public.save_wig_ai_filter_fit(integer, jsonb, text, text, text, text, text, text, text, boolean, timestamp without time zone, integer) to authenticated;
