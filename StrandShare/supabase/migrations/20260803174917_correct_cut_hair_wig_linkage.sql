-- Correct Cut_Hair_Inventory linkage for the current catalog workflow.
-- A completed physical wig is represented by a completed bundle whose
-- Wig_Specification_ID points to the catalog Wigs row. Wigs.Bundle_ID is a
-- legacy field and is not populated by complete_wig_stock_from_bundle_scan.

begin;

create or replace function public.resolve_bundle_catalog_wig_id(p_bundle_id integer)
returns integer
language sql
stable
security invoker
set search_path = public
as $fn$
  select ws."Wig_ID"
  from public."Hair_Submission_Bundles" b
  join public."Wig_Specifications" ws
    on ws."Wig_Specification_ID" = b."Wig_Specification_ID"
  where b."Bundle_ID" = p_bundle_id
  limit 1
$fn$;

create or replace function public.sync_cut_hair_inventory_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bundle_status text;
  v_bundle_completed_at timestamp without time zone;
  v_wig_id integer;
  v_inventory_status text;
begin
  if not exists (
    select 1
    from public."Cut_Hair_Inventory" chi
    where chi."Submission_ID" = new."Submission_ID"
  ) then
    return new;
  end if;

  if new."Bundle_ID" is null then
    v_inventory_status := 'Cut';
  else
    select
      public.normalize_flow_key(b."Status"),
      b."Wig_Completed_At",
      ws."Wig_ID"
    into
      v_bundle_status,
      v_bundle_completed_at,
      v_wig_id
    from public."Hair_Submission_Bundles" b
    left join public."Wig_Specifications" ws
      on ws."Wig_Specification_ID" = b."Wig_Specification_ID"
    where b."Bundle_ID" = new."Bundle_ID";

    if v_bundle_status in ('wigcreated', 'wigcompleted')
       and v_bundle_completed_at is not null
       and v_wig_id is not null then
      v_inventory_status := 'Wig Created';
    else
      v_inventory_status := 'Bundling';
      v_wig_id := null;
    end if;
  end if;

  update public."Cut_Hair_Inventory"
  set
    "Event_Request_ID" = new."Event_Request_ID",
    "Event_Attendee_ID" = new."Event_Attendee_ID",
    "Bundle_ID" = new."Bundle_ID",
    "Wig_ID" = v_wig_id,
    "Status" = v_inventory_status,
    "Bundled_At" = case
      when v_inventory_status in ('Bundling', 'Wig Created')
        then coalesce("Bundled_At", now())
      else null
    end,
    "Wig_Created_At" = case
      when v_inventory_status = 'Wig Created'
        then coalesce(
          "Wig_Created_At",
          v_bundle_completed_at at time zone 'Asia/Manila',
          now()
        )
      else null
    end,
    "Updated_At" = now()
  where "Submission_ID" = new."Submission_ID";

  return new;
end;
$fn$;

-- Keep every hair item in a bundle synchronized when the bundle completes,
-- is reopened, or changes its selected wig specification.
create or replace function public.sync_cut_hair_inventory_from_bundle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_wig_id integer;
  v_inventory_status text;
begin
  select ws."Wig_ID"
  into v_wig_id
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = new."Wig_Specification_ID";

  if public.normalize_flow_key(new."Status") in ('wigcreated', 'wigcompleted')
     and new."Wig_Completed_At" is not null
     and v_wig_id is not null then
    v_inventory_status := 'Wig Created';
  else
    v_inventory_status := 'Bundling';
    v_wig_id := null;
  end if;

  update public."Cut_Hair_Inventory" chi
  set
    "Bundle_ID" = new."Bundle_ID",
    "Wig_ID" = v_wig_id,
    "Status" = v_inventory_status,
    "Bundled_At" = coalesce(chi."Bundled_At", now()),
    "Wig_Created_At" = case
      when v_inventory_status = 'Wig Created'
        then coalesce(
          chi."Wig_Created_At",
          new."Wig_Completed_At" at time zone 'Asia/Manila',
          now()
        )
      else null
    end,
    "Updated_At" = now()
  where chi."Bundle_ID" = new."Bundle_ID";

  return new;
end;
$fn$;

