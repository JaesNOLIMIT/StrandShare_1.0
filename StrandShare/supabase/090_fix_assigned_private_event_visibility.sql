-- 090_fix_assigned_private_event_visibility.sql
-- Fix: assigned staff must always see their own Event_Requests, including Private events.
--
-- Why this exists:
-- Some environments only have visibility-oriented SELECT policies
-- (e.g. public/unlocked-private), which can hide private events from the
-- assigned staff operations page.
--
-- This policy is additive and safe: it only grants row access when the
-- logged-in user maps to users.user_id == Event_Requests.Assigned_Staff_User_ID.

begin;

alter table public."Event_Requests" enable row level security;

drop policy if exists event_requests_select_assigned_staff_fix on public."Event_Requests";

create policy event_requests_select_assigned_staff_fix
on public."Event_Requests"
for select
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.user_id = "Assigned_Staff_User_ID"
  )
);

commit;

