-- 116_fix_cap_size_storage_and_constraint.sql
-- Purpose:
-- 1) Prevent cap-size input overflow when labels include ranges (e.g. "Small (21-21.5 inches)").
-- 2) Normalize stored values to canonical enum-like values: Small / Medium / Large.
-- 3) Re-apply strict cap-size checks after normalization.

begin;

-- Allow longer incoming labels before normalization.
alter table if exists public."Wig_Specifications"
  alter column "Cap_Size" type character varying(40);

alter table if exists public."Wig_AI_Filters"
  alter column "Pending_Cap_Size" type character varying(40);

-- Normalize existing cap-size values.
update public."Wig_Specifications"
set "Cap_Size" = case
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('s', 'xs') then 'Small'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) = 'm' then 'Medium'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('l', 'xl') then 'Large'
  else null
end;

update public."Wig_AI_Filters"
set "Pending_Cap_Size" = case
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('s', 'xs') then 'Small'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) = 'm' then 'Medium'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('l', 'xl') then 'Large'
  else null
end;

-- Rebuild Wig_Specifications cap-size check.
alter table if exists public."Wig_Specifications"
  drop constraint if exists wig_specifications_cap_size_enum_check;

alter table if exists public."Wig_Specifications"
  add constraint wig_specifications_cap_size_enum_check
  check (
    "Cap_Size" is null
    or lower(regexp_replace("Cap_Size", '[^a-z0-9]+', '', 'g')) = any (
      array['small'::text, 'medium'::text, 'large'::text]
    )
  );

-- Rebuild Wig_AI_Filters pending-cap-size check.
alter table if exists public."Wig_AI_Filters"
  drop constraint if exists wig_ai_filters_pending_cap_size_enum_check;

alter table if exists public."Wig_AI_Filters"
  add constraint wig_ai_filters_pending_cap_size_enum_check
  check (
    "Pending_Cap_Size" is null
    or lower(regexp_replace("Pending_Cap_Size", '[^a-z0-9]+', '', 'g')) = any (
      array['small'::text, 'medium'::text, 'large'::text]
    )
  );

commit;
