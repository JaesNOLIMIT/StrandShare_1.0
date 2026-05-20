-- 106_align_hair_submission_status_and_bundle_capsize.sql
-- Aligns submission lifecycle and bundle cap-size behavior to current operations:
-- Pending -> Cut -> Wig In Production -> Wig Created (+ Cancelled)
-- Bundle draft cap size is derived from the selected Wig_Specification.

begin;

-- ---------------------------------------------------------------------------
-- Hair_Submissions status + cut confirmation metadata
-- ---------------------------------------------------------------------------
alter table public."Hair_Submissions"
  add column if not exists "Cut_At" timestamp without time zone null,
  add column if not exists "Cut_By_User_ID" integer null;

alter table public."Hair_Submissions"
  drop constraint if exists hair_submissions_cut_by_fkey;

alter table public."Hair_Submissions"
  add constraint hair_submissions_cut_by_fkey
  foreign key ("Cut_By_User_ID")
  references public.users(user_id)
  on delete set null;

create index if not exists idx_hair_submissions_cut_at
  on public."Hair_Submissions" ("Cut_At" desc);

-- Migrate legacy statuses to the new lifecycle.
update public."Hair_Submissions" hs
set "Status" = case
  when public.normalize_flow_key(hs."Status") in ('cancelled', 'canceled', 'rejected', 'noshow') then 'Cancelled'
  when public.normalize_flow_key(hs."Status") in ('wigcreated', 'wigcompleted', 'completed') then 'Wig Created'
  when hs."Bundle_ID" is not null then 'Wig In Production'
  when public.normalize_flow_key(hs."Status") in ('wiginproduction', 'inproduction', 'bundled') then 'Wig In Production'
  when public.normalize_flow_key(hs."Status") in ('cut', 'cutshipped', 'cutandshipped', 'received', 'approved') then 'Cut'
  else 'Pending'
end,
"Updated_At" = coalesce(hs."Updated_At", timezone('Asia/Manila', now()));

update public."Hair_Submissions"
set "Status" = 'Pending'
where coalesce(trim("Status"), '') = '';

alter table public."Hair_Submissions"
  alter column "Status" set default 'Pending';

alter table public."Hair_Submissions"
  alter column "Status" set not null;

do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public."Hair_Submissions"'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%"Status"%'
  loop
    execute format('alter table public."Hair_Submissions" drop constraint if exists %I', v_constraint.conname);
  end loop;
end
$$;

alter table public."Hair_Submissions"
  add constraint hair_submissions_status_check
  check (
    public.normalize_flow_key(coalesce("Status", '')) = any (
      array[
        'pending'::text,
        'cut'::text,
        'wiginproduction'::text,
        'wigcreated'::text,
        'cancelled'::text
      ]
    )
  );

update public."Hair_Submissions"
set "Cut_At" = coalesce("Cut_At", "Updated_At", "Created_At", timezone('Asia/Manila', now()))
where public.normalize_flow_key("Status") in ('cut', 'wiginproduction', 'wigcreated');

-- ---------------------------------------------------------------------------
-- Cap-size normalization (Small/Medium/Large)
-- ---------------------------------------------------------------------------
update public."Wig_Specifications"
set "Cap_Size" = case
  when public.normalize_flow_key("Cap_Size") in ('s', 'small') then 'Small'
  when public.normalize_flow_key("Cap_Size") in ('m', 'medium') then 'Medium'
  when public.normalize_flow_key("Cap_Size") in ('l', 'large') then 'Large'
  when coalesce(trim("Cap_Size"), '') = '' then null
  else "Cap_Size"
end;

update public."Hair_Submission_Bundles"
set "Target_Cap_Size" = case
  when public.normalize_flow_key("Target_Cap_Size") in ('s', 'small') then 'Small'
  when public.normalize_flow_key("Target_Cap_Size") in ('m', 'medium') then 'Medium'
  when public.normalize_flow_key("Target_Cap_Size") in ('l', 'large') then 'Large'
  when coalesce(trim("Target_Cap_Size"), '') = '' then null
  else "Target_Cap_Size"
end;

alter table public."Wig_Specifications"
  drop constraint if exists wig_specifications_cap_size_three_sizes_check;

alter table public."Wig_Specifications"
  add constraint wig_specifications_cap_size_three_sizes_check
  check (
    "Cap_Size" is null
    or public.normalize_flow_key("Cap_Size") = any (
      array['small'::text, 'medium'::text, 'large'::text]
    )
  );

alter table public."Hair_Submission_Bundles"
  drop constraint if exists hair_submission_bundles_target_cap_size_check;

