-- 115_enforce_three_cap_sizes.sql
-- Normalize and enforce cap sizes to only Small / Medium / Large.

begin;

-- Normalize existing Wig_Specifications cap sizes.
update public."Wig_Specifications"
set "Cap_Size" = case
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('xs', 's', 'small') then 'Small'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('m', 'medium') then 'Medium'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('l', 'xl', 'large') then 'Large'
  else null
end;

-- Normalize staged cap sizes in Wig_AI_Filters.
update public."Wig_AI_Filters"
set "Pending_Cap_Size" = case
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('xs', 's', 'small') then 'Small'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('m', 'medium') then 'Medium'
  when lower(regexp_replace(coalesce("Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('l', 'xl', 'large') then 'Large'
  else null
end;

-- Replace Wig_Specifications cap-size checks (keep only Small/Medium/Large).
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public."Wig_Specifications"'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%Cap_Size%'
  loop
    execute format('alter table public."Wig_Specifications" drop constraint %I', constraint_row.conname);
  end loop;
end
$$;

alter table public."Wig_Specifications"
  add constraint wig_specifications_cap_size_enum_check
  check (
    "Cap_Size" is null
    or lower(regexp_replace("Cap_Size", '[^a-z0-9]+', '', 'g')) = any (
      array['small'::text, 'medium'::text, 'large'::text]
    )
  );

-- Enforce pending cap size values as well.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public."Wig_AI_Filters"'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%Pending_Cap_Size%'
  loop
    execute format('alter table public."Wig_AI_Filters" drop constraint %I', constraint_row.conname);
  end loop;
end
$$;

alter table public."Wig_AI_Filters"
  add constraint wig_ai_filters_pending_cap_size_enum_check
  check (
    "Pending_Cap_Size" is null
    or lower(regexp_replace("Pending_Cap_Size", '[^a-z0-9]+', '', 'g')) = any (
      array['small'::text, 'medium'::text, 'large'::text]
    )
  );

commit;
