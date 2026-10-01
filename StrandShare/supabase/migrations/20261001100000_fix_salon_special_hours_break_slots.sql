-- A date override owns its break window. NULL on an override means no break,
-- not "inherit the regular break". Keep appointment and walk-in rules aligned.
begin;

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
      case when so."Schedule_Override_ID" is not null then not so."Is_Closed" else oh."Is_Open" end as is_open,
      coalesce(so."Opening_Time", oh."Opening_Time") as opening_time,
      coalesce(so."Closing_Time", oh."Closing_Time") as closing_time,
      case when so."Schedule_Override_ID" is not null then so."Break_Start_Time" else oh."Break_Start_Time" end as break_start_time,
      case when so."Schedule_Override_ID" is not null then so."Break_End_Time" else oh."Break_End_Time" end as break_end_time
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

notify pgrst, 'reload schema';
commit;
