begin;

-- Staff inventory screens need this read-only relationship to resolve a
-- completed bundle to its catalog wig. Existing specialist write policies
-- remain unchanged.
grant select on public."Wig_Specifications" to authenticated;

drop policy if exists wig_specifications_internal_inventory_select
  on public."Wig_Specifications";
create policy wig_specifications_internal_inventory_select
on public."Wig_Specifications"
for select to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role)
        in ('staff', 'admin', 'superadmin', 'specialist')
  )
);

-- A completed bundle points to a wig specification, and that specification
-- points to the catalog wig that was produced. Re-attach the synchronization
-- triggers in case an older deployment created the functions but missed a
-- trigger, then repair historical inventory rows from that relationship.
drop trigger if exists trg_sync_cut_hair_inventory_lifecycle
  on public."Hair_Submissions";
create trigger trg_sync_cut_hair_inventory_lifecycle
after update of "Status", "Bundle_ID", "Event_Request_ID", "Event_Attendee_ID"
on public."Hair_Submissions"
for each row execute function public.sync_cut_hair_inventory_lifecycle();

drop trigger if exists trg_sync_cut_hair_inventory_from_bundle
  on public."Hair_Submission_Bundles";
create trigger trg_sync_cut_hair_inventory_from_bundle
after update of "Status", "Wig_Completed_At", "Wig_Specification_ID"
on public."Hair_Submission_Bundles"
for each row execute function public.sync_cut_hair_inventory_from_bundle();

drop trigger if exists trg_sync_cut_hair_inventory_from_wig_specification
  on public."Wig_Specifications";
create trigger trg_sync_cut_hair_inventory_from_wig_specification
after update of "Wig_ID"
on public."Wig_Specifications"
for each row execute function public.sync_cut_hair_inventory_from_wig_specification();

update public."Cut_Hair_Inventory" inventory
set
  "Bundle_ID" = submission."Bundle_ID",
  "Status" = case
    when public.normalize_flow_key(bundle."Status") in ('wigcreated', 'wigcompleted')
      and bundle."Wig_Completed_At" is not null
      and specification."Wig_ID" is not null
    then 'Wig Created'
    when public.normalize_flow_key(submission."Status") = 'wiginproduction'
      or public.normalize_flow_key(bundle."Status") = 'inproduction'
    then 'Wig In Production'
    when submission."Bundle_ID" is not null then 'Bundling'
    else 'Cut'
  end,
  "Wig_ID" = case
    when public.normalize_flow_key(bundle."Status") in ('wigcreated', 'wigcompleted')
      and bundle."Wig_Completed_At" is not null
    then specification."Wig_ID"
    else null
  end,
  "Bundled_At" = case
    when submission."Bundle_ID" is not null
      then coalesce(inventory."Bundled_At", now())
    else null
  end,
  "Wig_Created_At" = case
    when public.normalize_flow_key(bundle."Status") in ('wigcreated', 'wigcompleted')
      and bundle."Wig_Completed_At" is not null
      and specification."Wig_ID" is not null
    then coalesce(
      inventory."Wig_Created_At",
      bundle."Wig_Completed_At" at time zone 'Asia/Manila',
      now()
    )
    else null
  end,
  "Updated_At" = now()
from public."Hair_Submissions" submission
left join public."Hair_Submission_Bundles" bundle
  on bundle."Bundle_ID" = submission."Bundle_ID"
left join public."Wig_Specifications" specification
  on specification."Wig_Specification_ID" = bundle."Wig_Specification_ID"
where submission."Submission_ID" = inventory."Submission_ID";

notify pgrst, 'reload schema';
commit;
