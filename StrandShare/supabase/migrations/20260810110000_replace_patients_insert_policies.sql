-- Replace every Patients policy created specifically for INSERT evaluation.
-- Existing SELECT/UPDATE/DELETE/ALL policies remain untouched.

begin;

create or replace function public.normalize_app_role(role_value text)
returns text
language sql
immutable
as $$
  select lower(replace(replace(replace(coalesce(role_value, ''), '_', ''), ' ', ''), '-', ''));
$$;

alter table public."Patients" enable row level security;
grant insert, select on public."Patients" to authenticated;

do $$
begin
  if to_regclass('public."Patients_Patient_ID_seq"') is not null then
    grant usage, select on sequence public."Patients_Patient_ID_seq" to authenticated;
  end if;
end
$$;

-- INSERT policies are rebuilt as a complete set below. Policies for every
-- other command are intentionally left untouched.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'Patients'
      and cmd = 'INSERT'
  loop
    execute format(
      'drop policy if exists %I on public."Patients"',
      existing_policy.policyname
    );
  end loop;
end
$$;

create policy patients_insert_assigned_h_representative
on public."Patients"
as permissive
for insert
to authenticated
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

create policy patients_insert_owned_hospital_representative
on public."Patients"
as permissive
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users actor
    join public."Hospitals" hospital
      on hospital."Created_By" = actor.user_id
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
      and hospital."Hospital_ID" = "Patients"."Hospital_ID"
      and (
        hospital."Is_Approved" is true
        or public.normalize_app_role(hospital."Approval_Status") = 'approved'
      )
  )
);

create policy patients_insert_admin
on public."Patients"
as permissive
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in ('admin', 'superadmin')
  )
);

do $$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'Patients'
      and cmd = 'INSERT'
      and policyname in (
        'patients_insert_assigned_h_representative',
        'patients_insert_owned_hospital_representative',
        'patients_insert_admin'
      )
  ) <> 3 then
    raise exception 'Patients INSERT policy replacement did not complete.';
  end if;
end
$$;

commit;
