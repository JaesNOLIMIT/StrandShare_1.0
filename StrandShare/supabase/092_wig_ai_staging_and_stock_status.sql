-- 092_wig_ai_staging_and_stock_status.sql
-- 1) Allow Wig_AI_Filters rows to be created before a Wig exists.
-- 2) Keep draft wig/spec data on the filter row until specialist approval.
-- 3) Move Wigs inventory semantics to stock-count based availability.

-- ---------------------------------------------------------------------------
-- Wig_AI_Filters: stage-first workflow (no Wig_ID required at creation time)
-- ---------------------------------------------------------------------------
alter table if exists public."Wig_AI_Filters"
  alter column "Wig_ID" drop not null;

alter table if exists public."Wig_AI_Filters"
  add column if not exists "Pending_Wig_Name" varchar(255) null,
  add column if not exists "Pending_Wig_Code" varchar(100) null,
  add column if not exists "Pending_Hair_Length" numeric(5,2) null,
  add column if not exists "Pending_Hair_Color" varchar(100) null,
  add column if not exists "Pending_Hair_Texture" varchar(100) null,
  add column if not exists "Pending_Hair_Density" varchar(100) null,
  add column if not exists "Pending_Cap_Size" varchar(20) null,
  add column if not exists "Pending_Style" varchar(120) null,
  add column if not exists "Pending_Stock_Count" integer not null default 1;

alter table if exists public."Wig_AI_Filters"
  drop constraint if exists "Wig_AI_Filters_pending_stock_count_non_negative";

alter table if exists public."Wig_AI_Filters"
  add constraint "Wig_AI_Filters_pending_stock_count_non_negative"
  check ("Pending_Stock_Count" >= 0);

alter table if exists public."Wig_AI_Filters"
  drop constraint if exists "Wig_AI_Filters_active_requires_wig";

alter table if exists public."Wig_AI_Filters"
  add constraint "Wig_AI_Filters_active_requires_wig"
  check ((not "Is_Active") or "Wig_ID" is not null);

alter table if exists public."Wig_AI_Filters"
  drop constraint if exists "Wig_AI_Filters_approved_requires_wig";

alter table if exists public."Wig_AI_Filters"
  add constraint "Wig_AI_Filters_approved_requires_wig"
  check (
    ("Status" not in ('approved'::public.wig_ai_filter_status, 'superseded'::public.wig_ai_filter_status))
    or "Wig_ID" is not null
  );

comment on column public."Wig_AI_Filters"."Pending_Wig_Name" is 'Draft wig name captured before specialist approval.';
comment on column public."Wig_AI_Filters"."Pending_Wig_Code" is 'Draft wig code captured before specialist approval.';
comment on column public."Wig_AI_Filters"."Pending_Hair_Length" is 'Draft hair length in inches.';
comment on column public."Wig_AI_Filters"."Pending_Hair_Color" is 'Draft hair color for approval-stage wig creation.';
comment on column public."Wig_AI_Filters"."Pending_Hair_Texture" is 'Draft hair texture for approval-stage wig creation.';
comment on column public."Wig_AI_Filters"."Pending_Hair_Density" is 'Draft hair density for approval-stage wig creation.';
comment on column public."Wig_AI_Filters"."Pending_Cap_Size" is 'Draft cap size for approval-stage wig creation.';
comment on column public."Wig_AI_Filters"."Pending_Style" is 'Draft style for approval-stage wig creation.';
comment on column public."Wig_AI_Filters"."Pending_Stock_Count" is 'Draft stock count to apply when the filter is approved and Wig row is created.';

-- ---------------------------------------------------------------------------
-- Wigs: status becomes availability-only and Stock_Count is authoritative
-- ---------------------------------------------------------------------------
alter table if exists public."Wigs"
  add column if not exists "Stock_Count" integer;

-- Backfill stock count from existing columns.
update public."Wigs"
set "Stock_Count" = case
  when "Stock_Count" is not null then "Stock_Count"
  when coalesce("In_Stock", false) then 1
  when lower(replace(replace(replace(coalesce("Wig_Status", ''), '_', ''), ' ', ''), '-', '')) in ('available', 'readyforrelease') then 1
  else 0
end;

alter table if exists public."Wigs"
  alter column "Stock_Count" set default 0;

alter table if exists public."Wigs"
  alter column "Wig_Status" set default 'not available';

alter table if exists public."Wigs"
  alter column "In_Stock" set default false;

update public."Wigs"
set "Stock_Count" = 0
where "Stock_Count" is null or "Stock_Count" < 0;

alter table if exists public."Wigs"
  alter column "Stock_Count" set not null;

-- Remove old lifecycle constraint and replace with availability-only values.
do $$
declare
  _old text;
begin
  select conname into _old
  from pg_constraint
  where conrelid = 'public."Wigs"'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%Wig_Status%';

  if _old is not null then
    execute format('alter table public."Wigs" drop constraint %I', _old);
  end if;
end
$$;

alter table if exists public."Wigs"
  add constraint "wigs_wig_status_available_only_check"
  check (
    lower(replace(replace(replace(coalesce("Wig_Status", ''), '_', ''), ' ', ''), '-', ''))
    in ('available', 'notavailable')
  ) not valid;

create or replace function public.normalize_wigs_status_and_stock_count()
returns trigger
language plpgsql
as $$
declare
  normalized_status text;
  stock_was_explicit boolean;
begin
  normalized_status := lower(replace(replace(replace(coalesce(new."Wig_Status", ''), '_', ''), ' ', ''), '-', ''));

  if tg_op = 'UPDATE' then
    stock_was_explicit := new."Stock_Count" is distinct from old."Stock_Count";
  else
    stock_was_explicit := false;
  end if;

  -- Primary rule: Stock_Count is the source of truth.
  if new."Stock_Count" is null then
    new."Stock_Count" := 0;
  end if;

  -- Backward compatibility: when legacy flows update only Wig_Status, infer
  -- stock changes from that status.
  if not stock_was_explicit then
    if normalized_status in ('available', 'readyforrelease') then
      if new."Stock_Count" <= 0 then
        new."Stock_Count" := 1;
      end if;
    elsif normalized_status in ('notavailable', 'inproduction', 'wigallocated', 'allocated', 'releasing', 'released') then
      new."Stock_Count" := 0;
    end if;
  end if;

  if new."Stock_Count" < 0 then
    new."Stock_Count" := 0;
  end if;

  new."Wig_Status" := case when new."Stock_Count" > 0 then 'available' else 'not available' end;
  new."In_Stock" := (new."Stock_Count" > 0);
  return new;
end;
$$;

drop trigger if exists trg_normalize_wigs_status_and_stock_count on public."Wigs";
create trigger trg_normalize_wigs_status_and_stock_count
before insert or update of "Wig_Status", "Stock_Count", "In_Stock"
on public."Wigs"
for each row
execute function public.normalize_wigs_status_and_stock_count();

-- Normalize current rows to the new status values.
update public."Wigs"
set
  "Wig_Status" = case when "Stock_Count" > 0 then 'available' else 'not available' end,
  "In_Stock" = ("Stock_Count" > 0);

alter table if exists public."Wigs"
  validate constraint "wigs_wig_status_available_only_check";

create index if not exists "idx_Wigs_Stock_Count"
  on public."Wigs" using btree ("Stock_Count");
