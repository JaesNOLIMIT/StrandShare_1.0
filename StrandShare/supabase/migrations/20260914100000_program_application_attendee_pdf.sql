begin;

-- Store the applicant's attendee roster as one uploaded PDF or clear image.
-- The legacy JSON roster remains readable for earlier applications.
alter table public."Event_Applications"
  add column if not exists "Expected_Attendee_List_Path" text,
  add column if not exists "Expected_Attendee_List_URL" text;

comment on column public."Event_Applications"."Expected_Attendee_List_Path" is
  'Storage path of the applicant-uploaded PDF or image containing expected attendee names and ages.';

comment on column public."Event_Applications"."Expected_Attendee_List_URL" is
  'Public URL of the applicant-uploaded expected attendee list PDF or image.';

notify pgrst, 'reload schema';
commit;
