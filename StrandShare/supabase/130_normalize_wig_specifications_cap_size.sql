-- 130_normalize_wig_specifications_cap_size.sql
-- Normalize Wig_Specifications.Cap_Size to canonical enum values (Small|Medium|Large).

begin;

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

  v_key := lower(regexp_replace(coalesce(new."Cap_Size", ''), '[^a-z0-9]+', '', 'g'));

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

update public."Wig_Specifications"
set "Cap_Size" = case
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('small', 's', 'xs')
    or lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'small%' then 'Small'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('medium', 'm')
    or lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'medium%' then 'Medium'
  when lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) in ('large', 'l', 'xl')
    or lower(regexp_replace(coalesce("Cap_Size", ''), '[^a-z0-9]+', '', 'g')) like 'large%' then 'Large'
  when coalesce(trim("Cap_Size"), '') = '' then null
  else null
end;

drop trigger if exists trg_normalize_wig_specifications_cap_size on public."Wig_Specifications";
create trigger trg_normalize_wig_specifications_cap_size
before insert or update of "Cap_Size"
on public."Wig_Specifications"
for each row
execute function public.normalize_wig_specifications_cap_size();

commit;

