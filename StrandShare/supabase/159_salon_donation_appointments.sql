-- Salon walk-in donation scheduling.
-- One salon is used; its displayed address comes from Logistics_Settings.
-- Donors book from the phone flow, while staff manage the calendar in the web portal.

begin;

create table if not exists public."Salon_Operating_Hours" (
  "Operating_Hours_ID" integer generated always as identity primary key,
  "Day_Group" character varying(20) not null,
  "Is_Open" boolean not null default true,
  "Opening_Time" time without time zone not null default '09:00',
  "Closing_Time" time without time zone not null default '17:00',
  "Break_Start_Time" time without time zone null,
  "Break_End_Time" time without time zone null,
  "Appointment_Duration_Minutes" integer not null default 60,
  "Buffer_Minutes" integer not null default 30,
  "Late_Grace_Minutes" integer not null default 15,
  "Capacity_Per_Slot" integer not null default 3,
  "Minimum_Booking_Notice_Days" integer not null default 1,
  "Maximum_Booking_Days" integer not null default 30,
  "Updated_By" integer null references public.users(user_id) on delete set null,
  "Updated_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  constraint salon_operating_hours_day_group_check
    check ("Day_Group" in ('Weekday', 'Weekend')),
  constraint salon_operating_hours_time_check
    check ("Closing_Time" > "Opening_Time"),
  constraint salon_operating_hours_break_check
    check (
      ("Break_Start_Time" is null and "Break_End_Time" is null)
      or (
        "Break_Start_Time" is not null
        and "Break_End_Time" is not null
        and "Break_End_Time" > "Break_Start_Time"
        and "Break_Start_Time" >= "Opening_Time"
        and "Break_End_Time" <= "Closing_Time"
      )
    ),
  constraint salon_operating_hours_duration_check
    check ("Appointment_Duration_Minutes" between 15 and 480),
  constraint salon_operating_hours_buffer_check
    check ("Buffer_Minutes" between 0 and 240),
  constraint salon_operating_hours_grace_check
    check ("Late_Grace_Minutes" between 0 and 120),
  constraint salon_operating_hours_capacity_check
    check ("Capacity_Per_Slot" between 1 and 20),
  constraint salon_operating_hours_notice_check
    check ("Minimum_Booking_Notice_Days" between 0 and 30),
  constraint salon_operating_hours_maximum_check
    check ("Maximum_Booking_Days" between 1 and 365)
);

create unique index if not exists uq_salon_operating_hours_day_group
  on public."Salon_Operating_Hours" ("Day_Group");

insert into public."Salon_Operating_Hours" (
  "Day_Group",
  "Is_Open",
  "Opening_Time",
  "Closing_Time",
  "Appointment_Duration_Minutes",
  "Buffer_Minutes",
  "Late_Grace_Minutes",
  "Capacity_Per_Slot",
  "Minimum_Booking_Notice_Days",
  "Maximum_Booking_Days"
)
values
  ('Weekday', true, '09:00', '17:00', 60, 30, 15, 3, 1, 30),
  ('Weekend', true, '09:00', '17:00', 60, 30, 15, 3, 1, 30)
on conflict ("Day_Group") do nothing;

create table if not exists public."Salon_Schedule_Overrides" (
  "Schedule_Override_ID" integer generated always as identity primary key,
  "Override_Date" date not null,
  "Is_Closed" boolean not null default true,
  "Opening_Time" time without time zone null,
  "Closing_Time" time without time zone null,
  "Break_Start_Time" time without time zone null,
  "Break_End_Time" time without time zone null,
  "Capacity_Per_Slot" integer null,
  "Reason" text null,
  "Created_By" integer null references public.users(user_id) on delete set null,
  "Created_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  "Updated_By" integer null references public.users(user_id) on delete set null,
  "Updated_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  constraint salon_schedule_overrides_special_hours_check
    check (
      "Is_Closed"
      or (
        "Opening_Time" is not null
        and "Closing_Time" is not null
        and "Closing_Time" > "Opening_Time"
      )
    ),
  constraint salon_schedule_overrides_break_check
    check (
      ("Break_Start_Time" is null and "Break_End_Time" is null)
      or (
        not "Is_Closed"
        and "Break_Start_Time" is not null
        and "Break_End_Time" is not null
        and "Break_End_Time" > "Break_Start_Time"
        and "Break_Start_Time" >= "Opening_Time"
        and "Break_End_Time" <= "Closing_Time"
      )
    ),
  constraint salon_schedule_overrides_capacity_check
    check ("Capacity_Per_Slot" is null or "Capacity_Per_Slot" between 1 and 20)
);

