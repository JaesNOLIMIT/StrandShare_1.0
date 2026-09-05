begin;

alter table public."Hair_Submissions" drop constraint if exists hair_submissions_status_check;
alter table public."Hair_Submissions" add constraint hair_submissions_status_check check (
  public.normalize_flow_key(coalesce("Status",'')) in (
    'pending','cut','available','rejected','wiginproduction','wigcreated','cancelled'
  )
);

-- Independent donations have only two business routes. Older labels remain
-- readable so existing records do not need a destructive rewrite.
create or replace function public.non_event_hair_logistics_kind(p_type text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case public.normalize_flow_key(coalesce(p_type, ''))
    when 'courier' then 'Courier'
    when 'shipbycourier' then 'Courier'
    when 'dropoff' then 'Drop-off'
    when 'salondropoff' then 'Drop-off'
    when 'walkindropoff' then 'Drop-off'
    else null
  end
$fn$;

-- Staff scans the Hair_Submissions waybill first. This is the only operation
-- that marks courier/drop-off hair physically received and opens specialist QA.
create or replace function public.staff_receive_non_event_hair_by_waybill(
  p_waybill_code text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_logistics public."Hair_Submission_Logistics"%rowtype;
  v_kind text;
  v_waybill text := upper(regexp_replace(trim(coalesce(p_waybill_code, '')), '[^A-Za-z0-9]', '', 'g'));
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff','admin','superadmin') then
    raise exception 'Only active staff/admin can receive donated hair.';
  end if;
  if not public.is_waybill_code(v_waybill) then
    raise exception 'Scan a valid Hair Submissions waybill (WB followed by 6 letters or numbers).';
  end if;

  select * into v_submission from public."Hair_Submissions"
  where upper(trim(coalesce("Waybill_Code", ''))) = v_waybill
  limit 1 for update;
  if v_submission."Submission_ID" is null then raise exception 'No Hair Submissions record uses waybill %.', v_waybill; end if;
  if coalesce(v_submission."From_Event", true) then raise exception 'Event waybills must be handled in Assigned Event Operations.'; end if;
  if v_submission."Bundle_ID" is not null then raise exception 'This hair is already assigned to a bundle.'; end if;
  if public.normalize_flow_key(v_submission."Status") <> 'pending' then
    raise exception 'Only a Pending independent donation can be received. Current status: %.', coalesce(v_submission."Status", 'N/A');
  end if;

  select * into v_logistics from public."Hair_Submission_Logistics"
  where "Submission_ID" = v_submission."Submission_ID" limit 1 for update;
  if v_logistics."Submission_Logistics_ID" is null then raise exception 'The submission has no logistics record.'; end if;
  v_kind := public.non_event_hair_logistics_kind(v_logistics."Logistics_Type");
  if v_kind is null then raise exception 'Only Ship by Courier and Drop-off donations can be received here.'; end if;

  if v_kind = 'Courier' then
    update public."Hair_Submission_Logistics"
    set "Shipment_Status" = 'Received', "Received_At" = coalesce("Received_At", v_now),
        "Received_By" = v_actor.user_id, "Updated_By" = v_actor.user_id,
        "Notes" = coalesce(nullif(trim(coalesce(p_note, '')), ''), "Notes"), "Updated_At" = v_now
    where "Submission_Logistics_ID" = v_logistics."Submission_Logistics_ID" returning * into v_logistics;
  else
    update public."Hair_Submission_Logistics"
    set "Dropoff_Status" = 'Completed', "Checked_In_At" = coalesce("Checked_In_At", v_now),
        "Completed_At" = coalesce("Completed_At", v_now), "Received_At" = coalesce("Received_At", v_now),
        "Received_By" = v_actor.user_id, "Updated_By" = v_actor.user_id,
        "Notes" = coalesce(nullif(trim(coalesce(p_note, '')), ''), "Notes"), "Updated_At" = v_now
    where "Submission_Logistics_ID" = v_logistics."Submission_Logistics_ID" returning * into v_logistics;
  end if;

  insert into public."Hair_Submission_Details" (
    "Submission_ID","Declared_Length","Declared_Color","Declared_Texture","Declared_Density",
    "Declared_Condition","Status","Created_At","Updated_By","Updated_At"
  )
  select v_submission."Submission_ID", ai."Estimated_Length", ai."Detected_Color", ai."Detected_Texture",
    ai."Detected_Density", ai."Detected_Condition", 'Pending', v_now, v_actor.user_id, v_now
  from public."AI_Screenings" ai
  where ai."AI_Screening_ID" = v_submission."AI_Screening_ID"
  on conflict ("Submission_ID") do nothing;

  insert into public."Hair_Submission_Details" ("Submission_ID","Status","Created_At","Updated_By","Updated_At")
  values (v_submission."Submission_ID",'Pending',v_now,v_actor.user_id,v_now)
  on conflict ("Submission_ID") do nothing;

  return jsonb_build_object(
    'route', v_kind, 'submission', to_jsonb(v_submission), 'logistics', to_jsonb(v_logistics),
    'next_step', 'Specialist Quality Check'
  );
end;
$fn$;

revoke all on function public.staff_receive_non_event_hair_by_waybill(text,text) from public,anon;
grant execute on function public.staff_receive_non_event_hair_by_waybill(text,text) to authenticated;

-- Versioned entry point makes the corrected Available/Rejected parent status
-- apply even when the preceding migration's older RPC was already installed.
create or replace function public.specialist_review_non_event_hair_quality_v2(
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
  v_result jsonb;
  v_submission public."Hair_Submissions"%rowtype;
  v_decision text := public.normalize_flow_key(p_decision);
  v_now timestamp without time zone := timezone('Asia/Manila',now());
begin
  v_result := public.specialist_review_received_hair_quality(
    p_submission_id,p_decision,p_rejection_reason,p_detail_updates
  );
  update public."Hair_Submissions"
  set "Status"=case when v_decision='approved' then 'Available' else 'Rejected' end,
      "Cut_At"=null,"Cut_By_User_ID"=null,"Updated_At"=v_now
  where "Submission_ID"=p_submission_id returning * into v_submission;
  -- Re-fire the inventory synchronization after the parent is Available.
  update public."Hair_Submission_Details" set "Status"="Status","Updated_At"=v_now
  where "Submission_ID"=p_submission_id;
  return v_result || jsonb_build_object('submission',to_jsonb(v_submission));
end;
$fn$;
revoke all on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb) from public,anon;
grant execute on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb) to authenticated;

-- Always freeze the AI row explicitly linked by Hair_Submissions. This works
-- for both event and non-event records and keeps AI_Screenings immutable.
create or replace function public.capture_hair_ai_review_baseline()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_submission public."Hair_Submissions"%rowtype;
  v_screening public."AI_Screenings"%rowtype;
  v_values jsonb;
  v_is_ai boolean := false;
begin
  if exists (select 1 from public."Hair_AI_Review_Comparisons" c where c."Submission_Detail_ID"=old."Submission_Detail_ID") then return new; end if;
  select * into v_submission from public."Hair_Submissions" where "Submission_ID"=old."Submission_ID";
  select * into v_screening from public."AI_Screenings" ai
  where ai."AI_Screening_ID" = v_submission."AI_Screening_ID" or ai."Submission_ID" = old."Submission_ID"
  order by case when ai."AI_Screening_ID" = v_submission."AI_Screening_ID" then 0 else 1 end,
    ai."Created_At" desc, ai."AI_Screening_ID" desc limit 1;
  if v_screening."AI_Screening_ID" is not null then
    v_is_ai := true;
    v_values := jsonb_build_object(
      'length',v_screening."Estimated_Length",'color',v_screening."Detected_Color",
      'texture',v_screening."Detected_Texture",'density',v_screening."Detected_Density",
      'condition',v_screening."Detected_Condition",'confidenceScore',v_screening."Confidence_Score",
      'decision',v_screening."Decision",'summary',v_screening."Summary",
      'visibleDamageNotes',v_screening."Visible_Damage_Notes");
  else
    v_values := jsonb_build_object('length',old."Declared_Length",'color',old."Declared_Color",
      'texture',old."Declared_Texture",'density',old."Declared_Density",'condition',old."Declared_Condition");
  end if;
  insert into public."Hair_AI_Review_Comparisons" (
    "Submission_Detail_ID","Submission_ID","Event_Request_ID","AI_Values","Is_AI_Source"
  ) values (old."Submission_Detail_ID",old."Submission_ID",v_submission."Event_Request_ID",v_values,v_is_ai)
  on conflict ("Submission_Detail_ID") do nothing;
  return new;
end;
$fn$;

-- Approved non-event hair is Available at the submission layer. The physical
-- inventory layer deliberately keeps its existing Cut status for production.
create or replace function public.sync_cut_hair_inventory_from_detail()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare v_submission public."Hair_Submissions"%rowtype;
begin
  if public.normalize_flow_key(new."Status") <> 'approved' then return new; end if;
  select * into v_submission from public."Hair_Submissions" where "Submission_ID"=new."Submission_ID";
  if v_submission."Submission_ID" is null
    or public.normalize_flow_key(v_submission."Status") not in ('cut','available') then return new; end if;
  insert into public."Cut_Hair_Inventory" (
    "Submission_ID","Event_Request_ID","Event_Attendee_ID","Donor_User_ID",
    "Approved_By_User_ID","Source_Type","Status","Approved_At","Updated_At"
  ) values (
    v_submission."Submission_ID",v_submission."Event_Request_ID",v_submission."Event_Attendee_ID",
    v_submission."User_ID",new."Updated_By",case when coalesce(v_submission."From_Event",false) then 'Event' else 'Non-Event' end,
    'Cut',coalesce(new."Updated_At" at time zone 'Asia/Manila',now()),now()
  ) on conflict ("Submission_ID") do update set
    "Event_Request_ID"=excluded."Event_Request_ID","Event_Attendee_ID"=excluded."Event_Attendee_ID",
    "Donor_User_ID"=excluded."Donor_User_ID","Approved_By_User_ID"=excluded."Approved_By_User_ID",
    "Source_Type"=excluded."Source_Type","Updated_At"=now();
  return new;
end;
$fn$;

create or replace function public.enforce_hair_bundle_quality_eligibility()
returns trigger language plpgsql set search_path=public as $fn$
declare v_status text:=public.normalize_flow_key(new."Status"); v_detail_status text;
begin
  if new."Bundle_ID" is null or new."Bundle_ID" is not distinct from old."Bundle_ID" then return new; end if;
  select public.normalize_flow_key(d."Status") into v_detail_status from public."Hair_Submission_Details" d
  where d."Submission_ID"=new."Submission_ID" order by d."Submission_Detail_ID" desc limit 1;
  if coalesce(v_detail_status,'') <> 'approved' then raise exception 'Submission % must be Approved in Quality Check before Bundling.',new."Submission_ID"; end if;
  if coalesce(new."From_Event",false) and v_status <> 'cut' then raise exception 'Event submission % must be Cut before Bundling.',new."Submission_ID"; end if;
  if not coalesce(new."From_Event",false) and v_status not in ('available','cut') then raise exception 'Non-event submission % must be Available before Bundling.',new."Submission_ID"; end if;
  return new;
end;
$fn$;

create or replace function public.restore_cut_status_before_bundle_removal()
returns trigger language plpgsql set search_path=public as $fn$
begin
  if old."Bundle_ID" is not null and new."Bundle_ID" is null then
    new."Status" := case when coalesce(new."From_Event",false) then 'Cut' else 'Available' end;
    new."Updated_At" := timezone('Asia/Manila',now());
  end if;
  return new;
end;
$fn$;

-- Keep the installed scanner implementation as the event/Cut implementation,
-- then wrap it so Available non-event records can use the same bundling flow.
do $rename$
begin
  if to_regprocedure('public.bundle_scan_add_waybill(integer,text)') is not null
    and to_regprocedure('public.bundle_scan_add_waybill_legacy_20260905(integer,text)') is null then
    execute 'alter function public.bundle_scan_add_waybill(integer,text) rename to bundle_scan_add_waybill_legacy_20260905';
  end if;
end;
$rename$;

create or replace function public.bundle_scan_add_waybill(p_bundle_id integer,p_waybill_payload text)
returns jsonb language plpgsql security definer set search_path=public as $fn$
declare
  v_raw text:=trim(coalesce(p_waybill_payload,'')); v_payload jsonb; v_waybill text; v_id integer;
  v_submission public."Hair_Submissions"%rowtype; v_result jsonb;
begin
  if left(v_raw,1)='{' then begin v_payload:=v_raw::jsonb; exception when others then v_payload:=null; end; end if;
  v_waybill:=upper(trim(coalesce(v_payload->>'Waybill_Code',v_payload->>'waybill_code',v_payload->>'waybillCode',v_raw)));
  begin v_id:=nullif(trim(coalesce(v_payload->>'Submission_ID',v_payload->>'submission_id')),'')::integer; exception when others then v_id:=null; end;
  select * into v_submission from public."Hair_Submissions" s
  where (v_id is not null and s."Submission_ID"=v_id)
     or (v_waybill<>'' and upper(trim(coalesce(s."Waybill_Code",'')))=v_waybill)
  order by case when s."Submission_ID"=v_id then 0 else 1 end limit 1 for update;
  if v_submission."Submission_ID" is not null and not coalesce(v_submission."From_Event",false)
    and public.normalize_flow_key(v_submission."Status")='available' then
    update public."Hair_Submissions" set "Status"='Cut' where "Submission_ID"=v_submission."Submission_ID";
    v_result:=public.bundle_scan_add_waybill_legacy_20260905(p_bundle_id,
      jsonb_build_object('Submission_ID',v_submission."Submission_ID",'Waybill_Code',v_waybill)::text);
    update public."Hair_Submissions" set "Status"='Available',"Updated_At"=timezone('Asia/Manila',now())
    where "Submission_ID"=v_submission."Submission_ID" returning * into v_submission;
    return v_result || jsonb_build_object('submission',to_jsonb(v_submission));
  end if;
  return public.bundle_scan_add_waybill_legacy_20260905(p_bundle_id,p_waybill_payload);
end;
$fn$;
revoke all on function public.bundle_scan_add_waybill(integer,text) from public,anon;
grant execute on function public.bundle_scan_add_waybill(integer,text) to authenticated;

-- Repair prior approved independent rows that used the old Cut label.
update public."Hair_Submissions" s set "Status"='Available',"Cut_At"=null,"Cut_By_User_ID"=null,
  "Updated_At"=timezone('Asia/Manila',now())
where not coalesce(s."From_Event",false) and public.normalize_flow_key(s."Status")='cut'
  and exists (select 1 from public."Hair_Submission_Details" d where d."Submission_ID"=s."Submission_ID" and public.normalize_flow_key(d."Status")='approved');

drop function if exists public.get_hair_ai_accuracy_report();
create function public.get_hair_ai_accuracy_report()
returns table (
  comparison_id bigint,submission_id integer,event_request_id integer,event_name text,source_type text,
  final_decision text,reviewed_at timestamp with time zone,staff_values jsonb,changed_fields text[],
  comparable_field_count integer,matched_field_count integer,ai_accuracy_percent numeric,ai_screening jsonb
)
language plpgsql security definer set search_path=public as $fn$
declare v_actor public.users%rowtype; v_role text;
begin
  select * into v_actor from public.users where auth_user_id=auth.uid() limit 1;
  if v_actor.user_id is null then raise exception 'Unable to resolve authenticated user.'; end if;
  v_role:=public.normalize_app_role(v_actor.role);
  if v_role not in ('staff','admin','superadmin','specialist') then raise exception 'Only staff/admin/specialist can view AI accuracy reports.'; end if;
  return query select c."Comparison_ID",c."Submission_ID",c."Event_Request_ID",
    case when coalesce(s."From_Event",false) then coalesce(e."Event_Name"::text,format('Event #%s',c."Event_Request_ID")) else 'Non-event donation' end,
    case when coalesce(s."From_Event",false) then 'Event' else 'Non-Event' end,
    c."Final_Decision"::text,c."Reviewed_At",c."Staff_Values",c."Changed_Fields",
    c."Comparable_Field_Count",c."Matched_Field_Count",c."AI_Accuracy_Percent",
    jsonb_build_object('Estimated_Length',c."AI_Values"->'length','Detected_Color',c."AI_Values"->'color',
      'Detected_Texture',c."AI_Values"->'texture','Detected_Density',c."AI_Values"->'density',
      'Detected_Condition',c."AI_Values"->'condition','Confidence_Score',c."AI_Values"->'confidenceScore',
      'Decision',c."AI_Values"->'decision','Summary',c."AI_Values"->'summary','Visible_Damage_Notes',c."AI_Values"->'visibleDamageNotes')
  from public."Hair_AI_Review_Comparisons" c
  join public."Hair_Submissions" s on s."Submission_ID"=c."Submission_ID"
  left join public."Event_Requests" e on e."Event_Request_ID"=c."Event_Request_ID"
  where c."Is_AI_Source"=true and c."Reviewed_At" is not null
    and (v_role in ('admin','superadmin','specialist') or not coalesce(s."From_Event",false)
      or (v_role='staff' and e."Assigned_Staff_User_ID"=v_actor.user_id))
  order by c."Reviewed_At" desc,c."Comparison_ID" desc;
end;
$fn$;
revoke all on function public.get_hair_ai_accuracy_report() from public,anon;
grant execute on function public.get_hair_ai_accuracy_report() to authenticated;

notify pgrst,'reload schema';
commit;
