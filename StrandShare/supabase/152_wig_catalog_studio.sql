-- 152_wig_catalog_studio.sql
-- Rebuild the Specialist Wig AI area as a local-first Wig Catalog Studio.
--
-- Key rules:
--   * Raw wig and portrait photos are processed locally and are not persisted.
--   * Only the approved transparent wig PNG is attached to inventory.
--   * Catalog codes use W + C/S + S/M/L + four digits (example WCM0001).
--   * AI suggestions remain advisory/editable.
--   * Similarity warnings require explicit specialist confirmation.
--   * Every stock change is recorded.

begin;

-- Local-first staging no longer needs cloud paths for raw reference photos.
alter table if exists public."Wig_AI_Filters"
  alter column "Source_Front_Path" drop not null,
  alter column "Source_Side_Path" drop not null;

alter table if exists public."Wig_AI_Filters"
  add column if not exists "AI_Suggestions" jsonb not null default '{}'::jsonb,
  add column if not exists "Duplicate_Matches" jsonb not null default '[]'::jsonb,
  add column if not exists "Duplicate_Confirmed" boolean not null default false,
  add column if not exists "Visual_Embedding" jsonb null;

comment on column public."Wig_AI_Filters"."AI_Suggestions"
  is 'High-confidence, editable local-AI attribute suggestions and confidence values.';
comment on column public."Wig_AI_Filters"."Duplicate_Matches"
  is 'Local visual + entered-attribute similarity candidates reviewed before approval.';
comment on column public."Wig_AI_Filters"."Visual_Embedding"
  is 'Normalized local image embedding used for future duplicate checks.';

alter table if exists public."Wigs"
  add column if not exists "Low_Stock_Threshold" integer not null default 2,
  add column if not exists "Catalog_Image_Path" text null;

alter table if exists public."Wigs"
  drop constraint if exists wigs_low_stock_threshold_non_negative;
alter table if exists public."Wigs"
  add constraint wigs_low_stock_threshold_non_negative
  check ("Low_Stock_Threshold" >= 0);

comment on column public."Wigs"."Catalog_Image_Path"
  is 'Approved transparent wig PNG path in the public wig_ai_filters bucket.';

alter table if exists public."Wig_Specifications"
  add column if not exists "Visual_Embedding" jsonb null,
  add column if not exists "AI_Suggestions" jsonb not null default '{}'::jsonb,
  add column if not exists "AI_Model_Version" varchar(120) null;

-- ---------------------------------------------------------------------------
-- Short catalog code reservation
-- ---------------------------------------------------------------------------
create sequence if not exists public.wig_catalog_number_seq
  as integer
  increment by 1
  minvalue 1
  no maxvalue
  start with 1
  cache 1;

do $$
declare
  v_max integer;
begin
  select max(right("Wig_Code", 4)::integer)
  into v_max
  from public."Wigs"
  where coalesce("Wig_Code", '') ~ '^W[CS][SML][0-9]{4}$';

  if v_max is null then
    perform setval('public.wig_catalog_number_seq', 1, false);
  else
    perform setval('public.wig_catalog_number_seq', greatest(v_max, 1), true);
  end if;
end
$$;

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
  v_cap_code text;
  v_number integer;
  v_code text;
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

  v_cap_code := case
    when lower(trim(coalesce(p_cap_size, ''))) = 'small' then 'S'
    when lower(trim(coalesce(p_cap_size, ''))) = 'medium' then 'M'
    when lower(trim(coalesce(p_cap_size, ''))) = 'large' then 'L'
    else null
  end;

  if v_texture_code is null or v_cap_code is null then
    raise exception 'Hair texture and cap size are required before a wig code can be generated';
  end if;

  for v_attempt in 1..10000 loop
    v_number := nextval('public.wig_catalog_number_seq');
    if v_number > 9999 then
      raise exception 'The four-digit wig catalog sequence is exhausted';
    end if;

    v_code := 'W' || v_texture_code || v_cap_code || lpad(v_number::text, 4, '0');
    if not exists (
      select 1 from public."Wigs" w where upper(coalesce(w."Wig_Code", '')) = v_code
    ) then
      return v_code;
    end if;
  end loop;

  raise exception 'Could not reserve a unique wig catalog code';
end;
$fn$;

grant execute on function public.reserve_wig_catalog_code(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Stock history
-- ---------------------------------------------------------------------------
create table if not exists public."Wig_Stock_History" (
  "Stock_History_ID" bigserial primary key,
  "Wig_ID" integer not null
    references public."Wigs" ("Wig_ID") on delete cascade,
  "Previous_Stock" integer not null,
  "New_Stock" integer not null,
  "Quantity_Change" integer not null,
  "Reason" text null,
  "Changed_By_User_ID" integer null
    references public.users (user_id) on delete set null,
  "Created_At" timestamp without time zone not null default now()
);

create index if not exists idx_wig_stock_history_wig_created
  on public."Wig_Stock_History" ("Wig_ID", "Created_At" desc);

alter table public."Wig_Stock_History" enable row level security;

drop policy if exists wig_stock_history_specialist_admin_select
  on public."Wig_Stock_History";
create policy wig_stock_history_specialist_admin_select
  on public."Wig_Stock_History"
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and public.normalize_app_role(u.role) in ('specialist', 'admin')
    )
  );

create or replace function public.record_wig_stock_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_previous integer;
  v_actor integer;
  v_reason text;