create unique index if not exists uq_salon_schedule_overrides_date
  on public."Salon_Schedule_Overrides" ("Override_Date");

create index if not exists idx_salon_schedule_overrides_date
  on public."Salon_Schedule_Overrides" ("Override_Date");

create table if not exists public."Salon_Donation_Appointments" (
  "Appointment_ID" integer generated always as identity primary key,
  "User_ID" integer not null references public.users(user_id),
  "Appointment_Start_At" timestamp without time zone not null,
  "Appointment_End_At" timestamp without time zone not null,
  "Status" character varying(30) not null default 'Confirmed',
  "Contact_Name" character varying(255) not null,
  "Contact_Email" character varying(255) null,
  "Contact_Number" character varying(50) not null,
  "Hair_Details" jsonb not null default '{}'::jsonb,
  "Screening_Answers" jsonb not null default '{}'::jsonb,
  "Donor_Notes" text null,
  "Is_Minor" boolean not null default false,
  "Guardian_Consent_ID" integer null
    references public.guardian_consents(guardian_consent_id) on delete set null,
  "Consent_Legal_Document_ID" integer null
    references public.legal_documents(legal_document_id) on delete set null,
  "Hair_Submission_ID" integer null
    references public."Hair_Submissions"("Submission_ID") on delete set null,
  "Booking_Source" character varying(30) not null default 'Mobile',
  "Checked_In_At" timestamp without time zone null,
  "Completed_At" timestamp without time zone null,
  "Cancelled_At" timestamp without time zone null,
  "Cancellation_Reason" text null,
  "Created_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  "Updated_At" timestamp without time zone not null default timezone('Asia/Manila', now()),
  constraint salon_donation_appointments_time_check
    check ("Appointment_End_At" > "Appointment_Start_At"),
  constraint salon_donation_appointments_status_check
    check (
      "Status" in (
        'Confirmed',
        'Rescheduled',
        'Checked In',
        'Completed',
        'Cancelled',
        'No Show'
      )
    ),
  constraint salon_donation_appointments_hair_details_object_check
    check (jsonb_typeof("Hair_Details") = 'object'),
  constraint salon_donation_appointments_screening_object_check
    check (jsonb_typeof("Screening_Answers") = 'object')
);

create index if not exists idx_salon_appointments_start
  on public."Salon_Donation_Appointments" ("Appointment_Start_At");

create index if not exists idx_salon_appointments_user
  on public."Salon_Donation_Appointments" ("User_ID");

create index if not exists idx_salon_appointments_status_start
  on public."Salon_Donation_Appointments" ("Status", "Appointment_Start_At");

create unique index if not exists uq_salon_appointments_hair_submission
  on public."Salon_Donation_Appointments" ("Hair_Submission_ID")
  where "Hair_Submission_ID" is not null;

create unique index if not exists uq_salon_appointments_active_user_date
  on public."Salon_Donation_Appointments" (
    "User_ID",
    (("Appointment_Start_At")::date)
  )
  where "Status" in ('Confirmed', 'Rescheduled', 'Checked In');

create table if not exists public."Salon_Appointment_Status_History" (
  "Status_History_ID" integer generated always as identity primary key,
  "Appointment_ID" integer not null
    references public."Salon_Donation_Appointments"("Appointment_ID") on delete cascade,
  "From_Status" character varying(30) null,
  "To_Status" character varying(30) not null,
  "Change_Type" character varying(30) not null default 'Status Change',
  "Old_Start_At" timestamp without time zone null,
  "New_Start_At" timestamp without time zone null,
  "Notes" text null,
  "Changed_By" integer null references public.users(user_id) on delete set null,
  "Changed_At" timestamp without time zone not null default timezone('Asia/Manila', now())
);

create index if not exists idx_salon_appointment_history_appointment
  on public."Salon_Appointment_Status_History" ("Appointment_ID", "Changed_At" desc);

