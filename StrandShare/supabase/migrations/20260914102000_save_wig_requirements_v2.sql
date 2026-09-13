begin;

-- Use a versioned RPC so PostgREST cannot resolve a stale cached definition of
-- the earlier update function. The statement remains an INSERT with a singleton
-- conflict target, which is compatible with the hosted safe-update guard.
create or replace function public.save_wig_requirements_v2(
  p_minimum_number_donor integer,
  p_minimum_hair_length numeric,
  p_chemical_treatment_status boolean,
  p_colored_hair_status boolean,
  p_bleached_hair_status boolean,
  p_rebonded_hair_status boolean,
  p_hair_texture_status text,
  p_notes text
)
returns setof public.wig_requirements
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_user_id integer;
  v_saved_requirement public.wig_requirements%rowtype;
begin
  select account.user_id
  into v_actor_user_id
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
    and public.normalize_app_role(account.role) in ('staff', 'admin', 'superadmin')
  limit 1;

  if v_actor_user_id is null then
    raise exception 'Only active staff and administrators can update wig requirements.';
  end if;

  if p_minimum_number_donor is not null and p_minimum_number_donor < 0 then
    raise exception 'Minimum donors cannot be negative.';
  end if;

  if p_minimum_hair_length is not null and p_minimum_hair_length < 0 then
    raise exception 'Minimum hair length cannot be negative.';
  end if;

  insert into public.wig_requirements (
    "Minimum_Number_Donor",
    "Minimum_Hair_Length",
    "Chemical_Treatment_Status",
    "Colored_Hair_Status",
    "Bleached_Hair_Status",
    "Rebonded_Hair_Status",
    "Hair_Texture_Status",
    "Notes",
    "Updated_By"
  )
  values (
    p_minimum_number_donor,
    p_minimum_hair_length,
    coalesce(p_chemical_treatment_status, false),
    coalesce(p_colored_hair_status, false),
    coalesce(p_bleached_hair_status, false),
    coalesce(p_rebonded_hair_status, false),
    nullif(trim(p_hair_texture_status), ''),
    nullif(trim(p_notes), ''),
    v_actor_user_id
  )
  on conflict ((1)) do update
  set
    "Minimum_Number_Donor" = excluded."Minimum_Number_Donor",
    "Minimum_Hair_Length" = excluded."Minimum_Hair_Length",
    "Chemical_Treatment_Status" = excluded."Chemical_Treatment_Status",
    "Colored_Hair_Status" = excluded."Colored_Hair_Status",
    "Bleached_Hair_Status" = excluded."Bleached_Hair_Status",
    "Rebonded_Hair_Status" = excluded."Rebonded_Hair_Status",
    "Hair_Texture_Status" = excluded."Hair_Texture_Status",
    "Notes" = excluded."Notes",
    "Updated_By" = excluded."Updated_By"
  returning * into v_saved_requirement;

  return next v_saved_requirement;
  return;
end;
$fn$;

revoke all on function public.save_wig_requirements_v2(integer, numeric, boolean, boolean, boolean, boolean, text, text)
  from public, anon;
grant execute on function public.save_wig_requirements_v2(integer, numeric, boolean, boolean, boolean, boolean, text, text)
  to authenticated;

comment on function public.save_wig_requirements_v2(integer, numeric, boolean, boolean, boolean, boolean, text, text) is
  'Versioned, safe-update-compatible save operation for the global wig requirements singleton.';

notify pgrst, 'reload schema';
commit;
