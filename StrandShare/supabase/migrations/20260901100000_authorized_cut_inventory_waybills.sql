-- Expose only the attendee identifiers needed by the shared cut-hair inventory.
-- This avoids broadening specialist SELECT access to full Event_Attendees rows.

begin;

create or replace function public.get_cut_hair_inventory_waybills(
  p_event_attendee_ids integer[]
)
returns table (
  event_attendee_id integer,
  event_request_id integer,
  user_id integer,
  waybill_code text
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor public.users%rowtype;
  v_role_key text;
begin
  select * into v_actor
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_actor.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_actor.role);
  if v_role_key not in ('admin', 'staff', 'specialist') then
    raise exception 'You are not authorized to view cut-hair inventory waybills.';
  end if;

  return query
  select distinct
    ea."Event_Attendee_ID",
    ea."Event_Request_ID",
    ea."User_ID",
    nullif(upper(trim(coalesce(ea."Waybill_Code", ''))), '')::text
  from public."Event_Attendees" ea
  join public."Cut_Hair_Inventory" chi
    on chi."Event_Attendee_ID" = ea."Event_Attendee_ID"
  where ea."Event_Attendee_ID" = any(coalesce(p_event_attendee_ids, array[]::integer[]))
    and (
      v_role_key in ('admin', 'specialist')
      or exists (
        select 1
        from public."Event_Requests" er
        where er."Event_Request_ID" = ea."Event_Request_ID"
          and er."Assigned_Staff_User_ID" = v_actor.user_id
      )
    );
end;
$fn$;

revoke all on function public.get_cut_hair_inventory_waybills(integer[]) from public, anon;
grant execute on function public.get_cut_hair_inventory_waybills(integer[]) to authenticated;

comment on function public.get_cut_hair_inventory_waybills(integer[])
  is 'Returns waybill codes only for authorized cut-inventory attendee links.';

commit;