create or replace function public.set_salon_schedule_updated_fields()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_user_id integer;
begin
  select u.user_id into v_user_id
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  new."Updated_At" := timezone('Asia/Manila', now());
  if tg_table_name = 'Salon_Operating_Hours' then
    new."Updated_By" := coalesce(v_user_id, new."Updated_By");
  elsif tg_table_name = 'Salon_Schedule_Overrides' then
    new."Updated_By" := coalesce(v_user_id, new."Updated_By");
    if tg_op = 'INSERT' then
      new."Created_By" := coalesce(v_user_id, new."Created_By");
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_salon_operating_hours_updated on public."Salon_Operating_Hours";
create trigger trg_salon_operating_hours_updated
before insert or update on public."Salon_Operating_Hours"
for each row execute function public.set_salon_schedule_updated_fields();

drop trigger if exists trg_salon_schedule_overrides_updated on public."Salon_Schedule_Overrides";
create trigger trg_salon_schedule_overrides_updated
before insert or update on public."Salon_Schedule_Overrides"
for each row execute function public.set_salon_schedule_updated_fields();

create or replace function public.record_salon_appointment_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id integer;
  v_change_type text;
begin
  select u.user_id into v_user_id
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if tg_op = 'INSERT' then
    insert into public."Salon_Appointment_Status_History" (
      "Appointment_ID",
      "From_Status",
      "To_Status",
      "Change_Type",
      "New_Start_At",
      "Changed_By"
    )
    values (
      new."Appointment_ID",
      null,
      new."Status",
      'Booked',
      new."Appointment_Start_At",
      v_user_id
    );
  elsif old."Status" is distinct from new."Status"
     or old."Appointment_Start_At" is distinct from new."Appointment_Start_At" then
    v_change_type := case
      when old."Appointment_Start_At" is distinct from new."Appointment_Start_At"
        then 'Rescheduled'
      else 'Status Change'
    end;
    insert into public."Salon_Appointment_Status_History" (
      "Appointment_ID",
      "From_Status",
      "To_Status",
      "Change_Type",
      "Old_Start_At",
      "New_Start_At",
      "Changed_By"
    )
    values (
      new."Appointment_ID",
      old."Status",
      new."Status",
      v_change_type,
      old."Appointment_Start_At",
      new."Appointment_Start_At",
      v_user_id
    );
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_salon_appointment_history on public."Salon_Donation_Appointments";
create trigger trg_salon_appointment_history
after insert or update of "Status", "Appointment_Start_At"
on public."Salon_Donation_Appointments"
for each row execute function public.record_salon_appointment_history();

