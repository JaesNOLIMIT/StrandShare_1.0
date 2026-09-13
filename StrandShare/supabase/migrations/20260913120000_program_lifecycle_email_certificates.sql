begin;

-- Lifecycle notices use the existing SMTP outbox. Stable queue keys guarantee
-- that every recipient and certificate is sent at most once per program.
alter table public."SMTP_Email_Outbox"
  drop constraint if exists smtp_email_outbox_notification_type_check;

alter table public."SMTP_Email_Outbox"
  add constraint smtp_email_outbox_notification_type_check
  check (
    public.normalize_flow_key(coalesce("Notification_Type", '')) = any (
      array[
        'eventapplicationreceived'::text,
        'staffrejected'::text,
        'staffendorsedpendingadmin'::text,
        'adminapproved'::text,
        'adminrejected'::text,
        'partnerhospitalapproved'::text,
        'partnerhospitalrejected'::text,
        'partnerhospitalaccessenabled'::text,
        'partnerhospitalaccessdisabled'::text,
        'eventautocancelled'::text,
        'patientapplicationotp'::text,
        'patientapplicationsubmitted'::text,
        'patientapplicationaccepted'::text,
        'patientapplicationrejected'::text,
        'programended'::text,
        'programsuccessfulapplicant'::text,
        'programsuccessfulattendee'::text
      ]
    )
  );

create or replace function public.enqueue_program_lifecycle_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old_status text := public.normalize_flow_key(old."Status");
  v_new_status text := public.normalize_flow_key(new."Status");
  v_application public."Event_Applications"%rowtype;
  v_attendee record;
  v_applicant_email text;
  v_applicant_name text;
  v_staff_name text;
  v_address text;
  v_common_payload jsonb;
