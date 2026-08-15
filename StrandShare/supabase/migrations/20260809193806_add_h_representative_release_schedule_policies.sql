-- Allow H-Representatives to read and decide release schedules only for wig
-- requests belonging to their assigned hospital.

begin;

alter table public."Release_Schedules" enable row level security;
grant select, update on public."Release_Schedules" to authenticated;

drop policy if exists release_schedules_select_assigned_h_representative
on public."Release_Schedules";

create policy release_schedules_select_assigned_h_representative
on public."Release_Schedules"
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public."Wig_Requests" request
    join public."Hospital_Representative" assignment
      on assignment."Hospital_ID" = request."Hospital_ID"
    join public.users actor
      on actor.user_id = assignment."User_ID"
    where request."Req_ID" = "Release_Schedules"."Req_ID"
      and actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
  )
);

drop policy if exists release_schedules_update_assigned_h_representative
on public."Release_Schedules";

create policy release_schedules_update_assigned_h_representative
on public."Release_Schedules"
as permissive
for update
to authenticated
using (
  exists (
    select 1
    from public."Wig_Requests" request
    join public."Hospital_Representative" assignment
      on assignment."Hospital_ID" = request."Hospital_ID"
    join public.users actor
      on actor.user_id = assignment."User_ID"
    where request."Req_ID" = "Release_Schedules"."Req_ID"
      and actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
  )
)
with check (
  exists (
    select 1
    from public."Wig_Requests" request
    join public."Hospital_Representative" assignment
      on assignment."Hospital_ID" = request."Hospital_ID"
    join public.users actor
      on actor.user_id = assignment."User_ID"
    where request."Req_ID" = "Release_Schedules"."Req_ID"
      and actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital',
        'hstaff',
        'hrepresentative',
        'hospitalrepresentative'
      )
  )
);

commit;