create or replace function public.get_salon_available_slots(
  p_from_date date,
  p_to_date date
)
returns table (
  "Slot_Start_At" timestamp without time zone,
  "Slot_End_At" timestamp without time zone,
  "Capacity" integer,
  "Booked_Count" integer,
  "Remaining_Capacity" integer,
  "Is_Available" boolean,
  "Schedule_Source" text,
  "Appointment_Duration_Minutes" integer,
  "Buffer_Minutes" integer,
  "Late_Grace_Minutes" integer,
  "Minimum_Booking_Notice_Days" integer,
  "Maximum_Booking_Days" integer
)
language sql
stable
security definer
set search_path = public
as $fn$
  with requested_dates as (
    select gs::date as schedule_date
    from generate_series(
      greatest(coalesce(p_from_date, timezone('Asia/Manila', now())::date), timezone('Asia/Manila', now())::date),
      least(
        coalesce(p_to_date, coalesce(p_from_date, timezone('Asia/Manila', now())::date)),
        greatest(coalesce(p_from_date, timezone('Asia/Manila', now())::date), timezone('Asia/Manila', now())::date) + 62
      ),
      interval '1 day'
    ) gs
  ),
  effective_schedule as (
    select
      rd.schedule_date,
      oh."Appointment_Duration_Minutes" as duration_minutes,
      oh."Buffer_Minutes" as buffer_minutes,
      oh."Late_Grace_Minutes" as late_grace_minutes,
      oh."Minimum_Booking_Notice_Days" as minimum_notice_days,
      oh."Maximum_Booking_Days" as maximum_booking_days,
      coalesce(so."Capacity_Per_Slot", oh."Capacity_Per_Slot") as capacity,
      case when so."Schedule_Override_ID" is not null then 'Override' else oh."Day_Group" end as schedule_source,
      case
        when so."Schedule_Override_ID" is not null then not so."Is_Closed"
        else oh."Is_Open"
      end as is_open,
      coalesce(so."Opening_Time", oh."Opening_Time") as opening_time,
      coalesce(so."Closing_Time", oh."Closing_Time") as closing_time,
      coalesce(so."Break_Start_Time", oh."Break_Start_Time") as break_start_time,
      coalesce(so."Break_End_Time", oh."Break_End_Time") as break_end_time
    from requested_dates rd
    join public."Salon_Operating_Hours" oh
      on oh."Day_Group" = case
        when extract(isodow from rd.schedule_date) between 1 and 5 then 'Weekday'
        else 'Weekend'
      end
    left join public."Salon_Schedule_Overrides" so
      on so."Override_Date" = rd.schedule_date
  ),
  generated_slots as (
    select
      es.*,
      slot_start,
      slot_start + make_interval(mins => es.duration_minutes) as slot_end
    from effective_schedule es
    cross join lateral generate_series(
      es.schedule_date + es.opening_time,
      es.schedule_date + es.closing_time - make_interval(mins => es.duration_minutes),
      make_interval(mins => es.duration_minutes + es.buffer_minutes)
    ) slot_start
    where es.is_open
  ),
  usable_slots as (
    select gs.*
    from generated_slots gs
    where gs.break_start_time is null
       or not (
         gs.slot_start < gs.schedule_date + gs.break_end_time
         and gs.slot_end > gs.schedule_date + gs.break_start_time
       )
  ),
  counted_slots as (
    select
      us.*,
      (
        select count(*)::integer
        from public."Salon_Donation_Appointments" a
        where a."Appointment_Start_At" = us.slot_start
          and a."Status" in ('Confirmed', 'Rescheduled', 'Checked In')
      ) as booked_count
    from usable_slots us
  )
  select
    cs.slot_start,
    cs.slot_end,
    cs.capacity,
    cs.booked_count,
    greatest(cs.capacity - cs.booked_count, 0)::integer,
    cs.booked_count < cs.capacity,
    cs.schedule_source,
    cs.duration_minutes,
    cs.buffer_minutes,
    cs.late_grace_minutes,
    cs.minimum_notice_days,
    cs.maximum_booking_days
  from counted_slots cs
  order by cs.slot_start;
$fn$;

