-- Allow Specialist Quality Check to finalize received courier/drop-off hair.

begin;

-- Direct detail writes remain protected by the existing staff approval guard.
-- The Specialist RPC performs its own active-role and submission validation,
-- so bypass only that redundant guard while the RPC updates the final status.
-- Inventory, certificates, AI comparison, and notification triggers still run.
drop trigger if exists trg_guard_staff_hair_donation_approval
on public."Hair_Submission_Details";
create trigger trg_guard_staff_hair_donation_approval
before insert or update of "Status" on public."Hair_Submission_Details"
for each row
when (
  coalesce(current_setting('donivra.walk_in_manual_review', true), '') <> 'on'
  and coalesce(current_setting('donivra.specialist_received_hair_review', true), '') <> 'on'
)
execute function public.guard_staff_hair_donation_approval();

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

  -- Transaction-local and set only after verifying the authenticated actor.
  perform set_config('donivra.specialist_received_hair_review', 'on', true);

  v_result := public.specialist_review_received_hair_quality(
    p_submission_id,
    p_decision,
    p_rejection_reason,
    p_detail_updates
  );

  update public."Hair_Submissions"
  set
    "Status" = case when v_decision = 'approved' then 'Available' else 'Rejected' end,
    "Cut_At" = null,
    "Cut_By_User_ID" = null,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id;

  -- Re-fire the final detail update after the parent reaches Available so the
  -- inventory synchronization trigger inserts approved physical hair.
  update public."Hair_Submission_Details"
  set "Updated_At" = v_now
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

comment on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb) is
  'Lets active specialists/admins review received courier/drop-off hair while preserving guarded direct writes.';

notify pgrst, 'reload schema';

commit;
