-- Operational program analytics for Admin and assigned Staff reports.
-- Admin sees every program; Staff sees only programs assigned to them.

create or replace function public.get_program_analytics_report()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor public.users%rowtype;
  v_role text;
  v_result jsonb;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
  limit 1;

  if v_actor.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role := public.normalize_app_role(v_actor.role);
  if v_role not in ('admin', 'staff') then
    raise exception 'Only Admin and Staff can view program analytics.';
  end if;

  with eligible_events as (
    select
      event.*,
      case
        when public.normalize_flow_key(event."Status") = 'successful' then 'Successful'
        when public.normalize_flow_key(event."Status") = 'ended' then 'Ended'
        when public.normalize_flow_key(event."Status") = 'approved'
          and event."End_Date" is not null
          and event."End_Date" <= timezone('Asia/Manila', now()) then 'Ended'
        else coalesce(nullif(trim(event."Status"), ''), 'Unknown')
      end as analytics_status
    from public."Event_Requests" event
    where v_role = 'admin' or event."Assigned_Staff_User_ID" = v_actor.user_id
  ), attendee_stats as (
    select
      attendee."Event_Request_ID" as event_request_id,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as registered,
      count(*) filter (
        where attendee."RSVP_Scanned_At" is not null
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
      )::integer as present,
      count(*) filter (
        where public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
      )::integer as donors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Attendee_Type") in ('visitor', 'voluntary')
      )::integer as visitors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
          and not exists (
            select 1
            from public."Hair_Submissions" submission
            join public."Hair_Submission_Details" detail
              on detail."Submission_ID" = submission."Submission_ID"
            where submission."Event_Request_ID" = attendee."Event_Request_ID"
              and (
                submission."Event_Attendee_ID" = attendee."Event_Attendee_ID"
                or (
                  submission."Event_Attendee_ID" is null
                  and submission."User_ID" = attendee."User_ID"
                )
              )
              and public.normalize_flow_key(detail."Status") in ('approved', 'rejected', 'rejectedcut')
          )
      )::integer as pending_reviews
    from public."Event_Attendees" attendee
    join eligible_events event on event."Event_Request_ID" = attendee."Event_Request_ID"
    group by attendee."Event_Request_ID"
  ), latest_details as (
    select distinct on (detail."Submission_ID")
      detail."Submission_ID",
      detail."Status"
    from public."Hair_Submission_Details" detail
    order by detail."Submission_ID", detail."Submission_Detail_ID" desc
  ), decision_stats as (
    select
      submission."Event_Request_ID" as event_request_id,
      count(*) filter (where public.normalize_flow_key(detail."Status") = 'approved')::integer as accepted,
      count(*) filter (where public.normalize_flow_key(detail."Status") = 'rejected')::integer as rejected,
      count(*) filter (where public.normalize_flow_key(detail."Status") = 'rejectedcut')::integer as rejected_cut
    from public."Hair_Submissions" submission
    join eligible_events event on event."Event_Request_ID" = submission."Event_Request_ID"
    left join latest_details detail on detail."Submission_ID" = submission."Submission_ID"
    group by submission."Event_Request_ID"
  ), inventory_stats as (
    select
      inventory."Event_Request_ID" as event_request_id,
      count(*)::integer as inventory_added
    from public."Cut_Hair_Inventory" inventory
    join eligible_events event on event."Event_Request_ID" = inventory."Event_Request_ID"
    group by inventory."Event_Request_ID"
  ), ai_stats as (
    select
      comparison."Event_Request_ID" as event_request_id,
      count(*) filter (
        where comparison."Is_AI_Source" and comparison."Reviewed_At" is not null
      )::integer as ai_reviews,
      round(avg(comparison."AI_Accuracy_Percent") filter (
        where comparison."Is_AI_Source" and comparison."Reviewed_At" is not null
      ), 2) as ai_accuracy_percent
    from public."Hair_AI_Review_Comparisons" comparison
    join eligible_events event on event."Event_Request_ID" = comparison."Event_Request_ID"
    group by comparison."Event_Request_ID"
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'event_request_id', event."Event_Request_ID",
      'event_name', event."Event_Name",
      'status', event.analytics_status,
      'assigned_staff_user_id', event."Assigned_Staff_User_ID",
      'start_date', event."Start_Date",
      'end_date', event."End_Date",
      'ended_at', event."Ended_At",
      'successful_at', event."Successful_At",
      'registered', coalesce(attendee.registered, 0),
      'present', coalesce(attendee.present, 0),
      'no_show', greatest(coalesce(attendee.registered, 0) - coalesce(attendee.present, 0), 0),
      'donors', coalesce(attendee.donors, 0),
      'visitors', coalesce(attendee.visitors, 0),
      'accepted', coalesce(decision.accepted, 0),
      'rejected', coalesce(decision.rejected, 0),
      'rejected_cut', coalesce(decision.rejected_cut, 0),
      'pending', coalesce(attendee.pending_reviews, 0),
      'inventory_added', coalesce(inventory.inventory_added, 0),
      'ai_reviews', coalesce(ai.ai_reviews, 0),
      'ai_accuracy_percent', coalesce(ai.ai_accuracy_percent, 0)
    ) order by event."Start_Date" desc, event."Event_Request_ID" desc
  ), '[]'::jsonb) into v_result
  from eligible_events event
  left join attendee_stats attendee on attendee.event_request_id = event."Event_Request_ID"
  left join decision_stats decision on decision.event_request_id = event."Event_Request_ID"
  left join inventory_stats inventory on inventory.event_request_id = event."Event_Request_ID"
  left join ai_stats ai on ai.event_request_id = event."Event_Request_ID";

  return v_result;
end;
$fn$;

revoke all on function public.get_program_analytics_report() from public, anon;
grant execute on function public.get_program_analytics_report() to authenticated;

comment on function public.get_program_analytics_report() is
  'Returns operational summaries for every program visible to the caller. Admin sees all programs; Staff sees assigned programs only.';
