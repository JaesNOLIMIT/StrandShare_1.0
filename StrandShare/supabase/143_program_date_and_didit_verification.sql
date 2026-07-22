-- 143_program_date_and_didit_verification.sql
-- Adds server-trusted Didit verification data and reserves every calendar date
-- covered by a non-rejected program application.

begin;

create table if not exists public."Didit_Verification_Sessions" (
  "Session_ID" uuid primary key,
  "Client_Token_Hash" text not null,
  "Vendor_Data" text not null unique,
  "Status" character varying(50) not null default 'Not Started',
  "Document_Data" jsonb,
  "Warnings" jsonb not null default '[]'::jsonb,
  "Event_Application_ID" integer unique,
  "Consumed_At" timestamp without time zone,
  "Verified_At" timestamp without time zone,
  "Created_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  "Updated_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  constraint didit_verification_sessions_event_application_fkey
    foreign key ("Event_Application_ID")
    references public."Event_Applications" ("Event_Application_ID")
    on delete set null
);

alter table public."Didit_Verification_Sessions" enable row level security;

-- No browser-facing policies are created. Only the service-role Edge Function
-- can create or update these verification records.
revoke all on table public."Didit_Verification_Sessions" from anon, authenticated;

alter table public."Event_Applications"
  add column if not exists "Applicant_Valid_ID_Type" character varying(80),
  add column if not exists "Didit_Session_ID" uuid,
  add column if not exists "Didit_Verification_Status" character varying(50),
  add column if not exists "Didit_Verified_At" timestamp without time zone,
  add column if not exists "Applicant_Date_Of_Birth" date,
  add column if not exists "Applicant_ID_Document_Number" character varying(150),
  add column if not exists "Applicant_ID_Personal_Number" character varying(150),
  add column if not exists "Applicant_ID_Issue_Date" date,
  add column if not exists "Applicant_ID_Expiration_Date" date,
  add column if not exists "Applicant_ID_Issuing_Country" character varying(120),
  add column if not exists "Applicant_ID_Nationality" character varying(120),
  add column if not exists "Applicant_ID_Address" text,
  add column if not exists "Applicant_ID_Place_Of_Birth" character varying(255),
  add column if not exists "Applicant_ID_Marital_Status" character varying(80),
  add column if not exists "Applicant_ID_Extra_Fields" jsonb,
  add column if not exists "Applicant_ID_Verification_Warnings" jsonb not null default '[]'::jsonb;

create unique index if not exists idx_event_applications_didit_session_unique
  on public."Event_Applications" ("Didit_Session_ID")
  where "Didit_Session_ID" is not null;

create or replace function public.normalize_didit_document_type(
  document_type text,
  document_subtype text
)
returns text
language sql
immutable
as $$
  select case
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%passport%' then 'passport'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%driver%' then 'drivers_license'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%philsys%'
      or lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%national%id%' then 'philsys'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%umid%'
      or lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%unified%multi%purpose%' then 'umid'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%professional%regulation%'
      or lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%prc%' then 'prc'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%postal%' then 'postal'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%voter%' then 'voters'
    when lower(coalesce(document_type, '') || ' ' || coalesce(document_subtype, '')) like '%senior%' then 'senior_citizen'
    else 'other_government'
  end;
$$;

create or replace function public.attach_approved_didit_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  verified_session public."Didit_Verification_Sessions"%rowtype;
  document_data jsonb;
begin
  if new."Didit_Session_ID" is null then
    raise exception 'Approved Didit ID verification is required before submitting a program application.';
  end if;

  select dvs.*
  into verified_session
  from public."Didit_Verification_Sessions" dvs
  where dvs."Session_ID" = new."Didit_Session_ID"
    and lower(replace(coalesce(dvs."Status", ''), ' ', '')) = 'approved'
    and dvs."Event_Application_ID" is null
    and dvs."Consumed_At" is null
  for update;

  if verified_session."Session_ID" is null then
    raise exception 'Didit verification is not approved, is invalid, or has already been used.';
  end if;

  document_data := coalesce(verified_session."Document_Data", '{}'::jsonb);
  new."Didit_Verification_Status" := 'Approved';
  new."Didit_Verified_At" := verified_session."Verified_At";
  new."Applicant_Date_Of_Birth" := coalesce(new."Applicant_Date_Of_Birth", nullif(document_data ->> 'date_of_birth', '')::date);
  new."Applicant_ID_Document_Number" := coalesce(nullif(trim(new."Applicant_ID_Document_Number"), ''), nullif(document_data ->> 'document_number', ''));
  new."Applicant_ID_Personal_Number" := coalesce(nullif(trim(new."Applicant_ID_Personal_Number"), ''), nullif(document_data ->> 'personal_number', ''));
  new."Applicant_ID_Issue_Date" := coalesce(new."Applicant_ID_Issue_Date", nullif(document_data ->> 'date_of_issue', '')::date);
  new."Applicant_ID_Expiration_Date" := coalesce(new."Applicant_ID_Expiration_Date", nullif(document_data ->> 'expiration_date', '')::date);
  new."Applicant_ID_Issuing_Country" := coalesce(
    nullif(trim(new."Applicant_ID_Issuing_Country"), ''),
    nullif(document_data ->> 'issuing_state_name', ''),
    nullif(document_data ->> 'issuing_state', '')
  );
  new."Applicant_ID_Nationality" := coalesce(nullif(trim(new."Applicant_ID_Nationality"), ''), nullif(document_data ->> 'nationality', ''));
  new."Applicant_ID_Address" := coalesce(
    nullif(trim(new."Applicant_ID_Address"), ''),
    nullif(document_data ->> 'formatted_address', ''),
    nullif(document_data ->> 'address', '')
  );
  new."Applicant_ID_Place_Of_Birth" := coalesce(nullif(trim(new."Applicant_ID_Place_Of_Birth"), ''), nullif(document_data ->> 'place_of_birth', ''));
  new."Applicant_ID_Marital_Status" := coalesce(nullif(trim(new."Applicant_ID_Marital_Status"), ''), nullif(document_data ->> 'marital_status', ''));
  new."Applicant_ID_Extra_Fields" := coalesce(document_data -> 'extra_fields', '{}'::jsonb);
  new."Applicant_ID_Verification_Warnings" := coalesce(verified_session."Warnings", '[]'::jsonb);

  if nullif(trim(coalesce(new."Applicant_Valid_ID_Type", '')), '') is null
     or new."Applicant_Valid_ID_Type" = 'other_government' then
    new."Applicant_Valid_ID_Type" := public.normalize_didit_document_type(
      document_data ->> 'document_type',
      document_data ->> 'document_subtype'
    );
  end if;

  return new;
