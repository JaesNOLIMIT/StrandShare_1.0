-- Repair specialist QA authorization, SMTP quota recovery, and walk-in reporting.

begin;

create or replace function public.specialist_review_non_event_hair_quality_v2(
  p_submission_id integer,
  p_decision text,
  p_rejection_reason text default null,
  p_detail_updates jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $fn$
  select public.specialist_review_non_event_hair_quality(
    p_submission_id,
    p_decision,
    p_rejection_reason,
    p_detail_updates
  );
$fn$;

revoke all on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb)
  from public, anon;
grant execute on function public.specialist_review_non_event_hair_quality_v2(integer,text,text,jsonb)
  to authenticated;

-- Recover notification rows that were permanently cancelled only because the
-- configured Gmail sender exhausted its daily allowance. The worker now keeps
-- future quota failures retryable without consuming the normal attempt budget.
update public."SMTP_Email_Outbox"
set
  "Status" = 'Failed',
  "Attempt_Count" = 0,
  "Next_Attempt_At" = timezone('Asia/Manila', now()) + interval '24 hours',
  "Updated_At" = timezone('Asia/Manila', now())
where public.normalize_flow_key(coalesce("Status", '')) = 'cancelled'
  and (
    coalesce("Last_Error", '') ilike '%daily user sending limit exceeded%'
    or coalesce("Last_Error", '') ilike '%daily sending quota exceeded%'
    or coalesce("Last_Error", '') ilike '%daily recipient quota exceeded%'
  );

