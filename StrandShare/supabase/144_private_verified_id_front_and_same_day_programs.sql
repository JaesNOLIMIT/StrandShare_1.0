-- 144_private_verified_id_front_and_same_day_programs.sql
-- Saves the verified ID front image privately and requires every program to
-- start and finish on one calendar date.

begin;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'event_application_private_ids') then
    update storage.buckets
    set name = 'event_application_private_ids', public = false
    where id = 'event_application_private_ids';
  else
    insert into storage.buckets (id, name, public)
    values ('event_application_private_ids', 'event_application_private_ids', false);
  end if;
end
$$;

alter table public."Didit_Verification_Sessions"
  add column if not exists "ID_Front_Image_Path" text;

alter table public."Event_Applications"
  drop constraint if exists event_applications_same_day_program;

alter table public."Event_Applications"
  add constraint event_applications_same_day_program
  check (
    "Proposed_Start_At" is null
    or "Proposed_End_At" is null
    or "Proposed_Start_At"::date = "Proposed_End_At"::date
  ) not valid;

drop policy if exists event_application_private_ids_select_staff_admin on storage.objects;
create policy event_application_private_ids_select_staff_admin
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'event_application_private_ids'
    and exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and public.is_staff_or_admin_role(u.role)
    )
  );

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
    raise exception 'Approved ID verification is required before submitting a program application.';
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
    raise exception 'ID verification is not approved, is invalid, or has already been used.';
  end if;

  if nullif(trim(coalesce(verified_session."ID_Front_Image_Path", '')), '') is null then
    raise exception 'The verified ID front image was not saved. Check verification again before submitting.';
  end if;

  document_data := coalesce(verified_session."Document_Data", '{}'::jsonb);
  new."Didit_Verification_Status" := 'Approved';
  new."Didit_Verified_At" := verified_session."Verified_At";
  new."Applicant_Valid_ID_Path" := verified_session."ID_Front_Image_Path";
  new."Applicant_Valid_ID_URL" := null;
  new."Applicant_ID_Document_Number" := coalesce(
    nullif(trim(new."Applicant_ID_Document_Number"), ''),
    nullif(document_data ->> 'document_number', '')
  );
  new."Applicant_ID_Address" := coalesce(
    nullif(trim(new."Applicant_ID_Address"), ''),
    nullif(document_data ->> 'formatted_address', ''),
    nullif(document_data ->> 'address', '')
  );
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

commit;