alter table public."Hair_Submission_Bundles"
  add constraint hair_submission_bundles_target_cap_size_check
  check (
    "Target_Cap_Size" is null
    or public.normalize_flow_key("Target_Cap_Size") = any (
      array['small'::text, 'medium'::text, 'large'::text]
    )
  );

-- ---------------------------------------------------------------------------
-- RSVP scan: one-time mark present + mark linked hair as Cut
-- ---------------------------------------------------------------------------
create or replace function public.scan_event_attendee_rsvp(
  p_event_request_id integer,
  p_qr_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_attendee public."Event_Attendees"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_user_id_hint integer;
  v_resolved_waybill text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_notes text;
  v_scan_stamp text;
  v_matches integer := 0;
  v_status_key text;
begin
  if p_event_request_id is null then
    raise exception 'Event_Request_ID is required.';
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
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can scan RSVP attendance.';
  end if;

  if v_role_key = 'staff' and not exists (
    select 1
    from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_user.user_id
  ) then
    raise exception 'You are not assigned to this event.';
  end if;

  if v_raw <> '' and left(v_raw, 1) = '{' then
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
      v_payload ->> 'submission_code',
      v_payload ->> 'Submission_Code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode',
      v_payload -> 'data' ->> 'submission_code',
      v_payload -> 'data' ->> 'Submission_Code'
    )), '');

    begin
      v_user_id_hint := nullif(trim(coalesce(
        v_payload ->> 'User_ID',
        v_payload ->> 'user_id',
        v_payload ->> 'userId',
        v_payload -> 'data' ->> 'User_ID',
        v_payload -> 'data' ->> 'user_id',
        v_payload -> 'data' ->> 'userId'
      )), '')::integer;
    exception
      when others then
        v_user_id_hint := null;
    end;
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_waybill_code is null and v_user_id_hint is null then
    raise exception 'No waybill code or user id detected from scan.';
  end if;

  if v_waybill_code is not null then
    select count(*)
    into v_matches
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = p_event_request_id
      and upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(v_waybill_code);

    if v_matches > 1 then
      raise exception 'Multiple attendees found for waybill % in this event.', v_waybill_code;
    elsif v_matches = 1 then
      select *
      into v_attendee
      from public."Event_Attendees" ea
      where ea."Event_Request_ID" = p_event_request_id
        and upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(v_waybill_code)
      limit 1;
    end if;
  end if;

  if v_attendee."Event_Attendee_ID" is null and v_user_id_hint is not null then
    select count(*)
    into v_matches
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = p_event_request_id
      and ea."User_ID" = v_user_id_hint;

    if v_matches > 1 then
      raise exception 'Multiple attendees found for user % in this event. Scan attendee waybill QR instead.', v_user_id_hint;
    elsif v_matches = 1 then
      select *
      into v_attendee
      from public."Event_Attendees" ea
      where ea."Event_Request_ID" = p_event_request_id
        and ea."User_ID" = v_user_id_hint
      limit 1;
    end if;
  end if;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'No attendee matched for this event and scan payload.';
  end if;

  if public.normalize_flow_key(v_attendee."Registration_Status") = 'cancelled' then
    raise exception 'This attendee registration is cancelled.';
  end if;

  if v_attendee."RSVP_Scanned_At" is not null then
    raise exception 'RSVP already scanned for this attendee.';
  end if;

  v_resolved_waybill := nullif(trim(coalesce(v_attendee."Waybill_Code", v_waybill_code)), '');
  if v_resolved_waybill is null then
    raise exception 'No attendee waybill code is assigned yet.';
  end if;

  v_scan_stamp := '[RSVP_SCAN ' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || ' by User#' || v_user.user_id || ']';
  v_notes := trim(coalesce(v_attendee."Notes", ''));
  if v_notes = '' then
    v_notes := v_scan_stamp;
  else
    v_notes := v_notes || E'\n' || v_scan_stamp;
  end if;

  update public."Event_Attendees"
  set
    "Attendance_Status" = 'Present',
    "RSVP_Scanned_At" = v_now,
    "RSVP_Scanned_By" = v_user.user_id,
    "Updated_At" = v_now,
    "Notes" = v_notes
  where "Event_Attendee_ID" = v_attendee."Event_Attendee_ID"
  returning * into v_attendee;

  select count(*)
  into v_matches
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" = p_event_request_id
    and hs."User_ID" = v_attendee."User_ID";

  if v_matches > 1 then
    raise exception 'Multiple hair submissions found for attendee user % in event %.', v_attendee."User_ID", p_event_request_id;
  elsif v_matches = 1 then
    select *
    into v_submission
    from public."Hair_Submissions" hs
    where hs."Event_Request_ID" = p_event_request_id
      and hs."User_ID" = v_attendee."User_ID"
    limit 1;
  end if;

  if v_submission."Submission_ID" is null then
    select count(*)
    into v_matches
    from public."Hair_Submissions" hs
    where upper(trim(coalesce(hs."Submission_Code", ''))) = upper(v_resolved_waybill);

    if v_matches > 1 then
      raise exception 'Multiple hair submissions matched waybill %. Please fix duplicate Submission_Code values.', v_resolved_waybill;
    elsif v_matches = 1 then
      select *
      into v_submission
      from public."Hair_Submissions" hs
      where upper(trim(coalesce(hs."Submission_Code", ''))) = upper(v_resolved_waybill)
      limit 1;
    end if;
  end if;

  if v_submission."Submission_ID" is null then
    raise exception 'No linked hair submission found. RSVP on mobile must insert Hair_Submissions first.';
  end if;

  v_status_key := public.normalize_flow_key(v_submission."Status");
  if v_status_key = 'cancelled' then
    raise exception 'Linked hair submission is cancelled.';
  end if;
  if v_status_key in ('wiginproduction', 'wigcreated') then
    raise exception 'Linked hair submission is already in % status.', v_submission."Status";
  end if;

  update public."Hair_Submissions"
  set
    "Event_Request_ID" = coalesce("Event_Request_ID", p_event_request_id),
    "Submission_Code" = coalesce(nullif("Submission_Code", ''), v_resolved_waybill),
    "Status" = 'Cut',
    "Cut_At" = coalesce("Cut_At", v_now),
    "Cut_By_User_ID" = coalesce("Cut_By_User_ID", v_user.user_id),
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  update public."Hair_Submission_Details"
  set
    "Updated_By" = v_user.user_id,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID";

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'event_attendees.rsvp_scan',
    format(
      'Scanned RSVP for event_request_id=%s attendee_id=%s waybill=%s; submission_id=%s now status=%s',
      p_event_request_id,
      v_attendee."Event_Attendee_ID",
      coalesce(v_resolved_waybill, 'N/A'),
      v_submission."Submission_ID",
      coalesce(v_submission."Status", 'N/A')
    ),
    v_user.email,
    'Event_Attendees',
    'success'
  );

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'waybill_code', v_resolved_waybill,
    'submission_status', v_submission."Status"
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Non-event scanner: create/update waybill as Cut
-- ---------------------------------------------------------------------------
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
      if v_status_key in ('cancelled', 'wiginproduction', 'wigcreated') then
        raise exception 'Submission % cannot be scanned while status is %.', v_submission_code, coalesce(v_submission."Status", 'N/A');
      end if;

      update public."Hair_Submissions"
      set
        "From_Event" = false,
        "Status" = 'Cut',
        "Cut_At" = coalesce("Cut_At", v_now),
        "Cut_By_User_ID" = coalesce("Cut_By_User_ID", v_user.user_id),
        "Updated_At" = v_now
      where "Submission_ID" = v_submission."Submission_ID"
      returning * into v_submission;

      v_action := 'existing';
      v_message := format('Non-event donation linked to existing waybill %s.', coalesce(v_submission."Submission_Code", v_submission_code));
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
      "Cut_At",
      "Cut_By_User_ID"
    )
    values (
      v_user_id,
      'Cut',
      v_now,
      v_now,
      nullif(v_submission_code, ''),
      null,
      false,
      v_now,
      v_user.user_id
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
        "Updated_By",
        "Updated_At"
      )
      values (
        v_submission."Submission_ID",
        v_user.user_id,
        v_now
      );
    end if;

    v_message := format('Non-event donation created with waybill %s.', v_submission."Submission_Code");
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

