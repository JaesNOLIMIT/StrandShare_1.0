-- Remove sensitive program-applicant data three months after the linked
-- program is marked Successful. Names, email addresses, and operational event
-- history remain available for certificates, communication, and reporting.

begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

alter table public."Event_Applications"
  add column if not exists "Personal_Data_Deleted_At" timestamp with time zone,
  add column if not exists "Personal_Data_Deleted_By_User_ID" integer,
  add column if not exists "Personal_Data_Deletion_Mode" text;

alter table public."Event_Applications"
  drop constraint if exists event_applications_personal_data_deletion_mode_check;
alter table public."Event_Applications"
  add constraint event_applications_personal_data_deletion_mode_check
  check (
    "Personal_Data_Deletion_Mode" is null
    or "Personal_Data_Deletion_Mode" in ('manual', 'automatic')
  );

create index if not exists idx_event_applications_personal_data_retention
  on public."Event_Applications" ("Linked_Event_Request_ID", "Personal_Data_Deleted_At");

create table if not exists public."Program_Applicant_Data_Deletion_Log" (
  "Deletion_Log_ID" bigint generated always as identity primary key,
  "Event_Application_ID" bigint not null,
  "Event_Request_ID" bigint,
  "Deletion_Mode" text not null check ("Deletion_Mode" in ('manual', 'automatic')),
  "Status" text not null check ("Status" in ('Completed', 'Failed')),
  "Deleted_Storage_Buckets" jsonb not null default '[]'::jsonb,
  "Deleted_File_Count" integer not null default 0,
  "Triggered_By_User_ID" integer,
  "Error_Message" text,
  "Created_At" timestamp with time zone not null default now()
);

alter table public."Program_Applicant_Data_Deletion_Log" enable row level security;

drop policy if exists program_applicant_deletion_log_admin_read
  on public."Program_Applicant_Data_Deletion_Log";
create policy program_applicant_deletion_log_admin_read
on public."Program_Applicant_Data_Deletion_Log"
for select
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and coalesce(actor.is_active, true)
      and public.normalize_app_role(actor.role) in ('admin', 'superadmin')
  )
);

revoke all on table public."Program_Applicant_Data_Deletion_Log" from public, anon, authenticated;
grant select on table public."Program_Applicant_Data_Deletion_Log" to authenticated;

