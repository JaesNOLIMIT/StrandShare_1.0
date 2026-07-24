-- 154_fix_wig_cap_size_normalization.sql
-- Preserve canonical enum values in the BEFORE triggers.
-- The earlier implementation removed uppercase first letters before lowercasing
-- (for example, Medium became "edium" and was stored as null).

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

  v_key := regexp_replace(
    lower(coalesce(new."Cap_Size"::text, '')),
    '[^a-z0-9]+',
    '',
    'g'
  );

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

  v_key := regexp_replace(
    lower(coalesce(new."Pending_Cap_Size"::text, '')),
    '[^a-z0-9]+',
    '',
    'g'
  );

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

commit;
