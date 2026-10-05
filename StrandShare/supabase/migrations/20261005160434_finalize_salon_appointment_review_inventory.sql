-- Finalize booked salon reviews only after the detail decision is written.
-- The existing Pending -> Cut safety trigger intentionally blocks the old
-- RPC's early parent update, because the detail is still Pending at that
-- point. This validated entry point performs the missing second update and
-- then re-fires detail inventory synchronization.

begin;

create or replace function public.staff_review_salon_appointment_hair_required(
  p_appointment_id integer,
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
  v_updates jsonb := coalesce(p_detail_updates, '{}'::jsonb);
  v_decision text := public.normalize_flow_key(p_decision);
  v_length numeric;
  v_submission_id integer;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_result jsonb;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin') then
    raise exception 'Only active staff or admin accounts can review salon appointment hair.';
  end if;

  if jsonb_typeof(v_updates) <> 'object' then
    raise exception 'Hair details must be provided.';
  end if;

  if nullif(trim(coalesce(v_updates ->> 'declaredLength', '')), '') is null then
    raise exception 'Hair length is required.';
  end if;

  begin
    v_length := trim(v_updates ->> 'declaredLength')::numeric;
  exception when invalid_text_representation then
    raise exception 'Hair length must be a number.';
  end;

  if v_length <= 0 or v_length > 999.99 then
    raise exception 'Hair length must be greater than 0 and no more than 999.99 inches.';
  end if;

  if nullif(trim(coalesce(v_updates ->> 'declaredColor', '')), '') is null then
    raise exception 'Hair color is required.';
  end if;
  if nullif(trim(coalesce(v_updates ->> 'declaredTexture', '')), '') is null then
    raise exception 'Hair pattern is required.';
  end if;
  if nullif(trim(coalesce(v_updates ->> 'declaredDensity', '')), '') is null then
    raise exception 'Hair density is required.';
  end if;
  if nullif(trim(coalesce(v_updates ->> 'declaredCondition', '')), '') is null then
    raise exception 'Hair condition is required.';
  end if;

  if trim(v_updates ->> 'declaredColor') not in (
    'Black', 'Dark Brown', 'Brown', 'Light Brown',
    'Blonde', 'Gray', 'Red / Auburn', 'Other'
  ) then
    raise exception 'Select a valid hair color.';
  end if;

  if trim(v_updates ->> 'declaredDensity') not in ('Light', 'Thin', 'Thick') then
    raise exception 'Hair density must be Light, Thin, or Thick.';
  end if;

  select appointment."Hair_Submission_ID"
  into v_submission_id
  from public."Salon_Donation_Appointments" appointment
  where appointment."Appointment_ID" = p_appointment_id;

  perform set_config(
    'strandshare.salon_appointment_transition',
    'appointment_review',
    true
  );

  v_result := public.staff_review_salon_appointment_hair(
    p_appointment_id,
    p_decision,
    p_rejection_reason,
    v_updates || jsonb_build_object('declaredLength', v_length)
  );

  if v_decision = 'approved' then
    -- At this point the detail is already Approved, so the Pending -> Cut
    -- quality gate permits the final parent transition.
    update public."Hair_Submissions"
    set
      "Status" = 'Cut',
      "Cut_At" = coalesce("Cut_At", v_now),
      "Cut_By_User_ID" = coalesce("Cut_By_User_ID", v_actor.user_id),
      "Updated_At" = v_now
    where "Submission_ID" = v_submission_id;

    -- UPDATE OF Status invokes sync_cut_hair_inventory_from_detail after the
    -- parent is Cut, creating the inventory row immediately and idempotently.
    update public."Hair_Submission_Details"
    set
      "Status" = "Status",
      "Updated_At" = v_now
    where "Submission_ID" = v_submission_id
      and public.normalize_flow_key("Status") = 'approved';
  end if;

  return v_result || jsonb_build_object(
    'submission', (
      select to_jsonb(submission)
      from public."Hair_Submissions" submission
      where submission."Submission_ID" = v_submission_id
    ),
    'inventory_added', exists (
      select 1
      from public."Cut_Hair_Inventory" inventory
      where inventory."Submission_ID" = v_submission_id
    )
  );
end;
$fn$;

revoke all on function public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb)
  to authenticated;

revoke execute on function public.staff_review_salon_appointment_hair(integer,text,text,jsonb)
  from authenticated;

comment on function public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb) is
  'Validates booked-appointment hair details, permits direct review without check-in, and creates Cut inventory only for Approved decisions.';

notify pgrst, 'reload schema';

commit;
