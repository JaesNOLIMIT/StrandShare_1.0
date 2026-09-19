begin;

-- The attendee list now accepts a structured CSV file (recommended) or a
-- clear image. The existing neutral path and URL columns remain compatible
-- with previously submitted files and do not require a data migration.
comment on column public."Event_Applications"."Expected_Attendee_List_Path" is
  'Storage path of the applicant-uploaded CSV or image containing expected attendee names and ages.';

comment on column public."Event_Applications"."Expected_Attendee_List_URL" is
  'Public URL of the applicant-uploaded expected attendee list CSV or image.';

notify pgrst, 'reload schema';
commit;
