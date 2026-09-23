begin;

-- Registered event donors must still pass the existing mobile RSVP and
-- completed check-in guard. Public walk-ins are validated by
-- staff_create_walk_in_hair_submission and are marked Present only after the
-- assigned Staff member completes the manual Accept/Reject decision.
drop trigger if exists trg_guard_hair_submission_donation_mode on public."Hair_Submissions";
create trigger trg_guard_hair_submission_donation_mode
before insert or update of "From_Event", "Event_Request_ID", "Event_Attendee_ID", "Waybill_Code"
on public."Hair_Submissions"
for each row
when (coalesce(new."Is_Walk_In", false) = false)
execute function public.guard_hair_submission_donation_mode();

notify pgrst, 'reload schema';
commit;
