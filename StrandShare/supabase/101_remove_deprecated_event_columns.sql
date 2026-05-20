-- 101_remove_deprecated_event_columns.sql
-- Remove deprecated legacy columns after event-request migration.
--
-- Removed:
--   1) Hair_Submissions.Donation_Drive_ID
--   2) Event_Attendees.Event_Application_ID

begin;

-- ---------------------------------------------------------------------------
-- Hair_Submissions: remove legacy Donation_Drive_ID
-- ---------------------------------------------------------------------------
alter table public."Hair_Submissions"
  drop constraint if exists hair_submissions_donation_drive_id_fkey;

drop index if exists public."idx_Hair_Submissions_Donation_Drive_ID";
drop index if exists public.idx_hair_submissions_donation_drive_id;

alter table public."Hair_Submissions"
  drop column if exists "Donation_Drive_ID";

-- ---------------------------------------------------------------------------
-- Event_Attendees: remove legacy Event_Application_ID
-- ---------------------------------------------------------------------------
drop policy if exists event_attendees_select_staff_admin_or_owner on public."Event_Attendees";
drop policy if exists event_attendees_insert_staff_admin on public."Event_Attendees";
drop policy if exists event_attendees_update_staff_admin on public."Event_Attendees";

alter table public."Event_Attendees"
  drop constraint if exists event_attendees_event_application_fkey;

drop index if exists public.idx_event_attendees_event_application;

alter table public."Event_Attendees"
  drop column if exists "Event_Application_ID";

-- Recreate attendee policies with Event_Request_ID only.
create policy event_attendees_select_staff_admin_or_owner
on public."Event_Attendees"
for select
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_admin_role(u.role)
  )
  or exists (
    select 1
    from public.users u
    join public."Event_Requests" er
      on er."Assigned_Staff_User_ID" = u.user_id
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) = 'staff'
      and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID"
  )
  or exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.user_id = public."Event_Attendees"."User_ID"
  )
);

create policy event_attendees_insert_staff_admin
on public."Event_Attendees"
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_admin_role(u.role)
  )
  or exists (
    select 1
    from public.users u
    join public."Event_Requests" er
      on er."Assigned_Staff_User_ID" = u.user_id
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) = 'staff'
      and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID"
  )
);

create policy event_attendees_update_staff_admin
on public."Event_Attendees"
for update
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_admin_role(u.role)
  )
  or exists (
    select 1
    from public.users u
    join public."Event_Requests" er
      on er."Assigned_Staff_User_ID" = u.user_id
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) = 'staff'
      and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID"
  )
)
with check (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_admin_role(u.role)
  )
  or exists (
    select 1
    from public.users u
    join public."Event_Requests" er
      on er."Assigned_Staff_User_ID" = u.user_id
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) = 'staff'
      and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID"
  )
);

commit;
