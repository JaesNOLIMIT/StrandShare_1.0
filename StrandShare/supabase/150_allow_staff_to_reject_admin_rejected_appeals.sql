-- Staff may permanently reject either:
-- 1) an application during initial staff review, or
-- 2) an admin-rejected application instead of resubmitting an appeal.

begin;

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
  staff_rejection_marker_added boolean := false;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  old_status_key := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));
  new_status_key := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));
  staff_rejection_marker_added := new_status_key = 'rejected'
    and coalesce(old."Staff_Rejected_By_User_ID", 0) = 0
    and coalesce(new."Staff_Rejected_By_User_ID", 0) > 0;

  if old_status_key is not distinct from new_status_key
    and not staff_rejection_marker_added
  then
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
    if new_status_key = 'rejected'
      and (
        (
          old_status_key = 'pendingstaffreview'
          and coalesce(new."Linked_Event_Request_ID", 0) = 0
        )
        or (
          old_status_key in ('pendingadmindecision', 'appealed', 'rejected')
          and linked_request_status_key = 'rejected'
        )
      )
    then
      if length(trim(coalesce(new."Staff_Rejection_Reason", ''))) = 0 then
        raise exception 'Staff rejection reason is required when rejecting event applications or appeals.';
      end if;
      new."Staff_Rejected_By_User_ID" = actor_user_id;
      new."Staff_Rejected_At" = coalesce(new."Staff_Rejected_At", manila_now);
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

create or replace function public.lock_staff_rejected_event_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old_status text;
begin
  v_old_status := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));

  if v_old_status = 'rejected'
    and coalesce(old."Staff_Rejected_By_User_ID", 0) > 0
  then
    raise exception 'This application or appeal was rejected by staff and is permanently closed. Submit a new application instead.';
  end if;

  return new;
end;
$fn$;

create or replace function public.enqueue_event_application_smtp_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  actor_user_id integer;
  recipient_email text;
  old_status_key text;
  new_status_key text;
  staff_rejection_marker_added boolean := false;
  queue_key text;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  old_status_key := lower(replace(replace(replace(coalesce(old."Status", ''), '_', ''), ' ', ''), '-', ''));
  new_status_key := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));
  staff_rejection_marker_added := new_status_key = 'rejected'
    and coalesce(old."Staff_Rejected_By_User_ID", 0) = 0
    and coalesce(new."Staff_Rejected_By_User_ID", 0) > 0;

  if old_status_key = new_status_key
    and not staff_rejection_marker_added
  then
    return new;
  end if;

  recipient_email := public.resolve_event_application_recipient_email(
    new."Applicant_Email",
    new."Preferred_Contact_Method",
    new."Preferred_Contact_Detail"
  );

  if recipient_email is null then
    return new;
  end if;

  select u.user_id
  into actor_user_id
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if new_status_key = 'rejected'
    and coalesce(new."Staff_Rejected_By_User_ID", 0) > 0
    and (old_status_key <> 'rejected' or staff_rejection_marker_added)
  then
    queue_key := 'ea_staff_rejected:' || new."Event_Application_ID"::text || ':' || to_char(coalesce(new."Staff_Rejected_At", manila_now), 'YYYYMMDDHH24MISS');

    perform public.enqueue_smtp_email_outbox(
      queue_key,
      'Event_Applications',
      new."Event_Application_ID",
      'staff_rejected',
      recipient_email,
      'Event Application Update - Not Approved by Staff',
      'event_staff_rejected',
      jsonb_build_object(
        'event_application_id', new."Event_Application_ID",
        'event_name', coalesce(new."Event_Name", ''),
        'event_overview', coalesce(new."Event_Overview", ''),
        'proposed_start_at', new."Proposed_Start_At",
        'proposed_end_at', new."Proposed_End_At",
        'expected_attendees', new."Expected_Attendees",
        'venue_address', coalesce(new."Venue_Address", ''),
        'street', coalesce(new."Street", ''),
        'barangay', coalesce(new."Barangay", ''),
        'city', coalesce(new."City", ''),
        'province', coalesce(new."Province", ''),
        'region', coalesce(new."Region", ''),
        'country', coalesce(new."Country", ''),
        'staff_rejection_reason', coalesce(new."Staff_Rejection_Reason", ''),
        'rejected_after_admin_decision', old_status_key <> 'pendingstaffreview',
        'preferred_contact_method', coalesce(new."Preferred_Contact_Method", ''),
        'preferred_contact_detail', coalesce(new."Preferred_Contact_Detail", '')
      ),
      actor_user_id
    );
  elsif new_status_key = 'pendingadmindecision'
    and old_status_key in ('pendingstaffreview', 'rejected', 'appealed')
    and coalesce(new."Linked_Event_Request_ID", 0) > 0
  then
    queue_key := 'ea_staff_endorsed:' || new."Event_Application_ID"::text || ':' || new."Linked_Event_Request_ID"::text;

    perform public.enqueue_smtp_email_outbox(
      queue_key,
      'Event_Applications',
      new."Event_Application_ID",
      'staff_endorsed_pending_admin',
      recipient_email,
      'Event Application Update - Staff Review Completed',
      'event_staff_endorsed_pending_admin',
      jsonb_build_object(
        'event_application_id', new."Event_Application_ID",
        'linked_event_request_id', new."Linked_Event_Request_ID",
        'event_name', coalesce(new."Event_Name", ''),
        'event_overview', coalesce(new."Event_Overview", ''),
        'proposed_start_at', new."Proposed_Start_At",
        'proposed_end_at', new."Proposed_End_At",
        'expected_attendees', new."Expected_Attendees",
        'venue_address', coalesce(new."Venue_Address", ''),
        'street', coalesce(new."Street", ''),
        'barangay', coalesce(new."Barangay", ''),
        'city', coalesce(new."City", ''),
        'province', coalesce(new."Province", ''),
        'region', coalesce(new."Region", ''),
        'country', coalesce(new."Country", ''),
        'preferred_contact_method', coalesce(new."Preferred_Contact_Method", ''),
        'preferred_contact_detail', coalesce(new."Preferred_Contact_Detail", ''),
        'message', 'Our staff reviewed your request and will contact you using your selected contact method. A separate email will follow after admin approval and publication readiness.'
      ),
      actor_user_id
    );
  end if;

  return new;
