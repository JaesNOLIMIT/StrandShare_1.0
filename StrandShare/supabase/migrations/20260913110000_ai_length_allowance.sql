begin;

-- Image-based hair length is an estimate. Differences up to four inches are
-- accepted without modifying the immutable AI value recorded at screening.
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
    'rebonded', coalesce(new."Is_Rebonded", false),
    'notes', new."Detail_Notes"
  );

  if nullif(v_row."AI_Values" ->> 'length', '') is not null then
    v_comparable := v_comparable + 1;
    v_ai_length := (v_row."AI_Values" ->> 'length')::numeric;
    v_staff_length := new."Declared_Length";
    if v_staff_length is not null then
      v_length_diff := abs(v_ai_length - v_staff_length);
      v_length_ok := v_length_diff <= 4;
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
      "AI_Accuracy_Percent" = case when v_row."Is_AI_Source" and v_comparable > 0
        then round((v_matched::numeric / v_comparable::numeric) * 100, 2) else null end,
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

-- Recalculate completed comparisons so historical reports use the same rule.
with recalculated as (
  select comparison."Comparison_ID",
    values_calc.comparable_count,
    values_calc.matched_count,
    values_calc.changed_fields,
    array(select item from unnest(values_calc.changed_fields) item where item in ('color', 'condition')) as critical_fields,
    array(select item from unnest(values_calc.changed_fields) item where item in ('length', 'texture', 'density')) as minor_fields,
    case
      when nullif(comparison."AI_Values" ->> 'length', '') is not null
       and nullif(comparison."Staff_Values" ->> 'length', '') is not null
      then abs((comparison."AI_Values" ->> 'length')::numeric - (comparison."Staff_Values" ->> 'length')::numeric)
      else null
    end as length_difference
  from public."Hair_AI_Review_Comparisons" comparison
  cross join lateral (
    select
      count(*) filter (where field.ai_value is not null)::integer as comparable_count,
      count(*) filter (where field.ai_value is not null and field.is_match)::integer as matched_count,
      coalesce(array_agg(field.field_name order by field.ordinality)
        filter (where field.ai_value is not null and not field.is_match), '{}')::text[] as changed_fields
    from (
      select source.field_name, source.ai_value, source.staff_value, source.ordinality,
        case when source.field_name = 'length'
          then coalesce(source.staff_value is not null and abs(source.ai_value::numeric - source.staff_value::numeric) <= 4, false)
          else lower(trim(source.ai_value)) is not distinct from lower(trim(source.staff_value))
        end as is_match
      from (values
        ('length', nullif(comparison."AI_Values" ->> 'length', ''), nullif(comparison."Staff_Values" ->> 'length', ''), 1),
        ('color', nullif(comparison."AI_Values" ->> 'color', ''), nullif(comparison."Staff_Values" ->> 'color', ''), 2),
        ('texture', nullif(comparison."AI_Values" ->> 'texture', ''), nullif(comparison."Staff_Values" ->> 'texture', ''), 3),
        ('density', nullif(comparison."AI_Values" ->> 'density', ''), nullif(comparison."Staff_Values" ->> 'density', ''), 4),
        ('condition', nullif(comparison."AI_Values" ->> 'condition', ''), nullif(comparison."Staff_Values" ->> 'condition', ''), 5)
      ) source(field_name, ai_value, staff_value, ordinality)
    ) field
  ) values_calc
  where comparison."Reviewed_At" is not null and comparison."Is_AI_Source" = true
)
update public."Hair_AI_Review_Comparisons" comparison
set "Comparable_Field_Count" = recalculated.comparable_count,
    "Matched_Field_Count" = recalculated.matched_count,
    "Changed_Fields" = recalculated.changed_fields,
    "Critical_Changed_Fields" = recalculated.critical_fields,
    "Minor_Changed_Fields" = recalculated.minor_fields,
    "AI_Accuracy_Percent" = case when recalculated.comparable_count > 0
      then round(recalculated.matched_count::numeric / recalculated.comparable_count::numeric * 100, 2) else null end,
    "Length_Difference_Inches" = recalculated.length_difference,
    "Length_Within_Tolerance" = case when recalculated.length_difference is null then null else recalculated.length_difference <= 4 end,
    "Updated_At" = now()
from recalculated
where comparison."Comparison_ID" = recalculated."Comparison_ID";

comment on function public.finalize_hair_ai_review_comparison() is
  'Finalizes immutable AI versus Staff comparisons with a four-inch photo-length estimation allowance.';

notify pgrst, 'reload schema';
commit;
