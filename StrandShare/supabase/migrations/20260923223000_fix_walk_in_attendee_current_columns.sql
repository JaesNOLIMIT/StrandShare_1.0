begin;

-- Event_Attendees no longer has the legacy Full_Name and Email columns.
-- Store public walk-in identity only in the dedicated Walk_In_* columns.
create or replace function public.submit_event_walk_in_registration(
  p_public_token uuid,
  p_email text,
  p_age smallint,
  p_full_name text default null,
  p_birthdate date default null,
  p_guardian_name text default null,
  p_guardian_relationship text default null,
  p_guardian_email text default null,
  p_consent_signer_name text default null,
  p_terms_accepted boolean default false,
  p_privacy_accepted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_intake jsonb;
  v_event public."Event_Requests"%rowtype;
  v_attendee public."Event_Attendees"%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(trim(coalesce(p_full_name, '')), '');
  v_now timestamp without time zone := timezone('Asia/Manila', now());
  v_age smallint;
begin
  v_intake := public.get_public_event_walk_in_intake(p_public_token);
  if coalesce((v_intake->>'is_open')::boolean, false) is not true then
    raise exception '%', coalesce(v_intake->>'message', 'Walk-in registration is closed.');
  end if;
  if v_email = '' or v_email not like '%_@_%._%' then raise exception 'Enter a valid email address.'; end if;
  if p_birthdate is null then raise exception 'Birthdate is required.'; end if;
  v_age := extract(year from age(v_now::date, p_birthdate))::smallint;
  if p_birthdate > v_now::date or v_age not between 1 and 120 then
    raise exception 'Enter a valid birthdate for a donor between 1 and 120 years old.';
  end if;
  if not coalesce(p_terms_accepted, false) or not coalesce(p_privacy_accepted, false) then
    raise exception 'Accept the Terms and Conditions and Privacy Notice to continue.';
  end if;
  if v_age < 18 and (
    nullif(trim(coalesce(p_guardian_name, '')), '') is null or
    nullif(trim(coalesce(p_guardian_relationship, '')), '') is null or
    nullif(trim(coalesce(p_guardian_email, '')), '') is null
  ) then raise exception 'Guardian name, relationship, and email are required for donors under 18.'; end if;
  if v_age < 18 and lower(trim(p_guardian_email)) not like '%_@_%._%' then
    raise exception 'Enter a valid guardian email address.';
  end if;

  select * into v_event from public."Event_Requests" event
  where event."Event_Request_ID" = (v_intake->>'event_request_id')::integer for update;

  if exists (
    select 1 from public."Event_Attendees" attendee
    where attendee."Event_Request_ID" = v_event."Event_Request_ID"
      and attendee."Is_Walk_In" is true
      and lower(trim(coalesce(attendee."Walk_In_Email", ''))) = v_email
      and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
  ) then raise exception 'This email is already registered as a walk-in for this program.'; end if;

  insert into public."Event_Attendees" (
    "Event_Request_ID", "User_ID", "Walk_In_Full_Name", "Walk_In_Email",
    "Registration_Status", "Attendance_Status", "Attendee_Type", "Is_Walk_In",
    "Walk_In_Age", "Walk_In_Birthdate", "Guardian_Name", "Guardian_Relationship",
    "Guardian_Email", "Consent_Signer_Name", "Terms_Accepted_At", "Privacy_Accepted_At",
    "Consent_Version", "Walk_In_Registered_At", "RSVP_Scanned_At", "Created_At", "Updated_At"
  ) values (
    v_event."Event_Request_ID", null,
    coalesce(v_name, 'Walk-in Donor'), v_email, 'Registered', 'Not Marked', 'Donor', true,
    v_age, p_birthdate, nullif(trim(coalesce(p_guardian_name, '')), ''),
    nullif(trim(coalesce(p_guardian_relationship, '')), ''),
    nullif(lower(trim(coalesce(p_guardian_email, ''))), ''), null,
    v_now, v_now, coalesce(v_intake->>'consent_version', 'walk-in-consent-2026-09'),
    v_now, null, v_now, v_now
  ) returning * into v_attendee;

  perform public.enqueue_smtp_email_outbox(
    'walk_in_registered:' || v_attendee."Event_Attendee_ID"::text,
    'Event_Attendees', v_attendee."Event_Attendee_ID", 'walk_in_registration_received',
    v_email, 'Your Donivra walk-in QR - ' || coalesce(v_event."Event_Name", 'Donivra Program'),
    'walk_in_registration_received',
    jsonb_build_object(
      'recipient_name', v_attendee."Walk_In_Full_Name",
      'event_name', v_event."Event_Name",
      'event_request_id', v_event."Event_Request_ID",
      'event_attendee_id', v_attendee."Event_Attendee_ID",
      'registered_at', v_now,
      'waybill_code', v_attendee."Waybill_Code",
      'message', 'Your walk-in donor registration and consent were received. Staff will record and review the donated hair separately.'
    ),
    null
  );

  return jsonb_build_object(
    'event_attendee_id', v_attendee."Event_Attendee_ID",
    'waybill_code', v_attendee."Waybill_Code",
    'event_name', v_event."Event_Name",
    'email', v_attendee."Walk_In_Email",
    'registered_at', v_now
  );
end;
$fn$;

revoke all on function public.submit_event_walk_in_registration(uuid,text,smallint,text,date,text,text,text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.submit_event_walk_in_registration(uuid,text,smallint,text,date,text,text,text,text,boolean,boolean) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
