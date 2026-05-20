-- 093_drop_in_stock_bool_and_pending_stock.sql
--
-- Consolidates stock management:
--   * Wigs.In_Stock (bool) is removed; Wigs.Stock_Count (int) becomes the
--     single source of truth ("in stock" = Stock_Count > 0).
--   * Wig_AI_Filters.Pending_Stock_Count is removed; stock is a Wigs concern
--     only and should not be drafted on the filter.

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop the existing normalize trigger so we can drop the In_Stock column
--    it references. The trigger function gets rewritten below to work off
--    Stock_Count alone.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_normalize_wigs_status_and_stock_count on public."Wigs";

create or replace function public.normalize_wigs_status_and_stock_count()
returns trigger
language plpgsql
as $fn$
declare
  status_key text;
begin
  -- Stock_Count guard: never negative, never null.
  if new."Stock_Count" is null or new."Stock_Count" < 0 then
    new."Stock_Count" := 0;
  end if;

  -- Wig_Status: if missing or not one of the allowed values, derive it from
  -- the stock count. Stock_Count > 0 -> 'available', else 'not available'.
  status_key := lower(replace(replace(replace(
    coalesce(new."Wig_Status"::text, ''), '_', ''), ' ', ''), '-', ''));
  if status_key not in ('available', 'notavailable') then
    new."Wig_Status" := case when new."Stock_Count" > 0
                              then 'available'::varchar
                              else 'not available'::varchar end;
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Drop the bool In_Stock column (and its index implicitly).
-- ---------------------------------------------------------------------------
alter table public."Wigs" drop column if exists "In_Stock";

-- Recreate the trigger without the In_Stock column reference.
create trigger trg_normalize_wigs_status_and_stock_count
  before insert or update of "Wig_Status", "Stock_Count"
  on public."Wigs"
  for each row execute function public.normalize_wigs_status_and_stock_count();

-- ---------------------------------------------------------------------------
-- 3. Drop Pending_Stock_Count from Wig_AI_Filters along with its check.
-- ---------------------------------------------------------------------------
alter table public."Wig_AI_Filters"
  drop constraint if exists "Wig_AI_Filters_pending_stock_count_non_negative";
alter table public."Wig_AI_Filters"
  drop column if exists "Pending_Stock_Count";

commit;
