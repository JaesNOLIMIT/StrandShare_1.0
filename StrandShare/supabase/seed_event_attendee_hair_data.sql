-- Sample hair-intake data for the eight Event_Attendees shown in the
-- September 3 screenshots. Run this manually in the Supabase SQL Editor.
--
-- This is intentionally a seed script instead of a migration. It is safe to
-- rerun: existing submissions, details, and AI screenings are left unchanged.

begin;

create temporary table seed_event_hair_rows_20260903 (
  event_attendee_id integer primary key,
  expected_user_id integer not null,
  expected_event_request_id integer not null,
  estimated_length numeric(5, 2) not null,
  detected_color text not null,
  detected_texture text not null,
  detected_density text not null,
  detected_condition text not null,
  confidence_score numeric(5, 2) not null,
  shine_level integer not null,
  frizz_level integer not null,
  dryness_level integer not null,
  oiliness_level integer not null,
  damage_level integer not null,
  hair_density_score numeric(5, 2) not null,
  notes text not null
) on commit drop;

insert into seed_event_hair_rows_20260903 values
  (1, 10, 1, 12.50, 'Natural Black', 'Straight', 'Medium', 'Healthy', 0.93, 8, 2, 2, 4, 1, 82.00,
   'Sample event hair record for attendee #1.'),
  (2, 12, 1, 10.00, 'Dark Brown',   'Wavy',     'Thick',  'Good',    0.89, 7, 3, 3, 4, 2, 88.00,
   'Sample event hair record for attendee #2.'),
  (3, 13, 1,  8.75, 'Natural Black', 'Curly',   'Medium', 'Good',    0.87, 7, 4, 3, 3, 2, 76.00,
   'Sample event hair record for attendee #3.'),
  (4, 14, 1, 14.00, 'Brown',         'Straight', 'Thick', 'Healthy', 0.95, 9, 2, 1, 4, 1, 91.00,
   'Sample event hair record for attendee #4.'),
  (5, 11, 1, 11.25, 'Natural Black', 'Wavy',     'Medium', 'Good',    0.90, 8, 3, 2, 3, 1, 80.00,
   'Sample event hair record for attendee #5.'),
  (6,  2, 1,  9.50, 'Dark Brown',    'Straight', 'Medium', 'Good',    0.86, 7, 3, 3, 4, 2, 78.00,
   'Sample event hair record for attendee #6.'),
  (7,  6, 1, 13.00, 'Natural Black', 'Curly',    'Thick',  'Healthy', 0.92, 8, 3, 2, 3, 1, 89.00,
   'Sample event hair record for attendee #7.'),
  (8,  8, 1, 10.75, 'Brown',         'Wavy',     'Medium', 'Good',    0.88, 7, 4, 3, 3, 2, 81.00,
   'Sample event hair record for attendee #8.');

-- Stop instead of attaching sample hair data to the wrong attendee if the
-- IDs in the database no longer match the screenshot.
do $validation$
begin
  if exists (
    select 1
    from seed_event_hair_rows_20260903 seed
    left join public."Event_Attendees" attendee
      on attendee."Event_Attendee_ID" = seed.event_attendee_id
    where attendee."Event_Attendee_ID" is null
       or attendee."User_ID" is distinct from seed.expected_user_id
       or attendee."Event_Request_ID" is distinct from seed.expected_event_request_id
  ) then
    raise exception
      'Seed cancelled: attendee IDs 1-8 must match users 10,12,13,14,11,2,6,8 and event request 1.';
  end if;
end;
$validation$;

-- This seed never changes attendance. Event hair records are created only for
-- registered donors who were already checked in through the normal RSVP flow.
-- Not Marked/No Show donors and Voluntary attendees remain attendee-only.

-- If an older submission already exists for the same user and event, connect
-- it to the attendee instead of trying to create a duplicate.
update public."Hair_Submissions" submission
set
  "Event_Attendee_ID" = seed.event_attendee_id,
  "Updated_At" = timezone('Asia/Manila', now())
from seed_event_hair_rows_20260903 seed
where submission."User_ID" = seed.expected_user_id
  and submission."Event_Request_ID" = seed.expected_event_request_id
  and coalesce(submission."From_Event", false) = true
  and submission."Event_Attendee_ID" is null
  and exists (
    select 1
    from public."Event_Attendees" attendee
    where attendee."Event_Attendee_ID" = seed.event_attendee_id
      and attendee."Attendee_Type" = 'Donor'
      and public.normalize_flow_key(attendee."Registration_Status") = 'registered'
      and public.normalize_flow_key(attendee."Attendance_Status") = 'Pending'
      and attendee."RSVP_Scanned_At" is not null
  )
  and not exists (
    select 1
    from public."Hair_Submissions" linked
    where linked."Event_Attendee_ID" = seed.event_attendee_id
  );

insert into public."Hair_Submissions" (
  "User_ID",
  "Status",
  "From_Event",
  "Donor_Notes",
  "Event_Request_ID",
  "Event_Attendee_ID",
  "Waybill_Code"
)
select
  attendee."User_ID",
  'Pending',
  true,
  seed.notes,
  attendee."Event_Request_ID",
  attendee."Event_Attendee_ID",
  null
from seed_event_hair_rows_20260903 seed
join public."Event_Attendees" attendee
  on attendee."Event_Attendee_ID" = seed.event_attendee_id
 and attendee."Attendee_Type" = 'Donor'
 and public.normalize_flow_key(attendee."Registration_Status") = 'registered'
 and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
 and attendee."RSVP_Scanned_At" is not null
