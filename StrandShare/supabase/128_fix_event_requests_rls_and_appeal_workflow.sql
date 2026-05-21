-- 128_fix_event_requests_rls_and_appeal_workflow.sql
-- Fix Event_Requests submit/appeal flow:
-- 1) Restore missing INSERT/UPDATE RLS for staff/admin.
-- 2) Ensure staff can set Rejected -> Appealed.
-- 3) Ensure admin can decide Appealed requests.
-- 4) Ensure status constraint accepts "Appealed".

begin;

alter table public."Event_Requests" enable row level security;

alter table public."Event_Requests"
  drop constraint if exists event_requests_status_check;

alter table public."Event_Requests"
  add constraint event_requests_status_check
  check (
    lower(
      replace(
        replace(
          replace(
            coalesce("Status", ''),
            '_',
            ''
          ),
          ' ',
          ''
        ),
        '-',
        ''
      )
    ) = any (
      array[
        'pendingadminapproval',
        'appealed',
        'approved',
        'rejected',
        'cancelled'
      ]
    )
  );

create or replace function public.enforce_event_request_workflow()
returns trigger
language plpgsql
as $$
declare
  actor_user_id integer;
  actor_role_key text;
  old_status_key text;
  new_status_key text;
  visibility_key text;
  candidate_code text;
  attempt_count integer := 0;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  old_status_key := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));
  new_status_key := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));

  visibility_key := lower(replace(replace(replace(coalesce(new."Event_Visibility", 'Public'), '_', ''), ' ', ''), '-', ''));
  new."Event_Visibility" := case when visibility_key = 'private' then 'Private' else 'Public' end;

  if old_status_key is not distinct from new_status_key then
    if new."Event_Visibility" <> 'Private' then
      new."Private_Event_Code" := null;
      new."Private_Event_Code_Sent_At" := null;
    end if;

    new."Updated_At" = manila_now;
    return new;
  end if;

  select u.user_id, public.normalize_app_role(u.role)
  into actor_user_id, actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if actor_user_id is null then
    raise exception 'Unable to resolve actor profile for event request workflow update.';
  end if;

  if actor_role_key = 'admin' then
    if old_status_key in ('pendingadminapproval', 'appealed') and new_status_key in ('approved', 'rejected') then
      new."Admin_Reviewer_User_ID" = actor_user_id;
      new."Admin_Reviewed_At" = manila_now;

      if new_status_key = 'rejected' and length(trim(coalesce(new."Admin_Decision_Reason", ''))) = 0 then
        raise exception 'Admin rejection reason is required for event requests.';
      end if;

      if new_status_key = 'approved' and new."Event_Visibility" = 'Private' then
        if nullif(trim(coalesce(new."Private_Event_Code", '')), '') is null then
          candidate_code := null;
          while attempt_count < 12 loop
            attempt_count := attempt_count + 1;
            candidate_code := public.generate_private_event_code();

            exit when not exists (
              select 1
              from public."Event_Requests" er
              where er."Private_Event_Code" = candidate_code
                and er."Event_Request_ID" <> old."Event_Request_ID"
            );
          end loop;

          if candidate_code is null
            or exists (
              select 1
              from public."Event_Requests" er
              where er."Private_Event_Code" = candidate_code
                and er."Event_Request_ID" <> old."Event_Request_ID"
            ) then
            raise exception 'Unable to generate unique private event code. Please retry.';
          end if;

          new."Private_Event_Code" := candidate_code;
        end if;
      end if;

      if new."Event_Visibility" <> 'Private' then
        new."Private_Event_Code" := null;
        new."Private_Event_Code_Sent_At" := null;
      end if;
    else
      raise exception 'Admin cannot change event request status from % to %.', old."Status", new."Status";
    end if;
  elsif actor_role_key = 'staff' then
    if old_status_key = 'pendingadminapproval' and new_status_key = 'cancelled' then
      null;
    elsif old_status_key = 'rejected' and new_status_key in ('appealed', 'pendingadminapproval') then
      new."Admin_Decision_Reason" := null;
      new."Admin_Reviewer_User_ID" := null;
      new."Admin_Reviewed_At" := null;
      if new."Event_Visibility" <> 'Private' then
        new."Private_Event_Code" := null;
        new."Private_Event_Code_Sent_At" := null;
      end if;
    else
      raise exception 'Staff cannot change event request status from % to %.', old."Status", new."Status";
    end if;
  else
    raise exception 'Only staff or admin can change event request status.';
  end if;

  new."Updated_At" = manila_now;
  return new;
end;
$$;

create or replace function public.sync_event_request_decision_to_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_status_key text;
  new_status_key text;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  old_status_key := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));
  new_status_key := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));

  if old_status_key = new_status_key then
    return new;
  end if;

  if new_status_key = 'approved' then
    update public."Event_Applications" ea
    set
      "Status" = 'Approved',
      "Updated_At" = manila_now
    where ea."Event_Application_ID" = new."Event_Application_ID";
  elsif new_status_key in ('rejected', 'appealed') then
    update public."Event_Applications" ea
    set
      "Status" = 'Appealed',
      "Updated_At" = manila_now
    where ea."Event_Application_ID" = new."Event_Application_ID";
  end if;

  return new;
end;
$$;

drop policy if exists event_requests_select_staff_admin_all on public."Event_Requests";
create policy event_requests_select_staff_admin_all
on public."Event_Requests"
for select
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_staff_or_admin_role(u.role)
  )
);

drop policy if exists event_requests_insert_staff_only on public."Event_Requests";
create policy event_requests_insert_staff_only
on public."Event_Requests"
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) = 'staff'
  )
);

drop policy if exists event_requests_update_staff_admin on public."Event_Requests";
create policy event_requests_update_staff_admin
on public."Event_Requests"
for update
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_staff_or_admin_role(u.role)
  )
)
with check (
  exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and public.is_staff_or_admin_role(u.role)
  )
);

commit;