-- If a catalog Wig_ID is attached to a specification after bundle completion,
-- immediately repair the inventory links for completed bundles using it.
create or replace function public.sync_cut_hair_inventory_from_wig_specification()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public."Cut_Hair_Inventory" chi
  set
    "Wig_ID" = new."Wig_ID",
    "Status" = case
      when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
        and b."Wig_Completed_At" is not null
        and new."Wig_ID" is not null
      then 'Wig Created'
      else 'Bundling'
    end,
    "Wig_Created_At" = case
      when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
        and b."Wig_Completed_At" is not null
        and new."Wig_ID" is not null
      then coalesce(
        chi."Wig_Created_At",
        b."Wig_Completed_At" at time zone 'Asia/Manila',
        now()
      )
      else null
    end,
    "Updated_At" = now()
  from public."Hair_Submission_Bundles" b
  where b."Wig_Specification_ID" = new."Wig_Specification_ID"
    and chi."Bundle_ID" = b."Bundle_ID";

  return new;
end;
$fn$;

drop trigger if exists trg_sync_cut_hair_inventory_from_bundle
  on public."Hair_Submission_Bundles";
create trigger trg_sync_cut_hair_inventory_from_bundle
after update of "Status", "Wig_Completed_At", "Wig_Specification_ID"
on public."Hair_Submission_Bundles"
for each row
execute function public.sync_cut_hair_inventory_from_bundle();

drop trigger if exists trg_sync_cut_hair_inventory_from_wig_specification
  on public."Wig_Specifications";
create trigger trg_sync_cut_hair_inventory_from_wig_specification
after update of "Wig_ID"
on public."Wig_Specifications"
for each row
execute function public.sync_cut_hair_inventory_from_wig_specification();

revoke all on function public.resolve_bundle_catalog_wig_id(integer) from public, anon, authenticated;
revoke all on function public.sync_cut_hair_inventory_lifecycle() from public, anon, authenticated;
revoke all on function public.sync_cut_hair_inventory_from_bundle() from public, anon, authenticated;
revoke all on function public.sync_cut_hair_inventory_from_wig_specification() from public, anon, authenticated;

-- Repair rows produced by the first inventory migration. Status is derived
-- from the actual completed bundle + specification-to-wig relationship.
update public."Cut_Hair_Inventory" chi
set
  "Bundle_ID" = hs."Bundle_ID",
  "Wig_ID" = case
    when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
      and b."Wig_Completed_At" is not null
      and ws."Wig_ID" is not null
    then ws."Wig_ID"
    else null
  end,
  "Status" = case
    when hs."Bundle_ID" is null then 'Cut'
    when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
      and b."Wig_Completed_At" is not null
      and ws."Wig_ID" is not null
    then 'Wig Created'
    else 'Bundling'
  end,
  "Bundled_At" = case
    when hs."Bundle_ID" is not null then coalesce(chi."Bundled_At", now())
    else null
  end,
  "Wig_Created_At" = case
    when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
      and b."Wig_Completed_At" is not null
      and ws."Wig_ID" is not null
    then coalesce(
      chi."Wig_Created_At",
      b."Wig_Completed_At" at time zone 'Asia/Manila',
      now()
    )
    else null
  end,
  "Updated_At" = now()
from public."Hair_Submissions" hs
left join public."Hair_Submission_Bundles" b
  on b."Bundle_ID" = hs."Bundle_ID"
left join public."Wig_Specifications" ws
  on ws."Wig_Specification_ID" = b."Wig_Specification_ID"
where hs."Submission_ID" = chi."Submission_ID";

-- Migration-time integrity test: no inventory row may claim Wig Created unless
-- its completed bundle resolves to that exact catalog wig.
do $verify$
begin
  if exists (
    select 1
    from public."Cut_Hair_Inventory" chi
    left join public."Hair_Submission_Bundles" b
      on b."Bundle_ID" = chi."Bundle_ID"
    left join public."Wig_Specifications" ws
      on ws."Wig_Specification_ID" = b."Wig_Specification_ID"
    where chi."Status" = 'Wig Created'
      and (
        chi."Bundle_ID" is null
        or chi."Wig_ID" is null
        or b."Wig_Completed_At" is null
        or public.normalize_flow_key(b."Status") not in ('wigcreated', 'wigcompleted')
        or ws."Wig_ID" is distinct from chi."Wig_ID"
      )
  ) then
    raise exception 'Cut hair inventory wig linkage verification failed.';
  end if;
end;
$verify$;

commit;
