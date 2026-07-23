-- 145_fix_event_staff_notes_and_resubmission.sql
-- Persist both staff-note fields through verified RPC writes and make a rejected
-- event request resubmission one atomic database operation.

begin;

create or replace function public.save_event_application_staff_notes(
  p_event_application_id integer,
  p_contact_notes text default null,
  p_review_notes text default null
)
returns table (
  event_application_id integer,
  staff_contact_notes text,
  staff_review_notes text,
  staff_contacted_at timestamp without time zone,
  staff_reviewer_user_id integer,
  updated_at timestamp without time zone
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor_user_id integer;
  v_actor_role text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select u.user_id, public.normalize_app_role(u.role)
  into v_actor_user_id, v_actor_role
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_actor_user_id is null or v_actor_role <> 'staff' then
    raise exception 'Only an authenticated staff user can save application notes.';
  end if;

  return query
  update public."Event_Applications" ea
  set
    "Staff_Contact_Notes" = nullif(trim(coalesce(p_contact_notes, '')), ''),
    "Staff_Review_Notes" = nullif(trim(coalesce(p_review_notes, '')), ''),
    "Staff_Contacted_At" = case
      when nullif(trim(coalesce(p_contact_notes, '')), '') is not null
        then coalesce(ea."Staff_Contacted_At", v_now)
      else ea."Staff_Contacted_At"
    end,
    "Staff_Reviewer_User_ID" = v_actor_user_id,
    "Updated_At" = v_now
  where ea."Event_Application_ID" = p_event_application_id
  returning
    ea."Event_Application_ID",
    ea."Staff_Contact_Notes",
    ea."Staff_Review_Notes",
    ea."Staff_Contacted_At",
    ea."Staff_Reviewer_User_ID",
    ea."Updated_At";

  if not found then
    raise exception 'Event application % was not found.', p_event_application_id;
  end if;
end;
$fn$;

-- Permit the application status to follow a linked request that an admin
-- rejected and staff subsequently appealed. Older guards omitted the
-- Pending Admin Decision -> Appealed staff path.
create or replace function public.enforce_event_application_workflow()
returns trigger
language plpgsql
as $fn$
declare
  actor_user_id integer;
  actor_role_key text;
  old_status_key text;
  new_status_key text;
  linked_request_status_key text;
  has_matching_request_decision boolean := false;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  old_status_key := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));
  new_status_key := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));

  if old_status_key is not distinct from new_status_key then
    new."Updated_At" = manila_now;
    return new;
  end if;

  select u.user_id, public.normalize_app_role(u.role)
  into actor_user_id, actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(new."Linked_Event_Request_ID", 0) > 0 then
    select lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', ''))
    into linked_request_status_key
    from public."Event_Requests" er
    where er."Event_Request_ID" = new."Linked_Event_Request_ID"
      and er."Event_Application_ID" = new."Event_Application_ID"
    limit 1;
  end if;

  if linked_request_status_key is null then
    if old_status_key in ('pendingadmindecision', 'appealed') and new_status_key = 'approved' then
      select exists (
        select 1
        from public."Event_Requests" er
        where er."Event_Application_ID" = new."Event_Application_ID"
          and lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', '')) = 'approved'
      ) into has_matching_request_decision;
    elsif old_status_key = 'pendingadmindecision' and new_status_key in ('appealed', 'rejected') then
      select exists (
        select 1
        from public."Event_Requests" er
        where er."Event_Application_ID" = new."Event_Application_ID"
          and lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', ''))
            in ('rejected', 'appealed', 'pendingadminapproval')
      ) into has_matching_request_decision;
    end if;
  end if;

  if actor_user_id is null then
    if (old_status_key = 'pendingadmindecision' and new_status_key in ('approved', 'rejected', 'appealed'))
      or (old_status_key = 'appealed' and new_status_key in ('pendingadmindecision', 'approved'))
    then
      new."Updated_At" = manila_now;
      return new;
    end if;
    raise exception 'Unable to resolve actor profile for event application workflow update.';
  end if;

  if actor_role_key = 'staff' then
    if old_status_key = 'pendingstaffreview' and new_status_key = 'rejected' then
      if length(trim(coalesce(new."Staff_Rejection_Reason", ''))) = 0 then
        raise exception 'Staff rejection reason is required when rejecting event applications.';
      end if;
      new."Staff_Rejected_By_User_ID" = actor_user_id;
      new."Staff_Rejected_At" = manila_now;
      new."Staff_Reviewer_User_ID" = actor_user_id;
      new."Staff_Reviewed_At" = coalesce(new."Staff_Reviewed_At", manila_now);
    elsif old_status_key in ('pendingstaffreview', 'rejected', 'appealed')
      and new_status_key = 'pendingadmindecision'
    then
      if coalesce(new."Linked_Event_Request_ID", 0) = 0 then
        raise exception 'Linked event request is required before submitting to admin decision.';
      end if;
      new."Staff_Reviewer_User_ID" = actor_user_id;
      new."Staff_Reviewed_At" = coalesce(new."Staff_Reviewed_At", manila_now);
      new."Staff_Rejection_Reason" = null;
      new."Staff_Rejected_At" = null;
      new."Staff_Rejected_By_User_ID" = null;
    elsif old_status_key in ('pendingadmindecision', 'rejected')
      and new_status_key = 'appealed'
      and (
        linked_request_status_key in ('rejected', 'appealed', 'pendingadminapproval')
        or has_matching_request_decision
      )
    then
      new."Staff_Reviewer_User_ID" = actor_user_id;
      new."Staff_Reviewed_At" = coalesce(new."Staff_Reviewed_At", manila_now);
    else
      raise exception 'Staff cannot change event application status from % to %.', old."Status", new."Status";
    end if;
  elsif actor_role_key = 'admin' then
    if old_status_key in ('pendingadmindecision', 'appealed')
      and new_status_key = 'approved'
      and (linked_request_status_key = 'approved' or has_matching_request_decision)
    then
      null;
    elsif old_status_key = 'pendingadmindecision'
      and new_status_key in ('appealed', 'rejected')
      and (linked_request_status_key = 'rejected' or has_matching_request_decision)
    then
      null;
    else
      raise exception 'Admin cannot change event application status directly. Use Event_Requests.';
    end if;
  else
    raise exception 'Only staff or admin can change event application status.';
  end if;

  new."Updated_At" = manila_now;
  return new;
