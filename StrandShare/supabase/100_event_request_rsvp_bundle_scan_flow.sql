-- 100_event_request_rsvp_bundle_scan_flow.sql
-- Event-request-native RSVP + bundle scan workflow.
--
-- Core rules implemented:
-- 1) Staff RSVP scan is one-time only (no re-scan).
-- 2) RSVP scan marks attendee Present and advances Hair_Submissions status.
-- 3) Specialist bundles by scanning waybill codes (8-10 hairs only).
-- 4) Each successful bundle scan updates Event_Requests.Hair_Collected_Count.
-- 5) Bundle close generates/locks bundle waybill metadata.

begin;

create or replace function public.normalize_flow_key(p_value text)
returns text
language sql
immutable
as $fn$
  select lower(
    replace(
      replace(
        replace(coalesce(p_value, ''), '_', ''),
        ' ',
        ''
      ),
      '-',
      ''
    )
  )
$fn$;

alter table public."Hair_Submissions"
  add column if not exists "Event_Request_ID" integer null;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Hair_Submissions'
      and column_name = 'Donation_Drive_ID'
  ) then
    update public."Hair_Submissions" hs
    set "Event_Request_ID" = ea."Event_Request_ID"
    from public."Event_Attendees" ea
    where hs."Event_Request_ID" is null
      and hs."User_ID" = ea."User_ID"
      and hs."Submission_Code" is not null
      and ea."Waybill_Code" is not null
      and upper(trim(hs."Submission_Code")) = upper(trim(ea."Waybill_Code"));
  end if;
end
$$;

alter table public."Hair_Submissions"
  drop constraint if exists hair_submissions_event_request_fkey;

alter table public."Hair_Submissions"
  add constraint hair_submissions_event_request_fkey
  foreign key ("Event_Request_ID")
  references public."Event_Requests" ("Event_Request_ID")
  on delete set null;

create index if not exists idx_hair_submissions_event_request_id
  on public."Hair_Submissions" ("Event_Request_ID");

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'Hair_Submissions'
      and indexname = 'uq_hair_submissions_user_event_request'
  ) then
    if exists (
      select 1
      from public."Hair_Submissions"
      where "Event_Request_ID" is not null
      group by "User_ID", "Event_Request_ID"
      having count(*) > 1
    ) then
      raise notice 'Skipped unique index uq_hair_submissions_user_event_request because duplicate rows already exist.';
    else
      create unique index uq_hair_submissions_user_event_request
        on public."Hair_Submissions" ("User_ID", "Event_Request_ID")
        where "Event_Request_ID" is not null;
    end if;
  end if;
end
$$;

alter table public."Event_Requests"
  add column if not exists "Hair_Collected_Count" integer not null default 0;

alter table public."Hair_Submission_Bundles"
  add column if not exists "Wig_Specification_ID" integer null,
  add column if not exists "Target_Cap_Size" character varying(20) null,
  add column if not exists "Hair_Item_Count" integer not null default 0,
  add column if not exists "Bundle_Waybill_Code" character varying(64) null,
  add column if not exists "Bundle_Waybill_Printed_At" timestamp without time zone null,
  add column if not exists "Bundle_Waybill_Printed_By" integer null;

alter table public."Hair_Submission_Bundles"
  drop constraint if exists hair_submission_bundles_wig_specification_fkey;

alter table public."Hair_Submission_Bundles"
  add constraint hair_submission_bundles_wig_specification_fkey
  foreign key ("Wig_Specification_ID")
  references public."Wig_Specifications" ("Wig_Specification_ID")
  on delete set null;

alter table public."Hair_Submission_Bundles"
  drop constraint if exists hair_submission_bundles_waybill_printed_by_fkey;

alter table public."Hair_Submission_Bundles"
  add constraint hair_submission_bundles_waybill_printed_by_fkey
  foreign key ("Bundle_Waybill_Printed_By")
  references public.users(user_id)
  on delete set null;

create index if not exists idx_hair_submission_bundles_wig_specification_id
  on public."Hair_Submission_Bundles" ("Wig_Specification_ID");

create unique index if not exists uq_hair_submission_bundles_waybill_code
  on public."Hair_Submission_Bundles" ("Bundle_Waybill_Code")
  where "Bundle_Waybill_Code" is not null;

create or replace function public.get_bundle_waybill_code(
  p_bundle_id integer,
  p_created_at timestamp without time zone default null
)
returns text
language sql
stable
as $fn$
  select
    case
      when p_bundle_id is null or p_bundle_id <= 0 then null
      else 'WB-' || to_char(coalesce(p_created_at, now()), 'YYYY') || '-' || lpad(p_bundle_id::text, 6, '0')
    end
$fn$;

