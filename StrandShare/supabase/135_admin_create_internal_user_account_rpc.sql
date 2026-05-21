-- 135_admin_create_internal_user_account_rpc.sql
-- Add admin-only RPC to create internal web accounts (Staff/Specialist) and
-- insert both public.users + public.user_details in one server-side action.
-- This avoids broad RLS changes on users tables and keeps other modules stable.

begin;

create or replace function public.admin_create_internal_user_account(
  p_email text,
  p_role text,
  p_access_start timestamp without time zone default null,
  p_access_end timestamp without time zone default null,
  p_is_active boolean default true,
  p_photo_path text default null,
  p_first_name text default null,
  p_middle_name text default null,
  p_last_name text default null,
  p_suffix text default null,
  p_birthdate date default null,
  p_gender text default null,
  p_street text default null,
  p_region text default null,
  p_barangay text default null,
  p_city text default null,
  p_province text default null,
  p_country text default null,
  p_contact_number text default null
)
returns table (
  user_id integer,
  user_details_id integer,
  email character varying,
  role character varying
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_joined_date date := timezone('Asia/Manila', now())::date;
  v_actor_role_key text;
  v_role_key text;
  v_role_value text;
  v_email text;
  v_user_id integer;
  v_user_details_id integer;
begin
  select lower(replace(replace(replace(coalesce(u.role, ''), '_', ''), ' ', ''), '-', ''))
  into v_actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(v_actor_role_key, '') <> 'admin' then
    raise exception 'Only admin can create internal user accounts.';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' then
    raise exception 'Email is required.';
  end if;

  v_role_key := lower(replace(replace(replace(coalesce(p_role, ''), '_', ''), ' ', ''), '-', ''));
  if v_role_key = 'staff' then
    v_role_value := 'staff';
  elsif v_role_key in ('specialist', 'qastylist') then
    v_role_value := 'specialist';
  else
    raise exception 'Role must be staff or specialist.';
  end if;

  if p_access_start is not null and p_access_end is not null and p_access_end <= p_access_start then
    raise exception 'Access End must be later than Access Start.';
  end if;

  if exists (
    select 1
    from public.users u
    where lower(coalesce(u.email, '')) = v_email
  ) then
    raise exception 'Email already exists in users table.';
  end if;

  insert into public.users (
    auth_user_id,
    email,
    role,
    access_start,
    access_end,
    is_active,
    created_at,
    updated_at
  )
  values (
    null,
    v_email,
    v_role_value,
    p_access_start,
    p_access_end,
    coalesce(p_is_active, true),
    v_now,
    v_now
  )
  returning users.user_id into v_user_id;

  insert into public.user_details (
    user_id,
    photo_path,
    first_name,
    middle_name,
    last_name,
    suffix,
    birthdate,
    gender,
    street,
    region,
    barangay,
    city,
    province,
    country,
    contact_number,
    joined_date,
    created_at,
    updated_at
  )
  values (
    v_user_id,
    nullif(trim(coalesce(p_photo_path, '')), ''),
    nullif(trim(coalesce(p_first_name, '')), ''),
    nullif(trim(coalesce(p_middle_name, '')), ''),
    nullif(trim(coalesce(p_last_name, '')), ''),
    nullif(trim(coalesce(p_suffix, '')), ''),
    p_birthdate,
    nullif(trim(coalesce(p_gender, '')), ''),
    nullif(trim(coalesce(p_street, '')), ''),
    nullif(trim(coalesce(p_region, '')), ''),
    nullif(trim(coalesce(p_barangay, '')), ''),
    nullif(trim(coalesce(p_city, '')), ''),
    nullif(trim(coalesce(p_province, '')), ''),
    nullif(trim(coalesce(p_country, '')), ''),
    nullif(trim(coalesce(p_contact_number, '')), ''),
    v_joined_date,
    v_now,
    v_now
  )
  returning user_details.user_details_id into v_user_details_id;

  return query
  select
    v_user_id,
    v_user_details_id,
    v_email::character varying,
    v_role_value::character varying;
end;
$fn$;

revoke all on function public.admin_create_internal_user_account(
  text,
  text,
  timestamp without time zone,
  timestamp without time zone,
  boolean,
  text,
  text,
  text,
  text,
  text,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public;

grant execute on function public.admin_create_internal_user_account(
  text,
  text,
  timestamp without time zone,
  timestamp without time zone,
  boolean,
  text,
  text,
  text,
  text,
  text,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to authenticated;

commit;
