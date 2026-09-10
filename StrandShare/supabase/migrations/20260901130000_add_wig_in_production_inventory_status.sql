-- Track closed production bundles separately from hairs still assigned to a
-- draft bundle. This preserves the complete inventory lifecycle:
-- Cut -> Bundling -> Wig In Production -> Wig Created.

begin;

alter table public."Cut_Hair_Inventory"
  drop constraint if exists cut_hair_inventory_status_check;

alter table public."Cut_Hair_Inventory"
  add constraint cut_hair_inventory_status_check
  check ("Status" in ('Cut', 'Bundling', 'Wig In Production', 'Wig Created'));

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
    elsif public.normalize_flow_key(new."Status") = 'wiginproduction'
          or v_bundle_status = 'inproduction' then
      v_inventory_status := 'Wig In Production';
      v_wig_id := null;
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
      when v_inventory_status in ('Bundling', 'Wig In Production', 'Wig Created')
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
  elsif public.normalize_flow_key(new."Status") = 'inproduction' then
    v_inventory_status := 'Wig In Production';
    v_wig_id := null;
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

create or replace function public.sync_cut_hair_inventory_from_wig_specification()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public."Cut_Hair_Inventory" chi
  set
    "Wig_ID" = case
      when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
        and b."Wig_Completed_At" is not null
        and new."Wig_ID" is not null
      then new."Wig_ID"
      else null
    end,
    "Status" = case
      when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
        and b."Wig_Completed_At" is not null
        and new."Wig_ID" is not null
      then 'Wig Created'
      when public.normalize_flow_key(b."Status") = 'inproduction'
      then 'Wig In Production'
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

-- Repair existing inventory rows using the current submission and bundle state.
update public."Cut_Hair_Inventory" chi
set
  "Status" = case
    when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
      and b."Wig_Completed_At" is not null
      and ws."Wig_ID" is not null
    then 'Wig Created'
    when public.normalize_flow_key(hs."Status") = 'wiginproduction'
      or public.normalize_flow_key(b."Status") = 'inproduction'
    then 'Wig In Production'
    when hs."Bundle_ID" is not null then 'Bundling'
    else 'Cut'
  end,
  "Wig_ID" = case
    when public.normalize_flow_key(b."Status") in ('wigcreated', 'wigcompleted')
      and b."Wig_Completed_At" is not null
      and ws."Wig_ID" is not null
    then ws."Wig_ID"
    else null
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

revoke all on function public.sync_cut_hair_inventory_lifecycle() from public, anon, authenticated;
revoke all on function public.sync_cut_hair_inventory_from_bundle() from public, anon, authenticated;
revoke all on function public.sync_cut_hair_inventory_from_wig_specification() from public, anon, authenticated;

commit;
