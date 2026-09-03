begin;

-- Correct deployments that received the earlier review-level 0/100 rule.
-- Accuracy is field-weighted: matched fields / comparable fields.
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
  if not public.is_hair_detail_final_status(new."Status") then return new; end if;

  select * into v_row
  from public."Hair_AI_Review_Comparisons" comparison
  where comparison."Submission_Detail_ID" = new."Submission_Detail_ID"
  for update;

  if v_row."Comparison_ID" is null or v_row."Reviewed_At" is not null then return new; end if;

  v_staff := jsonb_build_object(
    'length', new."Declared_Length", 'color', new."Declared_Color",
    'texture', new."Declared_Texture", 'density', new."Declared_Density",
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
  set "Staff_Values" = v_staff,
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

-- Rebuild counters and changed-field lists for every completed review from the
-- immutable AI baseline and stored final staff values. This repairs rows that
-- previously stayed at 100% after a staff color or other field correction.
with recalculated as (
  select comparison."Comparison_ID",
    values_calc.comparable_count,
    values_calc.matched_count,
    values_calc.changed_fields,
    array(select changed.field_name from unnest(values_calc.changed_fields) as changed(field_name) where changed.field_name in ('color', 'condition')) as critical_fields,
    array(select changed.field_name from unnest(values_calc.changed_fields) as changed(field_name) where changed.field_name in ('length', 'texture', 'density')) as minor_fields
  from public."Hair_AI_Review_Comparisons" comparison
  cross join lateral (
    select
      count(*) filter (where item.ai_value is not null)::integer as comparable_count,
      count(*) filter (where item.ai_value is not null and item.is_match)::integer as matched_count,
      coalesce(array_agg(item.field_name order by item.ordinality)
        filter (where item.ai_value is not null and not item.is_match), '{}')::text[] as changed_fields
    from (
      select field_name, ai_value, staff_value, ordinality,
        case when field_name = 'length'
          then coalesce(nullif(staff_value, '') is not null and ai_value::numeric = staff_value::numeric, false)
          else lower(trim(ai_value)) is not distinct from lower(trim(staff_value))
        end as is_match
      from (values
        ('length', nullif(comparison."AI_Values" ->> 'length', ''), nullif(comparison."Staff_Values" ->> 'length', ''), 1),
        ('color', nullif(comparison."AI_Values" ->> 'color', ''), nullif(comparison."Staff_Values" ->> 'color', ''), 2),
        ('texture', nullif(comparison."AI_Values" ->> 'texture', ''), nullif(comparison."Staff_Values" ->> 'texture', ''), 3),
        ('density', nullif(comparison."AI_Values" ->> 'density', ''), nullif(comparison."Staff_Values" ->> 'density', ''), 4),
        ('condition', nullif(comparison."AI_Values" ->> 'condition', ''), nullif(comparison."Staff_Values" ->> 'condition', ''), 5)
      ) fields(field_name, ai_value, staff_value, ordinality)
    ) item
  ) values_calc
  where comparison."Reviewed_At" is not null
    and comparison."Is_AI_Source" = true
    and comparison."Staff_Values" is not null
)
update public."Hair_AI_Review_Comparisons" comparison
set "Comparable_Field_Count" = recalculated.comparable_count,
    "Matched_Field_Count" = recalculated.matched_count,
    "Changed_Fields" = recalculated.changed_fields,
    "Critical_Changed_Fields" = recalculated.critical_fields,
    "Minor_Changed_Fields" = recalculated.minor_fields,
    "AI_Accuracy_Percent" = case when recalculated.comparable_count > 0
      then round((recalculated.matched_count::numeric / recalculated.comparable_count::numeric) * 100, 2)
      else null end,
    "Updated_At" = now()
from recalculated
where comparison."Comparison_ID" = recalculated."Comparison_ID";

-- Return the stored counters so report clients do not recalculate against a
-- newer AI_Screenings row and accidentally show 100% again.
drop function if exists public.get_hair_ai_accuracy_report();
create function public.get_hair_ai_accuracy_report()
returns table (
  comparison_id bigint,
  submission_id integer,
  event_request_id integer,
  event_name text,
  final_decision text,
  reviewed_at timestamp with time zone,
  staff_values jsonb,
  changed_fields text[],
  comparable_field_count integer,
  matched_field_count integer,
  ai_accuracy_percent numeric,
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
  select * into v_actor from public.users actor where actor.auth_user_id = auth.uid() limit 1;
  if v_actor.user_id is null then raise exception 'Unable to resolve authenticated user.'; end if;
  v_role_key := public.normalize_app_role(v_actor.role);
  if v_role_key not in ('staff', 'admin', 'superadmin', 'specialist') then
    raise exception 'Only staff/admin/specialist can view AI accuracy reports.';
  end if;

  return query
  select comparison."Comparison_ID", comparison."Submission_ID", comparison."Event_Request_ID",
    coalesce(event_request."Event_Name"::text, format('Event #%s', comparison."Event_Request_ID")),
    comparison."Final_Decision"::text, comparison."Reviewed_At", comparison."Staff_Values",
    comparison."Changed_Fields", comparison."Comparable_Field_Count", comparison."Matched_Field_Count",
    comparison."AI_Accuracy_Percent",
    jsonb_build_object(
      'Estimated_Length', comparison."AI_Values" -> 'length',
      'Detected_Color', comparison."AI_Values" -> 'color',
      'Detected_Texture', comparison."AI_Values" -> 'texture',
      'Detected_Density', comparison."AI_Values" -> 'density',
      'Detected_Condition', comparison."AI_Values" -> 'condition',
      'Confidence_Score', comparison."AI_Values" -> 'confidenceScore',
      'Decision', comparison."AI_Values" -> 'decision',
      'Summary', comparison."AI_Values" -> 'summary',
      'Visible_Damage_Notes', comparison."AI_Values" -> 'visibleDamageNotes'
    ) as ai_screening
  from public."Hair_AI_Review_Comparisons" comparison
  left join public."Event_Requests" event_request
    on event_request."Event_Request_ID" = comparison."Event_Request_ID"
  where comparison."Is_AI_Source" = true
    and comparison."Reviewed_At" is not null
    and (
      v_role_key in ('admin', 'superadmin', 'specialist')
      or (v_role_key = 'staff' and event_request."Assigned_Staff_User_ID" = v_actor.user_id)
    )
  order by comparison."Reviewed_At" desc, comparison."Comparison_ID" desc;
end;
$fn$;

revoke all on function public.get_hair_ai_accuracy_report() from public, anon;
grant execute on function public.get_hair_ai_accuracy_report() to authenticated;

comment on function public.finalize_hair_ai_review_comparison()
  is 'Calculates field-weighted AI accuracy: matched comparable fields divided by all comparable fields.';

notify pgrst, 'reload schema';
commit;
