-- Allow an active H-Representative to manage Patients only inside the hospital
-- they are assigned to (legacy/current assignment model) or created/own
-- (the direct hospital-manager model introduced by migration 141).

begin;

create or replace function public.normalize_app_role(role_value text)
returns text
language sql
immutable
as $$
  select lower(replace(replace(replace(coalesce(role_value, ''), '_', ''), ' ', ''), '-', ''));
$$;

alter table public."Hospitals" enable row level security;
alter table public."Patients" enable row level security;

grant select on public."Hospitals" to authenticated;
grant select, insert, update, delete on public."Patients" to authenticated;

do $$
begin
  if to_regclass('public."Patients_Patient_ID_seq"') is not null then
    grant usage, select on sequence public."Patients_Patient_ID_seq" to authenticated;
  end if;
end
$$;

drop policy if exists hospitals_select_h_representative_scope on public."Hospitals";
create policy hospitals_select_h_representative_scope
on public."Hospitals"
for select
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is true
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and (
        "Hospitals"."Created_By" = actor.user_id
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = "Hospitals"."Hospital_ID"
        )
      )
  )
);

drop policy if exists patients_insert_h_representative_scope on public."Patients";
create policy patients_insert_h_representative_scope
on public."Patients"
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users actor
    join public."Hospitals" hospital
      on hospital."Hospital_ID" = "Patients"."Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is true
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and (
        hospital."Is_Approved" is true
        or public.normalize_app_role(hospital."Approval_Status") = 'approved'
      )
      and (
        hospital."Created_By" = actor.user_id
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = hospital."Hospital_ID"
        )
      )
  )
  and exists (
    select 1
    from public.users patient_account
    where patient_account.user_id = "Patients"."User_ID"
      and patient_account.is_active is true
      and public.normalize_app_role(patient_account.role) in ('tentative', 'patient')
  )
);

-- These policies keep the create-flow rollback and future record maintenance
-- restricted to exactly the same hospital scope as insertion.
drop policy if exists patients_update_h_representative_scope on public."Patients";
create policy patients_update_h_representative_scope
on public."Patients"
for update
to authenticated
using (
  exists (
    select 1
    from public.users actor
    join public."Hospitals" hospital
      on hospital."Hospital_ID" = "Patients"."Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is true
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and (
        hospital."Created_By" = actor.user_id
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = hospital."Hospital_ID"
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.users actor
    join public."Hospitals" hospital
      on hospital."Hospital_ID" = "Patients"."Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is true
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and (
        hospital."Created_By" = actor.user_id
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = hospital."Hospital_ID"
        )
      )
  )
);

drop policy if exists patients_delete_h_representative_scope on public."Patients";
create policy patients_delete_h_representative_scope
on public."Patients"
for delete
to authenticated
using (
  exists (
    select 1
    from public.users actor
    join public."Hospitals" hospital
      on hospital."Hospital_ID" = "Patients"."Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is true
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and (
        hospital."Created_By" = actor.user_id
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = hospital."Hospital_ID"
        )
      )
  )
);

commit;
