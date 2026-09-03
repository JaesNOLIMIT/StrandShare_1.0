begin;

-- Freeze the latest AI screening the first time staff edits a detail row.
-- Later edits must never replace the original comparison baseline.
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
  if exists (
    select 1 from public."Hair_AI_Review_Comparisons" comparison
    where comparison."Submission_Detail_ID" = old."Submission_Detail_ID"
  ) then
    return new;
  end if;

  select submission."Event_Request_ID"
  into v_event_request_id
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = old."Submission_ID";

  select * into v_screening
  from public."AI_Screenings" screening
  where screening."Submission_ID" = old."Submission_ID"
  order by screening."Created_At" desc, screening."AI_Screening_ID" desc
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
    "Submission_Detail_ID", "Submission_ID", "Event_Request_ID",
    "AI_Values", "Is_AI_Source"
  ) values (
    old."Submission_Detail_ID", old."Submission_ID", v_event_request_id,
    v_ai_values, v_is_ai_source
  )
  on conflict ("Submission_Detail_ID") do nothing;

  return new;
end;
$fn$;

-- Each comparable field contributes an equal share of 100%. One changed field
-- out of five therefore reports 80% AI Correct / 20% Human Changes.
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

-- Recalculate already-finalized comparisons from their stored field counters.
update public."Hair_AI_Review_Comparisons"
set
  "AI_Accuracy_Percent" = case
    when "Is_AI_Source" and "Comparable_Field_Count" > 0
      then round(("Matched_Field_Count"::numeric / "Comparable_Field_Count"::numeric) * 100, 2)
    else null
  end,
  "Updated_At" = now()
where "Reviewed_At" is not null;

comment on function public.capture_hair_ai_review_baseline()
  is 'Freezes the latest AI screening once, before the first staff edit.';
comment on function public.finalize_hair_ai_review_comparison()
  is 'Calculates field-weighted AI Correct and Human Changes percentages across length, color, texture, density, and condition.';

notify pgrst, 'reload schema';
commit;