create or replace function public.book_salon_donation_appointment(
  p_start_at timestamp without time zone,
  p_contact_name text,
  p_contact_email text,
  p_contact_number text,
  p_hair_details jsonb default '{}'::jsonb,
  p_screening_answers jsonb default '{}'::jsonb,
  p_donor_notes text default null,
  p_guardian_consent_id integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_details public.user_details%rowtype;
  v_slot record;
  v_appointment public."Salon_Donation_Appointments"%rowtype;
  v_today date := timezone('Asia/Manila', now())::date;
  v_is_minor boolean := false;
  v_consent_document_id integer;
  v_guardian_consent public.guardian_consents%rowtype;
begin
  if p_start_at is null then
    raise exception 'Select an appointment time.';
  end if;
  if nullif(trim(coalesce(p_contact_name, '')), '') is null then
    raise exception 'Contact name is required.';
  end if;
  if nullif(trim(coalesce(p_contact_number, '')), '') is null then
    raise exception 'Contact number is required.';
  end if;
  if jsonb_typeof(coalesce(p_hair_details, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_screening_answers, '{}'::jsonb)) <> 'object' then
    raise exception 'Hair details and screening answers must be objects.';
  end if;

  select * into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;
  if v_user.user_id is null then
    raise exception 'A signed-in donor account is required.';
  end if;

  select * into v_details
  from public.user_details ud
  where ud.user_id = v_user.user_id
  limit 1;

  v_is_minor := v_details.birthdate is not null
    and v_details.birthdate > (v_today - interval '18 years')::date;

  select * into v_slot
  from public.get_salon_available_slots(p_start_at::date, p_start_at::date) s
  where s."Slot_Start_At" = p_start_at
  limit 1;
  if v_slot."Slot_Start_At" is null then
    raise exception 'The selected time is not part of the salon schedule.';
  end if;
  if p_start_at::date < v_today + v_slot."Minimum_Booking_Notice_Days" then
    raise exception 'Appointments must be booked at least % day(s) ahead.', v_slot."Minimum_Booking_Notice_Days";
  end if;
  if p_start_at::date > v_today + v_slot."Maximum_Booking_Days" then
    raise exception 'Appointments may be booked only % days ahead.', v_slot."Maximum_Booking_Days";
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_start_at::text, 0));

  if (
    select count(*)
    from public."Salon_Donation_Appointments" a
    where a."Appointment_Start_At" = p_start_at
      and a."Status" in ('Confirmed', 'Rescheduled', 'Checked In')
  ) >= v_slot."Capacity" then
    raise exception 'This appointment time has just become fully booked. Select another time.';
  end if;

  if exists (
    select 1
    from public."Salon_Donation_Appointments" a
    where a."User_ID" = v_user.user_id
      and a."Appointment_Start_At"::date = p_start_at::date
      and a."Status" in ('Confirmed', 'Rescheduled', 'Checked In')
  ) then
    raise exception 'You already have an active salon appointment on this date.';
  end if;

  if p_guardian_consent_id is not null then
    select * into v_guardian_consent
    from public.guardian_consents gc
    where gc.guardian_consent_id = p_guardian_consent_id
      and gc.user_id = v_user.user_id;
    if v_guardian_consent.guardian_consent_id is null then
      raise exception 'The selected guardian consent does not belong to this donor.';
    end if;
  end if;

  if v_is_minor then
    select ld.legal_document_id into v_consent_document_id
    from public.legal_documents ld
    where ld.document_type = 'consent_for_minors'
      and coalesce(ld.is_active, false)
      and coalesce(ld.effective_at, ld.created_at) <= timezone('Asia/Manila', now())
    order by coalesce(ld.effective_at, ld.created_at) desc, ld.legal_document_id desc
    limit 1;
  end if;

  insert into public."Salon_Donation_Appointments" (
    "User_ID",
    "Appointment_Start_At",
    "Appointment_End_At",
    "Status",
    "Contact_Name",
    "Contact_Email",
    "Contact_Number",
    "Hair_Details",
    "Screening_Answers",
    "Donor_Notes",
    "Is_Minor",
    "Guardian_Consent_ID",
    "Consent_Legal_Document_ID",
    "Booking_Source"
  )
  values (
    v_user.user_id,
    p_start_at,
    v_slot."Slot_End_At",
    'Confirmed',
    trim(p_contact_name),
    nullif(trim(coalesce(p_contact_email, '')), ''),
    trim(p_contact_number),
    coalesce(p_hair_details, '{}'::jsonb),
    coalesce(p_screening_answers, '{}'::jsonb),
    nullif(trim(coalesce(p_donor_notes, '')), ''),
    v_is_minor,
    p_guardian_consent_id,
    v_consent_document_id,
    'Mobile'
  )
  returning * into v_appointment;

  return jsonb_build_object(
    'appointment', to_jsonb(v_appointment),
    'remaining_capacity', greatest(v_slot."Remaining_Capacity" - 1, 0),
    'guardian_consent_required', v_is_minor and p_guardian_consent_id is null
  );
end;
$fn$;

