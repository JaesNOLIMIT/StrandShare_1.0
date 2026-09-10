-- Reduce idle write amplification from the event-ending cron job.
--
-- The event scanner RPCs also call mark_ended_event_requests(), so reducing the
-- background cadence does not delay validation when staff actively scan. The
-- scheduled transition remains available for events with no scanner activity.

begin;

create extension if not exists pg_cron with schema pg_catalog;

do $do$
declare
  v_primary_job_id bigint;
  v_duplicate_job_id bigint;
  v_cleanup_job_id bigint;
begin
  -- Keep one stable job id so recent execution history remains attributable.
  select min(j.jobid)
  into v_primary_job_id
  from cron.job j
  where j.jobname = 'strandshare-end-events';

  if v_primary_job_id is null then
    v_primary_job_id := cron.schedule(
      'strandshare-end-events',
      '*/5 * * * *',
      'select public.mark_ended_event_requests();'
    );
  else
    perform cron.alter_job(
      v_primary_job_id,
      schedule := '*/5 * * * *',
      command := 'select public.mark_ended_event_requests();',
      active := true
    );
  end if;

  -- A partially applied older migration could have left duplicate named jobs.
  -- Remove only the duplicates; the primary job above remains active.
  for v_duplicate_job_id in
    select j.jobid
    from cron.job j
    where j.jobname = 'strandshare-end-events'
      and j.jobid <> v_primary_job_id
  loop
    delete from cron.job_run_details d
    where d.jobid = v_duplicate_job_id;
    perform cron.unschedule(v_duplicate_job_id);
  end loop;

  -- pg_cron does not automatically purge job_run_details. Retain seven days of
  -- StrandShare history for troubleshooting without allowing it to grow forever.
  delete from cron.job_run_details d
  where d.end_time < now() - interval '7 days'
    and d.jobid in (
      select j.jobid
      from cron.job j
      where j.jobname like 'strandshare-%'
    );

  select min(j.jobid)
  into v_cleanup_job_id
  from cron.job j
  where j.jobname = 'strandshare-clean-cron-history';

  if v_cleanup_job_id is null then
    v_cleanup_job_id := cron.schedule(
      'strandshare-clean-cron-history',
      '17 3 * * *',
      $command$
        delete from cron.job_run_details d
        where d.end_time < now() - interval '7 days'
          and d.jobid in (
            select j.jobid
            from cron.job j
            where j.jobname like 'strandshare-%'
          );
      $command$
    );
  else
    perform cron.alter_job(
      v_cleanup_job_id,
      schedule := '17 3 * * *',
      command := $command$
        delete from cron.job_run_details d
        where d.end_time < now() - interval '7 days'
          and d.jobid in (
            select j.jobid
            from cron.job j
            where j.jobname like 'strandshare-%'
          );
      $command$,
      active := true
    );
  end if;

  for v_duplicate_job_id in
    select j.jobid
    from cron.job j
    where j.jobname = 'strandshare-clean-cron-history'
      and j.jobid <> v_cleanup_job_id
  loop
    delete from cron.job_run_details d
    where d.jobid = v_duplicate_job_id;
    perform cron.unschedule(v_duplicate_job_id);
  end loop;
end;
$do$;

comment on function public.mark_ended_event_requests()
  is 'Transitions approved events after End_Date; scheduled every five minutes and also called by scanner RPCs.';

commit;
