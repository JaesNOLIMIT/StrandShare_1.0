begin;

-- AI accuracy compares the immutable AI_Screenings result with the final
-- human-reviewed Hair_Submission_Details values. Hair_Submissions supplies the
-- canonical AI_Screening_ID and the event/non-event relationship only.

create or replace function public.capture_hair_ai_review_baseline()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_submission public."Hair_Submissions"%rowtype;
  v_screening public."AI_Screenings"%rowtype;
  v_submission_id integer := new."Submission_ID";
  v_values jsonb;
  v_is_ai boolean := false;
begin
  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = v_submission_id;

  -- Prefer the immutable screening explicitly selected for the submission.
  -- Submission_ID is retained as a compatibility fallback for older rows.
  select * into v_screening
  from public."AI_Screenings" screening
  where screening."AI_Screening_ID" = v_submission."AI_Screening_ID"
     or screening."Submission_ID" = v_submission_id
  order by
    case when screening."AI_Screening_ID" = v_submission."AI_Screening_ID" then 0 else 1 end,
    screening."Created_At" desc,
    screening."AI_Screening_ID" desc
  limit 1;

  if v_screening."AI_Screening_ID" is not null then
    v_is_ai := true;
    v_values := jsonb_build_object(
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
    v_values := jsonb_build_object(
      'length', new."Declared_Length",
      'color', new."Declared_Color",
      'texture', new."Declared_Texture",
      'density', new."Declared_Density",
      'condition', new."Declared_Condition"
    );
  end if;

  insert into public."Hair_AI_Review_Comparisons" (
    "Submission_Detail_ID",
    "Submission_ID",
    "Event_Request_ID",
    "AI_Values",
    "Is_AI_Source"
  ) values (
    new."Submission_Detail_ID",
    v_submission_id,
    v_submission."Event_Request_ID",
    v_values,
    v_is_ai
  )
  on conflict ("Submission_Detail_ID") do update
  set
    "AI_Values" = excluded."AI_Values",
    "Is_AI_Source" = true,
    "Event_Request_ID" = excluded."Event_Request_ID",
    "Updated_At" = now()
  where public."Hair_AI_Review_Comparisons"."Reviewed_At" is null
    and not public."Hair_AI_Review_Comparisons"."Is_AI_Source"
    and excluded."Is_AI_Source";

  return new;
end;
$fn$;

-- Capture immediately after a detail is created, and re-check immediately
-- before edits in case the AI screening was linked after the detail row.
drop trigger if exists trg_00_capture_hair_ai_review_baseline_insert
  on public."Hair_Submission_Details";
create trigger trg_00_capture_hair_ai_review_baseline_insert
after insert on public."Hair_Submission_Details"
for each row
execute function public.capture_hair_ai_review_baseline();

drop trigger if exists trg_00_capture_hair_ai_review_baseline
  on public."Hair_Submission_Details";
create trigger trg_00_capture_hair_ai_review_baseline
before update on public."Hair_Submission_Details"
for each row
execute function public.capture_hair_ai_review_baseline();

-- The capture trigger sorts before this finalizer for INSERT events, allowing
-- a row created directly in a final state to receive a complete comparison.
drop trigger if exists trg_finalize_hair_ai_review_comparison
  on public."Hair_Submission_Details";
create trigger trg_finalize_hair_ai_review_comparison
after insert or update of "Status" on public."Hair_Submission_Details"
for each row
execute function public.finalize_hair_ai_review_comparison();

-- Restore missing comparison rows from the canonical linked screening.
insert into public."Hair_AI_Review_Comparisons" (
  "Submission_Detail_ID",
  "Submission_ID",
  "Event_Request_ID",
  "AI_Values",
  "Is_AI_Source"
)
select
  detail."Submission_Detail_ID",
  detail."Submission_ID",
  submission."Event_Request_ID",
  jsonb_build_object(
    'length', screening."Estimated_Length",
    'color', screening."Detected_Color",
    'texture', screening."Detected_Texture",
    'density', screening."Detected_Density",
    'condition', screening."Detected_Condition",
    'confidenceScore', screening."Confidence_Score",
    'decision', screening."Decision",
    'summary', screening."Summary",
    'visibleDamageNotes', screening."Visible_Damage_Notes"
  ),
  true
from public."Hair_Submission_Details" detail
join public."Hair_Submissions" submission
  on submission."Submission_ID" = detail."Submission_ID"
join lateral (
  select candidate.*
  from public."AI_Screenings" candidate
  where candidate."AI_Screening_ID" = submission."AI_Screening_ID"
     or candidate."Submission_ID" = submission."Submission_ID"
  order by
    case when candidate."AI_Screening_ID" = submission."AI_Screening_ID" then 0 else 1 end,
    candidate."Created_At" desc,
    candidate."AI_Screening_ID" desc
  limit 1
) screening on true
on conflict ("Submission_Detail_ID") do nothing;

-- Repair rows that were captured before the canonical screening was linked.
-- Existing valid AI baselines remain immutable.
with canonical_screening as (
  select
    detail."Submission_Detail_ID",
    submission."Event_Request_ID",
    jsonb_build_object(
      'length', screening."Estimated_Length",
      'color', screening."Detected_Color",
      'texture', screening."Detected_Texture",
      'density', screening."Detected_Density",
      'condition', screening."Detected_Condition",
      'confidenceScore', screening."Confidence_Score",
      'decision', screening."Decision",
      'summary', screening."Summary",
      'visibleDamageNotes', screening."Visible_Damage_Notes"
    ) as ai_values
  from public."Hair_Submission_Details" detail
  join public."Hair_Submissions" submission
    on submission."Submission_ID" = detail."Submission_ID"
  join lateral (
    select candidate.*
    from public."AI_Screenings" candidate
    where candidate."AI_Screening_ID" = submission."AI_Screening_ID"
       or candidate."Submission_ID" = submission."Submission_ID"
    order by
      case when candidate."AI_Screening_ID" = submission."AI_Screening_ID" then 0 else 1 end,
      candidate."Created_At" desc,
      candidate."AI_Screening_ID" desc
    limit 1
  ) screening on true
)
update public."Hair_AI_Review_Comparisons" comparison
set
  "AI_Values" = canonical.ai_values,
  "Is_AI_Source" = true,
  "Event_Request_ID" = canonical."Event_Request_ID",
  "Updated_At" = now()
from canonical_screening canonical
where comparison."Submission_Detail_ID" = canonical."Submission_Detail_ID"
  and (
    not comparison."Is_AI_Source"
    or (
      nullif(comparison."AI_Values" ->> 'length', '') is null
      and nullif(comparison."AI_Values" ->> 'color', '') is null
      and nullif(comparison."AI_Values" ->> 'texture', '') is null
      and nullif(comparison."AI_Values" ->> 'density', '') is null
      and nullif(comparison."AI_Values" ->> 'condition', '') is null
    )
  );

-- Recalculate every finalized AI comparison against the final human values.
with recalculated as (
  select
    comparison."Comparison_ID",
    detail."Updated_By" as reviewed_by,
    detail."Updated_At" as reviewed_at,
    public.normalize_flow_key(detail."Status") as detail_status,
    jsonb_build_object(
      'length', detail."Declared_Length",
      'color', detail."Declared_Color",
      'texture', detail."Declared_Texture",
      'density', detail."Declared_Density",
      'condition', detail."Declared_Condition",
      'chemicallyTreated', coalesce(detail."Is_Chemically_Treated", false),
      'colored', coalesce(detail."Is_Colored", false),
      'bleached', coalesce(detail."Is_Bleached", false),
      'rebonded', coalesce(detail."Is_Rebonded", false)
    ) as staff_values,
    values_calc.comparable_count,
    values_calc.matched_count,
    values_calc.changed_fields
  from public."Hair_AI_Review_Comparisons" comparison
  join public."Hair_Submission_Details" detail
    on detail."Submission_Detail_ID" = comparison."Submission_Detail_ID"
  cross join lateral (
    select
      count(*) filter (where field.ai_value is not null)::integer as comparable_count,
      count(*) filter (where field.ai_value is not null and field.is_match)::integer as matched_count,
      coalesce(
        array_agg(field.field_name order by field.ordinality)
          filter (where field.ai_value is not null and not field.is_match),
        '{}'
      )::text[] as changed_fields
    from (
      select
        source.field_name,
        source.ai_value,
        source.staff_value,
        source.ordinality,
        case
          when source.field_name = 'length' then
            coalesce(
              source.staff_value is not null
              and source.ai_value::numeric = source.staff_value::numeric,
              false
            )
          else lower(trim(source.ai_value)) is not distinct from lower(trim(source.staff_value))
        end as is_match
      from (values
        ('length', nullif(comparison."AI_Values" ->> 'length', ''), nullif(detail."Declared_Length"::text, ''), 1),
        ('color', nullif(comparison."AI_Values" ->> 'color', ''), nullif(detail."Declared_Color"::text, ''), 2),
        ('texture', nullif(comparison."AI_Values" ->> 'texture', ''), nullif(detail."Declared_Texture"::text, ''), 3),
        ('density', nullif(comparison."AI_Values" ->> 'density', ''), nullif(detail."Declared_Density"::text, ''), 4),
        ('condition', nullif(comparison."AI_Values" ->> 'condition', ''), nullif(detail."Declared_Condition"::text, ''), 5)
      ) source(field_name, ai_value, staff_value, ordinality)
    ) field
  ) values_calc
  where comparison."Is_AI_Source"
    and public.is_hair_detail_final_status(detail."Status")
)
update public."Hair_AI_Review_Comparisons" comparison
set
  "Staff_Values" = recalculated.staff_values,
  "Changed_Fields" = recalculated.changed_fields,
  "Critical_Changed_Fields" = array(
    select changed.field_name
    from unnest(recalculated.changed_fields) as changed(field_name)
    where changed.field_name in ('color', 'condition')
  ),
  "Minor_Changed_Fields" = array(
    select changed.field_name
    from unnest(recalculated.changed_fields) as changed(field_name)
    where changed.field_name in ('length', 'texture', 'density')
  ),
  "Comparable_Field_Count" = recalculated.comparable_count,
  "Matched_Field_Count" = recalculated.matched_count,
  "AI_Accuracy_Percent" = case
    when recalculated.comparable_count > 0 then
      round(
        recalculated.matched_count::numeric
        / recalculated.comparable_count::numeric * 100,
        2
      )
    else null
  end,
  "Length_Difference_Inches" = case
    when nullif(comparison."AI_Values" ->> 'length', '') is not null
      and nullif(recalculated.staff_values ->> 'length', '') is not null
    then abs(
      (comparison."AI_Values" ->> 'length')::numeric
      - (recalculated.staff_values ->> 'length')::numeric
    )
    else null
  end,
  "Length_Within_Tolerance" = case
    when nullif(comparison."AI_Values" ->> 'length', '') is not null
      and nullif(recalculated.staff_values ->> 'length', '') is not null
    then (comparison."AI_Values" ->> 'length')::numeric
      = (recalculated.staff_values ->> 'length')::numeric
    else null
  end,
  "Final_Decision" = case
    when recalculated.detail_status = 'approved' then 'Approved'
    when recalculated.detail_status = 'rejectedcut' then 'Rejected Cut'
    else 'Rejected'
  end,
  "Reviewed_By_User_ID" = coalesce(comparison."Reviewed_By_User_ID", recalculated.reviewed_by),
  "Reviewed_At" = coalesce(
    comparison."Reviewed_At",
    recalculated.reviewed_at at time zone 'Asia/Manila',
    now()
  ),
  "Updated_At" = now()
from recalculated
where comparison."Comparison_ID" = recalculated."Comparison_ID";

comment on function public.capture_hair_ai_review_baseline()
  is 'Freezes the linked AI_Screenings result before human review and upgrades an unreviewed manual placeholder when its AI link arrives.';

notify pgrst, 'reload schema';
commit;
