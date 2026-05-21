-- 136_allow_appealed_application_to_sync_approved.sql
-- Fix admin approval flow for appealed requests:
-- When Event_Requests transitions Appealed -> Approved, the sync trigger updates
-- Event_Applications.Status from Appealed -> Approved. The workflow guard must
-- allow this sync path.

begin;

create or replace function public.enforce_event_application_workflow()
returns trigger
language plpgsql
as $$
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

  select
    u.user_id,
    public.normalize_app_role(u.role)
  into actor_user_id, actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if coalesce(new."Linked_Event_Request_ID", 0) > 0 then
    select
      lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', ''))
    into linked_request_status_key
    from public."Event_Requests" er
    where er."Event_Request_ID" = new."Linked_Event_Request_ID"
      and er."Event_Application_ID" = new."Event_Application_ID"
    limit 1;
  end if;

  -- Fallback for legacy rows with no Linked_Event_Request_ID.
  if linked_request_status_key is null then
    if old_status_key in ('pendingadmindecision', 'appealed') and new_status_key = 'approved' then
      select exists (
        select 1
        from public."Event_Requests" er
        where er."Event_Application_ID" = new."Event_Application_ID"
          and lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', '')) = 'approved'
      )
      into has_matching_request_decision;
    elsif old_status_key = 'pendingadmindecision' and new_status_key in ('appealed', 'rejected') then
      select exists (
        select 1
        from public."Event_Requests" er
        where er."Event_Application_ID" = new."Event_Application_ID"
          and lower(replace(replace(replace(coalesce(er."Status", ''), '_', ''), ' ', ''), '-', '')) = 'rejected'
      )
      into has_matching_request_decision;
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
    elsif old_status_key in ('pendingstaffreview', 'rejected', 'appealed') and new_status_key = 'pendingadmindecision' then
      if coalesce(new."Linked_Event_Request_ID", 0) = 0 then
        raise exception 'Linked event request is required before submitting to admin decision.';
      end if;

      new."Staff_Reviewer_User_ID" = actor_user_id;
      new."Staff_Reviewed_At" = coalesce(new."Staff_Reviewed_At", manila_now);
      new."Staff_Rejection_Reason" = null;
      new."Staff_Rejected_At" = null;
      new."Staff_Rejected_By_User_ID" = null;
    elsif old_status_key = 'rejected' and new_status_key = 'appealed' then
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
$$;

commit;