create or replace function public.staff_reschedule_salon_appointment(
  p_appointment_id integer,
  p_new_start_at timestamp without time zone,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_staff public.users%rowtype;
  v_appointment public."Salon_Donation_Appointments"%rowtype;
  v_slot record;
begin
  select * into v_staff
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;
  if v_staff.user_id is null
     or public.normalize_app_role(v_staff.role) not in ('staff', 'admin') then
    raise exception 'Only staff/admin can reschedule salon appointments.';
  end if;

  select * into v_appointment
  from public."Salon_Donation_Appointments" a
  where a."Appointment_ID" = p_appointment_id
  for update;
  if v_appointment."Appointment_ID" is null then
    raise exception 'Appointment not found.';
  end if;
  if v_appointment."Status" not in ('Confirmed', 'Rescheduled') then
    raise exception 'Only confirmed appointments can be rescheduled.';
  end if;

  select * into v_slot
  from public.get_salon_available_slots(p_new_start_at::date, p_new_start_at::date) s
  where s."Slot_Start_At" = p_new_start_at
  limit 1;
  if v_slot."Slot_Start_At" is null then
    raise exception 'The selected time is not part of the salon schedule.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_new_start_at::text, 0));
  if (
    select count(*)
    from public."Salon_Donation_Appointments" a
    where a."Appointment_Start_At" = p_new_start_at
      and a."Appointment_ID" <> p_appointment_id
      and a."Status" in ('Confirmed', 'Rescheduled', 'Checked In')
  ) >= v_slot."Capacity" then
    raise exception 'The selected time is already full.';
  end if;

  update public."Salon_Donation_Appointments"
  set
    "Appointment_Start_At" = p_new_start_at,
    "Appointment_End_At" = v_slot."Slot_End_At",
    "Status" = 'Rescheduled',
    "Updated_At" = timezone('Asia/Manila', now())
  where "Appointment_ID" = p_appointment_id
  returning * into v_appointment;

  update public."Salon_Appointment_Status_History"
  set "Notes" = nullif(trim(coalesce(p_notes, '')), '')
  where "Status_History_ID" = (
    select h."Status_History_ID"
    from public."Salon_Appointment_Status_History" h
    where h."Appointment_ID" = p_appointment_id
    order by h."Changed_At" desc, h."Status_History_ID" desc
    limit 1
  );

  return jsonb_build_object('appointment', to_jsonb(v_appointment));
end;
$fn$;

create or replace function public.staff_update_salon_appointment_status(
  p_appointment_id integer,
  p_status text,
  p_notes text default null,
  p_guardian_consent_id integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_staff public.users%rowtype;
  v_appointment public."Salon_Donation_Appointments"%rowtype;
  v_status text := initcap(lower(trim(coalesce(p_status, ''))));
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_guardian_consent public.guardian_consents%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_hair jsonb;
begin
  if lower(replace(trim(coalesce(p_status, '')), ' ', '')) = 'checkedin' then
    v_status := 'Checked In';
  elsif lower(replace(trim(coalesce(p_status, '')), ' ', '')) = 'noshow' then
    v_status := 'No Show';
  end if;

  if v_status not in ('Confirmed', 'Checked In', 'Completed', 'Cancelled', 'No Show') then
    raise exception 'Unsupported appointment status.';
  end if;

  select * into v_staff
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;
  if v_staff.user_id is null
     or public.normalize_app_role(v_staff.role) not in ('staff', 'admin') then
    raise exception 'Only staff/admin can update salon appointments.';
  end if;

  select * into v_appointment
  from public."Salon_Donation_Appointments" a
  where a."Appointment_ID" = p_appointment_id
  for update;
  if v_appointment."Appointment_ID" is null then
    raise exception 'Appointment not found.';
  end if;
  if v_appointment."Status" in ('Completed', 'Cancelled', 'No Show') then
    raise exception 'This appointment is already final.';
  end if;

  if v_status = 'Checked In'
     and v_appointment."Status" not in ('Confirmed', 'Rescheduled') then
    raise exception 'Only a confirmed or rescheduled appointment can be checked in.';
  end if;
  if v_status = 'Completed'
     and v_appointment."Status" <> 'Checked In' then
    raise exception 'Check in the donor before completing the appointment.';
  end if;
  if v_status = 'No Show'
     and v_appointment."Status" not in ('Confirmed', 'Rescheduled') then
    raise exception 'Only a confirmed or rescheduled appointment can be marked no show.';
  end if;
  if v_status = 'Confirmed'
     and v_appointment."Status" <> 'Confirmed' then
    raise exception 'Use the reschedule action instead of changing this appointment back to confirmed.';
  end if;

  if p_guardian_consent_id is not null then
    select * into v_guardian_consent
    from public.guardian_consents gc
    where gc.guardian_consent_id = p_guardian_consent_id
      and gc.user_id = v_appointment."User_ID";
    if v_guardian_consent.guardian_consent_id is null then
      raise exception 'Guardian consent does not belong to this donor.';
    end if;
    update public."Salon_Donation_Appointments"
    set "Guardian_Consent_ID" = p_guardian_consent_id
    where "Appointment_ID" = p_appointment_id;
    v_appointment."Guardian_Consent_ID" := p_guardian_consent_id;
  end if;

  if v_status = 'Completed' then
    if v_appointment."Is_Minor" then
      select * into v_guardian_consent
      from public.guardian_consents gc
      where gc.guardian_consent_id = v_appointment."Guardian_Consent_ID"
        and gc.user_id = v_appointment."User_ID"
        and lower(coalesce(gc.consent_status, '')) = 'active'
        and coalesce(gc.minor_donation_allowed, false)
        and gc.revoked_at is null;
      if v_guardian_consent.guardian_consent_id is null then
        raise exception 'Active guardian consent is required before completing a minor donation.';
      end if;
    end if;

    if v_appointment."Hair_Submission_ID" is null then
      v_hair := coalesce(v_appointment."Hair_Details", '{}'::jsonb);

      insert into public."Hair_Submissions" (
        "User_ID",
        "Status",
        "Created_At",
        "Updated_At",
        "From_Event",
        "Donor_Notes",
        "Cut_At",
        "Cut_By_User_ID"
      )
      values (
        v_appointment."User_ID",
        'Cut',
        v_now,
        v_now,
        false,
        jsonb_build_object(
          'source', 'SalonAppointment',
          'appointment_id', v_appointment."Appointment_ID",
          'screening_answers', v_appointment."Screening_Answers",
          'donor_notes', v_appointment."Donor_Notes"
        )::text,
        v_now,
        v_staff.user_id
      )
      returning * into v_submission;

      insert into public."Hair_Submission_Details" (
        "Submission_ID",
        "Declared_Length",
        "Declared_Color",
        "Declared_Texture",
        "Declared_Density",
        "Declared_Condition",
        "Is_Chemically_Treated",
        "Is_Colored",
        "Is_Bleached",
        "Is_Rebonded",
        "Detail_Notes",
        "Status",
        "Created_At",
        "Updated_By",
        "Updated_At"
      )
      values (
        v_submission."Submission_ID",
        nullif(trim(coalesce(v_hair->>'declaredLength', '')), '')::numeric,
        nullif(trim(coalesce(v_hair->>'declaredColor', '')), ''),
        nullif(trim(coalesce(v_hair->>'declaredTexture', '')), ''),
        nullif(trim(coalesce(v_hair->>'declaredDensity', '')), ''),
        nullif(trim(coalesce(v_hair->>'declaredCondition', '')), ''),
        coalesce((v_hair->>'isChemicallyTreated')::boolean, false),
        coalesce((v_hair->>'isColored')::boolean, false),
        coalesce((v_hair->>'isBleached')::boolean, false),
        coalesce((v_hair->>'isRebonded')::boolean, false),
        nullif(trim(coalesce(v_hair->>'detailNotes', '')), ''),
        'Approved',
        v_now,
        v_staff.user_id,
        v_now
      );

      v_appointment."Hair_Submission_ID" := v_submission."Submission_ID";
    end if;
  end if;

  update public."Salon_Donation_Appointments"
  set
    "Status" = v_status,
    "Guardian_Consent_ID" = v_appointment."Guardian_Consent_ID",
    "Hair_Submission_ID" = coalesce(
      v_appointment."Hair_Submission_ID",
      "Hair_Submission_ID"
    ),
    "Checked_In_At" = case
      when v_status = 'Checked In' then coalesce("Checked_In_At", v_now)
      else "Checked_In_At"
    end,
    "Completed_At" = case when v_status = 'Completed' then v_now else "Completed_At" end,
    "Cancelled_At" = case
      when v_status in ('Cancelled', 'No Show') then v_now
      else "Cancelled_At"
    end,
    "Cancellation_Reason" = case
      when v_status in ('Cancelled', 'No Show')
        then nullif(trim(coalesce(p_notes, '')), '')
      else "Cancellation_Reason"
    end,
    "Updated_At" = v_now
  where "Appointment_ID" = p_appointment_id
  returning * into v_appointment;

  update public."Salon_Appointment_Status_History"
  set "Notes" = nullif(trim(coalesce(p_notes, '')), '')
  where "Status_History_ID" = (
    select h."Status_History_ID"
    from public."Salon_Appointment_Status_History" h
    where h."Appointment_ID" = p_appointment_id
    order by h."Changed_At" desc, h."Status_History_ID" desc
    limit 1
  );

  insert into public.audit_logs (
    user_id,
    action,
    description,
    user_email,
    resource,
    status,
    "time"
  )
  values (
    v_staff.user_id,
    'salon_appointments.status_update',
    format(
      'appointment_id=%s status=%s hair_submission_id=%s',
      v_appointment."Appointment_ID",
      v_appointment."Status",
      coalesce(v_appointment."Hair_Submission_ID"::text, 'N/A')
    ),
    v_staff.email,
    'Salon_Donation_Appointments',
    'success',
    v_now
  );

  return jsonb_build_object(
    'appointment', to_jsonb(v_appointment),
    'hair_submission', case
      when v_submission."Submission_ID" is null then null
      else to_jsonb(v_submission)
    end
  );
end;
$fn$;

alter table public."Salon_Operating_Hours" enable row level security;
alter table public."Salon_Schedule_Overrides" enable row level security;
alter table public."Salon_Donation_Appointments" enable row level security;
alter table public."Salon_Appointment_Status_History" enable row level security;

grant select, update on public."Salon_Operating_Hours" to authenticated;
grant select, insert, update, delete on public."Salon_Schedule_Overrides" to authenticated;
grant select on public."Salon_Donation_Appointments" to authenticated;
grant select on public."Salon_Appointment_Status_History" to authenticated;

do $grant_sequences$
begin
  if to_regclass('public."Salon_Schedule_Overrides_Schedule_Override_ID_seq"') is not null then
    grant usage, select on sequence public."Salon_Schedule_Overrides_Schedule_Override_ID_seq" to authenticated;
  end if;
end
$grant_sequences$;

drop policy if exists salon_operating_hours_select_authenticated on public."Salon_Operating_Hours";
create policy salon_operating_hours_select_authenticated
on public."Salon_Operating_Hours"
for select to authenticated
using (true);

drop policy if exists salon_operating_hours_update_staff_admin on public."Salon_Operating_Hours";
create policy salon_operating_hours_update_staff_admin
on public."Salon_Operating_Hours"
for update to authenticated
using (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('staff', 'admin')
  )
)
with check (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('staff', 'admin')
  )
);

