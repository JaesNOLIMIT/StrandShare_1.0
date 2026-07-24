-- 153_wig_catalog_cap_size_families.sql
-- One approved wig style creates a three-size catalog family:
--   WCS0001 -> Small
--   WCM0001 -> Medium
--   WCL0001 -> Large
-- Only the specialist-selected cap size receives the entered starting stock.
-- All variants share the same image, AI analysis, attributes, and try-on fit.

begin;

alter table if exists public."Wigs"
  add column if not exists "Catalog_Family_Number" integer null;

update public."Wigs"
set "Catalog_Family_Number" = right("Wig_Code", 4)::integer
where "Catalog_Family_Number" is null
  and coalesce("Wig_Code", '') ~ '^W[CS][SML][0-9]{4}$';

create index if not exists idx_wigs_catalog_family_number
  on public."Wigs" ("Catalog_Family_Number");

comment on column public."Wigs"."Catalog_Family_Number"
  is 'Shared four-digit number for the Small, Medium, and Large variants of one wig style.';

create or replace function public.reserve_wig_catalog_code(
  p_hair_texture text,
  p_cap_size text
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_texture_code text;
  v_selected_cap_code text;
  v_number integer;
  v_digits text;
  v_attempt integer;
begin
  if not exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('specialist', 'admin')
  ) then
    raise exception 'Not authorized to reserve wig catalog codes';
  end if;

  v_texture_code := case
    when lower(trim(coalesce(p_hair_texture, ''))) = 'straight' then 'S'
    when lower(trim(coalesce(p_hair_texture, ''))) in ('wavy', 'curly', 'coily') then 'C'
    else null
  end;

  v_selected_cap_code := case
    when lower(trim(coalesce(p_cap_size, ''))) = 'small' then 'S'
    when lower(trim(coalesce(p_cap_size, ''))) = 'medium' then 'M'
    when lower(trim(coalesce(p_cap_size, ''))) = 'large' then 'L'
    else null
  end;

  if v_texture_code is null or v_selected_cap_code is null then
    raise exception 'Hair texture and cap size are required before a wig code can be generated';
  end if;

  for v_attempt in 1..10000 loop
    v_number := nextval('public.wig_catalog_number_seq');
    if v_number > 9999 then
      raise exception 'The four-digit wig catalog sequence is exhausted';
    end if;

    v_digits := lpad(v_number::text, 4, '0');
    if not exists (
      select 1
      from public."Wigs" w
      where upper(coalesce(w."Wig_Code", '')) = any (
        array[
          'W' || v_texture_code || 'S' || v_digits,
          'W' || v_texture_code || 'M' || v_digits,
          'W' || v_texture_code || 'L' || v_digits
        ]
      )
    ) then
      return 'W' || v_texture_code || v_selected_cap_code || v_digits;
    end if;
  end loop;

  raise exception 'Could not reserve a unique wig catalog family code';
end;
$fn$;

