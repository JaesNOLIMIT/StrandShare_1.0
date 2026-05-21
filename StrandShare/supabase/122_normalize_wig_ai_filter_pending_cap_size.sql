-- 122_normalize_wig_ai_filter_pending_cap_size.sql
-- Normalize Pending_Cap_Size to Small|Medium|Large before constraint checks.

begin;

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

  v_key := lower(regexp_replace(coalesce(new."Pending_Cap_Size", ''), '[^a-z0-9]+', '', 'g'));

  if v_key = '' then
    new."Pending_Cap_Size" := null;
  elsif v_key in ('small', 's', 'xs') or v_key like 'small%' then
    new."Pending_Cap_Size" := 'Small';
  elsif v_key in ('medium', 'm') or v_key like 'medium%' then
    new."Pending_Cap_Size" := 'Medium';
  elsif v_key in ('large', 'l', 'xl') or v_key like 'large%' then
    new."Pending_Cap_Size" := 'Large';
  else
    -- Unknown values become null so enum check will pass safely.
    new."Pending_Cap_Size" := null;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_normalize_wig_ai_filter_pending_cap_size on public."Wig_AI_Filters";
create trigger trg_normalize_wig_ai_filter_pending_cap_size
before insert or update of "Pending_Cap_Size"
on public."Wig_AI_Filters"
for each row
execute function public.normalize_wig_ai_filter_pending_cap_size();

commit;