where not exists (
  select 1
  from public."Hair_Submissions" existing
  where existing."Event_Attendee_ID" = attendee."Event_Attendee_ID"
     or (
       existing."User_ID" = attendee."User_ID"
       and existing."Event_Request_ID" = attendee."Event_Request_ID"
     )
);

-- AI results are linked through AI_Screenings.Submission_ID. Screening_Images
-- remains an empty JSON array because these are sample SQL records, not real
-- uploaded image analyses.
insert into public."AI_Screenings" (
  "Submission_ID",
  "User_ID",
  "Estimated_Length",
  "Detected_Color",
  "Detected_Texture",
  "Detected_Density",
  "Detected_Condition",
  "Visible_Damage_Notes",
  "Confidence_Score",
  "Decision",
  "Summary",
  "Shine_Level",
  "Frizz_Level",
  "Dryness_Level",
  "Oiliness_Level",
  "Damage_Level",
  "Bald_Spots_Present",
  "Affected_Regions",
  "Hair_Density_Score",
  "Shedding_Level",
  "Visible_Scalp_Area",
  "Scalp_Coverage_Notes",
  "Improvement_Tracking_Status",
  "Improvement_Recommendation",
  "Dandruff_Detected",
  "Dandruff_Severity",
  "Dandruff_Notes",
  "Lice_Detected",
  "Lice_Confidence",
  "Lice_Notes",
  "Length_Assessment",
  "Donation_Readiness_Note",
  "History_Assessment",
  "Analysis_Result",
  "Screening_Images"
)
select
  submission."Submission_ID",
  submission."User_ID",
  seed.estimated_length,
  seed.detected_color,
  seed.detected_texture,
  seed.detected_density,
  seed.detected_condition,
  'No visible damage found in the sample screening.',
  seed.confidence_score,
  'Pending manual review',
  format(
    'Sample AI screening: %s-inch %s %s hair with %s density.',
    seed.estimated_length,
    lower(seed.detected_color),
    lower(seed.detected_texture),
    lower(seed.detected_density)
  ),
  seed.shine_level,
  seed.frizz_level,
  seed.dryness_level,
  seed.oiliness_level,
  seed.damage_level,
  false,
  array['none']::text[],
  seed.hair_density_score,
  'None',
  'None',
  'No visible scalp coverage concern in the sample screening.',
  'Ready for donation',
  'Proceed to manual staff quality review before cutting or bundling.',
  false,
  'none',
  'No visible dandruff-like flakes in the sample screening.',
  false,
  'none',
  'No visible lice or nit-like signs in the sample screening.',
  format('Estimated usable length is %s inches.', seed.estimated_length),
  'The sample result is suitable for staff review; AI output is not the final decision.',
  'No earlier screening history was included in this seed data.',
  jsonb_build_object(
    'source', 'manual_seed',
    'eventAttendeeId', seed.event_attendee_id,
    'requiresManualReview', true
  ),
  '[]'::jsonb
from seed_event_hair_rows_20260903 seed
join public."Event_Attendees" attendee
  on attendee."Event_Attendee_ID" = seed.event_attendee_id
 and attendee."Attendee_Type" = 'Donor'
 and public.normalize_flow_key(attendee."Registration_Status") = 'registered'
 and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
 and attendee."RSVP_Scanned_At" is not null
join public."Hair_Submissions" submission
  on submission."Event_Attendee_ID" = seed.event_attendee_id
where not exists (
  select 1
  from public."AI_Screenings" existing
  where existing."Submission_ID" = submission."Submission_ID"
);

-- Start the staff-reviewed copy as Pending. Staff can then edit these values
-- and make the final Approved / Rejected / Rejected Cut decision in the UI.
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
  "Status"
)
select
  submission."Submission_ID",
  seed.estimated_length,
  seed.detected_color,
  seed.detected_texture,
  seed.detected_density,
  seed.detected_condition,
  false,
  false,
  false,
  false,
  'Seeded from the sample AI result. Verify all values before approval.',
  'Pending'
from seed_event_hair_rows_20260903 seed
join public."Event_Attendees" attendee
  on attendee."Event_Attendee_ID" = seed.event_attendee_id
 and attendee."Attendee_Type" = 'Donor'
 and public.normalize_flow_key(attendee."Registration_Status") = 'registered'
 and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
 and attendee."RSVP_Scanned_At" is not null
join public."Hair_Submissions" submission
  on submission."Event_Attendee_ID" = seed.event_attendee_id
where not exists (
  select 1
  from public."Hair_Submission_Details" existing
  where existing."Submission_ID" = submission."Submission_ID"
);

commit;

-- Verification output shows all eight attendees. Only donors already checked
-- in as Present will have linked Pending hair and review records.
select
  attendee."Event_Attendee_ID",
  attendee."User_ID",
  attendee."Event_Request_ID",
  attendee."Attendee_Type",
  attendee."Registration_Status",
  attendee."Attendance_Status",
  attendee."Waybill_Code" as "Attendee_Waybill_Code",
  submission."Submission_ID",
  submission."Status" as "Submission_Status",
  screening."AI_Screening_ID",
  screening."Estimated_Length",
  screening."Detected_Color",
  screening."Detected_Texture",
  detail."Submission_Detail_ID",
  detail."Status" as "Review_Status"
from public."Event_Attendees" attendee
left join public."Hair_Submissions" submission
  on submission."Event_Attendee_ID" = attendee."Event_Attendee_ID"
left join public."AI_Screenings" screening
  on screening."Submission_ID" = submission."Submission_ID"
left join public."Hair_Submission_Details" detail
  on detail."Submission_ID" = submission."Submission_ID"
where attendee."Event_Attendee_ID" in (1, 2, 3, 4, 5, 6, 7, 8)
order by attendee."Event_Attendee_ID";