end;
$fn$;

create or replace function public.staff_resubmit_event_request(
  p_event_request_id integer,
  p_event_application_id integer,
  p_request_data jsonb,
  p_contact_notes text default null,
  p_review_notes text default null
)
returns table (
  event_request_id integer,
  request_status character varying,
  resubmission_count integer,
  staff_contact_notes text,
  staff_review_notes text
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor_user_id integer;
  v_actor_role text;
  v_existing public."Event_Requests"%rowtype;
  v_request_status character varying;
  v_resubmission_count integer;
  v_contact_notes text := nullif(trim(coalesce(p_contact_notes, '')), '');
  v_review_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select u.user_id, public.normalize_app_role(u.role)
  into v_actor_user_id, v_actor_role
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if v_actor_user_id is null or v_actor_role <> 'staff' then
    raise exception 'Only an authenticated staff user can resubmit an event request.';
  end if;

  select *
  into v_existing
  from public."Event_Requests" er
  where er."Event_Request_ID" = p_event_request_id
  for update;

  if not found then
    raise exception 'Event request % was not found.', p_event_request_id;
  end if;
  if v_existing."Event_Application_ID" <> p_event_application_id then
    raise exception 'The event request does not belong to the selected application.';
  end if;
  if lower(replace(replace(replace(coalesce(v_existing."Status", ''), '_', ''), ' ', ''), '-', '')) <> 'rejected' then
    raise exception 'Only an admin-rejected event request can be resubmitted.';
  end if;
  if nullif(trim(coalesce(p_request_data->>'Event_Name', '')), '') is null then
    raise exception 'Event name is required before resubmitting.';
  end if;
  if nullif(trim(coalesce(p_request_data->>'Start_Date', '')), '') is null
    or nullif(trim(coalesce(p_request_data->>'End_Date', '')), '') is null
  then
    raise exception 'Start and end schedule are required before resubmitting.';
  end if;
  if nullif(trim(coalesce(p_request_data->>'Event_Photo_URL', '')), '') is null then
    raise exception 'Event poster photo is required before resubmitting.';
  end if;

  begin
    update public."Event_Requests" er
    set
      "Event_Name" = trim(p_request_data->>'Event_Name'),
      "Start_Date" = nullif(p_request_data->>'Start_Date', '')::timestamp without time zone,
      "End_Date" = nullif(p_request_data->>'End_Date', '')::timestamp without time zone,
      "Venue_Name" = nullif(trim(coalesce(p_request_data->>'Venue_Name', '')), ''),
      "Country" = coalesce(nullif(trim(coalesce(p_request_data->>'Country', '')), ''), 'Philippines'),
      "Region" = nullif(trim(coalesce(p_request_data->>'Region', '')), ''),
      "Province" = nullif(trim(coalesce(p_request_data->>'Province', '')), ''),
      "City_Municipality" = nullif(trim(coalesce(p_request_data->>'City_Municipality', '')), ''),
      "Barangay" = nullif(trim(coalesce(p_request_data->>'Barangay', '')), ''),
      "Street" = nullif(trim(coalesce(p_request_data->>'Street', '')), ''),
      "Longitude" = nullif(p_request_data->>'Longitude', '')::numeric,
      "Latitude" = nullif(p_request_data->>'Latitude', '')::numeric,
      "Event_Photo_URL" = trim(p_request_data->>'Event_Photo_URL'),
      "Event_Visibility" = case
        when lower(coalesce(p_request_data->>'Event_Visibility', 'public')) = 'private' then 'Private'
        else 'Public'
      end,
      "Event_By" = nullif(trim(coalesce(p_request_data->>'Event_By', '')), ''),
      "Partnered_With" = nullif(trim(coalesce(p_request_data->>'Partnered_With', '')), ''),
      "Partner_Social_Media_Link" = nullif(trim(coalesce(p_request_data->>'Partner_Social_Media_Link', '')), ''),
      "Status" = 'Appealed',
      "Staff_Prepared_By_User_ID" = v_actor_user_id,
      "Staff_Contact_Notes" = v_contact_notes,
      "Admin_Decision_Reason" = null,
      "Admin_Reviewer_User_ID" = null,
      "Admin_Reviewed_At" = null,
      "Updated_At" = v_now
    where er."Event_Request_ID" = p_event_request_id
    returning er."Status" into v_request_status;
  exception when check_violation or raise_exception then
    -- Compatibility with databases whose older workflow only accepts the
    -- rejected -> pending-admin transition.
    update public."Event_Requests" er
    set
      "Event_Name" = trim(p_request_data->>'Event_Name'),
      "Start_Date" = nullif(p_request_data->>'Start_Date', '')::timestamp without time zone,
      "End_Date" = nullif(p_request_data->>'End_Date', '')::timestamp without time zone,
      "Venue_Name" = nullif(trim(coalesce(p_request_data->>'Venue_Name', '')), ''),
      "Country" = coalesce(nullif(trim(coalesce(p_request_data->>'Country', '')), ''), 'Philippines'),
      "Region" = nullif(trim(coalesce(p_request_data->>'Region', '')), ''),
      "Province" = nullif(trim(coalesce(p_request_data->>'Province', '')), ''),
      "City_Municipality" = nullif(trim(coalesce(p_request_data->>'City_Municipality', '')), ''),
      "Barangay" = nullif(trim(coalesce(p_request_data->>'Barangay', '')), ''),
      "Street" = nullif(trim(coalesce(p_request_data->>'Street', '')), ''),
      "Longitude" = nullif(p_request_data->>'Longitude', '')::numeric,
      "Latitude" = nullif(p_request_data->>'Latitude', '')::numeric,
      "Event_Photo_URL" = trim(p_request_data->>'Event_Photo_URL'),
      "Event_Visibility" = case
        when lower(coalesce(p_request_data->>'Event_Visibility', 'public')) = 'private' then 'Private'
        else 'Public'
      end,
      "Event_By" = nullif(trim(coalesce(p_request_data->>'Event_By', '')), ''),
      "Partnered_With" = nullif(trim(coalesce(p_request_data->>'Partnered_With', '')), ''),
      "Partner_Social_Media_Link" = nullif(trim(coalesce(p_request_data->>'Partner_Social_Media_Link', '')), ''),
      "Status" = 'Pending Admin Approval',
      "Staff_Prepared_By_User_ID" = v_actor_user_id,
      "Staff_Contact_Notes" = v_contact_notes,
      "Admin_Decision_Reason" = null,
      "Admin_Reviewer_User_ID" = null,
      "Admin_Reviewed_At" = null,
      "Updated_At" = v_now
    where er."Event_Request_ID" = p_event_request_id
    returning er."Status" into v_request_status;
  end;

  update public."Event_Applications" ea
  set
    "Status" = 'Appealed',
    "Staff_Contact_Notes" = v_contact_notes,
    "Staff_Review_Notes" = v_review_notes,
    "Staff_Contacted_At" = case
      when v_contact_notes is not null then coalesce(ea."Staff_Contacted_At", v_now)
      else ea."Staff_Contacted_At"
    end,
    "Staff_Reviewer_User_ID" = v_actor_user_id,
    "Staff_Reviewed_At" = coalesce(ea."Staff_Reviewed_At", v_now),
    "Resubmission_Count" = coalesce(ea."Resubmission_Count", 0) + 1,
    "Updated_At" = v_now
  where ea."Event_Application_ID" = p_event_application_id
  returning ea."Resubmission_Count"
  into v_resubmission_count;

  if not found then
    raise exception 'Event application % was not found.', p_event_application_id;
  end if;

  return query
  select
    p_event_request_id,
    v_request_status,
    v_resubmission_count,
    v_contact_notes,
    v_review_notes;
end;
$fn$;

revoke all on function public.save_event_application_staff_notes(integer, text, text) from public;
revoke all on function public.staff_resubmit_event_request(integer, integer, jsonb, text, text) from public;

grant execute on function public.save_event_application_staff_notes(integer, text, text) to authenticated;
grant execute on function public.staff_resubmit_event_request(integer, integer, jsonb, text, text) to authenticated;

commit;