end;
$$;

create or replace function public.claim_approved_didit_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public."Didit_Verification_Sessions"
  set
    "Event_Application_ID" = new."Event_Application_ID",
    "Consumed_At" = timezone('Asia/Manila', now()),
    "Updated_At" = timezone('Asia/Manila', now())
  where "Session_ID" = new."Didit_Session_ID"
    and "Event_Application_ID" is null
    and "Consumed_At" is null;

  if not found then
    raise exception 'Didit verification has already been used by another application.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_attach_approved_didit_verification on public."Event_Applications";
create trigger trg_attach_approved_didit_verification
  before insert on public."Event_Applications"
  for each row
  execute function public.attach_approved_didit_verification();

drop trigger if exists trg_claim_approved_didit_verification on public."Event_Applications";
create trigger trg_claim_approved_didit_verification
  after insert on public."Event_Applications"
  for each row
  execute function public.claim_approved_didit_verification();

-- An exclusion constraint cannot be introduced while legacy active rows
-- already overlap. Use transaction-scoped advisory locks plus a trigger so
-- existing data remains untouched while all new/rescheduled dates are safe
-- from both ordinary conflicts and simultaneous submissions.
alter table public."Event_Applications"
  drop constraint if exists event_applications_one_active_program_per_date;

create or replace function public.enforce_one_active_program_per_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_status_key text;
  old_status_key text;
  proposed_start_date date;
  proposed_end_date date;
  reserved_day date;
  conflicting_application_id integer;
begin
  new_status_key := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));

  -- Staff rejection is the only state that releases the application's dates.
  if new_status_key = 'rejected' or new."Proposed_Start_At" is null then
    return new;
  end if;

  proposed_start_date := new."Proposed_Start_At"::date;
  proposed_end_date := coalesce(new."Proposed_End_At", new."Proposed_Start_At")::date;

  if proposed_end_date < proposed_start_date then
    raise exception 'Proposed end cannot be earlier than proposed start.';
  end if;

  if tg_op = 'UPDATE' then
    old_status_key := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));

    -- Preserve updates to legacy overlapping applications unless an update
    -- newly activates or changes the occupied date range.
    if old_status_key <> 'rejected'
       and new_status_key <> 'rejected'
       and new."Proposed_Start_At" is not distinct from old."Proposed_Start_At"
       and new."Proposed_End_At" is not distinct from old."Proposed_End_At" then
      return new;
    end if;
  end if;

  -- Always acquire locks in ascending date order to prevent deadlocks when
  -- two multi-day applications overlap only on part of their ranges.
  for reserved_day in
    select generated_day::date
    from generate_series(proposed_start_date, proposed_end_date, interval '1 day') generated_day
    order by generated_day
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('strandshare-program-date:' || reserved_day::text, 0)
    );
  end loop;

  select ea."Event_Application_ID"
  into conflicting_application_id
  from public."Event_Applications" ea
  where ea."Event_Application_ID" is distinct from new."Event_Application_ID"
    and ea."Proposed_Start_At" is not null
    and lower(replace(replace(replace(coalesce(ea."Status", ''), '_', ''), ' ', ''), '-', '')) <> 'rejected'
    and ea."Proposed_Start_At"::date <= proposed_end_date
    and coalesce(ea."Proposed_End_At", ea."Proposed_Start_At")::date >= proposed_start_date
  order by ea."Created_At", ea."Event_Application_ID"
  limit 1;

  if conflicting_application_id is not null then
    raise exception using
      errcode = '23P01',
      message = format(
        'Selected program date is already reserved by application EA-%s. Choose another date or wait until staff rejects that application.',
        conflicting_application_id
      );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_one_active_program_per_date on public."Event_Applications";
create trigger trg_enforce_one_active_program_per_date
  before insert or update on public."Event_Applications"
  for each row
  execute function public.enforce_one_active_program_per_date();

create or replace function public.get_unavailable_program_dates(
  p_from_date date default (timezone('Asia/Manila', now()))::date
)
returns table (program_date date)
language sql
stable
security definer
set search_path = public
as $$
  select distinct occupied_day::date as program_date
  from public."Event_Applications" ea
  cross join lateral generate_series(
    ea."Proposed_Start_At"::date,
    coalesce(ea."Proposed_End_At", ea."Proposed_Start_At")::date,
    interval '1 day'
  ) occupied_day
  where ea."Proposed_Start_At" is not null
    and lower(replace(replace(replace(coalesce(ea."Status", ''), '_', ''), ' ', ''), '-', '')) <> 'rejected'
    and occupied_day::date >= coalesce(p_from_date, (timezone('Asia/Manila', now()))::date)
  order by program_date;
$$;

revoke all on function public.get_unavailable_program_dates(date) from public;
grant execute on function public.get_unavailable_program_dates(date) to anon, authenticated;

commit;
