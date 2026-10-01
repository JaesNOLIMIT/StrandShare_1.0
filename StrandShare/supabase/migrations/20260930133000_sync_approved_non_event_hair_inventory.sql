-- Finalize approved courier/drop-off hair as Cut and synchronize inventory.

begin;

create or replace function public.sync_cut_hair_inventory_from_detail()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_submission public."Hair_Submissions"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if tg_op = 'DELETE' then
    delete from public."Cut_Hair_Inventory"
    where "Submission_ID" = old."Submission_ID";
    return old;
  end if;

  -- Rejected, rejected-cut, pending, and cancelled details never create stock.
  if public.normalize_flow_key(new."Status") <> 'approved' then
    return new;
  end if;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = new."Submission_ID";

  if v_submission."Submission_ID" is null
    or public.normalize_flow_key(v_submission."Status") <> 'cut' then
    return new;
  end if;

  insert into public."Cut_Hair_Inventory" (
    "Submission_ID", "Event_Request_ID", "Event_Attendee_ID", "Donor_User_ID",
    "Approved_By_User_ID", "Source_Type", "Status", "Approved_At", "Updated_At"
  ) values (
    v_submission."Submission_ID",
    v_submission."Event_Request_ID",
    v_submission."Event_Attendee_ID",
    v_submission."User_ID",
    new."Updated_By",
    case
      when coalesce(v_submission."From_Event", false) then 'Event'
      else 'Non-Event'
    end,
    'Cut',
    coalesce(new."Updated_At", v_now),
    v_now
  )
  on conflict ("Submission_ID") do update
  set
    "Event_Request_ID" = excluded."Event_Request_ID",
    "Event_Attendee_ID" = excluded."Event_Attendee_ID",
    "Donor_User_ID" = excluded."Donor_User_ID",
    "Approved_By_User_ID" = excluded."Approved_By_User_ID",
    "Source_Type" = excluded."Source_Type",
    "Updated_At" = v_now;

  return new;
end;
$fn$;

revoke all on function public.sync_cut_hair_inventory_from_detail()
  from public, anon, authenticated;

create or replace function public.specialist_review_non_event_hair_quality_v2(
  p_submission_id integer,
  p_decision text,
  p_rejection_reason text default null,
  p_detail_updates jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_result jsonb;
  v_decision text := public.normalize_flow_key(p_decision);
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('specialist', 'admin', 'superadmin') then
    raise exception 'Only an active specialist/admin can review received hair.';
  end if;

  if exists (
    select 1
    from public."Salon_Donation_Appointments" appointment
    where appointment."Hair_Submission_ID" = p_submission_id
  ) then
    raise exception 'Booked salon hair must be reviewed from Receiving Schedule.';
  end if;

  perform set_config('donivra.specialist_received_hair_review', 'on', true);

  v_result := public.specialist_review_received_hair_quality(
    p_submission_id,
    p_decision,
    p_rejection_reason,
    p_detail_updates
  );

  update public."Hair_Submissions"
  set
    "Status" = case when v_decision = 'approved' then 'Cut' else 'Rejected' end,
    "Cut_At" = case
      when v_decision = 'approved' then coalesce("Cut_At", v_now)
      else null
    end,
    "Cut_By_User_ID" = case
      when v_decision = 'approved' then coalesce("Cut_By_User_ID", v_actor.user_id)
      else null
    end,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id;

  -- Status is intentionally assigned to itself. UPDATE OF "Status" re-fires
  -- the inventory trigger after the parent submission has reached Cut.
  update public."Hair_Submission_Details"
  set
    "Status" = "Status",
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
    and public.normalize_flow_key("Status") in ('approved', 'rejected');

  return v_result || jsonb_build_object(
    'submission', (
      select to_jsonb(submission)
      from public."Hair_Submissions" submission
      where submission."Submission_ID" = p_submission_id
    )
  );
end;
$fn$;

revoke all on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb)
  to authenticated;

-- Repair earlier approved non-event reviews that reached Available before the
-- inventory trigger could observe a Cut parent. Rejected/cancelled rows are
-- deliberately excluded.
update public."Hair_Submissions" submission
set
  "Status" = 'Cut',
  "Cut_At" = coalesce(submission."Cut_At", detail."Updated_At", timezone('Asia/Manila', now())),
  "Cut_By_User_ID" = coalesce(submission."Cut_By_User_ID", detail."Updated_By"),
  "Updated_At" = timezone('Asia/Manila', now())
from public."Hair_Submission_Details" detail
where detail."Submission_ID" = submission."Submission_ID"
  and coalesce(submission."From_Event", false) = false
  and public.normalize_flow_key(submission."Status") in ('available', 'cut')
  and public.normalize_flow_key(detail."Status") = 'approved'
  and submission."Bundle_ID" is null;

update public."Hair_Submission_Details" detail
set
  "Status" = detail."Status",
  "Updated_At" = timezone('Asia/Manila', now())
from public."Hair_Submissions" submission
where submission."Submission_ID" = detail."Submission_ID"
  and coalesce(submission."From_Event", false) = false
  and public.normalize_flow_key(submission."Status") = 'cut'
  and public.normalize_flow_key(detail."Status") = 'approved'
  and not exists (
    select 1
    from public."Cut_Hair_Inventory" inventory
    where inventory."Submission_ID" = submission."Submission_ID"
  );

notify pgrst, 'reload schema';

commit;
