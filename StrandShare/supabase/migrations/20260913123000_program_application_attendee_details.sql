begin;

-- Keep the applicant's expected attendee roster with the program application.
-- Existing applications remain valid with an empty roster.
alter table public."Event_Applications"
  add column if not exists "Expected_Attendee_Details" jsonb not null default '[]'::jsonb;

alter table public."Event_Applications"
  drop constraint if exists event_applications_attendee_details_array_check;

alter table public."Event_Applications"
  add constraint event_applications_attendee_details_array_check
  check (jsonb_typeof("Expected_Attendee_Details") = 'array');

alter table public."Event_Applications"
  drop constraint if exists event_applications_attendee_details_count_check;

alter table public."Event_Applications"
  add constraint event_applications_attendee_details_count_check
  check (
    jsonb_array_length("Expected_Attendee_Details") = 0
    or jsonb_array_length("Expected_Attendee_Details") = "Expected_Attendees"
  );

comment on column public."Event_Applications"."Expected_Attendee_Details" is
  'Applicant-provided expected attendee roster containing each attendee full name and age.';

notify pgrst, 'reload schema';
commit;
