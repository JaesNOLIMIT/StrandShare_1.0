-- 118_fix_event_applications_insert_rls_for_public_submit.sql
-- Re-align Event_Applications insert RLS so public event applications can be submitted.

begin;

alter table public."Event_Applications" enable row level security;

drop policy if exists event_applications_insert_anon on public."Event_Applications";
drop policy if exists event_applications_insert_authenticated_requestor on public."Event_Applications";

create policy event_applications_insert_anon
on public."Event_Applications"
for insert
to anon
with check (
  lower(replace(replace(replace(coalesce("Status", ''), '_', ''), ' ', ''), '-', '')) = 'pendingstaffreview'
  and "Staff_Reviewer_User_ID" is null
  and "Staff_Rejected_By_User_ID" is null
  and "Linked_Event_Request_ID" is null
);

create policy event_applications_insert_authenticated_requestor
on public."Event_Applications"
for insert
to authenticated
with check (
  lower(replace(replace(replace(coalesce("Status", ''), '_', ''), ' ', ''), '-', '')) = 'pendingstaffreview'
  and "Staff_Reviewer_User_ID" is null
  and "Staff_Rejected_By_User_ID" is null
  and "Linked_Event_Request_ID" is null
  and not exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_staff_or_admin_role(u.role)
  )
);

commit;