begin
  v_previous := case when tg_op = 'INSERT' then 0 else coalesce(old."Stock_Count", 0) end;

  if coalesce(new."Stock_Count", 0) = v_previous then
    return new;
  end if;

  select u.user_id
  into v_actor
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  v_reason := nullif(current_setting('wig.stock_reason', true), '');
  if v_reason is null then
    v_reason := case
      when tg_op = 'INSERT' then 'Initial inventory'
      else 'Inventory adjustment'
    end;
  end if;

  insert into public."Wig_Stock_History" (
    "Wig_ID",
    "Previous_Stock",
    "New_Stock",
    "Quantity_Change",
    "Reason",
    "Changed_By_User_ID"
  )
  values (
    new."Wig_ID",
    v_previous,
    coalesce(new."Stock_Count", 0),
    coalesce(new."Stock_Count", 0) - v_previous,
    v_reason,
    v_actor
  );

  return new;
end;
$fn$;

drop trigger if exists trg_record_wig_stock_history on public."Wigs";
create trigger trg_record_wig_stock_history
after insert or update of "Stock_Count"
on public."Wigs"
for each row
execute function public.record_wig_stock_history();

create or replace function public.adjust_wig_catalog_stock(
  p_wig_id integer,
  p_quantity_change integer,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_current integer;
  v_next integer;
begin
  if not exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('specialist', 'admin')
  ) then
    raise exception 'Not authorized to adjust wig stock';
  end if;

  if p_quantity_change is null or p_quantity_change = 0 then
    raise exception 'Quantity change must be a non-zero whole number';
  end if;

  select coalesce(w."Stock_Count", 0)
  into v_current
  from public."Wigs" w
  where w."Wig_ID" = p_wig_id
  for update;

  if not found then
    raise exception 'Wig % was not found', p_wig_id;
  end if;

  v_next := v_current + p_quantity_change;
  if v_next < 0 then
    raise exception 'Stock cannot be negative (current %, requested change %)',
      v_current, p_quantity_change;
  end if;

  perform set_config(
    'wig.stock_reason',
    coalesce(nullif(trim(p_reason), ''), 'Inventory adjustment'),
    true
  );

  update public."Wigs"
  set
    "Stock_Count" = v_next,
    "Wig_Status" = case when v_next > 0 then 'available' else 'not available' end
  where "Wig_ID" = p_wig_id;

  return v_next;
end;
$fn$;

grant execute on function public.adjust_wig_catalog_stock(integer, integer, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic final confirmation
-- ---------------------------------------------------------------------------
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
  v_wig_id integer;
  v_code text;
  v_expected_prefix text;
  v_cap public.wig_cap_size;
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

  v_code := upper(trim(coalesce(p_wig_code, '')));
  if v_code !~ '^W[CS][SML][0-9]{4}$' then
    raise exception 'Wig code must use W + C/S + S/M/L + four digits';
  end if;

  v_expected_prefix := 'W'
    || case
         when lower(trim(p_hair_texture)) = 'straight' then 'S'
         when lower(trim(p_hair_texture)) in ('wavy', 'curly', 'coily') then 'C'
         else ''
       end
    || case
         when lower(trim(p_cap_size)) = 'small' then 'S'
         when lower(trim(p_cap_size)) = 'medium' then 'M'
         when lower(trim(p_cap_size)) = 'large' then 'L'
         else ''
       end;
  if length(v_expected_prefix) <> 3 or left(v_code, 3) <> v_expected_prefix then
    raise exception 'Wig code % does not match texture % and cap size %',
      v_code, p_hair_texture, p_cap_size;
  end if;

  if exists (
    select 1 from public."Wigs" w where upper(coalesce(w."Wig_Code", '')) = v_code
  ) then
    raise exception 'Wig code % is already in use', v_code;
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

  v_cap := case lower(trim(p_cap_size))
    when 'small' then 'Small'::public.wig_cap_size
    when 'medium' then 'Medium'::public.wig_cap_size
    when 'large' then 'Large'::public.wig_cap_size
    else null
  end;
  if v_cap is null then
    raise exception 'Cap size must be Small, Medium, or Large';
  end if;

  perform set_config('wig.stock_reason', 'Initial catalog stock', true);

  insert into public."Wigs" as inserted_wig (
    "Wig_Name",
    "Wig_Code",
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
    v_code,
    coalesce(p_stock_count, 1),
    coalesce(p_low_stock_threshold, 2),
    case when coalesce(p_stock_count, 1) > 0 then 'available' else 'not available' end,
    v_filter."Layer_Full_Wig_Path",
    v_actor,
    v_actor,
    now()
  )
  returning inserted_wig."Wig_ID" into v_wig_id;

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
    v_wig_id,
    p_hair_length,
    trim(p_hair_color),
    trim(p_hair_texture),
    trim(p_hair_density),
    v_cap,
    trim(p_style),
    v_filter."Visual_Embedding",
    coalesce(v_filter."AI_Suggestions", '{}'::jsonb),
    v_filter."AI_Model_Version"
  );

  update public."Wig_AI_Filters"
  set
    "Wig_ID" = v_wig_id,
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

  return query select v_wig_id, v_code;
end;
$fn$;

grant execute on function public.finalize_wig_catalog_item(
  integer, text, text, numeric, text, text, text, text, text,
  integer, integer, jsonb, boolean
) to authenticated;

commit;
