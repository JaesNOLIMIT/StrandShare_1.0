-- 091_event_attendees_rsvp_scanner.sql
-- Add RSVP scan tracking and align Event_Attendees access with Event_Request_ID.

begin;

alter table public."Event_Attendees"
  add column if not exists "Event_Request_ID" integer,
  add column if not exists "RSVP_Scanned_At" timestamp without time zone,
  add column if not exists "RSVP_Scanned_By" integer;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Event_Attendees'
      and column_name = 'Event_Application_ID'
  ) then
    update public."Event_Attendees" ea
    set "Event_Request_ID" = er."Event_Request_ID"
    from public."Event_Requests" er
    where ea."Event_Request_ID" is null
      and er."Event_Application_ID" = ea."Event_Application_ID";
  end if;
end
$$;

alter table public."Event_Attendees"
  drop constraint if exists event_attendees_event_request_fkey;

alter table public."Event_Attendees"
  add constraint event_attendees_event_request_fkey
  foreign key ("Event_Request_ID") references public."Event_Requests" ("Event_Request_ID") on delete cascade;

alter table public."Event_Attendees"
  drop constraint if exists event_attendees_rsvp_scanned_by_fkey;

alter table public."Event_Attendees"
  add constraint event_attendees_rsvp_scanned_by_fkey
  foreign key ("RSVP_Scanned_By") references public.users(user_id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from public."Event_Attendees"
    where "Event_Request_ID" is null
  ) then
    alter table public."Event_Attendees"
      alter column "Event_Request_ID" set not null;
  end if;
end
$$;

create index if not exists idx_event_attendees_event_request
  on public."Event_Attendees" using btree ("Event_Request_ID");

create index if not exists idx_event_attendees_rsvp_scanned_at
  on public."Event_Attendees" using btree ("RSVP_Scanned_At" desc);

drop policy if exists event_attendees_select_staff_admin_or_owner on public."Event_Attendees";
drop policy if exists event_attendees_insert_staff_admin on public."Event_Attendees";
drop policy if exists event_attendees_update_staff_admin on public."Event_Attendees";

do $$
declare
  has_event_application_id boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Event_Attendees'
      and column_name = 'Event_Application_ID'
  ) into has_event_application_id;

  if has_event_application_id then
    execute $sql$
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
            and (
              (public."Event_Attendees"."Event_Request_ID" is not null and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID")
              or (public."Event_Attendees"."Event_Request_ID" is null and er."Event_Application_ID" = public."Event_Attendees"."Event_Application_ID")
            )
        )
        or exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and u.user_id = public."Event_Attendees"."User_ID"
        )
      );
    $sql$;

    execute $sql$
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
            and (
              (public."Event_Attendees"."Event_Request_ID" is not null and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID")
              or (public."Event_Attendees"."Event_Request_ID" is null and er."Event_Application_ID" = public."Event_Attendees"."Event_Application_ID")
            )
        )
      );
    $sql$;

    execute $sql$
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
            and (
              (public."Event_Attendees"."Event_Request_ID" is not null and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID")
              or (public."Event_Attendees"."Event_Request_ID" is null and er."Event_Application_ID" = public."Event_Attendees"."Event_Application_ID")
            )
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
            and (
              (public."Event_Attendees"."Event_Request_ID" is not null and er."Event_Request_ID" = public."Event_Attendees"."Event_Request_ID")
              or (public."Event_Attendees"."Event_Request_ID" is null and er."Event_Application_ID" = public."Event_Attendees"."Event_Application_ID")
            )
        )
      );
    $sql$;
  else
    execute $sql$
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
    $sql$;

    execute $sql$
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
    $sql$;

    execute $sql$
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
    $sql$;
  end if;
end
$$;

commit;

