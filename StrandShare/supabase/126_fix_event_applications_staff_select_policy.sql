-- 126_fix_event_applications_staff_select_policy.sql
-- Restore staff/admin visibility for Event_Applications so Manage Event Application can load all intake rows.

begin;

alter table public."Event_Applications" enable row level security;

-- Keep any existing approved-only policy as-is for other authenticated users,
-- but add a staff/admin policy that can see all rows.
drop policy if exists event_applications_select_staff_admin on public."Event_Applications";

create policy event_applications_select_staff_admin
on public."Event_Applications"
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

commit;
