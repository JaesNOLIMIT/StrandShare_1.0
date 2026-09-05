begin;

-- Follow-up for databases where 20260905100000 was already applied before
-- received non-event hair was restored to the Pending quality-review state.
create or replace function public.keep_received_submission_pending_until_quality()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if coalesce(new."From_Event", false) = false
    and public.normalize_flow_key(old."Status") = 'pending'
    and public.normalize_flow_key(new."Status") = 'cut'
    and public.is_hair_submission_physically_received(new."Submission_ID")
    and not exists (
      select 1 from public."Hair_Submission_Details" detail
      where detail."Submission_ID" = new."Submission_ID"
        and public.normalize_flow_key(detail."Status") in ('approved','rejected','rejectedcut')
    )
  then
    new."Status" := 'Pending';
    new."Cut_At" := null;
    new."Cut_By_User_ID" := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_keep_received_submission_pending_until_quality on public."Hair_Submissions";
create trigger trg_keep_received_submission_pending_until_quality
before update of "Status" on public."Hair_Submissions"
for each row execute function public.keep_received_submission_pending_until_quality();

-- Repair received walk-in rows that were prematurely changed to Cut but have
-- not received a final human quality decision.
update public."Hair_Submissions" submission
set "Status" = 'Pending', "Cut_At" = null, "Cut_By_User_ID" = null,
    "Updated_At" = timezone('Asia/Manila', now())
where coalesce(submission."From_Event", false) = false
  and public.normalize_flow_key(submission."Status") = 'cut'
  and public.is_hair_submission_physically_received(submission."Submission_ID")
  and not exists (
    select 1 from public."Hair_Submission_Details" detail
    where detail."Submission_ID" = submission."Submission_ID"
      and public.normalize_flow_key(detail."Status") in ('approved','rejected','rejectedcut')
  );

create or replace function public.specialist_review_received_hair_quality(
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
  v_submission public."Hair_Submissions"%rowtype;
  v_detail public."Hair_Submission_Details"%rowtype;
  v_decision text := public.normalize_flow_key(p_decision);
  v_updates jsonb := coalesce(p_detail_updates, '{}'::jsonb);
  v_reason text := nullif(trim(coalesce(p_rejection_reason, '')), '');
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if v_decision not in ('approved','rejected') then raise exception 'Decision must be Approved or Rejected.'; end if;
  if v_decision = 'rejected' and v_reason is null then raise exception 'Rejection reason is required.'; end if;
  if jsonb_typeof(v_updates) <> 'object' then raise exception 'Detail updates must be an object.'; end if;

  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('specialist','admin','superadmin') then
    raise exception 'Only an active specialist/admin can review received hair.';
  end if;

  select * into v_submission from public."Hair_Submissions"
  where "Submission_ID" = p_submission_id for update;
  if v_submission."Submission_ID" is null then raise exception 'Hair submission was not found.'; end if;
  if coalesce(v_submission."From_Event", true) then raise exception 'Use Assigned Event Operations for event hair.'; end if;
  if v_submission."Bundle_ID" is not null then raise exception 'Bundled hair can no longer be reviewed.'; end if;
  if public.normalize_flow_key(v_submission."Status") not in ('pending','cut') then raise exception 'Only Pending received hair can be reviewed.'; end if;
  if not public.is_hair_submission_physically_received(p_submission_id) then raise exception 'Hair must be physically received before quality verification.'; end if;

  insert into public."Hair_Submission_Details" (
    "Submission_ID","Declared_Length","Declared_Color","Declared_Texture","Declared_Density",
    "Declared_Condition","Status","Created_At","Updated_By","Updated_At"
  )
  select v_submission."Submission_ID", ai."Estimated_Length", ai."Detected_Color", ai."Detected_Texture",
    ai."Detected_Density", ai."Detected_Condition", 'Pending', v_now, v_actor.user_id, v_now
  from public."AI_Screenings" ai where ai."AI_Screening_ID" = v_submission."AI_Screening_ID"
  on conflict ("Submission_ID") do nothing;

  insert into public."Hair_Submission_Details" ("Submission_ID","Status","Created_At","Updated_By","Updated_At")
  values (v_submission."Submission_ID",'Pending',v_now,v_actor.user_id,v_now)
  on conflict ("Submission_ID") do nothing;

  select * into v_detail from public."Hair_Submission_Details"
  where "Submission_ID" = v_submission."Submission_ID" for update;
  if public.normalize_flow_key(v_detail."Status") <> 'pending' then raise exception 'This quality review is already final.'; end if;

  -- Non-event donors bring already-cut hair. Once the specialist approves the
  -- physical item it is Available; it is not labelled Cut by Donivra.
  update public."Hair_Submissions"
  set "Status" = case when v_decision = 'approved' then 'Available' else 'Rejected' end,
      "Cut_At" = null,
      "Cut_By_User_ID" = null,
      "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  update public."Hair_Submission_Details" set
    "Declared_Length"=case when v_updates?'declaredLength' then nullif(v_updates->>'declaredLength','')::numeric else "Declared_Length" end,
    "Declared_Color"=case when v_updates?'declaredColor' then nullif(trim(v_updates->>'declaredColor'),'') else "Declared_Color" end,
    "Declared_Texture"=case when v_updates?'declaredTexture' then nullif(trim(v_updates->>'declaredTexture'),'') else "Declared_Texture" end,
    "Declared_Density"=case when v_updates?'declaredDensity' then nullif(trim(v_updates->>'declaredDensity'),'') else "Declared_Density" end,
    "Declared_Condition"=case when v_updates?'declaredCondition' then nullif(trim(v_updates->>'declaredCondition'),'') else "Declared_Condition" end,
    "Is_Chemically_Treated"=case when v_updates?'isChemicallyTreated' then coalesce((v_updates->>'isChemicallyTreated')::boolean,false) else "Is_Chemically_Treated" end,
    "Is_Colored"=case when v_updates?'isColored' then coalesce((v_updates->>'isColored')::boolean,false) else "Is_Colored" end,
    "Is_Bleached"=case when v_updates?'isBleached' then coalesce((v_updates->>'isBleached')::boolean,false) else "Is_Bleached" end,
    "Is_Rebonded"=case when v_updates?'isRebonded' then coalesce((v_updates->>'isRebonded')::boolean,false) else "Is_Rebonded" end,
    "Detail_Notes"=case when v_updates?'detailNotes' then nullif(trim(v_updates->>'detailNotes'),'') else "Detail_Notes" end,
    "Status"=case when v_decision='approved' then 'Approved' else 'Rejected' end,
    "Rejection_Reason"=case when v_decision='rejected' then v_reason else null end,
    "Updated_By"=v_actor.user_id, "Updated_At"=v_now
  where "Submission_ID"=v_submission."Submission_ID" returning * into v_detail;

  return jsonb_build_object('decision',v_detail."Status",'submission',to_jsonb(v_submission),'details',jsonb_build_array(to_jsonb(v_detail)));
end;
$fn$;

revoke all on function public.specialist_review_received_hair_quality(integer,text,text,jsonb) from public,anon;
grant execute on function public.specialist_review_received_hair_quality(integer,text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