begin
  if v_old_status is not distinct from v_new_status
     or v_new_status not in ('ended', 'successful') then
    return new;
  end if;

  select application.* into v_application
  from public."Event_Applications" application
  where application."Event_Application_ID" = new."Event_Application_ID"
  limit 1;

  v_applicant_email := public.resolve_event_application_recipient_email(
    v_application."Applicant_Email",
    v_application."Preferred_Contact_Method",
    v_application."Preferred_Contact_Detail"
  );
  v_applicant_name := nullif(trim(concat_ws(' ',
    v_application."Applicant_First_Name",
    v_application."Applicant_Middle_Name",
    v_application."Applicant_Last_Name"
  )), '');
  v_applicant_name := coalesce(v_applicant_name, 'Program Applicant');

  select nullif(trim(concat_ws(' ', detail.first_name, detail.middle_name, detail.last_name, detail.suffix)), '')
  into v_staff_name
  from public.user_details detail
  where detail.user_id = new."Assigned_Staff_User_ID"
  limit 1;
  v_staff_name := coalesce(v_staff_name, 'Assigned Donivra Staff');

  v_address := nullif(trim(concat_ws(', ',
    new."Street", new."Barangay", new."City_Municipality",
    new."Province", new."Region", new."Country"
  )), '');

  v_common_payload := jsonb_build_object(
    'event_request_id', new."Event_Request_ID",
    'program_name', coalesce(new."Event_Name", 'Untitled Program'),
    'event_name', coalesce(new."Event_Name", 'Untitled Program'),
    'start_date', new."Start_Date",
    'end_date', new."End_Date",
    'ended_at', new."Ended_At",
    'successful_at', new."Successful_At",
    'venue_name', coalesce(new."Venue_Name", ''),
    'venue_address', coalesce(v_address, ''),
    'street', coalesce(new."Street", ''),
    'barangay', coalesce(new."Barangay", ''),
    'city_municipality', coalesce(new."City_Municipality", ''),
    'province', coalesce(new."Province", ''),
    'region', coalesce(new."Region", ''),
    'country', coalesce(new."Country", ''),
    'program_organizer', coalesce(new."Event_By", v_applicant_name),
    'assigned_staff_name', v_staff_name
  );

  if v_new_status = 'ended' then
    if v_applicant_email is not null then
      perform public.enqueue_smtp_email_outbox(
        'program_ended:applicant:' || new."Event_Request_ID"::text,
        'Event_Requests', new."Event_Request_ID", 'program_ended',
        v_applicant_email,
        'Program Ended - ' || coalesce(new."Event_Name", 'Donivra Program'),
        'program_ended',
        v_common_payload || jsonb_build_object(
          'recipient_name', v_applicant_name,
          'recipient_role', 'Applicant'
        ),
        null
      );
    end if;

    for v_attendee in
      select
        attendee."Event_Attendee_ID",
        coalesce(
          nullif(trim(concat_ws(' ', detail.first_name, detail.middle_name, detail.last_name, detail.suffix)), ''),
          nullif(trim(account.email), ''),
          'Participant'
        ) as full_name,
        lower(trim(account.email)) as email,
        attendee."Attendee_Type"
      from public."Event_Attendees" attendee
      join public.users account on account.user_id = attendee."User_ID"
      left join public.user_details detail on detail.user_id = attendee."User_ID"
      where attendee."Event_Request_ID" = new."Event_Request_ID"
        and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
        and nullif(trim(coalesce(account.email, '')), '') is not null
        and account.email like '%_@_%._%'
        and (v_applicant_email is null or lower(trim(account.email)) <> v_applicant_email)
    loop
      perform public.enqueue_smtp_email_outbox(
        'program_ended:attendee:' || new."Event_Request_ID"::text || ':' || v_attendee."Event_Attendee_ID"::text,
        'Event_Requests', new."Event_Request_ID", 'program_ended',
        v_attendee.email,
        'Program Ended - ' || coalesce(new."Event_Name", 'Donivra Program'),
        'program_ended',
        v_common_payload || jsonb_build_object(
          'recipient_name', v_attendee.full_name,
          'recipient_role', coalesce(v_attendee."Attendee_Type", 'Attendee')
        ),
        null
      );
    end loop;
  elsif v_new_status = 'successful' then
    if v_applicant_email is not null then
      perform public.enqueue_smtp_email_outbox(
        'program_successful:applicant:' || new."Event_Request_ID"::text,
        'Event_Requests', new."Event_Request_ID", 'program_successful_applicant',
        v_applicant_email,
        'Program Completion Certificate - ' || coalesce(new."Event_Name", 'Donivra Program'),
        'program_successful_applicant',
        v_common_payload || jsonb_build_object(
          'recipient_name', v_applicant_name,
          'recipient_role', 'Program Applicant',
          'certificate_kind', 'program_completion',
          'certificate_id', 'DPC-' || new."Event_Request_ID"::text,
          'certificate_issued_at', coalesce(new."Successful_At", now())
        ),
        new."Successful_By_User_ID"
      );
    end if;

    for v_attendee in
      select
        attendee."Event_Attendee_ID",
        coalesce(
          nullif(trim(concat_ws(' ', detail.first_name, detail.middle_name, detail.last_name, detail.suffix)), ''),
          nullif(trim(account.email), ''),
          'Participant'
        ) as full_name,
        lower(trim(account.email)) as email,
        attendee."Attendee_Type"
      from public."Event_Attendees" attendee
      join public.users account on account.user_id = attendee."User_ID"
      left join public.user_details detail on detail.user_id = attendee."User_ID"
      where attendee."Event_Request_ID" = new."Event_Request_ID"
        and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
        and nullif(trim(coalesce(account.email, '')), '') is not null
        and account.email like '%_@_%._%'
    loop
      perform public.enqueue_smtp_email_outbox(
        'program_successful:attendee:' || new."Event_Request_ID"::text || ':' || v_attendee."Event_Attendee_ID"::text,
        'Event_Requests', new."Event_Request_ID", 'program_successful_attendee',
        v_attendee.email,
        'Your Participation Certificate - ' || coalesce(new."Event_Name", 'Donivra Program'),
        'program_successful_attendee',
        v_common_payload || jsonb_build_object(
          'recipient_name', v_attendee.full_name,
          'recipient_role', case
            when public.normalize_flow_key(v_attendee."Attendee_Type") = 'visitor' then 'Visitor'
            else 'Donor'
          end,
          'certificate_kind', 'participant',
          'certificate_id', 'DPA-' || new."Event_Request_ID"::text || '-' || v_attendee."Event_Attendee_ID"::text,
          'certificate_issued_at', coalesce(new."Successful_At", now())
        ),
        new."Successful_By_User_ID"
      );
    end loop;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_enqueue_program_lifecycle_notifications
  on public."Event_Requests";
create trigger trg_enqueue_program_lifecycle_notifications
after update of "Status" on public."Event_Requests"
for each row execute function public.enqueue_program_lifecycle_notifications();

comment on function public.enqueue_program_lifecycle_notifications() is
  'Queues one-time Program Ended notices and Successful certificate emails for the applicant and eligible attendees.';

notify pgrst, 'reload schema';
commit;
