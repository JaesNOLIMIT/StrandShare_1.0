begin;

-- Public landing content is deliberately aggregated and limited to approved
-- organizations/events. It never exposes applications, patients, contacts, or
-- internal workflow records.
create or replace function public.get_public_landing_content()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with approved_hospitals as (
    select
      hospital."Hospital_ID" as hospital_id,
      hospital."Hospital_Name"::text as hospital_name,
      hospital."Hospital_Logo"::text as hospital_logo,
      concat_ws(
        ', ',
        nullif(hospital."City", ''),
        nullif(hospital."Province", ''),
        nullif(hospital."Region", '')
      )::text as location,
      hospital."Patient_Applications_Open" as applications_open
    from public."Hospitals" hospital
    where hospital."Is_Approved" is true
      and public.normalize_flow_key(hospital."Approval_Status") = 'approved'
  ),
  approved_programs as (
    select
      event."Event_Request_ID" as event_id,
      event."Event_Name"::text as event_name,
      event."Start_Date" as start_date,
      event."End_Date" as end_date,
      event."Venue_Name"::text as venue_name,
      event."City_Municipality"::text as city,
      event."Province"::text as province
    from public."Event_Requests" event
    where public.normalize_flow_key(event."Status") = 'approved'
  ),
  upcoming_programs as (
    select program.*
    from approved_programs program
    where program.end_date is null
      or program.end_date >= timezone('Asia/Manila', now())
    order by program.start_date asc nulls last, program.event_id desc
    limit 3
  ),
  featured_hospitals as (
    select hospital.*
    from approved_hospitals hospital
    order by hospital.applications_open desc, hospital.hospital_name
    limit 6
  )
  select jsonb_build_object(
    'metrics', jsonb_build_object(
      'partner_hospitals', (select count(*) from approved_hospitals),
      'open_patient_applications', (
        select count(*) from approved_hospitals where applications_open is true
      ),
      'approved_programs', (select count(*) from approved_programs),
      'released_wigs', (
        select count(*)
        from public."Wig_Requests" request
        where public.normalize_flow_key(request."Status") = 'released'
      )
    ),
    'upcoming_programs', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', program.event_id,
          'name', program.event_name,
          'start_date', program.start_date,
          'end_date', program.end_date,
          'venue', program.venue_name,
          'city', program.city,
          'province', program.province
        ) order by program.start_date asc nulls last, program.event_id desc
      )
      from upcoming_programs program
    ), '[]'::jsonb),
    'partner_hospitals', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', hospital.hospital_id,
          'name', hospital.hospital_name,
          'logo', hospital.hospital_logo,
          'location', hospital.location,
          'applications_open', hospital.applications_open
        ) order by hospital.applications_open desc, hospital.hospital_name
      )
      from featured_hospitals hospital
    ), '[]'::jsonb),
    'updated_at', now()
  );
$fn$;

revoke all on function public.get_public_landing_content() from public;
grant execute on function public.get_public_landing_content() to anon, authenticated;

comment on function public.get_public_landing_content() is
  'Returns privacy-safe live landing-page totals and approved public program/hospital previews.';

notify pgrst, 'reload schema';
commit;
