-- 111_non_event_specialist_quality_review.sql
-- Quality Check is now for non-event donations only (Hair_Submissions.From_Event=false).
-- Specialist/Admin scans waybill and submits final QA decision:
--   Approved -> Hair_Submissions.Status='Cut', Hair_Submission_Details.Status='Approved'
--   Rejected -> Hair_Submissions.Status='Cancelled', Hair_Submission_Details.Status='Rejected'

begin;

-- Register non-event scans as Pending (not Cut). Final QA decision happens on
-- specialist Quality Check via specialist_review_non_event_hair_quality.
create or replace function public.scan_non_event_hair_submission(
  p_qr_payload text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_submission_code text;
  v_user_id integer;
  v_submission public."Hair_Submissions"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_action text := 'created';
  v_message text := '';
  v_status_key text;
begin
  if v_raw = '' then
    raise exception 'QR payload is required.';
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
  if v_role_key not in ('staff', 'specialist', 'admin') then
    raise exception 'Only staff/specialist/admin can scan non-event donation QR.';
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
    v_submission_code := nullif(trim(coalesce(
      v_payload ->> 'Submission_Code',
      v_payload ->> 'submission_code',
      v_payload ->> 'Waybill_Code',
      v_payload ->> 'waybill_code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Submission_Code',
      v_payload -> 'data' ->> 'submission_code',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code'
    )), '');

    begin
      v_user_id := nullif(trim(coalesce(
        v_payload ->> 'User_ID',
        v_payload ->> 'user_id',
        v_payload ->> 'userId',
        v_payload -> 'data' ->> 'User_ID',
        v_payload -> 'data' ->> 'user_id',
        v_payload -> 'data' ->> 'userId'
      )), '')::integer;
    exception
      when others then
        v_user_id := null;
    end;
  end if;

  if v_payload is null then
    if v_raw ~ '^[0-9]+$' then
      v_user_id := v_raw::integer;
    else
      v_submission_code := v_raw;
    end if;
  end if;

  if v_submission_code is not null then
    v_submission_code := upper(trim(v_submission_code));
  end if;

  if v_submission_code is not null then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where upper(trim(coalesce(hs."Submission_Code", ''))) = v_submission_code
    for update;

    if v_submission."Submission_ID" is not null then
      if v_submission."Event_Request_ID" is not null then
        raise exception 'Submission % belongs to an event donation. Use assigned event RSVP scanner.', v_submission_code;
      end if;

      if v_user_id is not null and v_submission."User_ID" is distinct from v_user_id then
        raise exception 'Scanned user id does not match owner of submission %.', v_submission_code;
      end if;

      v_status_key := public.normalize_flow_key(v_submission."Status");
      if v_status_key in ('cancelled', 'wiginproduction', 'wigcreated', 'cut') then
        raise exception 'Submission % cannot be scanned while status is %.', v_submission_code, coalesce(v_submission."Status", 'N/A');
      end if;

      update public."Hair_Submissions"
      set
        "From_Event" = false,
        "Status" = 'Pending',
        "Updated_At" = v_now,
        "Donor_Notes" = case
          when nullif(trim(coalesce(p_notes, '')), '') is null then "Donor_Notes"
          else nullif(trim(p_notes), '')
        end
      where "Submission_ID" = v_submission."Submission_ID"
      returning * into v_submission;

      v_action := 'existing';
      v_message := format('Non-event donation linked to existing waybill %s for specialist quality review.', coalesce(v_submission."Submission_Code", v_submission_code));
    end if;
  end if;

  if v_submission."Submission_ID" is null then
    if v_user_id is null or v_user_id <= 0 then
      raise exception 'No valid user id detected in QR payload.';
    end if;

    insert into public."Hair_Submissions" (
      "User_ID",
      "Status",
      "Created_At",
      "Updated_At",
      "Submission_Code",
      "Event_Request_ID",
      "From_Event",
      "Donor_Notes"
    )
    values (
      v_user_id,
      'Pending',
      v_now,
      v_now,
      nullif(v_submission_code, ''),
      null,
      false,
      nullif(trim(coalesce(p_notes, '')), '')
    )
    returning * into v_submission;

    if coalesce(trim(v_submission."Submission_Code"), '') = '' then
      v_submission_code := 'HS-' || to_char(coalesce(v_submission."Created_At", v_now), 'YYYY') || '-' || lpad(v_submission."Submission_ID"::text, 6, '0');
      update public."Hair_Submissions"
      set "Submission_Code" = v_submission_code
      where "Submission_ID" = v_submission."Submission_ID"
      returning * into v_submission;
    end if;

    if not exists (
      select 1
      from public."Hair_Submission_Details" hsd
      where hsd."Submission_ID" = v_submission."Submission_ID"
    ) then
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
      );
    end if;

    v_message := format('Non-event donation created with waybill %s (Pending specialist quality review).', v_submission."Submission_Code");
  end if;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submissions.scan_non_event',
    format(
      '%s submission_id=%s user_id=%s code=%s notes=%s',
      case when v_action = 'existing' then 'Updated existing non-event submission:' else 'Created non-event submission:' end,
      v_submission."Submission_ID",
      v_submission."User_ID",
      coalesce(v_submission."Submission_Code", 'N/A'),
      coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success'
  );

  return jsonb_build_object(
    'action', v_action,
    'message', v_message,
    'submission', to_jsonb(v_submission)
  );
end;
$fn$;

grant execute on function public.scan_non_event_hair_submission(text, text) to authenticated;

create or replace function public.specialist_review_non_event_hair_quality(
  p_submission_id integer,
  p_decision text,
  p_rejection_reason text default null
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
    raise exception 'Only Pending non-event submissions can be reviewed here. Current status: %.', coalesce(v_submission."Status", 'N/A');
  end if;

  if not exists (
    select 1
    from public."Hair_Submission_Details" hsd
    where hsd."Submission_ID" = v_submission."Submission_ID"
  ) then
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
    );
  end if;

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

  select coalesce(jsonb_agg(to_jsonb(hsd) order by hsd."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" hsd
  where hsd."Submission_ID" = v_submission."Submission_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submissions.specialist_non_event_quality_review',
    format(
      'submission_id=%s decision=%s resulting_status=%s reason=%s',
      v_submission."Submission_ID",
      case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
      coalesce(v_submission."Status", 'N/A'),
      coalesce(v_reason, 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success'
  );

  return jsonb_build_object(
    'decision', case when v_decision_key = 'approved' then 'Approved' else 'Rejected' end,
    'submission', to_jsonb(v_submission),
    'details', v_details
  );
end;
$fn$;

grant execute on function public.specialist_review_non_event_hair_quality(integer, text, text) to authenticated;

commit;
