-- Separate mobile-app registrations from walk-ins and repair the direct pickup backfill.

begin;

-- Preserve the authorized summaries as private base functions, then correct
-- only the attendance fields exposed by the public RPC names.
alter function public.get_event_operations_summary(integer)
  rename to get_event_operations_summary_before_mobile_split;

revoke all on function public.get_event_operations_summary_before_mobile_split(integer)
  from public, anon, authenticated;

create function public.get_event_operations_summary(p_event_request_id integer)
returns jsonb
language sql
security definer
set search_path = public
as $fn$
  with base as (
    select public.get_event_operations_summary_before_mobile_split(p_event_request_id) as result
  ), stats as (
    select
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as total_registered,
      count(*) filter (
        where coalesce(attendee."Is_Walk_In", false) = false
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as mobile_registered,
      count(*) filter (
        where coalesce(attendee."Is_Walk_In", false) = true
          and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
      )::integer as walk_ins,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
      )::integer as donors,
      count(*) filter (
        where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
          and attendee."RSVP_Scanned_At" is not null
          and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
      )::integer as present
    from public."Event_Attendees" attendee
    where attendee."Event_Request_ID" = p_event_request_id
  )
  select base.result || jsonb_build_object(
    'registered', stats.mobile_registered,
    'walk_ins', stats.walk_ins,
    'donors', stats.donors,
    'present', stats.present,
    'no_show', greatest(stats.total_registered - stats.present, 0)
  )
  from base cross join stats;
$fn$;

revoke all on function public.get_event_operations_summary(integer) from public, anon;
grant execute on function public.get_event_operations_summary(integer) to authenticated;

comment on function public.get_event_operations_summary(integer) is
  'Returns event operations totals with donors first, mobile-app registrations separate from walk-ins, and no-shows based on all attendees.';

alter function public.get_program_analytics_report()
  rename to get_program_analytics_report_before_mobile_split;

revoke all on function public.get_program_analytics_report_before_mobile_split()
  from public, anon, authenticated;

create function public.get_program_analytics_report()
returns jsonb
language sql
security definer
set search_path = public
as $fn$
  with base as (
    select public.get_program_analytics_report_before_mobile_split() as result
  ), rows as (
    select item.value
    from base
    cross join lateral jsonb_array_elements(base.result) item(value)
  ), corrected as (
    select
      row.value,
      stats.total_registered,
      stats.mobile_registered,
      stats.walk_ins,
      stats.donors,
      stats.present
    from rows row
    left join lateral (
      select
        count(*) filter (
          where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
        )::integer as total_registered,
        count(*) filter (
          where coalesce(attendee."Is_Walk_In", false) = false
            and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
        )::integer as mobile_registered,
        count(*) filter (
          where coalesce(attendee."Is_Walk_In", false) = true
            and public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
        )::integer as walk_ins,
        count(*) filter (
          where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
            and public.normalize_flow_key(attendee."Attendee_Type") = 'donor'
        )::integer as donors,
        count(*) filter (
          where public.normalize_flow_key(attendee."Registration_Status") <> 'cancelled'
            and attendee."RSVP_Scanned_At" is not null
            and public.normalize_flow_key(attendee."Attendance_Status") = 'present'
        )::integer as present
      from public."Event_Attendees" attendee
      where attendee."Event_Request_ID" = (row.value ->> 'event_request_id')::integer
    ) stats on true
  )
  select coalesce(jsonb_agg(
    corrected.value || jsonb_build_object(
      'registered', coalesce(corrected.mobile_registered, 0),
      'walk_ins', coalesce(corrected.walk_ins, 0),
      'donors', coalesce(corrected.donors, 0),
      'present', coalesce(corrected.present, 0),
      'no_show', greatest(
        coalesce(corrected.total_registered, 0) - coalesce(corrected.present, 0),
        0
      )
    )
    order by corrected.value ->> 'start_date' desc,
      (corrected.value ->> 'event_request_id')::integer desc
  ), '[]'::jsonb)
  from corrected;
$fn$;

revoke all on function public.get_program_analytics_report() from public, anon;
grant execute on function public.get_program_analytics_report() to authenticated;

comment on function public.get_program_analytics_report() is
  'Returns program analytics with total donors, mobile-app registrations, and walk-in donors reported separately.';

-- The prior backfill changed only updated_at, but the lifecycle trigger listens
-- to return_status. Including return_status in SET makes PostgreSQL fire it.
update public.wig_release_appeals appeal
set
  return_status = appeal.return_status,
  updated_at = timezone('Asia/Manila',now())
where appeal.return_status = 'Ready for Re-release'
  and exists (
    select 1
    from public."Wig_Requests" request
    where request."Req_ID" = appeal.req_id
      and request."Hospital_ID" is null
      and public.normalize_flow_key(request."Status") in ('toberelease','appealed')
  );

notify pgrst, 'reload schema';

commit;
