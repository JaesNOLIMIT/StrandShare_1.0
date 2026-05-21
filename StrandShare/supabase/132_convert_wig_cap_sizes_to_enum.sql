-- 132_convert_wig_cap_sizes_to_enum.sql
-- Convert wig cap-size columns to a shared enum type:
--   public.wig_cap_size = ('Small', 'Medium', 'Large')
-- Applies to:
--   - public."Wig_Specifications"."Cap_Size"
--   - public."Wig_AI_Filters"."Pending_Cap_Size"

begin;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'wig_cap_size'
  ) then
    create type public.wig_cap_size as enum ('Small', 'Medium', 'Large');
  end if;
end
$$;

-- Canonicalize existing values first.
update public."Wig_Specifications"
set "Cap_Size" = case
  when lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('small', 's', 'xs')
    or lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'
  when lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('medium', 'm')
    or lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'
  when lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('large', 'l', 'xl')
    or lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'
  else null
end;

update public."Wig_AI_Filters"
set "Pending_Cap_Size" = case
  when lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('small', 's', 'xs')
    or lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'
  when lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('medium', 'm')
    or lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'
  when lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('large', 'l', 'xl')
    or lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'
  else null
end;

-- Remove old regex checks; enum enforces valid values.
alter table if exists public."Wig_Specifications"
  drop constraint if exists wig_specifications_cap_size_enum_check;
alter table if exists public."Wig_Specifications"
  drop constraint if exists wig_specifications_cap_size_three_sizes_check;
alter table if exists public."Wig_AI_Filters"
  drop constraint if exists wig_ai_filters_pending_cap_size_enum_check;

-- Triggers depending on these columns block ALTER COLUMN TYPE.
drop trigger if exists trg_normalize_wig_specifications_cap_size on public."Wig_Specifications";
drop trigger if exists trg_normalize_wig_ai_filter_pending_cap_size on public."Wig_AI_Filters";

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Wig_Specifications'
      and column_name = 'Cap_Size'
      and udt_name <> 'wig_cap_size'
  ) then
    execute $sql$
      alter table public."Wig_Specifications"
      alter column "Cap_Size" type public.wig_cap_size
      using (
        case
          when lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('small', 's', 'xs')
            or lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'::public.wig_cap_size
          when lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('medium', 'm')
            or lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'::public.wig_cap_size
          when lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('large', 'l', 'xl')
            or lower(regexp_replace(coalesce("Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'::public.wig_cap_size
          else null
        end
      )
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Wig_AI_Filters'
      and column_name = 'Pending_Cap_Size'
      and udt_name <> 'wig_cap_size'
  ) then
    execute $sql$
      alter table public."Wig_AI_Filters"
      alter column "Pending_Cap_Size" type public.wig_cap_size
      using (
        case
          when lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('small', 's', 'xs')
            or lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'::public.wig_cap_size
          when lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('medium', 'm')
            or lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'::public.wig_cap_size
          when lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) in ('large', 'l', 'xl')
            or lower(regexp_replace(coalesce("Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'::public.wig_cap_size
          else null
        end
      )
    $sql$;
  end if;
end
$$;

-- Keep compatibility helpers; cast enum to text before string normalization.
create or replace function public.normalize_wig_specifications_cap_size()
returns trigger
language plpgsql
as $fn$
declare
  v_key text;
begin
  if new."Cap_Size" is null then
    return new;
  end if;

  v_key := lower(regexp_replace(coalesce(new."Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g'));

  if v_key = '' then
    new."Cap_Size" := null;
  elsif v_key in ('small', 's', 'xs') or v_key like 'small%' then
    new."Cap_Size" := 'Small';
  elsif v_key in ('medium', 'm') or v_key like 'medium%' then
    new."Cap_Size" := 'Medium';
  elsif v_key in ('large', 'l', 'xl') or v_key like 'large%' then
    new."Cap_Size" := 'Large';
  else
    new."Cap_Size" := null;
  end if;

  return new;
end;
$fn$;

create or replace function public.normalize_wig_ai_filter_pending_cap_size()
returns trigger
language plpgsql
as $fn$
declare
  v_key text;
begin
  if new."Pending_Cap_Size" is null then
    return new;
  end if;

  v_key := lower(regexp_replace(coalesce(new."Pending_Cap_Size"::text, ''), '[^a-z0-9]+', '', 'g'));

  if v_key = '' then
    new."Pending_Cap_Size" := null;
  elsif v_key in ('small', 's', 'xs') or v_key like 'small%' then
    new."Pending_Cap_Size" := 'Small';
  elsif v_key in ('medium', 'm') or v_key like 'medium%' then
    new."Pending_Cap_Size" := 'Medium';
  elsif v_key in ('large', 'l', 'xl') or v_key like 'large%' then
    new."Pending_Cap_Size" := 'Large';
  else
    new."Pending_Cap_Size" := null;
  end if;

  return new;
end;
$fn$;

create trigger trg_normalize_wig_specifications_cap_size
before insert or update of "Cap_Size"
on public."Wig_Specifications"
for each row
execute function public.normalize_wig_specifications_cap_size();

create trigger trg_normalize_wig_ai_filter_pending_cap_size
before insert or update of "Pending_Cap_Size"
on public."Wig_AI_Filters"
for each row
execute function public.normalize_wig_ai_filter_pending_cap_size();

commit;
