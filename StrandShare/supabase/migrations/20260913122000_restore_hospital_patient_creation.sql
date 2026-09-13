begin;

-- Restore direct patient registration for an active H-Representative assigned
-- to the selected hospital. Admin's existing insert policy remains in place.
alter table public."Patients" enable row level security;

grant select, insert on public."Patients" to authenticated;

do $do$
begin
  if to_regclass('public."Patients_Patient_ID_seq"') is not null then
    grant usage, select on sequence public."Patients_Patient_ID_seq" to authenticated;
  end if;
end;
$do$;

drop policy if exists patients_insert_assigned_h_representative
  on public."Patients";

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
    join public.users patient_account
      on patient_account.user_id = "Patients"."User_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) = 'hrepresentative'
      and assignment."Hospital_ID" = "Patients"."Hospital_ID"
      and "Patients"."Created_By" = actor.user_id
      and patient_account.is_active is distinct from false
      and public.normalize_app_role(patient_account.role) in ('patient', 'tentative')
  )
);

comment on policy patients_insert_assigned_h_representative
  on public."Patients" is
  'Allows an active assigned H-Representative to register a patient only within their hospital.';

notify pgrst, 'reload schema';
commit;
