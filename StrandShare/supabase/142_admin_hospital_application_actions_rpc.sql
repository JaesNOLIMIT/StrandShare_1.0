-- 142_admin_hospital_application_actions_rpc.sql
-- Admin-only hospital application decisions and access toggles.
-- Keeps approval/rejection/access writes server-side so RLS cannot silently affect zero rows.

begin;

create or replace function public.normalize_app_role(role_value text)
returns text
language sql
immutable
as $$
  select lower(replace(replace(replace(coalesce(role_value, ''), '_', ''), ' ', ''), '-', ''));
$$;

drop function if exists public.admin_update_hospital_application(integer, text, text);
drop function if exists public.admin_update_hospital_application(integer, text, text, text);

create or replace function public.admin_update_hospital_application(
  p_hospital_id integer,
  p_action text,
  p_review_notes text default null,
  p_temporary_password text default null,
  p_login_url text default null
)
returns table (
  hospital_id integer,
  approval_status character varying,
  is_approved boolean,
  review_notes text,
  approved_at timestamp without time zone,
  approved_by integer,
  updated_at timestamp without time zone,
  applicant_user_id integer,
  applicant_user_email character varying,
  applicant_user_role character varying,
  applicant_user_is_active boolean,
  applicant_auth_user_id uuid
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_actor_user_id integer;
  v_actor_role_key text;
  v_action_key text := public.normalize_app_role(p_action);
  v_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_created_by integer;
  v_row_count integer;
  v_notification_type text;
  v_template_key text;
  v_subject text;
  v_queue_key text;
  v_recipient_email text;
  v_manager_name text;
  v_hospital_name text;
  v_login_url text := coalesce(nullif(trim(coalesce(p_login_url, '')), ''), '/login');
begin
  select u.user_id, public.normalize_app_role(u.role)
  into v_actor_user_id, v_actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(v_actor_role_key, '') not in ('admin', 'superadmin') then
    raise exception 'Only Admin can update hospital applications.';
  end if;

  if coalesce(p_hospital_id, 0) <= 0 then
    raise exception 'Hospital ID is required.';
  end if;

  select h."Created_By"
  into v_created_by
  from public."Hospitals" h
  where h."Hospital_ID" = p_hospital_id
  for update;

  if not found then
    raise exception 'Hospital application was not found.';
  end if;

  if v_created_by is null then
    raise exception 'Hospital application is missing a managing account.';
  end if;

  if v_action_key = 'approve' then
    v_notification_type := 'partner_hospital_approved';
    v_template_key := 'partner_hospital_approved';
    v_subject := 'Donivra Partner Hospital Application Approved';

    update public."Hospitals"
    set
      "Approval_Status" = 'Approved',
      "Is_Approved" = true,
      "Review_Notes" = v_notes,
      "Approved_At" = v_now,
      "Approved_By" = v_actor_user_id,
      "Updated_By" = v_actor_user_id,
      "Updated_At" = v_now
    where "Hospital_ID" = p_hospital_id;

    update public.users
    set
      role = 'h_representative',
      is_active = true,
      updated_at = v_now
    where user_id = v_created_by;
  elsif v_action_key = 'reject' then
    v_notification_type := 'partner_hospital_rejected';
    v_template_key := 'partner_hospital_rejected';
    v_subject := 'Donivra Partner Hospital Application Update';

    update public."Hospitals"
    set
      "Approval_Status" = 'Rejected',
      "Is_Approved" = false,
      "Review_Notes" = v_notes,
      "Approved_At" = v_now,
      "Approved_By" = v_actor_user_id,
      "Updated_By" = v_actor_user_id,
      "Updated_At" = v_now
    where "Hospital_ID" = p_hospital_id;

    update public.users
    set
      role = 'h_representative',
      is_active = false,
      updated_at = v_now
    where user_id = v_created_by;
  elsif v_action_key in ('turnon', 'turnonaccess', 'enable', 'enableaccess') then
    v_notification_type := 'partner_hospital_access_enabled';
    v_template_key := 'partner_hospital_access_enabled';
    v_subject := 'Donivra Partner Hospital Access Turned On';

    update public."Hospitals"
    set
      "Is_Approved" = true,
      "Updated_By" = v_actor_user_id,
      "Updated_At" = v_now
    where "Hospital_ID" = p_hospital_id;

    update public.users
    set
      role = 'h_representative',
      is_active = true,
      updated_at = v_now
    where user_id = v_created_by;
  elsif v_action_key in ('turnoff', 'turnoffaccess', 'disable', 'disableaccess') then
    v_notification_type := 'partner_hospital_access_disabled';
    v_template_key := 'partner_hospital_access_disabled';
    v_subject := 'Donivra Partner Hospital Access Turned Off';

    update public."Hospitals"
    set
      "Is_Approved" = false,
      "Updated_By" = v_actor_user_id,
      "Updated_At" = v_now
    where "Hospital_ID" = p_hospital_id;

    update public.users
    set
      is_active = false,
      updated_at = v_now
    where user_id = v_created_by;
  else
    raise exception 'Unsupported hospital application action: %.', coalesce(p_action, '');
  end if;

  get diagnostics v_row_count = row_count;
  if v_row_count = 0 then
    raise exception 'No matching H-Representative account was updated.';
  end if;

  select
    h."Hospital_Name",
    lower(coalesce(u.email, '')),
    nullif(
      trim(concat_ws(' ', d.first_name, d.middle_name, d.last_name, d.suffix)),
      ''
    )
  into v_hospital_name, v_recipient_email, v_manager_name
  from public."Hospitals" h
  left join public.users u on u.user_id = h."Created_By"
  left join public.user_details d on d.user_id = u.user_id
  where h."Hospital_ID" = p_hospital_id
  limit 1;

  if to_regclass('public."SMTP_Email_Outbox"') is not null
     and nullif(trim(coalesce(v_recipient_email, '')), '') is not null then
    v_queue_key := concat(
      'partner-hospital:',
      p_hospital_id,
      ':',
      replace(v_notification_type, '_', '-'),
      ':',
      to_char(v_now, 'YYYYMMDDHH24MISSMS')
    );

    insert into public."SMTP_Email_Outbox" (
      "Queue_Key",
      "Source_Table",
      "Source_ID",
      "Notification_Type",
      "Recipient_Email",
      "Subject",
      "Template_Key",
      "Payload",
      "Created_By_User_ID"
    )
    values (
      v_queue_key,
      'Hospitals',
      p_hospital_id,
      v_notification_type,
      v_recipient_email,
      v_subject,
      v_template_key,
      jsonb_build_object(
        'hospital_id', p_hospital_id,
        'hospital_name', coalesce(v_hospital_name, 'Partner Hospital'),
        'manager_name', coalesce(v_manager_name, ''),
        'recipient_email', v_recipient_email,
        'role_label', 'H-Representative',
        'review_notes', coalesce(v_notes, ''),
        'temporary_password', coalesce(nullif(trim(coalesce(p_temporary_password, '')), ''), ''),
        'login_url', v_login_url,
        'action_at', v_now,
        'access_status', case
          when v_action_key in ('approve', 'turnon', 'turnonaccess', 'enable', 'enableaccess') then 'On'
          else 'Off'
        end
      ),
      v_actor_user_id
    )
    on conflict ("Queue_Key") do nothing;
  end if;

  return query
  select
    h."Hospital_ID",
    h."Approval_Status",
    h."Is_Approved",
    h."Review_Notes",
    h."Approved_At",
    h."Approved_By",
    h."Updated_At",
    u.user_id,
    u.email,
    u.role,
    u.is_active,
    u.auth_user_id
  from public."Hospitals" h
  left join public.users u on u.user_id = h."Created_By"
  where h."Hospital_ID" = p_hospital_id
  limit 1;
end;
$fn$;

do $$
begin
  if to_regclass('public."SMTP_Email_Outbox"') is not null then
    alter table public."SMTP_Email_Outbox"
      drop constraint if exists smtp_email_outbox_notification_type_check;

    alter table public."SMTP_Email_Outbox"
      add constraint smtp_email_outbox_notification_type_check
      check (
        lower(replace(replace(replace(coalesce("Notification_Type", ''), '_', ''), ' ', ''), '-', '')) in (
          'eventapplicationreceived',
          'staffrejected',
          'staffendorsedpendingadmin',
          'adminapproved',
          'adminrejected',
          'partnerhospitalapproved',
          'partnerhospitalrejected',
          'partnerhospitalaccessenabled',
          'partnerhospitalaccessdisabled'
        )
      );
  end if;
end
$$;

revoke all on function public.admin_update_hospital_application(integer, text, text, text, text) from public;
grant execute on function public.admin_update_hospital_application(integer, text, text, text, text) to authenticated;

commit;
