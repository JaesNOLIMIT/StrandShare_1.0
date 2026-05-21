-- 129_fix_bundle_scan_without_submission_code.sql
-- Purpose:
-- - Force bundling RPCs to work with current schema (no Hair_Submissions.Submission_Code).
-- - Resolve donor hair by Event_Attendees.Waybill_Code <-> Hair_Submissions.Event_Attendee_ID.

begin;

create or replace function public.bundle_scan_add_waybill(
  p_bundle_id integer,
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_raw text := trim(coalesce(p_waybill_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_submission_id_hint integer;
  v_attendee_id_hint integer;
  v_member_count integer := 0;
  v_status_key text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if p_bundle_id is null then
    raise exception 'Bundle_ID is required.';
  end if;

  if v_raw = '' then
    raise exception 'Waybill payload is required.';
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
    raise exception 'Only specialist/admin can scan waybills into a bundle.';
  end if;

  if left(v_raw, 1) = '{' then
    begin
      v_payload := v_raw::jsonb;
    exception
      when others then
        v_payload := null;
    end;
  end if;

  if v_payload is not null then
    v_waybill_code := nullif(trim(coalesce(
      v_payload ->> 'Waybill_Code',
      v_payload ->> 'waybill_code',
      v_payload ->> 'waybillCode',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode'
    )), '');

    begin
      v_submission_id_hint := nullif(trim(coalesce(
        v_payload ->> 'Submission_ID',
        v_payload ->> 'submission_id',
        v_payload -> 'data' ->> 'Submission_ID',
        v_payload -> 'data' ->> 'submission_id'
      )), '')::integer;
    exception
      when others then
        v_submission_id_hint := null;
    end;

    begin
      v_attendee_id_hint := nullif(trim(coalesce(
        v_payload ->> 'Event_Attendee_ID',
        v_payload ->> 'event_attendee_id',
        v_payload ->> 'attendee_id',
        v_payload -> 'data' ->> 'Event_Attendee_ID',
        v_payload -> 'data' ->> 'event_attendee_id',
        v_payload -> 'data' ->> 'attendee_id'
      )), '')::integer;
    exception
      when others then
        v_attendee_id_hint := null;
    end;
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_waybill_code is null and v_submission_id_hint is null and v_attendee_id_hint is null then
    raise exception 'No waybill code detected from scan payload.';
  end if;

  if v_waybill_code is not null then
    v_waybill_code := upper(trim(v_waybill_code));
  end if;

  select *
  into v_bundle
  from public."Hair_Submission_Bundles" b
  where b."Bundle_ID" = p_bundle_id
  for update;

  if v_bundle."Bundle_ID" is null then
    raise exception 'Bundle % not found.', p_bundle_id;
  end if;

  if public.normalize_flow_key(v_bundle."Status") <> 'draft' then
    raise exception 'Bundle % is not Draft. Current status: %', p_bundle_id, coalesce(v_bundle."Status", 'N/A');
  end if;

  select count(*)
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  if v_member_count >= 10 then
    raise exception 'Bundle already has 10 hairs. Close this bundle and open a new one.';
  end if;

  if v_submission_id_hint is not null and v_submission_id_hint > 0 then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."Submission_ID" = v_submission_id_hint
    for update;
  end if;

  if v_submission."Submission_ID" is null and v_attendee_id_hint is not null and v_attendee_id_hint > 0 then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."Event_Attendee_ID" = v_attendee_id_hint
    limit 1
    for update;
  end if;

  if v_submission."Submission_ID" is null and v_waybill_code is not null then
    select ea.*
    into v_attendee
    from public."Event_Attendees" ea
    where upper(trim(coalesce(ea."Waybill_Code", ''))) = v_waybill_code
    limit 1;

    if v_attendee."Event_Attendee_ID" is null then
      raise exception 'No hair submission matched waybill %.', v_waybill_code;
    end if;

    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
    limit 1
    for update;
  end if;

  if v_submission."Submission_ID" is null then
    raise exception 'No hair submission matched this scan payload.';
  end if;

  if v_attendee."Event_Attendee_ID" is null and v_submission."Event_Attendee_ID" is not null then
    select *
    into v_attendee
    from public."Event_Attendees" ea
    where ea."Event_Attendee_ID" = v_submission."Event_Attendee_ID"
    limit 1;
  end if;

  v_waybill_code := coalesce(v_waybill_code, nullif(trim(coalesce(v_attendee."Waybill_Code", '')), ''));
  if v_waybill_code is null then
    v_waybill_code := 'WB-UNKNOWN';
  end if;

  if v_submission."Bundle_ID" is not null then
    if v_submission."Bundle_ID" = p_bundle_id then
      raise exception 'Waybill % is already scanned in this bundle.', v_waybill_code;
    end if;
    raise exception 'Waybill % is already assigned to bundle %.', v_waybill_code, v_submission."Bundle_ID";
  end if;

  v_status_key := public.normalize_flow_key(v_submission."Status");
  if v_status_key in ('cancelled', 'wigcreated', 'wiginproduction') then
    raise exception 'Waybill % cannot be bundled while status is %.', v_waybill_code, coalesce(v_submission."Status", 'N/A');
  end if;
  if v_status_key <> 'cut' then
    raise exception 'Waybill % must be in Cut status before bundling. Current status: %', v_waybill_code, coalesce(v_submission."Status", 'N/A');
  end if;

  update public."Hair_Submissions"
  set
    "Bundle_ID" = p_bundle_id,
    "Status" = 'Cut',
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set
    "Updated_At" = v_now
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  if v_submission."Event_Request_ID" is not null then
    perform public.recompute_event_request_hair_collected_count(v_submission."Event_Request_ID");
  end if;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status, "time")
  values (
    v_user.user_id,
    'hair_submission_bundles.scan_waybill',
    format(
      'Scanned waybill %s into bundle_id=%s (submission_id=%s, count=%s)',
      v_waybill_code,
      p_bundle_id,
      v_submission."Submission_ID",
      v_member_count
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success',
    v_now
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'submission', to_jsonb(v_submission) || jsonb_build_object('Waybill_Code', v_waybill_code),
    'member_count', v_member_count,
    'ready_to_close', (v_member_count between 8 and 10)
  );
end;
$fn$;

create or replace function public.bundle_remove_waybill_from_draft(
  p_bundle_id integer,
  p_submission_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_attendee_waybill text;
  v_member_count integer := 0;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if p_bundle_id is null then
    raise exception 'Bundle_ID is required.';
  end if;

  if p_submission_id is null then
    raise exception 'Submission_ID is required.';
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
    raise exception 'Only specialist/admin can remove waybills from a draft bundle.';
  end if;

  select *
  into v_bundle
  from public."Hair_Submission_Bundles" b
  where b."Bundle_ID" = p_bundle_id
  for update;

  if v_bundle."Bundle_ID" is null then
    raise exception 'Bundle % not found.', p_bundle_id;
  end if;

  if public.normalize_flow_key(v_bundle."Status") <> 'draft' then
    raise exception 'Bundle % is not Draft. Current status: %', p_bundle_id, coalesce(v_bundle."Status", 'N/A');
  end if;

  select *
  into v_submission
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = p_submission_id
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'Submission % not found.', p_submission_id;
  end if;

  if v_submission."Bundle_ID" is null then
    raise exception 'Submission % is not assigned to any bundle.', p_submission_id;
  end if;

  if v_submission."Bundle_ID" <> p_bundle_id then
    raise exception 'Submission % belongs to bundle %, not bundle %.', p_submission_id, v_submission."Bundle_ID", p_bundle_id;
  end if;

  if public.normalize_flow_key(v_submission."Status") <> 'cut' then
    raise exception 'Only Cut submissions can be removed from draft bundles. Current status: %', coalesce(v_submission."Status", 'N/A');
  end if;

  if v_submission."Event_Attendee_ID" is not null then
    select nullif(trim(coalesce(ea."Waybill_Code", '')), '')
    into v_attendee_waybill
    from public."Event_Attendees" ea
    where ea."Event_Attendee_ID" = v_submission."Event_Attendee_ID"
    limit 1;
  end if;

  update public."Hair_Submissions"
  set
    "Bundle_ID" = null,
    "Updated_At" = v_now
  where "Submission_ID" = p_submission_id
    and "Bundle_ID" = p_bundle_id
  returning * into v_submission;

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set "Updated_At" = v_now
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  if v_submission."Event_Request_ID" is not null then
    perform public.recompute_event_request_hair_collected_count(v_submission."Event_Request_ID");
  end if;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status, "time")
  values (
    v_user.user_id,
    'hair_submission_bundles.remove_waybill_from_draft',
    format(
      'Removed submission_id=%s waybill=%s from bundle_id=%s (count=%s)',
      v_submission."Submission_ID",
      coalesce(v_attendee_waybill, format('SUB#%s', v_submission."Submission_ID")),
      p_bundle_id,
      v_member_count
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success',
    v_now
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'submission', to_jsonb(v_submission),
    'member_count', v_member_count
  );
end;
$fn$;

grant execute on function public.bundle_scan_add_waybill(integer, text) to authenticated;
grant execute on function public.bundle_remove_waybill_from_draft(integer, integer) to authenticated;

commit;

