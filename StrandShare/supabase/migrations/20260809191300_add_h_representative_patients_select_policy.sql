-- Allow an authenticated H-Representative to read only patients belonging to
-- the hospital assignment attached to their own auth account. This policy is
-- also required for INSERT ... RETURNING (Supabase .insert().select()).

begin;

alter table public."Patients" enable row level security;
grant select on public."Patients" to authenticated;

drop policy if exists patients_select_assigned_h_representative
on public."Patients";

create policy patients_select_assigned_h_representative
on public."Patients"
as permissive
for select
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
