-- Require a complete physical assessment before any booked salon hair review
-- can be finalized. Keep the original review RPC private behind this validated
-- entry point so the browser-side checks cannot be bypassed.

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
  v_length numeric;
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

  return public.staff_review_salon_appointment_hair(
    p_appointment_id,
    p_decision,
    p_rejection_reason,
    v_updates || jsonb_build_object('declaredLength', v_length)
  );
end;
$fn$;

revoke all on function public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb)
  to authenticated;

-- All staff clients must use the validated entry point above.
revoke execute on function public.staff_review_salon_appointment_hair(integer,text,text,jsonb)
  from authenticated;

comment on function public.staff_review_salon_appointment_hair_required(integer,text,text,jsonb) is
  'Validates all required booked-appointment hair assessment fields before final review and inventory synchronization.';

notify pgrst, 'reload schema';

commit;
