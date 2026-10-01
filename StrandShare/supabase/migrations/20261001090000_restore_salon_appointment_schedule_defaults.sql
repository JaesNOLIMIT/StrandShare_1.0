-- Restore the appointment schedule rows required by the staff calendar.

begin;

-- Some environments retained the schedule tables but lost their two seed
-- rows while the receiving page was being simplified. Keep existing staff
-- choices and only recreate a missing Weekday or Weekend configuration.
insert into public."Salon_Operating_Hours" (
  "Day_Group",
  "Is_Open",
  "Opening_Time",
  "Closing_Time",
  "Break_Start_Time",
  "Break_End_Time",
  "Appointment_Duration_Minutes",
  "Buffer_Minutes",
  "Late_Grace_Minutes",
  "Capacity_Per_Slot",
  "Minimum_Booking_Notice_Days",
  "Maximum_Booking_Days",
  "Updated_At"
)
values
  (
    'Weekday', true, '09:00', '17:00', null, null,
    60, 30, 15, 3, 1, 30, timezone('Asia/Manila', now())
  ),
  (
    'Weekend', true, '09:00', '17:00', null, null,
    60, 30, 15, 3, 1, 30, timezone('Asia/Manila', now())
  )
on conflict ("Day_Group") do nothing;

comment on table public."Salon_Operating_Hours" is
  'Editable weekday/weekend appointment hours, duration, buffer, grace period, capacity, and booking window.';

notify pgrst, 'reload schema';

commit;