-- ---------------------------------------------------------------------------
-- Bundle draft/open/scan/close behavior aligned to Cut -> Wig In Production
-- ---------------------------------------------------------------------------
create or replace function public.create_hair_bundle_draft(
  p_wig_specification_id integer,
  p_cap_size_override text default null,
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
  v_bundle public."Hair_Submission_Bundles"%rowtype;
  v_target_cap_size text;
begin
  if p_wig_specification_id is null then
    raise exception 'Wig_Specification_ID is required.';
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
    raise exception 'Only specialist/admin can open bundle drafts.';
  end if;

  select ws."Cap_Size"
  into v_target_cap_size
  from public."Wig_Specifications" ws
  where ws."Wig_Specification_ID" = p_wig_specification_id
  limit 1;

  if not found then
    raise exception 'Wig specification % does not exist.', p_wig_specification_id;
  end if;

  if v_target_cap_size is null
    or public.normalize_flow_key(v_target_cap_size) not in ('small', 'medium', 'large') then
    raise exception 'Wig specification % must have cap size Small, Medium, or Large.', p_wig_specification_id;
  end if;

  insert into public."Hair_Submission_Bundles" (
    "Created_By",
    "Status",
    "Notes",
    "Wig_Specification_ID",
    "Target_Cap_Size"
  )
  values (
    v_user.user_id,
    'Draft',
    nullif(trim(coalesce(p_notes, '')), ''),
    p_wig_specification_id,
    case
      when public.normalize_flow_key(v_target_cap_size) = 'small' then 'Small'
      when public.normalize_flow_key(v_target_cap_size) = 'medium' then 'Medium'
      when public.normalize_flow_key(v_target_cap_size) = 'large' then 'Large'
      else v_target_cap_size
    end
  )
  returning * into v_bundle;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.open_draft',
    format(
      'Opened bundle draft bundle_id=%s wig_specification_id=%s cap_size=%s',
      v_bundle."Bundle_ID",
      p_wig_specification_id,
      coalesce(v_bundle."Target_Cap_Size", 'N/A')
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return to_jsonb(v_bundle);
end;
$fn$;

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
  v_raw text := trim(coalesce(p_waybill_payload, ''));
  v_payload jsonb;
  v_waybill_code text;
  v_member_count integer := 0;
  v_status_key text;
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
      v_payload ->> 'Submission_Code',
      v_payload ->> 'submission_code',
      v_payload ->> 'code',
      v_payload ->> 'value',
      v_payload -> 'data' ->> 'Waybill_Code',
      v_payload -> 'data' ->> 'waybill_code',
      v_payload -> 'data' ->> 'waybillCode',
      v_payload -> 'data' ->> 'Submission_Code',
      v_payload -> 'data' ->> 'submission_code'
    )), '');
  end if;

  if v_waybill_code is null then
    v_waybill_code := nullif(v_raw, '');
  end if;

  if v_waybill_code is null then
    raise exception 'No waybill code detected from scan payload.';
  end if;

  v_waybill_code := upper(v_waybill_code);

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

  select *
  into v_submission
  from public."Hair_Submissions" hs
  where upper(trim(coalesce(hs."Submission_Code", ''))) = v_waybill_code
  for update;

  if v_submission."Submission_ID" is null then
    raise exception 'No hair submission matched waybill %.', v_waybill_code;
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
    "Updated_At" = timezone('Asia/Manila', now())
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  perform public.recompute_event_request_hair_collected_count(v_submission."Event_Request_ID");

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
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
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'submission', to_jsonb(v_submission),
    'member_count', v_member_count,
    'ready_to_close', (v_member_count between 8 and 10)
  );
