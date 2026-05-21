-- 118_force_manila_staff_scan_and_audit_timestamps.sql
-- Ensure staff-side scan/print/write timestamps persist in Manila (UTC+8).

begin;

-- Event attendee timestamps (staff Assigned Event Operations page writes here).
alter table public."Event_Attendees"
  alter column "Created_At" set default timezone('Asia/Manila', now()),
  alter column "Updated_At" set default timezone('Asia/Manila', now());

-- Audit logs are written by staff RPC functions during scans/reviews.
alter table public.audit_logs
  alter column "time" set default timezone('Asia/Manila', now());

-- Keep attendee Updated_At in Manila whenever row changes.
create or replace function public.set_event_attendees_updated_at_manila()
returns trigger
language plpgsql
as $fn$
begin
  new."Updated_At" = timezone('Asia/Manila', now());
  return new;
end;
$fn$;

drop trigger if exists trg_set_event_attendees_updated_at_manila on public."Event_Attendees";
create trigger trg_set_event_attendees_updated_at_manila
before update on public."Event_Attendees"
for each row
execute function public.set_event_attendees_updated_at_manila();

commit;