create or replace function public.get_program_applicant_cleanup_candidates(
  p_limit integer default 100
)
returns table (
  event_application_id bigint,
  event_request_id bigint,
  applicant_valid_id_path text,
  attendee_list_path text,
  didit_session_id text,
  didit_id_front_image_path text,
  successful_at timestamp with time zone
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service-role access is required.';
  end if;

  return query
  select
    application."Event_Application_ID"::bigint,
    event."Event_Request_ID"::bigint,
    nullif(trim(application."Applicant_Valid_ID_Path"), ''),
    nullif(trim(application."Expected_Attendee_List_Path"), ''),
    nullif(trim(application."Didit_Session_ID"::text), ''),
    nullif(trim(session_row."ID_Front_Image_Path"), ''),
    event."Successful_At"
  from public."Event_Applications" application
  join public."Event_Requests" event
    on event."Event_Request_ID" = application."Linked_Event_Request_ID"
  left join public."Didit_Verification_Sessions" session_row
    on session_row."Session_ID" = application."Didit_Session_ID"
  where public.normalize_flow_key(event."Status") = 'successful'
    and event."Successful_At" is not null
    and event."Successful_At" <= now() - interval '3 months'
    and application."Personal_Data_Deleted_At" is null
  order by event."Successful_At", application."Event_Application_ID"
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$fn$;

revoke all on function public.get_program_applicant_cleanup_candidates(integer)
  from public, anon, authenticated;
grant execute on function public.get_program_applicant_cleanup_candidates(integer)
  to service_role;

-- Normal edits must retain an adult applicant birthdate. The tightly scoped
-- service-role cleanup transaction may null it only while marking the row as
-- deleted, so the existing validation trigger cannot block lawful disposal.
create or replace function public.enforce_adult_event_applicant()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new."Applicant_Birthdate" is null then
    if coalesce(current_setting('strandshare.program_applicant_data_cleanup', true), 'off') = 'on'
       and new."Personal_Data_Deleted_At" is not null then
      return new;
    end if;
    raise exception 'Applicant birthdate is required';
  end if;

  if new."Applicant_Birthdate" > (timezone('Asia/Manila', now())::date - interval '18 years')::date then
    raise exception 'The event applicant must be at least 18 years old';
  end if;

  return new;
end;
$fn$;

create or replace function public.finalize_program_applicant_data_deletion(
  p_event_application_id bigint,
  p_deletion_mode text,
  p_deleted_storage_buckets jsonb default '[]'::jsonb,
  p_deleted_file_count integer default 0,
  p_triggered_by_user_id integer default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_application public."Event_Applications"%rowtype;
  v_event_request_id bigint;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service-role access is required.';
  end if;
  if p_deletion_mode not in ('manual', 'automatic') then
    raise exception 'Deletion mode must be manual or automatic.';
  end if;

  select application.*
  into v_application
  from public."Event_Applications" application
  join public."Event_Requests" event
    on event."Event_Request_ID" = application."Linked_Event_Request_ID"
  where application."Event_Application_ID" = p_event_application_id
    and public.normalize_flow_key(event."Status") = 'successful'
    and event."Successful_At" is not null
    and event."Successful_At" <= now() - interval '3 months'
    and application."Personal_Data_Deleted_At" is null
  for update of application;

  if not found then
    return false;
  end if;

  v_event_request_id := v_application."Linked_Event_Request_ID";

  if nullif(trim(coalesce(p_error_message, '')), '') is not null then
    insert into public."Program_Applicant_Data_Deletion_Log" (
      "Event_Application_ID", "Event_Request_ID", "Deletion_Mode", "Status",
      "Deleted_Storage_Buckets", "Deleted_File_Count", "Triggered_By_User_ID", "Error_Message"
    ) values (
      p_event_application_id, v_event_request_id, p_deletion_mode, 'Failed',
      coalesce(p_deleted_storage_buckets, '[]'::jsonb), greatest(coalesce(p_deleted_file_count, 0), 0),
      p_triggered_by_user_id, left(p_error_message, 2000)
    );
    return false;
  end if;

  perform set_config('strandshare.program_applicant_data_cleanup', 'on', true);

  update public."Event_Applications"
  set
    "Applicant_Birthdate" = null,
    "Applicant_Date_Of_Birth" = null,
    "Applicant_Gender" = null,
    "Applicant_ID_Document_Number" = null,
    "Applicant_ID_Personal_Number" = null,
    "Applicant_ID_Issue_Date" = null,
    "Applicant_ID_Expiration_Date" = null,
    "Applicant_ID_Issuing_Country" = null,
    "Applicant_ID_Nationality" = null,
    "Applicant_ID_Address" = null,
    "Applicant_ID_Place_Of_Birth" = null,
    "Applicant_ID_Marital_Status" = null,
    "Applicant_ID_Extra_Fields" = null,
    "Applicant_ID_Verification_Warnings" = '[]'::jsonb,
    "Applicant_Contact_Number" = null,
    "Applicant_Valid_ID_Type" = null,
    "Applicant_Valid_ID_Path" = null,
    "Applicant_Valid_ID_URL" = null,
    "Didit_Session_ID" = null,
    "Didit_Verification_Status" = null,
    "Didit_Verified_At" = null,
    "Preferred_Contact_Detail" = null,
    "Expected_Attendee_Details" = '[]'::jsonb,
    "Expected_Attendee_List_Path" = null,
    "Expected_Attendee_List_URL" = null,
    "Personal_Data_Deleted_At" = now(),
    "Personal_Data_Deleted_By_User_ID" = p_triggered_by_user_id,
    "Personal_Data_Deletion_Mode" = p_deletion_mode,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Event_Application_ID" = p_event_application_id;

  if v_application."Didit_Session_ID" is not null then
    delete from public."Didit_Verification_Sessions"
    where "Session_ID" = v_application."Didit_Session_ID";
  end if;

  insert into public."Program_Applicant_Data_Deletion_Log" (
    "Event_Application_ID", "Event_Request_ID", "Deletion_Mode", "Status",
    "Deleted_Storage_Buckets", "Deleted_File_Count", "Triggered_By_User_ID"
  ) values (
    p_event_application_id, v_event_request_id, p_deletion_mode, 'Completed',
    coalesce(p_deleted_storage_buckets, '[]'::jsonb), greatest(coalesce(p_deleted_file_count, 0), 0),
    p_triggered_by_user_id
  );

  return true;
end;
$fn$;

revoke all on function public.finalize_program_applicant_data_deletion(bigint, text, jsonb, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.finalize_program_applicant_data_deletion(bigint, text, jsonb, integer, integer, text)
  to service_role;

create or replace function public.get_program_applicant_maintenance_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor_id integer;
  v_result jsonb;
begin
  select actor.user_id
  into v_actor_id
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and coalesce(actor.is_active, true)
    and public.normalize_app_role(actor.role) in ('admin', 'superadmin')
  limit 1;

  if v_actor_id is null and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only an active Admin can view applicant-data maintenance.';
  end if;

  select jsonb_build_object(
    'retention_months', 3,
    'eligible_count', (
      select count(*)
      from public."Event_Applications" application
      join public."Event_Requests" event
        on event."Event_Request_ID" = application."Linked_Event_Request_ID"
      where public.normalize_flow_key(event."Status") = 'successful'
        and event."Successful_At" is not null
        and event."Successful_At" <= now() - interval '3 months'
        and application."Personal_Data_Deleted_At" is null
    ),
    'next_eligible_at', (
      select min(event."Successful_At" + interval '3 months')
      from public."Event_Applications" application
      join public."Event_Requests" event
        on event."Event_Request_ID" = application."Linked_Event_Request_ID"
      where public.normalize_flow_key(event."Status") = 'successful'
        and event."Successful_At" is not null
        and application."Personal_Data_Deleted_At" is null
    ),
    'completed_count', (
      select count(*) from public."Event_Applications"
      where "Personal_Data_Deleted_At" is not null
    ),
    'last_cleanup_at', (
      select max(log_row."Created_At")
      from public."Program_Applicant_Data_Deletion_Log" log_row
      where log_row."Status" = 'Completed'
    ),
    'automatic_schedule_active', exists (
      select 1 from cron.job
      where jobname = 'strandshare-program-applicant-data-retention'
        and active
    ),
    'database_size_bytes', pg_database_size(current_database()),
    'storage_size_bytes', coalesce((
      select sum(
        case
          when coalesce(object_row.metadata ->> 'size', '') ~ '^[0-9]+$'
            then (object_row.metadata ->> 'size')::bigint
          else 0
        end
      )
      from storage.objects object_row
    ), 0)
  ) into v_result;

  return v_result;
end;
$fn$;

revoke all on function public.get_program_applicant_maintenance_summary()
  from public, anon;
grant execute on function public.get_program_applicant_maintenance_summary()
  to authenticated, service_role;

-- Called by the maintenance Edge Function with its service-role client. The
-- public anon key is stored in Vault and used only to pass the Edge gateway;
-- the endpoint permits only policy-bound cleanup or an authenticated Admin.
create or replace function public.configure_program_applicant_maintenance_schedule(
  p_project_url text,
  p_anon_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, vault, cron, pg_temp
as $fn$
declare
  v_url_secret_id uuid;
  v_key_secret_id uuid;
  v_job_id bigint;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service-role access is required.';
  end if;
  if nullif(trim(coalesce(p_project_url, '')), '') is null
     or left(lower(trim(p_project_url)), 8) <> 'https://'
     or nullif(trim(coalesce(p_anon_key, '')), '') is null then
    raise exception 'A valid Supabase project URL and public API key are required.';
  end if;

  select id into v_url_secret_id from vault.secrets
  where name = 'strandshare_program_maintenance_url' limit 1;
  if v_url_secret_id is null then
    perform vault.create_secret(rtrim(p_project_url, '/'), 'strandshare_program_maintenance_url');
  else
    perform vault.update_secret(v_url_secret_id, rtrim(p_project_url, '/'));
  end if;

  select id into v_key_secret_id from vault.secrets
  where name = 'strandshare_program_maintenance_anon_key' limit 1;
  if v_key_secret_id is null then
    perform vault.create_secret(p_anon_key, 'strandshare_program_maintenance_anon_key');
  else
    perform vault.update_secret(v_key_secret_id, p_anon_key);
  end if;

  select jobid into v_job_id from cron.job
  where jobname = 'strandshare-program-applicant-data-retention' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'strandshare-program-applicant-data-retention',
    '35 18 * * *',
    $command$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'strandshare_program_maintenance_url')
          || '/functions/v1/program-applicant-maintenance',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'strandshare_program_maintenance_anon_key'),
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'strandshare_program_maintenance_anon_key')
        ),
        body := '{"action":"cleanup","mode":"automatic"}'::jsonb
      );
    $command$
  );

  return true;
end;
$fn$;

revoke all on function public.configure_program_applicant_maintenance_schedule(text, text)
  from public, anon, authenticated;
grant execute on function public.configure_program_applicant_maintenance_schedule(text, text)
  to service_role;

comment on column public."Event_Applications"."Personal_Data_Deleted_At" is
  'Time sensitive applicant identity/contact data and uploaded attendee data were purged, three months after program success.';
comment on table public."Program_Applicant_Data_Deletion_Log" is
  'Non-PII audit trail for automatic and Admin-triggered program-applicant data retention cleanup.';

commit;
