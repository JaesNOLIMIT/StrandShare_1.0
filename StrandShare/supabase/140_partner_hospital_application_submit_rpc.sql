-- 140_partner_hospital_application_submit_rpc.sql
-- Submit partner hospital applications from a verified Supabase auth session.
-- Keeps public users / user_details / Hospitals writes behind one server-side RPC
-- instead of requiring broad anonymous table insert policies.

begin;

create or replace function public.normalize_app_role(role_value text)
returns text
language sql
immutable
as $$
  select lower(replace(replace(replace(coalesce(role_value, ''), '_', ''), ' ', ''), '-', ''));
$$;

create table if not exists public."Hospitals" (
  "Hospital_ID" serial primary key,
  "Hospital_Name" character varying(255),
  "Hospital_Logo" character varying(255),
  "Country" character varying(255),
  "Region" character varying(255),
  "City" character varying(255),
  "Barangay" character varying(255),
  "Street" character varying(255),
  "Contact_Number" character varying(50),
  "Created_At" timestamp without time zone default now(),
  "Updated_At" timestamp without time zone default now()
);

alter table public."Hospitals" add column if not exists "Province" character varying(255);
alter table public."Hospitals" add column if not exists "Latitude" numeric(10, 7);
alter table public."Hospitals" add column if not exists "Longitude" numeric(10, 7);
alter table public."Hospitals" add column if not exists "Is_Approved" boolean default false;
alter table public."Hospitals" add column if not exists "Approval_Status" character varying(50) default 'Pending';
alter table public."Hospitals" add column if not exists "Approved_By" integer;
alter table public."Hospitals" add column if not exists "Approved_At" timestamp without time zone;
alter table public."Hospitals" add column if not exists "Review_Notes" text;
alter table public."Hospitals" add column if not exists "Created_By" integer;
alter table public."Hospitals" add column if not exists "Updated_By" integer;
alter table public."Hospitals" add column if not exists "Hospital_Head_Name" character varying(255);
alter table public."Hospitals" add column if not exists "Hospital_Head_Title" character varying(255);
alter table public."Hospitals" add column if not exists "Hospital_Head_Contact_Number" character varying(50);
alter table public."Hospitals" add column if not exists "Hospital_Head_Email" character varying(255);

