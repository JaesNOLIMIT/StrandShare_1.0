-- Remove the Patients -> Hospitals -> Patients RLS dependency cycle.
-- H-Representative access is authorized directly through the assignment table.

begin;

drop policy if exists patients_insert_owned_hospital_representative
on public."Patients";

drop policy if exists patients_update_h_representative_scope
on public."Patients";

create policy patients_update_h_representative_scope
on public."Patients"
as permissive
for update
to authenticated
using (
  exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and assignment."Hospital_ID" = "Patients"."Hospital_ID"
  )
)
with check (
  exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and assignment."Hospital_ID" = "Patients"."Hospital_ID"
  )
);

drop policy if exists patients_delete_h_representative_scope
on public."Patients";

create policy patients_delete_h_representative_scope
on public."Patients"
as permissive
for delete
to authenticated
using (
  exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and assignment."Hospital_ID" = "Patients"."Hospital_ID"
  )
);

commit;