create or replace function public.finalize_wig_catalog_item(
  p_filter_id integer,
  p_wig_name text,
  p_wig_code text,
  p_hair_length numeric,
  p_hair_color text,
  p_hair_texture text,
  p_hair_density text,
  p_cap_size text,
  p_style text,
  p_stock_count integer default 1,
  p_low_stock_threshold integer default 2,
  p_fit_settings jsonb default '{}'::jsonb,
  p_duplicate_confirmed boolean default false
)
returns table ("Wig_ID" integer, "Wig_Code" text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_filter public."Wig_AI_Filters"%rowtype;
  v_actor integer;
  v_variant_id integer;
  v_selected_wig_id integer;
  v_selected_code text;
  v_variant_code text;
  v_texture_code text;
  v_expected_prefix text;
  v_family_digits text;
  v_family_number integer;
  v_cap_text text;
  v_cap_letter text;
  v_variant_stock integer;
  v_selected_cap public.wig_cap_size;
  v_variant_cap public.wig_cap_size;
begin
  select u.user_id
  into v_actor
  from public.users u
  where u.auth_user_id = auth.uid()
    and public.normalize_app_role(u.role) in ('specialist', 'admin')
  limit 1;

  if v_actor is null then
    raise exception 'Not authorized to add wig catalog items';
  end if;

  select *
  into v_filter
  from public."Wig_AI_Filters" f
  where f."Filter_ID" = p_filter_id
  for update;

  if not found then
    raise exception 'AI review % was not found', p_filter_id;
  end if;

  if v_filter."Status" <> 'pending_review'::public.wig_ai_filter_status then
    raise exception 'AI review is not ready for final confirmation';
  end if;

  if v_filter."Layer_Full_Wig_Path" is null then
    raise exception 'The transparent wig image is missing';
  end if;

  if trim(coalesce(p_wig_name, '')) = ''
    or trim(coalesce(p_hair_color, '')) = ''
    or trim(coalesce(p_hair_texture, '')) = ''
    or trim(coalesce(p_hair_density, '')) = ''
    or trim(coalesce(p_cap_size, '')) = ''
    or trim(coalesce(p_style, '')) = ''
    or p_hair_length is null
  then
    raise exception 'All wig details are required';
  end if;

  v_selected_code := upper(trim(coalesce(p_wig_code, '')));
  if v_selected_code !~ '^W[CS][SML][0-9]{4}$' then
    raise exception 'Wig code must use W + C/S + S/M/L + four digits';
  end if;

  v_texture_code := case
    when lower(trim(p_hair_texture)) = 'straight' then 'S'
    when lower(trim(p_hair_texture)) in ('wavy', 'curly', 'coily') then 'C'
    else null
  end;

  v_selected_cap := case lower(trim(p_cap_size))
    when 'small' then 'Small'::public.wig_cap_size
    when 'medium' then 'Medium'::public.wig_cap_size
    when 'large' then 'Large'::public.wig_cap_size
    else null
  end;

  v_expected_prefix := 'W'
    || coalesce(v_texture_code, '')
    || case v_selected_cap
         when 'Small'::public.wig_cap_size then 'S'
         when 'Medium'::public.wig_cap_size then 'M'
         when 'Large'::public.wig_cap_size then 'L'
         else ''
       end;

  if length(v_expected_prefix) <> 3 or left(v_selected_code, 3) <> v_expected_prefix then
    raise exception 'Wig code % does not match texture % and selected cap size %',
      v_selected_code, p_hair_texture, p_cap_size;
  end if;

  v_family_digits := right(v_selected_code, 4);
  v_family_number := v_family_digits::integer;

  if exists (
    select 1
    from public."Wigs" w
    where upper(coalesce(w."Wig_Code", '')) = any (
      array[
        'W' || v_texture_code || 'S' || v_family_digits,
        'W' || v_texture_code || 'M' || v_family_digits,
        'W' || v_texture_code || 'L' || v_family_digits
      ]
    )
  ) then
    raise exception 'One or more cap-size codes for family % are already in use',
      v_family_digits;
  end if;

  if coalesce(p_stock_count, 0) < 0 or coalesce(p_low_stock_threshold, 0) < 0 then
    raise exception 'Stock values cannot be negative';
  end if;

  if jsonb_path_exists(
    coalesce(v_filter."Duplicate_Matches", '[]'::jsonb),
    '$[*] ? (@.score >= 0.78)'
  ) and not coalesce(p_duplicate_confirmed, false) then
    raise exception 'Review and confirm the similar inventory matches before submission';
  end if;

  foreach v_cap_text in array array['Small', 'Medium', 'Large'] loop
    v_variant_cap := v_cap_text::public.wig_cap_size;
    v_cap_letter := case v_variant_cap
      when 'Small'::public.wig_cap_size then 'S'
      when 'Medium'::public.wig_cap_size then 'M'
      when 'Large'::public.wig_cap_size then 'L'
    end;
    v_variant_code := 'W' || v_texture_code || v_cap_letter || v_family_digits;
    v_variant_stock := case
      when v_variant_cap = v_selected_cap then coalesce(p_stock_count, 1)
      else 0
    end;

    perform set_config(
      'wig.stock_reason',
      case
        when v_variant_cap = v_selected_cap then 'Initial catalog stock'
        else 'Catalog cap-size variant created without stock'
      end,
      true
    );

    insert into public."Wigs" as inserted_wig (
      "Wig_Name",
      "Wig_Code",
      "Catalog_Family_Number",
      "Stock_Count",
      "Low_Stock_Threshold",
      "Wig_Status",
      "Catalog_Image_Path",
      "Created_By",
      "Added_By",
      "Completed_At"
    )
    values (
      trim(p_wig_name),
      v_variant_code,
      v_family_number,
      v_variant_stock,
      coalesce(p_low_stock_threshold, 2),
      case when v_variant_stock > 0 then 'available' else 'not available' end,
      v_filter."Layer_Full_Wig_Path",
      v_actor,
      v_actor,
      now()
    )
    returning inserted_wig."Wig_ID" into v_variant_id;

    insert into public."Wig_Specifications" (
      "Wig_ID",
      "Hair_Length",
      "Hair_Color",
      "Hair_Texture",
      "Hair_Density",
      "Cap_Size",
      "Style",
      "Visual_Embedding",
      "AI_Suggestions",
      "AI_Model_Version"
    )
    values (
      v_variant_id,
      p_hair_length,
      trim(p_hair_color),
      trim(p_hair_texture),
      trim(p_hair_density),
      v_variant_cap,
      trim(p_style),
      v_filter."Visual_Embedding",
      coalesce(v_filter."AI_Suggestions", '{}'::jsonb),
      v_filter."AI_Model_Version"
    );

    if v_variant_cap = v_selected_cap then
      v_selected_wig_id := v_variant_id;
    else
      insert into public."Wig_AI_Filters" (
        "Wig_ID",
        "Version",
        "Status",
        "Is_Active",
        "Source_Front_Path",
        "Source_Side_Path",
        "Source_Top_Path",
        "Source_Back_Path",
        "Thumbnail_Path",
        "Fit_Settings",
        "AI_Model_Version",
        "Processing_Started_At",
        "Processing_Completed_At",
        "Created_By_User_ID",
        "Approved_By_User_ID",
        "Approved_At",
        "Layer_Full_Wig_Path",
        "Layer_Back_Hair_Path",
        "Layer_Front_Bangs_Path",
        "Layer_Hair_Mask_Path",
        "Layer_Face_Mask_Path",
        "AI_Suggestions",
        "Duplicate_Matches",
        "Duplicate_Confirmed",
        "Visual_Embedding"
      )
      values (
        v_variant_id,
        1,
        'approved',
        true,
        null,
        null,
        null,
        null,
        v_filter."Thumbnail_Path",
        coalesce(p_fit_settings, '{}'::jsonb),
        v_filter."AI_Model_Version",
        v_filter."Processing_Started_At",
        v_filter."Processing_Completed_At",
        v_actor,
        v_actor,
        now(),
        v_filter."Layer_Full_Wig_Path",
        v_filter."Layer_Back_Hair_Path",
        v_filter."Layer_Front_Bangs_Path",
        v_filter."Layer_Hair_Mask_Path",
        v_filter."Layer_Face_Mask_Path",
        coalesce(v_filter."AI_Suggestions", '{}'::jsonb),
        coalesce(v_filter."Duplicate_Matches", '[]'::jsonb),
        coalesce(p_duplicate_confirmed, false),
        v_filter."Visual_Embedding"
      );
    end if;

    "Wig_ID" := v_variant_id;
    "Wig_Code" := v_variant_code;
    return next;
  end loop;

  update public."Wig_AI_Filters"
  set
    "Wig_ID" = v_selected_wig_id,
    "Status" = 'approved',
    "Is_Active" = true,
    "Fit_Settings" = coalesce(p_fit_settings, '{}'::jsonb),
    "Approved_By_User_ID" = v_actor,
    "Approved_At" = now(),
    "Duplicate_Confirmed" = coalesce(p_duplicate_confirmed, false),
    "Pending_Wig_Name" = null,
    "Pending_Wig_Code" = null,
    "Pending_Hair_Length" = null,
    "Pending_Hair_Color" = null,
    "Pending_Hair_Texture" = null,
    "Pending_Hair_Density" = null,
    "Pending_Cap_Size" = null,
    "Pending_Style" = null
  where "Filter_ID" = p_filter_id;
end;
$fn$;

grant execute on function public.finalize_wig_catalog_item(
  integer, text, text, numeric, text, text, text, text, text,
  integer, integer, jsonb, boolean
) to authenticated;

commit;
