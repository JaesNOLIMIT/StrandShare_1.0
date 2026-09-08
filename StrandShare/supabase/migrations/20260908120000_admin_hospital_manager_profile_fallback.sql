begin;

-- Secure public-profile fallback while an older account-management Edge
-- Function is still deployed. Login email changes intentionally remain in the
-- Edge Function because Auth identities must be updated through the Auth API.
create or replace function public.admin_update_hospital_manager_profile(
  p_hospital_id integer,
  p_user_id integer,
  p_access_start timestamp without time zone,
  p_access_end timestamp without time zone,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_suffix text,
  p_contact_number text,
  p_birthdate date,
  p_gender text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('admin', 'superadmin')
  then raise exception 'Only an active Admin can update H-Representative accounts.';
  end if;

  if not exists (
    select 1 from public."Hospitals" hospital
    join public.users manager on manager.user_id = hospital."Created_By"
    where hospital."Hospital_ID" = p_hospital_id
      and manager.user_id = p_user_id
      and public.normalize_app_role(manager.role) = 'hrepresentative'
  ) then raise exception 'The linked H-Representative account could not be verified.';
  end if;

  if nullif(trim(coalesce(p_first_name, '')), '') is null
    or nullif(trim(coalesce(p_last_name, '')), '') is null
  then raise exception 'Manager first name and last name are required.';
  end if;
  if p_access_start is not null and p_access_end is not null and p_access_end <= p_access_start
  then raise exception 'Access End must be later than Access Start.';
  end if;

  update public.users set
    access_start = p_access_start,
    access_end = p_access_end,
    updated_at = timezone('Asia/Manila', now())
  where user_id = p_user_id;

  update public.user_details set
    first_name = trim(p_first_name),
    middle_name = nullif(trim(coalesce(p_middle_name, '')), ''),
    last_name = trim(p_last_name),
    suffix = nullif(trim(coalesce(p_suffix, '')), ''),
    contact_number = nullif(trim(coalesce(p_contact_number, '')), ''),
    birthdate = p_birthdate,
    gender = nullif(trim(coalesce(p_gender, '')), ''),
    updated_at = timezone('Asia/Manila', now())
  where user_id = p_user_id;

  return jsonb_build_object('hospital_id', p_hospital_id, 'user_id', p_user_id, 'updated', true);
end;
$fn$;

revoke all on function public.admin_update_hospital_manager_profile(
  integer, integer, timestamp without time zone, timestamp without time zone,
  text, text, text, text, text, date, text
) from public, anon;
grant execute on function public.admin_update_hospital_manager_profile(
  integer, integer, timestamp without time zone, timestamp without time zone,
  text, text, text, text, text, date, text
) to authenticated;

notify pgrst, 'reload schema';
commit;
