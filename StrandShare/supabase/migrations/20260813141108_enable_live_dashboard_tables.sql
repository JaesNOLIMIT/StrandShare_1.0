-- Keep all data-driven dashboard pages current while they remain mounted in the
-- role shell. Postgres Changes only emits events for tables in this publication;
-- row visibility is still enforced by each table's existing RLS policies.

do $do$
declare
  dashboard_table text;
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'The supabase_realtime publication does not exist.';
  end if;

  foreach dashboard_table in array array[
    'audit_logs',
    'Hospitals',
    'Hospital_Representative',
    'Patients',
    'Patient_Hospital_Transfer_Requests',
    'Event_Applications',
    'Event_Requests',
    'Event_Attendees',
    'Wig_Requests',
    'Wig_Specifications',
    'Wig_AI_Filters',
    'Wigs',
    'Wig_Stock_History',
    'Release_Schedules',
    'patient_wig_safety_assessments',
    'Hair_Submissions',
    'Hair_Submission_Details',
    'Hair_Submission_Images',
    'Hair_Submission_Bundles',
    'Cut_Hair_Inventory',
    'Hair_AI_Review_Comparisons',
    'Salon_Donation_Appointments',
    'Salon_Operating_Hours',
    'Salon_Schedule_Overrides',
    'Salon_Appointment_Status_History',
    'guardian_consents',
    'wig_requirements',
    'Logistics_Settings',
    'legal_documents'
  ]
  loop
    if to_regclass(format('public.%I', dashboard_table)) is not null
      and not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = dashboard_table
      )
    then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        dashboard_table
      );
    end if;
  end loop;

  -- Do not publish account/profile tables until RLS is enabled and their
  -- authorization policies have been reviewed. Other live-table events still
  -- cause the relevant views to re-fetch these joined display values.
  foreach dashboard_table in array array['users', 'user_details']
  loop
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = dashboard_table
    )
    then
      execute format(
        'alter publication supabase_realtime drop table public.%I',
        dashboard_table
      );
    end if;
  end loop;
end;
$do$;
