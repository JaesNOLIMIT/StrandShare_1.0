begin;

drop function if exists public.specialist_review_non_event_hair_quality(integer, text, text);

create function public.specialist_review_non_event_hair_quality(
  p_submission_id integer,
  p_decision text,
  p_rejection_reason text default null,
  p_detail_updates jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_submission public."Hair_Submissions"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_decision_key text := public.normalize_flow_key(p_decision);
  v_reason text := nullif(trim(coalesce(p_rejection_reason, '')), '');
  v_updates jsonb := coalesce(p_detail_updates, '{}'::jsonb);
  v_declared_length numeric;
  v_details jsonb := '[]'::jsonb;
begin
  if p_submission_id is null then
    raise exception 'Submission_ID is required.';
  end if;

  if v_decision_key not in ('approved', 'rejected') then
    raise exception 'Decision must be Approved or Rejected.';
  end if;

  if v_decision_key = 'rejected' and v_reason is null then
    raise exception 'Rejection reason is required when decision is Rejected.';
  end if;

  if jsonb_typeof(v_updates) <> 'object' then
    raise exception 'Detail updates must be a JSON object.';
  end if;

  if v_updates ? 'declaredLength'
    and nullif(trim(coalesce(v_updates->>'declaredLength', '')), '') is not null
  then
    begin
      v_declared_length := (v_updates->>'declaredLength')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Declared length must be numeric.';
    end;

    if v_declared_length < 0 or v_declared_length > 999.99 then
      raise exception 'Declared length must be between 0 and 999.99 inches.';
    end if;
  end if;

  select *
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('specialist', 'admin') then
    raise exception 'Only specialist/admin can review non-event hair quality.';
  end if;

  select *
  into v_submission
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = p_submission_id
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'Submission % was not found.', p_submission_id;
  end if;

  if coalesce(v_submission."From_Event", true) then
    raise exception 'Submission % is event-based and cannot be reviewed on this page.', p_submission_id;
  end if;

  if v_submission."Bundle_ID" is not null then
    raise exception 'Submission % is already assigned to a bundle and can no longer be reviewed.', p_submission_id;
  end if;

  if public.normalize_flow_key(v_submission."Status") <> 'pending' then
    raise exception 'Only Pending non-event submissions can be reviewed here. Current status: %.',
      coalesce(v_submission."Status", 'N/A');
  end if;

  insert into public."Hair_Submission_Details" (
    "Submission_ID",
    "Created_At",
    "Status",
    "Updated_By",
    "Updated_At"
  )
  values (
    v_submission."Submission_ID",
    v_now,
    'Pending',
    v_user.user_id,
    v_now
  )
  on conflict ("Submission_ID") do nothing;

  update public."Hair_Submission_Details"
  set
    "Declared_Length" = case
      when v_updates ? 'declaredLength'
        then nullif(trim(coalesce(v_updates->>'declaredLength', '')), '')::numeric
      else "Declared_Length"
    end,
    "Declared_Color" = case
      when v_updates ? 'declaredColor'
        then nullif(trim(coalesce(v_updates->>'declaredColor', '')), '')
      else "Declared_Color"
    end,
    "Declared_Texture" = case
      when v_updates ? 'declaredTexture'
        then nullif(trim(coalesce(v_updates->>'declaredTexture', '')), '')
      else "Declared_Texture"
    end,
    "Declared_Density" = case
      when v_updates ? 'declaredDensity'
        then nullif(trim(coalesce(v_updates->>'declaredDensity', '')), '')
      else "Declared_Density"
    end,
    "Declared_Condition" = case
      when v_updates ? 'declaredCondition'
        then nullif(trim(coalesce(v_updates->>'declaredCondition', '')), '')
      else "Declared_Condition"
    end,
    "Is_Chemically_Treated" = case
      when v_updates ? 'isChemicallyTreated'
        then coalesce((v_updates->>'isChemicallyTreated')::boolean, false)
      else "Is_Chemically_Treated"
    end,
    "Is_Colored" = case
      when v_updates ? 'isColored'
        then coalesce((v_updates->>'isColored')::boolean, false)
      else "Is_Colored"
    end,
    "Is_Bleached" = case
      when v_updates ? 'isBleached'
        then coalesce((v_updates->>'isBleached')::boolean, false)
      else "Is_Bleached"
    end,
    "Is_Rebonded" = case
      when v_updates ? 'isRebonded'
        then coalesce((v_updates->>'isRebonded')::boolean, false)
      else "Is_Rebonded"
    end,
    "Detail_Notes" = case
      when v_updates ? 'detailNotes'
        then nullif(trim(coalesce(v_updates->>'detailNotes', '')), '')
      else "Detail_Notes"
    end,
    "Updated_By" = v_user.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID";

  if v_decision_key = 'approved' then
    update public."Hair_Submissions"
    set
      "Status" = 'Cut',
      "Cut_At" = coalesce("Cut_At", v_now),
      "Cut_By_User_ID" = coalesce("Cut_By_User_ID", v_user.user_id),
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID"
    returning * into v_submission;

    update public."Hair_Submission_Details"
    set
      "Status" = 'Approved',
      "Rejection_Reason" = null,
      "Updated_By" = v_user.user_id,
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID";
  else
    update public."Hair_Submissions"
    set
      "Status" = 'Cancelled',
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID"
    returning * into v_submission;

    update public."Hair_Submission_Details"
    set
      "Status" = 'Rejected',
      "Rejection_Reason" = v_reason,
      "Updated_By" = v_user.user_id,
      "Updated_At" = v_now
    where "Submission_ID" = v_submission."Submission_ID";
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(hsd) order by hsd."Submission_Detail_ID"),
    '[]'::jsonb
  )
  into v_details
  from public."Hair_Submission_Details" hsd
  where hsd."Submission_ID" = v_submission."Submission_ID";

  insert into public.audit_logs (
    user_id,
    action,
    description,
    user_email,
    resource,
    status,
    "time"
  )
  values (
    v_user.user_id,
    'hair_submissions.specialist_non_event_quality_review',
    format(
      'submission_id=%s decision=%s resulting_status=%s details_updated=true reason=%s',
      v_submission."Submission_ID",
      case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
      coalesce(v_submission."Status", 'N/A'),
      coalesce(v_reason, 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success',
    v_now
  );

  return jsonb_build_object(
    'decision', case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
    'submission', to_jsonb(v_submission),
    'details', v_details
  );
end;
$fn$;

grant execute on function public.specialist_review_non_event_hair_quality(
  integer,
  text,
  text,
  jsonb
) to authenticated;

comment on function public.specialist_review_non_event_hair_quality(integer, text, text, jsonb)
  is 'Atomically saves specialist-edited non-event hair details and approves or rejects the submission.';

commit;