end;
$fn$;

create or replace function public.staff_reject_event_application(
  p_event_application_id integer,
  p_rejection_reason text,
  p_contact_notes text default null,
  p_review_notes text default null
)
returns setof public."Event_Applications"
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor_user_id integer;
  v_actor_role text;
  v_application public."Event_Applications"%rowtype;
  v_application_status text;
  v_linked_request_status text;
  v_is_initial_rejection boolean := false;
  v_is_appeal_rejection boolean := false;
  v_reason text := nullif(trim(coalesce(p_rejection_reason, '')), '');
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
    raise exception 'Only an authenticated staff user can reject an event application or appeal.';
  end if;

  if v_reason is null then
    raise exception 'A rejection reason is required.';
  end if;

  select *
  into v_application
  from public."Event_Applications" ea
  where ea."Event_Application_ID" = p_event_application_id
  for update;

  if not found then
    raise exception 'Event application % was not found.', p_event_application_id;
  end if;

  v_application_status := lower(replace(replace(replace(coalesce(v_application."Status", ''), '_', ''), ' ', ''), '-', ''));
  v_is_initial_rejection := v_application_status = 'pendingstaffreview'
    and coalesce(v_application."Linked_Event_Request_ID", 0) = 0;

  if coalesce(v_application."Linked_Event_Request_ID", 0) > 0 then
    select lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', ''))
    into v_linked_request_status
    from public."Event_Requests" er
    where er."Event_Request_ID" = v_application."Linked_Event_Request_ID"
      and er."Event_Application_ID" = v_application."Event_Application_ID"
    for update;

    v_is_appeal_rejection := v_linked_request_status = 'rejected'
      and v_application_status in ('pendingadmindecision', 'appealed', 'rejected')
      and coalesce(v_application."Staff_Rejected_By_User_ID", 0) = 0;
  end if;

  if not v_is_initial_rejection and not v_is_appeal_rejection then
    raise exception 'Only an application pending staff review or an admin-rejected application awaiting appeal can be rejected by staff.';
  end if;

  return query
  update public."Event_Applications" ea
  set
    "Status" = 'Rejected',
    "Staff_Rejection_Reason" = v_reason,
    "Staff_Contact_Notes" = v_contact_notes,
    "Staff_Review_Notes" = v_review_notes,
    "Staff_Contacted_At" = case
      when v_contact_notes is not null then coalesce(ea."Staff_Contacted_At", v_now)
      else ea."Staff_Contacted_At"
    end,
    "Staff_Reviewer_User_ID" = v_actor_user_id,
    "Staff_Reviewed_At" = coalesce(ea."Staff_Reviewed_At", v_now),
    "Staff_Rejected_By_User_ID" = v_actor_user_id,
    "Staff_Rejected_At" = v_now,
    "Updated_At" = v_now
  where ea."Event_Application_ID" = p_event_application_id
  returning ea.*;

  if not found then
    raise exception 'The application or appeal rejection was not saved.';
  end if;
end;
$fn$;

revoke all on function public.staff_reject_event_application(integer, text, text, text) from public;
grant execute on function public.staff_reject_event_application(integer, text, text, text) to authenticated;

commit;
