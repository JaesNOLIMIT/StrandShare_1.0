-- 125_non_event_scan_without_submission_code.sql
-- Remove any remaining Submission_Code dependency from non-event scan flow.

begin;

drop function if exists public.scan_non_event_hair_submission(text, text);

create function public.scan_non_event_hair_submission(
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
  v_submission_id integer;
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
    begin
      v_submission_id := nullif(trim(coalesce(
        v_payload ->> 'Submission_ID',
        v_payload ->> 'submission_id',
        v_payload -> 'data' ->> 'Submission_ID',
        v_payload -> 'data' ->> 'submission_id'
      )), '')::integer;
    exception
      when others then
        v_submission_id := null;
    end;

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
  else
    if v_raw ~ '^[0-9]+$' then
      v_user_id := v_raw::integer;
    end if;
  end if;

  if v_submission_id is not null and v_submission_id > 0 then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."Submission_ID" = v_submission_id
    for update;
  end if;

  if v_submission."Submission_ID" is null and v_user_id is not null and v_user_id > 0 then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."User_ID" = v_user_id
      and coalesce(hs."From_Event", false) = false
      and hs."Bundle_ID" is null
      and public.normalize_flow_key(hs."Status") = 'pending'
    order by coalesce(hs."Updated_At", hs."Created_At") desc, hs."Submission_ID" desc
    limit 1
    for update;
  end if;

  if v_submission."Submission_ID" is not null then
    if coalesce(v_submission."From_Event", true) or v_submission."Event_Request_ID" is not null then
      raise exception 'Submission % belongs to an event donation. Use assigned event RSVP scanner.', v_submission."Submission_ID";
    end if;

    if v_user_id is not null and v_submission."User_ID" is distinct from v_user_id then
      raise exception 'Scanned user id does not match owner of submission %.', v_submission."Submission_ID";
    end if;

    v_status_key := public.normalize_flow_key(v_submission."Status");
    if v_status_key in ('cancelled', 'wiginproduction', 'wigcreated', 'cut') then
      raise exception 'Submission % cannot be scanned while status is %.', v_submission."Submission_ID", coalesce(v_submission."Status", 'N/A');
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
    v_message := format('Non-event donation linked to existing submission #%s for specialist quality review.', v_submission."Submission_ID");
  else
    if v_user_id is null or v_user_id <= 0 then
      raise exception 'No valid user id detected in QR payload.';
    end if;

    insert into public."Hair_Submissions" (
      "User_ID",
      "Status",
      "Created_At",
      "Updated_At",
      "Event_Request_ID",
      "From_Event",
      "Donor_Notes"
    )
    values (
      v_user_id,
      'Pending',
      v_now,
      v_now,
      null,
      false,
      nullif(trim(coalesce(p_notes, '')), '')
    )
    returning * into v_submission;

    v_message := format('Non-event donation created with submission #%s (Pending specialist quality review).', v_submission."Submission_ID");
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

  insert into public.audit_logs (user_id, action, description, user_email, resource, status, "time")
  values (
    v_user.user_id,
    'hair_submissions.scan_non_event',
    format(
      '%s submission_id=%s user_id=%s notes=%s',
      case when v_action = 'existing' then 'Updated existing non-event submission:' else 'Created non-event submission:' end,
      v_submission."Submission_ID",
      v_submission."User_ID",
      coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'N/A')
    ),
    v_user.email,
    'Hair_Submissions',
    'success',
    v_now
  );

  return jsonb_build_object(
    'action', v_action,
    'message', v_message,
    'submission', to_jsonb(v_submission)
  );
end;
$fn$;

grant execute on function public.scan_non_event_hair_submission(text, text) to authenticated;

commit;