create or replace function public.recompute_event_request_hair_collected_count(
  p_event_request_id integer
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  if p_event_request_id is null then
    return;
  end if;

  select count(*)::integer
  into v_count
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" = p_event_request_id
    and hs."Bundle_ID" is not null;

  update public."Event_Requests"
  set "Hair_Collected_Count" = coalesce(v_count, 0)
  where "Event_Request_ID" = p_event_request_id;
end;
$fn$;

create or replace function public.refresh_event_request_hair_collected_count_after_submission_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_event_request_hair_collected_count(old."Event_Request_ID");
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.recompute_event_request_hair_collected_count(new."Event_Request_ID");
    return new;
  end if;

  if old."Event_Request_ID" is distinct from new."Event_Request_ID" then
    perform public.recompute_event_request_hair_collected_count(old."Event_Request_ID");
    perform public.recompute_event_request_hair_collected_count(new."Event_Request_ID");
  elsif old."Bundle_ID" is distinct from new."Bundle_ID" then
    perform public.recompute_event_request_hair_collected_count(new."Event_Request_ID");
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_refresh_event_request_hair_collected_count_iud on public."Hair_Submissions";
create trigger trg_refresh_event_request_hair_collected_count_iud
after insert or update of "Bundle_ID", "Event_Request_ID" or delete
on public."Hair_Submissions"
for each row
execute function public.refresh_event_request_hair_collected_count_after_submission_change();

update public."Event_Requests" er
set "Hair_Collected_Count" = coalesce(summary.total, 0)
from (
  select hs."Event_Request_ID", count(*)::integer as total
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" is not null
    and hs."Bundle_ID" is not null
  group by hs."Event_Request_ID"
) as summary
where er."Event_Request_ID" = summary."Event_Request_ID";

update public."Event_Requests"
set "Hair_Collected_Count" = 0
where "Event_Request_ID" not in (
  select distinct hs."Event_Request_ID"
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" is not null
    and hs."Bundle_ID" is not null
);

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
  update public."Hair_Submissions"
  set
    "Event_Request_ID" = coalesce("Event_Request_ID", p_event_request_id),
    "Submission_Code" = coalesce(nullif("Submission_Code", ''), v_resolved_waybill),
    "Status" = case
      when v_status_key in ('', 'pending', 'draft') then 'Cut & Shipped'
      else "Status"
    end,
    "Updated_At" = v_now
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  update public."Hair_Submission_Details"
  set
    "Updated_By" = v_user.user_id,
    "Updated_At" = v_now,
    "Current_Tracking_Status" = case
      when public.normalize_flow_key("Current_Tracking_Status") in ('draft', 'qrgenerated', 'readyforshipping')
        then 'Submitted'
      else "Current_Tracking_Status"
    end
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

  if not exists (
    select 1
    from public."Wig_Specifications" ws
    where ws."Wig_Specification_ID" = p_wig_specification_id
  ) then
    raise exception 'Wig specification % does not exist.', p_wig_specification_id;
  end if;

  insert into public."Hair_Submission_Bundles" (
    "Created_By",
    "Status",
    "Notes",
    "Wig_Specification_ID",
    "Target_Cap_Size",
    "Draft_Submission_IDs",
    "Hair_Item_Count"
  )
  values (
    v_user.user_id,
    'Draft',
    nullif(trim(coalesce(p_notes, '')), ''),
    p_wig_specification_id,
    nullif(trim(coalesce(p_cap_size_override, '')), ''),
    '[]'::jsonb,
    0
  )
  returning * into v_bundle;

  insert into public.audit_logs (user_id, action, description, user_email, resource, status)
  values (
    v_user.user_id,
    'hair_submission_bundles.open_draft',
    format(
      'Opened bundle draft bundle_id=%s wig_specification_id=%s cap_size_override=%s',
      v_bundle."Bundle_ID",
      p_wig_specification_id,
      coalesce(nullif(trim(coalesce(p_cap_size_override, '')), ''), 'N/A')
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
  v_draft_ids jsonb := '[]'::jsonb;
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
  if v_status_key in ('rejected', 'cancelled', 'wigcreated') then
    raise exception 'Waybill % cannot be bundled while status is %.', v_waybill_code, coalesce(v_submission."Status", 'N/A');
  end if;

  update public."Hair_Submissions"
  set
    "Bundle_ID" = p_bundle_id,
    "Status" = 'Bundled',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Submission_ID" = v_submission."Submission_ID"
  returning * into v_submission;

  select
    coalesce(jsonb_agg(hs."Submission_ID" order by hs."Submission_ID"), '[]'::jsonb),
    count(*)::integer
  into v_draft_ids, v_member_count
  from public."Hair_Submissions" hs
  where hs."Bundle_ID" = p_bundle_id;

  update public."Hair_Submission_Bundles"
  set
    "Hair_Item_Count" = v_member_count,
    "Draft_Submission_IDs" = v_draft_ids,
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
    nullif(trim(v_bundle."Submission_Code"), ''),
    public.get_bundle_waybill_code(v_bundle."Bundle_ID", v_bundle."Created_At")
  );

  update public."Hair_Submission_Bundles"
  set
    "Status" = 'In Production',
    "Hair_Item_Count" = v_member_count,
    "Submission_Code" = v_code,
    "Bundle_Waybill_Code" = v_code,
    "Bundle_Waybill_Printed_At" = timezone('Asia/Manila', now()),
    "Bundle_Waybill_Printed_By" = v_user.user_id,
    "Draft_Submission_IDs" = '[]'::jsonb,
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
  returning * into v_bundle;

  update public."Hair_Submissions"
  set
    "Status" = 'Bundled',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Bundle_ID" = p_bundle_id
    and public.normalize_flow_key("Status") <> 'wigcreated';

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
grant execute on function public.create_hair_bundle_draft(integer, text, text) to authenticated;
grant execute on function public.bundle_scan_add_waybill(integer, text) to authenticated;
grant execute on function public.bundle_close_draft(integer) to authenticated;
grant execute on function public.recompute_event_request_hair_collected_count(integer) to authenticated;

commit;
