-- 102_hair_submissions_from_event_and_non_event_scan.sql
-- Purpose:
-- 1) Keep Submission_Code as the canonical waybill/QR key.
-- 2) Replace Donation_Source with boolean From_Event.
-- 3) Remove unused legacy columns from Hair_Submissions.
-- 4) Add RPC for non-event donation QR scanning/intake.

begin;

-- ------------------------------------------------------------
-- Hair_Submissions schema cleanup
-- ------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Hair_Submissions'
      and column_name = 'Donation_Source'
  ) then
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'Hair_Submissions'
        and column_name = 'From_Event'
    ) then
      execute 'alter table public."Hair_Submissions" rename column "Donation_Source" to "From_Event"';
    else
      update public."Hair_Submissions"
      set "From_Event" = case
        when lower(trim(coalesce("Donation_Source", ''))) in ('true', 't', '1', 'yes', 'y', 'event', 'fromevent') then true
        when lower(trim(coalesce("Donation_Source", ''))) in ('false', 'f', '0', 'no', 'n', 'nonevent', 'non-event', 'walkin', 'walk-in') then false
        else coalesce("From_Event", true)
      end
      where "Donation_Source" is not null;

      execute 'alter table public."Hair_Submissions" drop column "Donation_Source"';
    end if;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'Hair_Submissions'
      and column_name = 'From_Event'
  ) then
    alter table public."Hair_Submissions"
      alter column "From_Event" type boolean
      using case
        when "From_Event" is null then true
        when trim("From_Event"::text) = '' then true
        when lower(trim("From_Event"::text)) in ('true', 't', '1', 'yes', 'y', 'event', 'fromevent') then true
        when lower(trim("From_Event"::text)) in ('false', 'f', '0', 'no', 'n', 'nonevent', 'non-event', 'walkin', 'walk-in') then false
        else true
      end;
  else
    alter table public."Hair_Submissions"
      add column "From_Event" boolean not null default true;
  end if;
end
$$;

alter table public."Hair_Submissions"
  alter column "From_Event" set default true,
  alter column "From_Event" set not null;

-- Optional but useful for reports/filters.
create index if not exists idx_hair_submissions_from_event
  on public."Hair_Submissions" ("From_Event");

-- Remove columns not used by current flow.
alter table public."Hair_Submissions"
  drop column if exists "Recipient_Type",
  drop column if exists "Submitted_At",
  drop column if exists "Cancelled_At";

-- ------------------------------------------------------------
-- Non-event intake QR scan RPC
-- ------------------------------------------------------------

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

      if public.normalize_flow_key(v_submission."Status") in ('cancelled', 'rejected', 'wigcreated') then
        raise exception 'Submission % cannot be scanned while status is %.', v_submission_code, coalesce(v_submission."Status", 'N/A');
      end if;

      update public."Hair_Submissions"
      set
        "From_Event" = false,
        "Status" = case
          when public.normalize_flow_key("Status") in ('', 'pending', 'draft') then 'Cut & Shipped'
          else "Status"
        end,
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
      "From_Event"
    )
    values (
      v_user_id,
      'Cut & Shipped',
      v_now,
      v_now,
      nullif(v_submission_code, ''),
      null,
      false
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

grant execute on function public.scan_non_event_hair_submission(text, text) to authenticated;

commit;