end;
$fn$;

create or replace function public.bundle_close_draft(
  p_bundle_id integer
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
  v_member_count integer := 0;
  v_code text;
begin
  if p_bundle_id is null then
    raise exception 'Bundle_ID is required.';
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
    raise exception 'Only specialist/admin can close bundle drafts.';
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

  select count(*)::integer
  into v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  if v_member_count < 8 or v_member_count > 10 then
    raise exception 'Bundle must contain 8-10 hairs before closing. Current count: %.', v_member_count;
  end if;

  v_code := coalesce(
    nullif(trim(v_bundle."Bundle_Waybill_Code"), ''),
    public.get_bundle_waybill_code(v_bundle."Bundle_ID", v_bundle."Created_At")
  );

  update public."Hair_Submission_Bundles"
  set
    "Status" = 'In Production',
    "Bundle_Waybill_Code" = v_code,
    "Bundle_Waybill_Printed_At" = timezone('Asia/Manila', now()),
    "Bundle_Waybill_Printed_By" = v_user.user_id,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  update public."Hair_Submissions"
  set
    "Status" = 'Wig In Production',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
    and public.normalize_flow_key("Status") not in ('wigcreated', 'cancelled');

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.close_draft',
    format(
      'Closed bundle_id=%s with %s hairs; waybill=%s',
      p_bundle_id,
      v_member_count,
      v_code
    ),
    v_user.email,
    'Hair_Submission_Bundles',
    'success'
  );

  return jsonb_build_object(
    'bundle', to_jsonb(v_bundle),
    'member_count', v_member_count
  );
end;
$fn$;

grant execute on function public.scan_event_attendee_rsvp(integer, text) to authenticated;
grant execute on function public.scan_non_event_hair_submission(text, text) to authenticated;
grant execute on function public.create_hair_bundle_draft(integer, text, text) to authenticated;
grant execute on function public.bundle_scan_add_waybill(integer, text) to authenticated;
grant execute on function public.bundle_close_draft(integer) to authenticated;

commit;
