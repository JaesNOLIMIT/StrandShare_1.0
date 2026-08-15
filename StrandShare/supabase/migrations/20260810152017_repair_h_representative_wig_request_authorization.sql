-- Repair role comparisons after normalize_app_role removes underscores,
-- spaces, and hyphens. This migration intentionally touches only the wig
-- request workflow and does not modify Patients or Manage Patient policies.

begin;

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
  v_spec public."Wig_Specifications"%rowtype;
  v_wig public."Wigs"%rowtype;
  v_is_wish boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select u.user_id, public.normalize_app_role(u.role)
  into v_actor_user_id, v_actor_role
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(v_actor_user_id, 0) <= 0 then raise exception 'Unable to resolve actor user'; end if;
  if v_actor_role not in (
    'hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff',
    'staff', 'admin', 'superadmin'
  ) then
    raise exception 'Not authorized to submit wig request';
  end if;

  if v_actor_role in ('hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff')
    and not exists (
      select 1
      from public."Hospital_Representative" hr
      where hr."User_ID" = v_actor_user_id
        and hr."Hospital_ID" = p_hospital_id
    )
  then
    raise exception 'You are not assigned to this hospital';
  end if;

  if not exists (
    select 1
    from public."Patients" p
    where p."Patient_ID" = p_patient_id
      and p."Hospital_ID" = p_hospital_id
  ) then
    raise exception 'Selected patient is not linked to the selected hospital';
  end if;

  select * into v_spec
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = p_wig_specification_id;

  if v_spec."Wig_Specification_ID" is null or v_spec."Wig_ID" is null then
    raise exception 'Selected wig specification does not exist or is not linked to a wig';
  end if;

  select * into v_wig
  from public."Wigs" w
  where w."Wig_ID" = v_spec."Wig_ID";

  if v_wig."Wig_ID" is null then raise exception 'Selected catalog wig does not exist'; end if;

  v_is_wish := greatest(0, coalesce(v_wig."Stock_Count", 0)) = 0
    or public.normalize_flow_key(v_wig."Wig_Status") <> 'available';

  insert into public."Wig_Requests" (
    "Hospital_ID", "Patient_ID", "Status", "Requested_By", "Requested_Wig_ID",
    "Requested_Wig_Specification_ID", "Requested_Cap_Size", "Is_Wish_Request",
    "Fulfillment_Status", "Request_Date", "Updated_At", "Status_Reason"
  ) values (
    p_hospital_id, p_patient_id, 'Pending', v_actor_user_id, v_spec."Wig_ID",
    v_spec."Wig_Specification_ID", coalesce(nullif(trim(p_cap_size), ''), v_spec."Cap_Size"::text),
    v_is_wish, case when v_is_wish then 'awaiting_review' else 'catalog_available' end,
    timezone('Asia/Manila', now()), timezone('Asia/Manila', now()),
    case when coalesce(p_special_notes, '') like 'SSMETA:%' then p_special_notes else null end
  ) returning "Req_ID" into v_req_id;

  insert into public."Wig_Request_Specifications" (
    "Req_ID", "Preferred_Color", "Preferred_Length", "Hair_Texture", "Cap_Size",
    "Style_Preference", "Special_Notes"
  ) values (
    v_req_id,
    coalesce(nullif(trim(p_preferred_color), ''), v_spec."Hair_Color"),
    coalesce(nullif(trim(p_preferred_length), ''), v_spec."Hair_Length"::text),
    coalesce(nullif(trim(p_hair_texture), ''), v_spec."Hair_Texture"),
    coalesce(nullif(trim(p_cap_size), ''), v_spec."Cap_Size"::text),
    coalesce(nullif(trim(p_style_preference), ''), v_spec."Style"),
    nullif(trim(coalesce(p_special_notes, '')), '')
  )
  on conflict ("Req_ID") do update set
    "Preferred_Color" = excluded."Preferred_Color",
    "Preferred_Length" = excluded."Preferred_Length",
    "Hair_Texture" = excluded."Hair_Texture",
    "Cap_Size" = excluded."Cap_Size",
    "Style_Preference" = excluded."Style_Preference",
    "Special_Notes" = excluded."Special_Notes";

  return v_req_id;
end;
$fn$;

revoke all on function public.create_wig_request_with_spec(
  integer, integer, integer, text, text, text, text, text, text
) from public, anon;

grant execute on function public.create_wig_request_with_spec(
  integer, integer, integer, text, text, text, text, text, text
) to authenticated;

drop policy if exists wig_requests_insert_staff_admin_hrep on public."Wig_Requests";
create policy wig_requests_insert_staff_admin_hrep
on public."Wig_Requests"
as permissive
for insert
to authenticated
with check (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin')
        or (
          public.normalize_app_role(actor.role) in (
            'hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff'
          )
          and "Wig_Requests"."Requested_By" = actor.user_id
          and exists (
            select 1
            from public."Hospital_Representative" assignment
            where assignment."User_ID" = actor.user_id
              and assignment."Hospital_ID" = "Wig_Requests"."Hospital_ID"
          )
        )
      )
  )
);

drop policy if exists wig_requests_select_staff_admin_hrep on public."Wig_Requests";
create policy wig_requests_select_staff_admin_hrep
on public."Wig_Requests"
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin', 'specialist')
        or (
          public.normalize_app_role(actor.role) in (
            'hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff'
          )
          and exists (
            select 1
            from public."Hospital_Representative" assignment
            where assignment."User_ID" = actor.user_id
              and assignment."Hospital_ID" = "Wig_Requests"."Hospital_ID"
          )
        )
      )
  )
);

drop policy if exists wig_requests_update_staff_admin_hrep on public."Wig_Requests";
create policy wig_requests_update_staff_admin_hrep
on public."Wig_Requests"
as permissive
for update
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin', 'specialist')
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where public.normalize_app_role(actor.role) in (
              'hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff'
            )
            and assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = "Wig_Requests"."Hospital_ID"
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin', 'specialist')
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where public.normalize_app_role(actor.role) in (
              'hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff'
            )
            and assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = "Wig_Requests"."Hospital_ID"
        )
      )
  )
);

drop policy if exists wig_requests_delete_staff_admin_hrep on public."Wig_Requests";
create policy wig_requests_delete_staff_admin_hrep
on public."Wig_Requests"
as permissive
for delete
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin', 'specialist')
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where public.normalize_app_role(actor.role) in (
              'hrepresentative', 'hospitalrepresentative', 'hospital', 'hstaff'
            )
            and assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" = "Wig_Requests"."Hospital_ID"
        )
      )
  )
);

commit;