create or replace function public.submit_partner_hospital_application(
  p_email text,
  p_first_name text,
  p_middle_name text default null,
  p_last_name text default null,
  p_suffix text default null,
  p_birthdate date default null,
  p_gender text default null,
  p_lead_contact_number text default null,
  p_lead_street text default null,
  p_lead_barangay text default null,
  p_lead_city text default null,
  p_lead_province text default null,
  p_lead_region text default null,
  p_lead_country text default null,
  p_hospital_name text default null,
  p_hospital_logo_url text default null,
  p_hospital_head_name text default null,
  p_hospital_head_title text default null,
  p_hospital_head_contact_number text default null,
  p_hospital_head_email text default null,
  p_hospital_contact_number text default null,
  p_hospital_street text default null,
  p_hospital_barangay text default null,
  p_hospital_city text default null,
  p_hospital_province text default null,
  p_hospital_region text default null,
  p_hospital_country text default null,
  p_latitude numeric default null,
  p_longitude numeric default null
)
returns table (
  user_id integer,
  hospital_id integer
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auth_user_id uuid := auth.uid();
  v_auth_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_joined_date date := timezone('Asia/Manila', now())::date;
  v_user_id integer;
  v_existing_role_key text;
  v_row_count integer;
  v_hospital_id integer;
begin
  if v_auth_user_id is null then
    raise exception 'Please verify your email before submitting.';
  end if;

  if v_email = '' or v_auth_email = '' or v_email <> v_auth_email then
    raise exception 'Verified email does not match the application email.';
  end if;

  if nullif(trim(coalesce(p_first_name, '')), '') is null
     or nullif(trim(coalesce(p_last_name, '')), '') is null
     or nullif(trim(coalesce(p_hospital_name, '')), '') is null then
    raise exception 'Required application details are missing.';
  end if;

  select u.user_id, public.normalize_app_role(u.role)
  into v_user_id, v_existing_role_key
  from public.users u
  where lower(coalesce(u.email, '')) = v_email
  limit 1;

  if v_user_id is null then
    select u.user_id, public.normalize_app_role(u.role)
    into v_user_id, v_existing_role_key
    from public.users u
    where u.auth_user_id = v_auth_user_id
    limit 1;
  end if;

  if v_user_id is not null
     and coalesce(v_existing_role_key, '') <> ''
     and v_existing_role_key not in ('user', 'partner', 'hospital', 'partnerhospital', 'hrepresentative', 'hospitalrepresentative') then
    raise exception 'This email is linked to a restricted account role. Use a different email for the H-Representative account.';
  end if;

  if v_user_id is null then
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
      v_auth_user_id,
      v_email,
      'h_representative',
      null,
      null,
      false,
      v_now,
      v_now
    )
    returning users.user_id into v_user_id;
  else
    update public.users
    set
      auth_user_id = v_auth_user_id,
      email = v_email,
      role = 'h_representative',
      access_start = null,
      access_end = null,
      is_active = false,
      updated_at = v_now
    where users.user_id = v_user_id;
  end if;

  update public.user_details
  set
    first_name = nullif(trim(coalesce(p_first_name, '')), ''),
    middle_name = nullif(trim(coalesce(p_middle_name, '')), ''),
    suffix = nullif(trim(coalesce(p_suffix, '')), ''),
    birthdate = p_birthdate,
    gender = nullif(trim(coalesce(p_gender, '')), ''),
    last_name = nullif(trim(coalesce(p_last_name, '')), ''),
    contact_number = nullif(trim(coalesce(p_lead_contact_number, '')), ''),
    street = nullif(trim(coalesce(p_lead_street, '')), ''),
    barangay = nullif(trim(coalesce(p_lead_barangay, '')), ''),
    city = nullif(trim(coalesce(p_lead_city, '')), ''),
    province = nullif(trim(coalesce(p_lead_province, '')), ''),
    region = nullif(trim(coalesce(p_lead_region, '')), ''),
    country = nullif(trim(coalesce(p_lead_country, '')), ''),
    updated_at = v_now
  where user_details.user_id = v_user_id;

  get diagnostics v_row_count = row_count;

  if v_row_count = 0 then
    insert into public.user_details (
      user_id,
      first_name,
      middle_name,
      suffix,
      birthdate,
      gender,
      last_name,
      contact_number,
      street,
      barangay,
      city,
      province,
      region,
      country,
      joined_date,
      created_at,
      updated_at
    )
    values (
      v_user_id,
      nullif(trim(coalesce(p_first_name, '')), ''),
      nullif(trim(coalesce(p_middle_name, '')), ''),
      nullif(trim(coalesce(p_suffix, '')), ''),
      p_birthdate,
      nullif(trim(coalesce(p_gender, '')), ''),
      nullif(trim(coalesce(p_last_name, '')), ''),
      nullif(trim(coalesce(p_lead_contact_number, '')), ''),
      nullif(trim(coalesce(p_lead_street, '')), ''),
      nullif(trim(coalesce(p_lead_barangay, '')), ''),
      nullif(trim(coalesce(p_lead_city, '')), ''),
      nullif(trim(coalesce(p_lead_province, '')), ''),
      nullif(trim(coalesce(p_lead_region, '')), ''),
      nullif(trim(coalesce(p_lead_country, '')), ''),
      v_joined_date,
      v_now,
      v_now
    );
  end if;

  insert into public."Hospitals" (
    "Hospital_Name",
    "Hospital_Logo",
    "Hospital_Head_Name",
    "Hospital_Head_Title",
    "Hospital_Head_Contact_Number",
    "Hospital_Head_Email",
    "Contact_Number",
    "Street",
    "Barangay",
    "City",
    "Province",
    "Region",
    "Country",
    "Latitude",
    "Longitude",
    "Is_Approved",
    "Approval_Status",
    "Approved_By",
    "Approved_At",
    "Review_Notes",
    "Created_By",
    "Updated_By",
    "Created_At",
    "Updated_At"
  )
  values (
    nullif(trim(coalesce(p_hospital_name, '')), ''),
    nullif(trim(coalesce(p_hospital_logo_url, '')), ''),
    nullif(trim(coalesce(p_hospital_head_name, '')), ''),
    nullif(trim(coalesce(p_hospital_head_title, '')), ''),
    nullif(trim(coalesce(p_hospital_head_contact_number, '')), ''),
    nullif(trim(coalesce(p_hospital_head_email, '')), ''),
    nullif(trim(coalesce(p_hospital_contact_number, '')), ''),
    nullif(trim(coalesce(p_hospital_street, '')), ''),
    nullif(trim(coalesce(p_hospital_barangay, '')), ''),
    nullif(trim(coalesce(p_hospital_city, '')), ''),
    nullif(trim(coalesce(p_hospital_province, '')), ''),
    nullif(trim(coalesce(p_hospital_region, '')), ''),
    nullif(trim(coalesce(p_hospital_country, '')), ''),
    p_latitude,
    p_longitude,
    false,
    'Pending',
    null,
    null,
    null,
    v_user_id,
    v_user_id,
    v_now,
    v_now
  )
  returning "Hospital_ID" into v_hospital_id;

  return query
  select v_user_id, v_hospital_id;
end;
$fn$;

revoke all on function public.submit_partner_hospital_application(
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
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric
) from public;

grant execute on function public.submit_partner_hospital_application(
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
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric
) to authenticated;

commit;
