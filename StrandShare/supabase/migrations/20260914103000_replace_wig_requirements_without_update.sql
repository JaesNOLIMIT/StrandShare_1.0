begin;

-- The hosted safe-update guard also treats ON CONFLICT DO UPDATE as an
-- unfiltered update. Replace the singleton row without issuing UPDATE at all.
-- No table has a foreign key to wig_requirements, so preserving the primary key
-- makes this replacement safe for current and future readers.
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
  v_requirement_id integer;
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

  -- Serialize singleton replacements and retain the existing public ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.wig_requirements.singleton'));

  select requirement."Wig_Requirement_ID"
  into v_requirement_id
  from public.wig_requirements requirement
  order by requirement."Wig_Requirement_ID"
  limit 1;

  if v_requirement_id is not null then
    delete from public.wig_requirements requirement
    where requirement."Wig_Requirement_ID" = v_requirement_id;
  end if;

  insert into public.wig_requirements (
    "Wig_Requirement_ID",
    "Minimum_Number_Donor",
    "Minimum_Hair_Length",
    "Chemical_Treatment_Status",
    "Colored_Hair_Status",
    "Bleached_Hair_Status",
    "Rebonded_Hair_Status",
    "Hair_Texture_Status",
    "Notes",
    "Updated_At",
    "Updated_By"
  )
  values (
    coalesce(
      v_requirement_id,
      pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.wig_requirements', 'Wig_Requirement_ID'))
    ),
    p_minimum_number_donor,
    p_minimum_hair_length,
    coalesce(p_chemical_treatment_status, false),
    coalesce(p_colored_hair_status, false),
    coalesce(p_bleached_hair_status, false),
    coalesce(p_rebonded_hair_status, false),
    nullif(pg_catalog.btrim(p_hair_texture_status), ''),
    nullif(pg_catalog.btrim(p_notes), ''),
    pg_catalog.now(),
    v_actor_user_id
  )
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
  'Saves the wig requirements singleton without UPDATE or ON CONFLICT, for databases using the safe-update guard.';

notify pgrst, 'reload schema';
commit;
