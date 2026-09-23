begin;

-- The previously deployed capture function referenced the removed
-- Hair_Submission_Details.Input_Method column and OLD during INSERT. Use only
-- current columns, preserve the registered-donor AI baseline behavior, and do
-- not create AI comparison rows for manual public walk-ins.
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

  if v_submission."Submission_ID" is null then
    return new;
  end if;
  if v_submission."Is_Walk_In" is true then
    return new;
  end if;

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

-- Reassert the expected trigger events so databases that received an older
-- variant use NEW safely on both INSERT and UPDATE.
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

notify pgrst, 'reload schema';
commit;
