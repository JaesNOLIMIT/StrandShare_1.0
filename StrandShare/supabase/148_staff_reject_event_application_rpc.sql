-- 148_staff_reject_event_application_rpc.sql
-- Reject an intake application through one verified staff-only transaction.
-- This avoids silent zero-row updates caused by direct table RLS filtering.

begin;

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
    raise exception 'Only an authenticated staff user can reject an event application.';
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

  if lower(replace(replace(replace(coalesce(v_application."Status", ''), '_', ''), ' ', ''), '-', ''))
    <> 'pendingstaffreview'
  then
    raise exception 'Only an application pending staff review can be rejected.';
  end if;

  if coalesce(v_application."Linked_Event_Request_ID", 0) > 0 then
    raise exception 'This application was already submitted to admin and cannot be rejected by staff.';
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
    "Updated_At" = v_now
  where ea."Event_Application_ID" = p_event_application_id
  returning ea.*;

  if not found then
    raise exception 'The application rejection was not saved.';
  end if;
end;
$fn$;

revoke all on function public.staff_reject_event_application(integer, text, text, text) from public;
grant execute on function public.staff_reject_event_application(integer, text, text, text) to authenticated;

commit;
