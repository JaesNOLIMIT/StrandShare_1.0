-- Staff can close an expected independent courier donation that never arrived.
begin;

create or replace function public.staff_mark_courier_hair_not_received(
  p_submission_id integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_logistics public."Hair_Submission_Logistics"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor
  from public.users
  where auth_user_id = auth.uid()
    and is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin') then
    raise exception 'Only active staff/admin can close an unreceived courier donation.';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to mark this courier donation Not Received.';
  end if;

  select * into v_submission
  from public."Hair_Submissions"
  where "Submission_ID" = p_submission_id
  for update;

  if v_submission."Submission_ID" is null
    or coalesce(v_submission."From_Event", true)
    or public.normalize_flow_key(v_submission."Status") <> 'pending'
    or v_submission."Bundle_ID" is not null then
    raise exception 'Only an expected independent courier donation can be marked Not Received.';
  end if;

  if exists (
    select 1 from public."Salon_Donation_Appointments"
    where "Hair_Submission_ID" = p_submission_id
  ) then
    raise exception 'Booked appointments must be handled in the Appointments tab.';
  end if;

  select * into v_logistics
  from public."Hair_Submission_Logistics"
  where "Submission_ID" = p_submission_id
    and public.non_event_hair_logistics_kind("Logistics_Type") = 'Courier'
  order by "Submission_Logistics_ID" desc
  limit 1
  for update;

  if v_logistics."Submission_Logistics_ID" is null
    or v_logistics."Received_At" is not null
    or public.normalize_flow_key(coalesce(v_logistics."Shipment_Status", ''))
      in ('received', 'completed', 'delivered', 'cancelled', 'canceled', 'noshow') then
    raise exception 'This courier donation is already final or received.';
  end if;

  update public."Hair_Submission_Logistics"
  set "Shipment_Status" = 'No Show',
      "Cancelled_At" = v_now,
      "Cancellation_Source" = 'Staff',
      "Cancellation_Reason" = btrim(p_reason),
      "Updated_By" = v_actor.user_id,
      "Updated_At" = v_now
  where "Submission_Logistics_ID" = v_logistics."Submission_Logistics_ID"
  returning * into v_logistics;

  update public."Hair_Submissions"
  set "Status" = 'Cancelled', "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
  returning * into v_submission;

  return jsonb_build_object(
    'submission', to_jsonb(v_submission),
    'logistics', to_jsonb(v_logistics)
  );
end;
$fn$;

revoke all on function public.staff_mark_courier_hair_not_received(integer, text)
  from public, anon, authenticated;
grant execute on function public.staff_mark_courier_hair_not_received(integer, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
