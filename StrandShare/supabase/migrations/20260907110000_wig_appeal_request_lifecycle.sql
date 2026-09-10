begin;

-- A released request becomes active again while an appeal is being handled.
-- Keep the appeal state on Wig_Requests so every dashboard and report shows
-- the same lifecycle as wig_release_appeals.
alter table public."Wig_Requests"
  drop constraint if exists wig_requests_status_check;

alter table public."Wig_Requests"
  add constraint wig_requests_status_check check (
    lower(coalesce("Status", '')) = any (array[
      'pending',
      'accepted - wig allocated',
      'accepted - in production',
      'ready for pick-up',
      'to be release',
      'releasing',
      'released',
      'appealed',
      'rejected',
      'cancelled'
    ])
  );

-- Returning to Released because an appeal was rejected must not create a
-- second release receipt. A new receipt is created only after an actual
-- repaired/replacement wig handover.
create or replace function public.create_wig_release_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_released_at timestamp without time zone := coalesce(new."Updated_At", timezone('Asia/Manila', now()));
  v_cycle integer;
  v_terms text := 'By confirming receipt, the hospital representative acknowledges that the wig was received on behalf of the named patient. The wig must be inspected promptly. Damage, an incorrect wig, or a material fit issue may be appealed within seven calendar days after staff confirms release. Appeals must include an explanation and supporting evidence when available. An approved appeal requires the wig to be returned to the displayed office destination. Staff will confirm receipt, complete the repair or replacement work, and schedule a new release.';
begin
  if public.normalize_flow_key(new."Status") = 'released'
    and (tg_op = 'INSERT' or public.normalize_flow_key(old."Status") is distinct from 'released')
    and coalesce(new."Status_Reason", '') not like 'Appeal rejected;%'
  then
    select coalesce(max(release_cycle), 0) + 1 into v_cycle
    from public.wig_release_receipts where req_id = new."Req_ID";

    insert into public.wig_release_receipts (
      req_id, release_cycle, released_at, appeal_deadline,
      terms_version, terms_snapshot, updated_at
    ) values (
      new."Req_ID", v_cycle, v_released_at, v_released_at + interval '7 days',
      '2026-09-03-v2', v_terms, v_released_at
    );

    update public.wig_release_appeals
    set return_status = 'Completed', updated_at = v_released_at
    where req_id = new."Req_ID" and return_status = 'Ready for Re-release';
  end if;
  return new;
end;
$fn$;

create or replace function public.sync_wig_request_appeal_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  if new.return_status = 'Completed' then
    -- The release trigger has already moved the request to Released and made
    -- the next receipt cycle. Do not overwrite that final transition.
    return new;
  end if;

  if new.status = 'Rejected' then
    update public."Wig_Requests"
    set "Status" = 'Released',
        "Status_Reason" = 'Appeal rejected; the original wig release remains final',
        "Updated_At" = v_now
    where "Req_ID" = new.req_id;
  elsif new.return_status = 'Ready for Re-release' then
    update public."Release_Schedules"
    set "Is_Current" = false, "Updated_At" = v_now
    where "Req_ID" = new.req_id and "Is_Current" = true;

    update public."Wig_Requests"
    set "Status" = 'To Be Release',
        "Status_Reason" = 'Repair completed; waiting for a new release schedule',
        "Updated_At" = v_now
    where "Req_ID" = new.req_id;
  else
    update public."Wig_Requests"
    set "Status" = 'Appealed',
        "Status_Reason" = case
          when new.status = 'Pending Staff Review' then 'Release appeal submitted and awaiting Staff review'
          when new.return_status = 'Awaiting Return' then 'Appeal approved; waiting for the wig return shipment'
          when new.return_status = 'In Transit' then 'Appealed wig is being returned to the office'
          when new.return_status = 'Return Received' then 'Appealed wig was returned and is waiting for repair'
          when new.return_status = 'Under Repair' then 'Appealed wig is under repair or replacement'
          else 'Wig release appeal is active'
        end,
        "Updated_At" = v_now
    where "Req_ID" = new.req_id;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_sync_wig_request_appeal_lifecycle on public.wig_release_appeals;
create trigger trg_sync_wig_request_appeal_lifecycle
after insert or update of status, return_status
on public.wig_release_appeals
for each row execute function public.sync_wig_request_appeal_lifecycle();

-- The older repair RPC writes Accepted - Wig Allocated after completing a
-- repair. Normalize that legacy write to the actual next step: schedule the
-- repaired wig for release again.
create or replace function public.keep_repaired_wig_in_release_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if public.normalize_flow_key(new."Status") = 'acceptedwigallocated'
    and exists (
      select 1
      from public.wig_release_appeals appeal
      where appeal.req_id = new."Req_ID"
        and appeal.return_status = 'Ready for Re-release'
    )
  then
    new."Status" := 'To Be Release';
    new."Status_Reason" := 'Repair completed; waiting for a new release schedule';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_05_keep_repaired_wig_in_release_queue on public."Wig_Requests";
create trigger trg_05_keep_repaired_wig_in_release_queue
before update of "Status"
on public."Wig_Requests"
for each row execute function public.keep_repaired_wig_in_release_queue();

-- Repair already-open appeals in databases that applied the original return
-- workflow. Completed and rejected appeals keep their existing final status.
with latest_active_appeal as (
  select distinct on (appeal.req_id)
    appeal.req_id,
    appeal.status,
    appeal.return_status
  from public.wig_release_appeals appeal
  where appeal.status <> 'Rejected'
    and appeal.return_status is distinct from 'Completed'
  order by appeal.req_id, appeal.submitted_at desc, appeal.appeal_id desc
)
update public."Wig_Requests" request_row
set "Status" = case
      when appeal.return_status = 'Ready for Re-release' then 'To Be Release'
      else 'Appealed'
    end,
    "Status_Reason" = case
      when appeal.return_status = 'Ready for Re-release' then 'Repair completed; waiting for a new release schedule'
      when appeal.status = 'Pending Staff Review' then 'Release appeal submitted and awaiting Staff review'
      when appeal.return_status = 'Awaiting Return' then 'Appeal approved; waiting for the wig return shipment'
      when appeal.return_status = 'In Transit' then 'Appealed wig is being returned to the office'
      when appeal.return_status = 'Return Received' then 'Appealed wig was returned and is waiting for repair'
      when appeal.return_status = 'Under Repair' then 'Appealed wig is under repair or replacement'
      else 'Wig release appeal is active'
    end,
    "Updated_At" = timezone('Asia/Manila', now())
from latest_active_appeal appeal
where request_row."Req_ID" = appeal.req_id;

update public."Release_Schedules" schedule
set "Is_Current" = false, "Updated_At" = timezone('Asia/Manila', now())
where schedule."Is_Current" = true
  and exists (
    select 1 from public.wig_release_appeals appeal
    where appeal.req_id = schedule."Req_ID"
      and appeal.return_status = 'Ready for Re-release'
  );

notify pgrst, 'reload schema';
commit;
