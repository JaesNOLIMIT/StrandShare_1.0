-- Use AI_Screenings as the canonical AI baseline for event hair review and
-- accuracy reporting. Hair_Submission_Details remains the staff-reviewed copy.

begin;

create or replace function public.get_event_hair_ai_screening(
  p_event_request_id integer,
  p_submission_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor public.users%rowtype;
  v_role_key text;
  v_result jsonb;
begin
  if p_event_request_id is null or p_submission_id is null then
    raise exception 'Event_Request_ID and Submission_ID are required.';
  end if;

  select * into v_actor
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_actor.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role_key := public.normalize_app_role(v_actor.role);
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can view event AI hair screening.';
  end if;

  if v_role_key = 'staff' and not exists (
    select 1
    from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_actor.user_id
  ) then
    raise exception 'You are not assigned to this event.';
  end if;

  if not exists (
    select 1
    from public."Hair_Submissions" hs
    where hs."Submission_ID" = p_submission_id
      and hs."Event_Request_ID" = p_event_request_id
  ) then
    raise exception 'Submission is not linked to the selected event.';
  end if;

  select to_jsonb(screening)
  into v_result
  from public."AI_Screenings" screening
  where screening."Submission_ID" = p_submission_id
  order by screening."Created_At" desc, screening."AI_Screening_ID" desc
  limit 1;

  return v_result;
end;
$fn$;

revoke all on function public.get_event_hair_ai_screening(integer, integer)
  from public, anon;
grant execute on function public.get_event_hair_ai_screening(integer, integer)
  to authenticated;

comment on function public.get_event_hair_ai_screening(integer, integer)
  is 'Returns the latest AI screening for an authorized assigned-event hair review.';

create or replace function public.get_hair_ai_accuracy_report()
returns table (
  comparison_id bigint,
  submission_id integer,
  event_request_id integer,
  event_name text,
  final_decision text,
  reviewed_at timestamp with time zone,
  staff_values jsonb,
  changed_fields text[],
  ai_screening jsonb
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
  if v_role_key not in ('staff', 'admin', 'specialist') then
    raise exception 'Only staff/admin/specialist can view AI accuracy reports.';
  end if;

  return query
  select
    comparison."Comparison_ID",
    comparison."Submission_ID",
    comparison."Event_Request_ID",
    coalesce(event_request."Event_Name"::text, format('Event #%s', comparison."Event_Request_ID")) as event_name,
    comparison."Final_Decision"::text,
    comparison."Reviewed_At",
    comparison."Staff_Values",
    comparison."Changed_Fields",
    to_jsonb(screening) as ai_screening
  from public."Hair_AI_Review_Comparisons" comparison
  join public."Hair_Submissions" submission
    on submission."Submission_ID" = comparison."Submission_ID"
  join lateral (
    select ai.*
    from public."AI_Screenings" ai
    where ai."Submission_ID" = comparison."Submission_ID"
    order by ai."Created_At" desc, ai."AI_Screening_ID" desc
    limit 1
  ) screening on true
  left join public."Event_Requests" event_request
    on event_request."Event_Request_ID" = comparison."Event_Request_ID"
  where comparison."Reviewed_At" is not null
    and (
      v_role_key in ('admin', 'specialist')
      or (
        v_role_key = 'staff'
        and event_request."Assigned_Staff_User_ID" = v_actor.user_id
      )
    )
  order by comparison."Reviewed_At" desc, comparison."Comparison_ID" desc;
end;
$fn$;

revoke all on function public.get_hair_ai_accuracy_report()
  from public, anon;
grant execute on function public.get_hair_ai_accuracy_report()
  to authenticated;

comment on function public.get_hair_ai_accuracy_report()
  is 'Authorized reviewed AI screening rows with the final staff values for accuracy reporting.';

create or replace function public.capture_hair_ai_review_baseline()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_event_request_id integer;
  v_screening public."AI_Screenings"%rowtype;
  v_ai_values jsonb;
  v_is_ai_source boolean := false;
begin
  select hs."Event_Request_ID"
  into v_event_request_id
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = old."Submission_ID";

  select * into v_screening
  from public."AI_Screenings" ai
  where ai."Submission_ID" = old."Submission_ID"
  order by ai."Created_At" desc, ai."AI_Screening_ID" desc
  limit 1;

  if v_screening."AI_Screening_ID" is not null then
    v_is_ai_source := true;
    v_ai_values := jsonb_build_object(
      'length', v_screening."Estimated_Length",
      'color', v_screening."Detected_Color",
      'texture', v_screening."Detected_Texture",
      'density', v_screening."Detected_Density",
      'condition', v_screening."Detected_Condition",
      'confidenceScore', v_screening."Confidence_Score",
      'decision', v_screening."Decision",
      'summary', v_screening."Summary",
      'visibleDamageNotes', v_screening."Visible_Damage_Notes"
    );
  else
    v_ai_values := jsonb_build_object(
      'length', old."Declared_Length",
      'color', old."Declared_Color",
      'texture', old."Declared_Texture",
      'density', old."Declared_Density",
      'condition', old."Declared_Condition"
    );
  end if;

  insert into public."Hair_AI_Review_Comparisons" (
    "Submission_Detail_ID",
    "Submission_ID",
    "Event_Request_ID",
    "AI_Values",
    "Is_AI_Source"
  ) values (
    old."Submission_Detail_ID",
    old."Submission_ID",
    v_event_request_id,
    v_ai_values,
    v_is_ai_source
  )
  on conflict ("Submission_Detail_ID") do update
  set
    "AI_Values" = excluded."AI_Values",
    "Is_AI_Source" = excluded."Is_AI_Source",
    "Event_Request_ID" = excluded."Event_Request_ID",
    "Updated_At" = now()
  where public."Hair_AI_Review_Comparisons"."Reviewed_At" is null;

  return new;
end;
$fn$;

create or replace function public.finalize_hair_ai_review_comparison()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public."Hair_AI_Review_Comparisons"%rowtype;
  v_staff jsonb;
  v_changed text[] := '{}';
  v_critical text[] := '{}';
  v_minor text[] := '{}';
  v_comparable integer := 0;
  v_matched integer := 0;
  v_ai_text text;
  v_staff_text text;
  v_ai_length numeric;
  v_staff_length numeric;
  v_length_diff numeric;
  v_length_ok boolean;
  v_field text;
begin
  if not public.is_hair_detail_final_status(new."Status") then
    return new;
  end if;

  select * into v_row
  from public."Hair_AI_Review_Comparisons" comparison
  where comparison."Submission_Detail_ID" = new."Submission_Detail_ID"
  for update;

  if v_row."Comparison_ID" is null or v_row."Reviewed_At" is not null then
    return new;
  end if;

  v_staff := jsonb_build_object(
    'length', new."Declared_Length",
    'color', new."Declared_Color",
    'texture', new."Declared_Texture",
    'density', new."Declared_Density",
    'condition', new."Declared_Condition",
    'chemicallyTreated', coalesce(new."Is_Chemically_Treated", false),
    'colored', coalesce(new."Is_Colored", false),
    'bleached', coalesce(new."Is_Bleached", false),
    'rebonded', coalesce(new."Is_Rebonded", false)
  );

  if nullif(v_row."AI_Values" ->> 'length', '') is not null then
    v_comparable := v_comparable + 1;
    v_ai_length := (v_row."AI_Values" ->> 'length')::numeric;
    v_staff_length := new."Declared_Length";
    if v_staff_length is not null then
      v_length_diff := abs(v_ai_length - v_staff_length);
      v_length_ok := v_length_diff = 0;
      if v_length_ok then
        v_matched := v_matched + 1;
      else
        v_changed := array_append(v_changed, 'length');
        v_minor := array_append(v_minor, 'length');
      end if;
    else
      v_length_ok := false;
      v_changed := array_append(v_changed, 'length');
      v_minor := array_append(v_minor, 'length');
    end if;
  end if;

  foreach v_field in array array['color', 'condition', 'texture', 'density'] loop
    v_ai_text := nullif(lower(trim(coalesce(v_row."AI_Values" ->> v_field, ''))), '');
    v_staff_text := nullif(lower(trim(coalesce(v_staff ->> v_field, ''))), '');
    if v_ai_text is not null then
      v_comparable := v_comparable + 1;
      if v_ai_text is not distinct from v_staff_text then
        v_matched := v_matched + 1;
      else
        v_changed := array_append(v_changed, v_field);
        if v_field in ('color', 'condition') then
          v_critical := array_append(v_critical, v_field);
        else
          v_minor := array_append(v_minor, v_field);
        end if;
      end if;
    end if;
  end loop;

  update public."Hair_AI_Review_Comparisons"
  set
    "Staff_Values" = v_staff,
    "Changed_Fields" = v_changed,
    "Critical_Changed_Fields" = v_critical,
    "Minor_Changed_Fields" = v_minor,
    "Comparable_Field_Count" = v_comparable,
    "Matched_Field_Count" = v_matched,
    "AI_Accuracy_Percent" = case
      when v_row."Is_AI_Source" and v_comparable > 0
        then round((v_matched::numeric / v_comparable::numeric) * 100, 2)
      else null
    end,
    "Length_Difference_Inches" = v_length_diff,
    "Length_Within_Tolerance" = v_length_ok,
    "Final_Decision" = case
      when public.normalize_flow_key(new."Status") = 'approved' then 'Approved'
      when public.normalize_flow_key(new."Status") = 'rejectedcut' then 'Rejected Cut'
      else 'Rejected'
    end,
    "Reviewed_By_User_ID" = new."Updated_By",
    "Reviewed_At" = coalesce(new."Updated_At" at time zone 'Asia/Manila', now()),
    "Updated_At" = now()
  where "Comparison_ID" = v_row."Comparison_ID";

  return new;
end;
$fn$;

drop trigger if exists trg_00_capture_hair_ai_review_baseline
  on public."Hair_Submission_Details";
create trigger trg_00_capture_hair_ai_review_baseline
before update on public."Hair_Submission_Details"
for each row
execute function public.capture_hair_ai_review_baseline();

drop trigger if exists trg_finalize_hair_ai_review_comparison
  on public."Hair_Submission_Details";
create trigger trg_finalize_hair_ai_review_comparison
after update of "Status" on public."Hair_Submission_Details"
for each row
execute function public.finalize_hair_ai_review_comparison();

comment on function public.capture_hair_ai_review_baseline()
  is 'Captures the latest AI_Screenings values as an immutable baseline before staff edits.';
comment on function public.finalize_hair_ai_review_comparison()
  is 'Calculates exact AI-vs-staff accuracy for length, color, texture, density, and condition.';

commit;
