-- 113_fix_wig_request_submit_rls_and_rpc.sql
-- Fix H-Representative Wig Request submit when RLS is enabled.
-- This version does NOT depend on Wig_Request_Specifications.

begin;

-- Backward-compatible role normalizer in case older environments skipped role helper migrations.
create or replace function public.normalize_app_role(role_value text)
returns text
language sql
immutable
as $$
  with normalized as (
    select lower(replace(replace(replace(coalesce(role_value, ''), '_', ''), ' ', ''), '-', '')) as role_key
  )
  select
    case
      when role_key in ('superadmin', 'admin') then 'admin'
      when role_key in ('staff') then 'staff'
      when role_key in ('qastylist', 'specialist') then 'specialist'
      when role_key in ('hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative') then 'h_representative'
      when role_key in ('organization', 'organizations', 'org', 'partner', 'partners') then 'organization'
      else role_key
    end
  from normalized;
$$;

alter table if exists public."Wig_Requests" enable row level security;

grant select, insert, update, delete on table public."Wig_Requests" to authenticated;

do $$
begin
  if to_regclass('public."Wig_Requests_Req_ID_seq"') is not null then
    grant usage, select on sequence public."Wig_Requests_Req_ID_seq" to authenticated;
  end if;
end
$$;

drop policy if exists wig_requests_select_staff_admin_hrep on public."Wig_Requests";
drop policy if exists wig_requests_insert_staff_admin_hrep on public."Wig_Requests";
drop policy if exists wig_requests_update_staff_admin_hrep on public."Wig_Requests";
drop policy if exists wig_requests_delete_staff_admin_hrep on public."Wig_Requests";

create policy wig_requests_select_staff_admin_hrep
  on public."Wig_Requests"
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and (
          public.normalize_app_role(u.role) in ('staff', 'admin', 'specialist')
          or (
            public.normalize_app_role(u.role) = 'h_representative'
            and exists (
              select 1
              from public."Hospital_Representative" hr
              where hr."User_ID" = u.user_id
                and hr."Hospital_ID" = "Wig_Requests"."Hospital_ID"
            )
          )
        )
    )
  );

create policy wig_requests_insert_staff_admin_hrep
  on public."Wig_Requests"
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and (
          public.normalize_app_role(u.role) in ('staff', 'admin')
          or (
            public.normalize_app_role(u.role) = 'h_representative'
            and "Wig_Requests"."Requested_By" = u.user_id
            and exists (
              select 1
              from public."Hospital_Representative" hr
              where hr."User_ID" = u.user_id
                and hr."Hospital_ID" = "Wig_Requests"."Hospital_ID"
            )
          )
        )
    )
  );

create policy wig_requests_update_staff_admin_hrep
  on public."Wig_Requests"
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and (
          public.normalize_app_role(u.role) in ('staff', 'admin', 'specialist')
          or (
            public.normalize_app_role(u.role) = 'h_representative'
            and exists (
              select 1
              from public."Hospital_Representative" hr
              where hr."User_ID" = u.user_id
                and hr."Hospital_ID" = "Wig_Requests"."Hospital_ID"
            )
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and (
          public.normalize_app_role(u.role) in ('staff', 'admin', 'specialist')
          or (
            public.normalize_app_role(u.role) = 'h_representative'
            and exists (
              select 1
              from public."Hospital_Representative" hr
              where hr."User_ID" = u.user_id
                and hr."Hospital_ID" = "Wig_Requests"."Hospital_ID"
            )
          )
        )
    )
  );

create policy wig_requests_delete_staff_admin_hrep
  on public."Wig_Requests"
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and (
          public.normalize_app_role(u.role) in ('staff', 'admin', 'specialist')
          or (
            public.normalize_app_role(u.role) = 'h_representative'
            and exists (
              select 1
              from public."Hospital_Representative" hr
              where hr."User_ID" = u.user_id
                and hr."Hospital_ID" = "Wig_Requests"."Hospital_ID"
            )
          )
        )
    )
  );

-- RPC fallback submitter (bypasses table-RLS safely via explicit auth checks).
-- Keeps legacy arguments for client compatibility.
create or replace function public.create_wig_request_with_spec(
  p_hospital_id integer,
  p_patient_id integer,
  p_wig_specification_id integer,
  p_special_notes text default null,
  p_preferred_color text default null,
  p_preferred_length text default null,
  p_hair_texture text default null,
  p_cap_size text default null,
  p_style_preference text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor_user_id integer;
  v_actor_role text;
  v_req_id integer;
  v_requested_wig_id integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select u.user_id, public.normalize_app_role(u.role)
  into v_actor_user_id, v_actor_role
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(v_actor_user_id, 0) <= 0 then
    raise exception 'Unable to resolve actor user';
  end if;

  if v_actor_role not in ('h_representative', 'staff', 'admin') then
    raise exception 'Not authorized to submit wig request';
  end if;

  if coalesce(p_hospital_id, 0) <= 0 then
    raise exception 'Hospital_ID is required';
  end if;

  if coalesce(p_patient_id, 0) <= 0 then
    raise exception 'Patient_ID is required';
  end if;

  if coalesce(p_wig_specification_id, 0) <= 0 then
    raise exception 'Wig_Specification_ID is required';
  end if;

  if v_actor_role = 'h_representative' then
    if not exists (
      select 1
      from public."Hospital_Representative" hr
      where hr."User_ID" = v_actor_user_id
        and hr."Hospital_ID" = p_hospital_id
    ) then
      raise exception 'You are not assigned to this hospital';
    end if;
  end if;

  if not exists (
    select 1
    from public."Patients" p
    where p."Patient_ID" = p_patient_id
      and p."Hospital_ID" = p_hospital_id
  ) then
    raise exception 'Selected patient is not linked to the selected hospital';
  end if;

  select ws."Wig_ID"
  into v_requested_wig_id
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = p_wig_specification_id
  limit 1;

  if coalesce(v_requested_wig_id, 0) <= 0 then
    raise exception 'Selected wig specification does not exist or is not linked to a wig';
  end if;

  insert into public."Wig_Requests" (
    "Hospital_ID",
    "Patient_ID",
    "Status",
    "Requested_By",
    "Requested_Wig_ID",
    "Request_Date",
    "Updated_At",
    "Status_Reason"
  )
  values (
    p_hospital_id,
    p_patient_id,
    'Pending',
    v_actor_user_id,
    v_requested_wig_id,
    timezone('Asia/Manila', now()),
    timezone('Asia/Manila', now()),
    case
      when coalesce(p_special_notes, '') like 'SSMETA:%' then p_special_notes
      else null
    end
  )
  returning "Req_ID" into v_req_id;

  return v_req_id;
end;
$fn$;

grant execute on function public.create_wig_request_with_spec(
  integer,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text,
  text
) to authenticated;

commit;