-- Walk-ins are registered on site. Include them in the registered total while
-- also exposing them as a separate subset for the operations summary.
create or replace function public.get_event_operations_summary(p_event_request_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role text;
  v_result jsonb;
begin
  select * into v_user
  from public.users account
  where account.auth_user_id = auth.uid()
  limit 1;

  if v_user.user_id is null then
    raise exception 'Unable to resolve authenticated user.';
  end if;

  v_role := public.normalize_app_role(v_user.role);
  if v_role not in ('admin', 'specialist') and not exists (
    select 1 from public."Event_Requests" event
    where event."Event_Request_ID" = p_event_request_id
      and event."Assigned_Staff_User_ID" = v_user.user_id
      and v_role = 'staff'
  ) then
    raise exception 'You do not have access to this event summary.';
  end if;

  with attendee_stats as (
    select
      count(*) filter (
        where coalesce(attendee."Is_Walk_In", false) = false
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as registered,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as total_registered,
      count(*) filter (
        where coalesce(attendee."Is_Walk_In", false) = true
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as walk_ins,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and attendee."RSVP_Scanned_At" is not null
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
      )::integer as present,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
      )::integer as donors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendee_Type") in ('visitor', 'voluntary')
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
            where submission."Event_Request_ID" = p_event_request_id
              and (
                submission."Event_Attendee_ID" = attendee."Event_Attendee_ID"
                or (
                  submission."Event_Attendee_ID" is null
                  and submission."User_ID" = attendee."User_ID"
                )
              )
              and public.normalize_flow_key(detail."Status") in (
                'approved', 'rejected', 'rejectedcut'
              )
          )
      )::integer as pending_reviews
    from public."Event_Attendees" attendee
    where attendee."Event_Request_ID" = p_event_request_id
  ), decisions as (
    select
      count(*) filter (where public.normalize_flow_key(latest."Status") = 'approved')::integer as accepted,
      count(*) filter (where public.normalize_flow_key(latest."Status") = 'rejected')::integer as rejected,
      count(*) filter (where public.normalize_flow_key(latest."Status") = 'rejectedcut')::integer as rejected_cut
    from public."Hair_Submissions" submission
    left join lateral (
      select detail."Status"
      from public."Hair_Submission_Details" detail
      where detail."Submission_ID" = submission."Submission_ID"
      order by detail."Submission_Detail_ID" desc
      limit 1
    ) latest on true
    where submission."Event_Request_ID" = p_event_request_id
  ), inventory_stats as (
    select count(*)::integer as inventory_added
    from public."Cut_Hair_Inventory" inventory
    where inventory."Event_Request_ID" = p_event_request_id
  ), ai_stats as (
    select
      count(*) filter (
        where comparison."Is_AI_Source" and comparison."Reviewed_At" is not null
      )::integer as ai_reviews,
      coalesce(sum(cardinality(comparison."Changed_Fields")) filter (
        where comparison."Is_AI_Source"
      ), 0)::integer as ai_corrections,
      coalesce(sum(cardinality(comparison."Critical_Changed_Fields")) filter (
        where comparison."Is_AI_Source"
      ), 0)::integer as critical_corrections,
      round(avg(comparison."AI_Accuracy_Percent") filter (
        where comparison."Is_AI_Source" and comparison."Reviewed_At" is not null
      ), 2) as ai_accuracy
    from public."Hair_AI_Review_Comparisons" comparison
    where comparison."Event_Request_ID" = p_event_request_id
  ), event_state as (
    select event."Status", event."Successful_At", event."Successful_By_User_ID"
    from public."Event_Requests" event
    where event."Event_Request_ID" = p_event_request_id
  )
  select jsonb_build_object(
    'registered', attendee.registered,
    'walk_ins', attendee.walk_ins,
    'present', attendee.present,
    'no_show', greatest(attendee.total_registered - attendee.present, 0),
    'donors', attendee.donors,
    'visitors', attendee.visitors,
    'accepted', decision.accepted,
    'approved_cut', decision.accepted,
    'rejected', decision.rejected,
    'rejected_cut', decision.rejected_cut,
    'pending', attendee.pending_reviews,
    'pending_reviews', attendee.pending_reviews,
    'inventory_added', inventory.inventory_added,
    'ai_reviews', ai.ai_reviews,
    'ai_corrections', ai.ai_corrections,
    'critical_corrections', ai.critical_corrections,
    'ai_accuracy_percent', ai.ai_accuracy,
    'event_status', event_state."Status",
    'successful_at', event_state."Successful_At",
    'successful_by_user_id', event_state."Successful_By_User_ID",
    'can_mark_successful', (
      v_role = 'staff'
      and public.normalize_flow_key(event_state."Status") = 'ended'
      and attendee.pending_reviews = 0
    )
  ) into v_result
  from attendee_stats attendee
  cross join decisions decision
  cross join inventory_stats inventory
  cross join ai_stats ai
  cross join event_state;

  return coalesce(v_result, '{}'::jsonb);
end;
$fn$;

revoke all on function public.get_event_operations_summary(integer) from public, anon;
grant execute on function public.get_event_operations_summary(integer) to authenticated;

comment on function public.get_event_operations_summary(integer) is
  'Returns total donors, mobile-app registrations, and registered-on-site walk-in donors separately.';

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
        where coalesce(attendee."Is_Walk_In", false) = false
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as registered,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as total_registered,
      count(*) filter (
        where coalesce(attendee."Is_Walk_In", false) = false
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and attendee."RSVP_Scanned_At" is not null
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
      )::integer as registered_present,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and attendee."RSVP_Scanned_At" is not null
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
      )::integer as present,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
      )::integer as donors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendee_Type") in ('visitor', 'voluntary')
      )::integer as visitors,
      count(*) filter (
        where coalesce(attendee."Is_Walk_In", false) = true
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as walk_ins,
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
    select distinct on (detail."Submission_ID") detail."Submission_ID", detail."Status"
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
    select inventory."Event_Request_ID" as event_request_id, count(*)::integer as inventory_added
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
      'walk_ins', coalesce(attendee.walk_ins, 0),
      'present', coalesce(attendee.present, 0),
      'no_show', greatest(coalesce(attendee.total_registered, 0) - coalesce(attendee.present, 0), 0),
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
  'Returns total donors, mobile-app registrations, and registered-on-site walk-in donors separately.';

notify pgrst, 'reload schema';

commit;