drop policy if exists salon_schedule_overrides_select_authenticated on public."Salon_Schedule_Overrides";
create policy salon_schedule_overrides_select_authenticated
on public."Salon_Schedule_Overrides"
for select to authenticated
using (true);

drop policy if exists salon_schedule_overrides_manage_staff_admin on public."Salon_Schedule_Overrides";
create policy salon_schedule_overrides_manage_staff_admin
on public."Salon_Schedule_Overrides"
for all to authenticated
using (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('staff', 'admin')
  )
)
with check (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('staff', 'admin')
  )
);

drop policy if exists salon_appointments_select_owner_staff_admin on public."Salon_Donation_Appointments";
create policy salon_appointments_select_owner_staff_admin
on public."Salon_Donation_Appointments"
for select to authenticated
using (
  "User_ID" = (
    select u.user_id from public.users u
    where u.auth_user_id = auth.uid()
    limit 1
  )
  or exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('staff', 'admin')
  )
);

drop policy if exists salon_appointment_history_select_owner_staff_admin on public."Salon_Appointment_Status_History";
create policy salon_appointment_history_select_owner_staff_admin
on public."Salon_Appointment_Status_History"
for select to authenticated
using (
  exists (
    select 1
    from public."Salon_Donation_Appointments" a
    join public.users u on u.user_id = a."User_ID"
    where a."Appointment_ID" = "Salon_Appointment_Status_History"."Appointment_ID"
      and u.auth_user_id = auth.uid()
  )
  or exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and public.normalize_app_role(u.role) in ('staff', 'admin')
  )
);

grant execute on function public.get_salon_available_slots(date, date) to authenticated;
grant execute on function public.book_salon_donation_appointment(
  timestamp without time zone,
  text,
  text,
  text,
  jsonb,
  jsonb,
  text,
  integer
) to authenticated;
grant execute on function public.staff_reschedule_salon_appointment(
  integer,
  timestamp without time zone,
  text
) to authenticated;
grant execute on function public.staff_update_salon_appointment_status(
  integer,
  text,
  text,
  integer
) to authenticated;

commit;
