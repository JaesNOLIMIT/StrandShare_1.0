-- 121_link_hair_submissions_to_event_attendees.sql
-- Link Hair_Submissions to Event_Attendees directly while keeping backward
-- compatibility for existing Event_Request_ID-based flows.

begin;

alter table public."Hair_Submissions"
  add column if not exists "Event_Attendee_ID" integer null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hair_submissions_event_attendee_fkey'
      and conrelid = 'public."Hair_Submissions"'::regclass
  ) then
    alter table public."Hair_Submissions"
      add constraint hair_submissions_event_attendee_fkey
      foreign key ("Event_Attendee_ID")
      references public."Event_Attendees" ("Event_Attendee_ID")
      on delete set null;
  end if;
end
$$;

create index if not exists idx_hair_submissions_event_attendee_id
  on public."Hair_Submissions" using btree ("Event_Attendee_ID");

-- Backfill attendee link from existing (Event_Request_ID + User_ID).
with matched as (
  select
    hs."Submission_ID",
    ea_match."Event_Attendee_ID"
  from public."Hair_Submissions" hs
  join lateral (
    select ea."Event_Attendee_ID"
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = hs."Event_Request_ID"
      and ea."User_ID" = hs."User_ID"
    order by coalesce(ea."RSVP_Scanned_At", ea."Created_At") desc nulls last,
      ea."Event_Attendee_ID" desc
    limit 1
  ) as ea_match on true
  where hs."Event_Attendee_ID" is null
    and coalesce(hs."From_Event", false)
    and hs."Event_Request_ID" is not null
    and hs."User_ID" is not null
)
update public."Hair_Submissions" hs
set "Event_Attendee_ID" = matched."Event_Attendee_ID"
from matched
where hs."Submission_ID" = matched."Submission_ID";

-- Keep Event_Attendee_ID and Event_Request_ID in sync during transition.
create or replace function public.sync_hair_submissions_event_links()
returns trigger
language plpgsql
as $fn$
declare
  v_attendee_id integer;
  v_attendee_event_request_id integer;
  v_attendee_user_id integer;
begin
  if coalesce(new."From_Event", false) then
    if new."Event_Attendee_ID" is null
      and new."Event_Request_ID" is not null
      and new."User_ID" is not null then
      select
        ea."Event_Attendee_ID",
        ea."Event_Request_ID",
        ea."User_ID"
      into
        v_attendee_id,
        v_attendee_event_request_id,
        v_attendee_user_id
      from public."Event_Attendees" ea
      where ea."Event_Request_ID" = new."Event_Request_ID"
        and ea."User_ID" = new."User_ID"
      order by coalesce(ea."RSVP_Scanned_At", ea."Created_At") desc nulls last,
        ea."Event_Attendee_ID" desc
      limit 1;

      if v_attendee_id is not null then
        new."Event_Attendee_ID" := v_attendee_id;
      end if;
    end if;

    if new."Event_Attendee_ID" is not null then
      select
        ea."Event_Request_ID",
        ea."User_ID"
      into
        v_attendee_event_request_id,
        v_attendee_user_id
      from public."Event_Attendees" ea
      where ea."Event_Attendee_ID" = new."Event_Attendee_ID"
      limit 1;

      if v_attendee_event_request_id is not null then
        new."Event_Request_ID" := v_attendee_event_request_id;
      end if;

      if new."User_ID" is null then
        new."User_ID" := v_attendee_user_id;
      end if;
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_sync_hair_submissions_event_links on public."Hair_Submissions";
create trigger trg_sync_hair_submissions_event_links
before insert or update of "From_Event", "Event_Attendee_ID", "Event_Request_ID", "User_ID"
on public."Hair_Submissions"
for each row
execute function public.sync_hair_submissions_event_links();

-- Event attendee defaults are independent from Hair_Submissions waybill columns.
create or replace function public.set_event_attendees_defaults()
returns trigger
language plpgsql
as $fn$
begin
  if public.is_waybill_code(new."Waybill_Code") then
    new."Waybill_Code" := upper(trim(new."Waybill_Code"));
  else
    new."Waybill_Code" := public.generate_waybill_code();
  end if;

  if new."Created_At" is null then
    new."Created_At" := timezone('Asia/Manila', now());
  end if;
  new."Updated_At" := timezone('Asia/Manila', now());

  return new;
end;
$fn$;

-- Legacy compatibility: keep function name available but no-op.
create or replace function public.set_hair_submissions_waybill_defaults()
returns trigger
language plpgsql
as $fn$
begin
  return new;
end;
$fn$;

drop trigger if exists trg_set_hair_submissions_waybill_defaults on public."Hair_Submissions";

commit;
