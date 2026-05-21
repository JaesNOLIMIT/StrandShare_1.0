-- 133_restore_event_requests_staff_write_rls.sql
-- Purpose:
-- Restore missing Event_Requests write access under RLS so Staff can
-- submit requests to Admin from Manage Event Applications.
--
-- This migration is additive and safe:
-- - Keeps existing SELECT policies intact.
-- - Ensures authenticated role has table/sequence grants.
-- - Adds explicit INSERT (staff) and UPDATE (staff/admin) policies.

begin;

alter table public."Event_Requests" enable row level security;

grant select, insert, update, delete on public."Event_Requests" to authenticated;

do $$
begin
  if to_regclass('public."Event_Requests_Event_Request_ID_seq"') is not null then
    grant usage, select on sequence public."Event_Requests_Event_Request_ID_seq" to authenticated;
  end if;
end
$$;

drop policy if exists event_requests_select_staff_admin_fix_20260522 on public."Event_Requests";
create policy event_requests_select_staff_admin_fix_20260522
on public."Event_Requests"
for select
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and lower(
        replace(
          replace(
            replace(coalesce(u.role, ''), '_', ''),
            ' ',
            ''
          ),
          '-',
          ''
        )
      ) in ('staff', 'admin')
  )
);

drop policy if exists event_requests_insert_staff_fix_20260522 on public."Event_Requests";
create policy event_requests_insert_staff_fix_20260522
on public."Event_Requests"
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and lower(
        replace(
          replace(
            replace(coalesce(u.role, ''), '_', ''),
            ' ',
            ''
          ),
          '-',
          ''
        )
      ) = 'staff'
      and (
        "Staff_Prepared_By_User_ID" is null
        or "Staff_Prepared_By_User_ID" = u.user_id
      )
  )
);

drop policy if exists event_requests_update_staff_admin_fix_20260522 on public."Event_Requests";
create policy event_requests_update_staff_admin_fix_20260522
on public."Event_Requests"
for update
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and lower(
        replace(
          replace(
            replace(coalesce(u.role, ''), '_', ''),
            ' ',
            ''
          ),
          '-',
          ''
        )
      ) in ('staff', 'admin')
  )
)
with check (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and lower(
        replace(
          replace(
            replace(coalesce(u.role, ''), '_', ''),
            ' ',
            ''
          ),
          '-',
          ''
        )
      ) in ('staff', 'admin')
  )
);

commit;
