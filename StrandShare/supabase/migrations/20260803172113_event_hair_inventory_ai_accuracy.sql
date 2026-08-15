-- Event operations, cut-hair inventory, and AI review accuracy.
-- Length changes up to 6 inches are recorded as staff corrections but are
-- treated as acceptable variance when calculating AI accuracy.

begin;

-- ---------------------------------------------------------------------------
-- Event completion
-- ---------------------------------------------------------------------------

alter table public."Event_Requests"
  add column if not exists "Ended_At" timestamp with time zone;

alter table public."Event_Requests"
  drop constraint if exists event_requests_status_check;

alter table public."Event_Requests"
  add constraint event_requests_status_check
  check (
    public.normalize_flow_key(coalesce("Status", '')) = any (
      array[
        'pendingadminapproval'::text,
        'appealed'::text,
        'approved'::text,
        'ended'::text,
        'rejected'::text,
        'cancelled'::text
      ]
    )
  );

create index if not exists idx_event_requests_end_date_approved
  on public."Event_Requests" ("End_Date")
  where public.normalize_flow_key("Status") = 'approved';

-- Preserve the current workflow and add the system transition Approved -> Ended.
create or replace function public.enforce_event_request_workflow()
returns trigger
language plpgsql
as $fn$
declare
  actor_user_id integer;
  actor_role_key text;
  old_status_key text;
  new_status_key text;
  visibility_key text;
  candidate_code text;
  attempt_count integer := 0;
  manila_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  old_status_key := public.normalize_flow_key(old."Status");
  new_status_key := public.normalize_flow_key(new."Status");
  visibility_key := public.normalize_flow_key(coalesce(new."Event_Visibility", 'Public'));
  new."Event_Visibility" := case when visibility_key = 'private' then 'Private' else 'Public' end;

  if old_status_key is not distinct from new_status_key then
    if new."Event_Visibility" <> 'Private' then
      new."Private_Event_Code" := null;
      new."Private_Event_Code_Sent_At" := null;
    end if;
    new."Updated_At" := manila_now;
    return new;
  end if;

  if old_status_key = 'approved'
     and new_status_key = 'ended'
     and old."End_Date" is not null
     and old."End_Date" <= manila_now then
    new."Ended_At" := coalesce(new."Ended_At", now());
    new."Updated_At" := manila_now;
    return new;
  end if;

  select u.user_id, public.normalize_app_role(u.role)
  into actor_user_id, actor_role_key
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if actor_user_id is null then
    raise exception 'Unable to resolve actor profile for event request workflow update.';
  end if;

  if actor_role_key = 'admin' then
    if old_status_key in ('pendingadminapproval', 'appealed')
       and new_status_key in ('approved', 'rejected') then
      new."Admin_Reviewer_User_ID" := actor_user_id;
      new."Admin_Reviewed_At" := manila_now;

      if new_status_key = 'rejected'
         and length(trim(coalesce(new."Admin_Decision_Reason", ''))) = 0 then
        raise exception 'Admin rejection reason is required for event requests.';
      end if;

      if new_status_key = 'approved' and new."Event_Visibility" = 'Private' then
        if nullif(trim(coalesce(new."Private_Event_Code", '')), '') is null then
          while attempt_count < 12 loop
            attempt_count := attempt_count + 1;
            candidate_code := public.generate_private_event_code();
            exit when not exists (
              select 1
              from public."Event_Requests" er
              where er."Private_Event_Code" = candidate_code
                and er."Event_Request_ID" <> old."Event_Request_ID"
            );
          end loop;
          if candidate_code is null or exists (
            select 1
            from public."Event_Requests" er
            where er."Private_Event_Code" = candidate_code
              and er."Event_Request_ID" <> old."Event_Request_ID"
          ) then
            raise exception 'Unable to generate unique private event code. Please retry.';
          end if;
          new."Private_Event_Code" := candidate_code;
        end if;
      end if;

      if new."Event_Visibility" <> 'Private' then
        new."Private_Event_Code" := null;
        new."Private_Event_Code_Sent_At" := null;
      end if;
    else
      raise exception 'Admin cannot change event request status from % to %.', old."Status", new."Status";
    end if;
  elsif actor_role_key = 'staff' then
    if old_status_key = 'pendingadminapproval' and new_status_key = 'cancelled' then
      null;
    elsif old_status_key = 'rejected' and new_status_key in ('appealed', 'pendingadminapproval') then
      new."Admin_Decision_Reason" := null;
      new."Admin_Reviewer_User_ID" := null;
      new."Admin_Reviewed_At" := null;
      if new."Event_Visibility" <> 'Private' then
        new."Private_Event_Code" := null;
        new."Private_Event_Code_Sent_At" := null;
      end if;
    else
      raise exception 'Staff cannot change event request status from % to %.', old."Status", new."Status";
    end if;
  else
    raise exception 'Only staff or admin can change event request status.';
  end if;

  new."Updated_At" := manila_now;
  return new;
end;
$fn$;

create or replace function public.mark_ended_event_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  update public."Event_Requests"
  set "Status" = 'Ended', "Ended_At" = coalesce("Ended_At", now())
  where public.normalize_flow_key("Status") = 'approved'
    and "End_Date" is not null
    and "End_Date" <= timezone('Asia/Manila', now());
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

revoke all on function public.mark_ended_event_requests() from public, anon, authenticated;

-- Run the transition every minute. The function is also called by scanner RPCs,
-- so correctness does not depend on the browser being open.
create extension if not exists pg_cron with schema pg_catalog;
do $do$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'strandshare-end-events' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
  perform cron.schedule(
    'strandshare-end-events',
    '* * * * *',
    'select public.mark_ended_event_requests();'
  );
end;
$do$;

-- ---------------------------------------------------------------------------
-- Cut-hair inventory
-- ---------------------------------------------------------------------------

create table if not exists public."Cut_Hair_Inventory" (
  "Inventory_ID" bigint generated always as identity primary key,
  "Submission_ID" integer not null unique
    references public."Hair_Submissions"("Submission_ID") on delete cascade,
  "Event_Request_ID" integer
    references public."Event_Requests"("Event_Request_ID") on delete set null,
  "Event_Attendee_ID" integer
    references public."Event_Attendees"("Event_Attendee_ID") on delete set null,
  "Donor_User_ID" integer not null
    references public.users(user_id) on delete restrict,
  "Approved_By_User_ID" integer
    references public.users(user_id) on delete set null,
  "Bundle_ID" integer
    references public."Hair_Submission_Bundles"("Bundle_ID") on delete set null,
  "Wig_ID" integer
    references public."Wigs"("Wig_ID") on delete set null,
  "Source_Type" text not null default 'Event',
  "Status" text not null default 'Cut',
  "Approved_At" timestamp with time zone not null default now(),
  "Bundled_At" timestamp with time zone,
  "Wig_Created_At" timestamp with time zone,
  "Created_At" timestamp with time zone not null default now(),
  "Updated_At" timestamp with time zone not null default now(),
  constraint cut_hair_inventory_source_check
    check ("Source_Type" in ('Event', 'Non-Event')),
  constraint cut_hair_inventory_status_check
    check ("Status" in ('Cut', 'Bundling', 'Wig Created'))
);

create index if not exists idx_cut_hair_inventory_event
  on public."Cut_Hair_Inventory" ("Event_Request_ID", "Approved_At" desc);
create index if not exists idx_cut_hair_inventory_attendee
  on public."Cut_Hair_Inventory" ("Event_Attendee_ID");
create index if not exists idx_cut_hair_inventory_donor
  on public."Cut_Hair_Inventory" ("Donor_User_ID");
create index if not exists idx_cut_hair_inventory_approved_by
  on public."Cut_Hair_Inventory" ("Approved_By_User_ID");
create index if not exists idx_cut_hair_inventory_bundle
  on public."Cut_Hair_Inventory" ("Bundle_ID");
create index if not exists idx_cut_hair_inventory_wig
  on public."Cut_Hair_Inventory" ("Wig_ID");
create index if not exists idx_cut_hair_inventory_status_date
  on public."Cut_Hair_Inventory" ("Status", "Approved_At" desc);

alter table public."Cut_Hair_Inventory" enable row level security;

drop policy if exists cut_hair_inventory_select_authorized on public."Cut_Hair_Inventory";
create policy cut_hair_inventory_select_authorized
on public."Cut_Hair_Inventory"
for select
to authenticated
using (
  exists (
    select 1 from public.users u
    where u.auth_user_id = (select auth.uid())
      and public.normalize_app_role(u.role) in ('admin', 'specialist')
  )
  or exists (
    select 1
    from public.users u
    join public."Event_Requests" er on er."Assigned_Staff_User_ID" = u.user_id
    where u.auth_user_id = (select auth.uid())
      and public.normalize_app_role(u.role) = 'staff'
      and er."Event_Request_ID" = "Cut_Hair_Inventory"."Event_Request_ID"
  )
);

revoke all on table public."Cut_Hair_Inventory" from anon, authenticated;
grant select on table public."Cut_Hair_Inventory" to authenticated;

-- Specialists need the event name/date context for global inventory and reports.
drop policy if exists event_requests_select_specialist_inventory_context on public."Event_Requests";
create policy event_requests_select_specialist_inventory_context
on public."Event_Requests"
for select
to authenticated
using (
  public.normalize_flow_key("Status") in ('approved', 'ended')
  and exists (
    select 1 from public.users u
    where u.auth_user_id = (select auth.uid())
      and public.normalize_app_role(u.role) = 'specialist'
  )
);

create or replace function public.sync_cut_hair_inventory_from_detail()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_submission public."Hair_Submissions"%rowtype;
begin
  if public.normalize_flow_key(new."Status") <> 'approved' then
    return new;
  end if;

  select * into v_submission
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = new."Submission_ID";

  if v_submission."Submission_ID" is null
     or public.normalize_flow_key(v_submission."Status") <> 'cut' then
    return new;
  end if;

  insert into public."Cut_Hair_Inventory" (
    "Submission_ID", "Event_Request_ID", "Event_Attendee_ID", "Donor_User_ID",
    "Approved_By_User_ID", "Source_Type", "Status", "Approved_At", "Updated_At"
  ) values (
    v_submission."Submission_ID", v_submission."Event_Request_ID",
    v_submission."Event_Attendee_ID", v_submission."User_ID", new."Updated_By",
    case when coalesce(v_submission."From_Event", false) then 'Event' else 'Non-Event' end,
    'Cut', coalesce(new."Updated_At" at time zone 'Asia/Manila', now()), now()
  )
  on conflict ("Submission_ID") do update set
    "Event_Request_ID" = excluded."Event_Request_ID",
    "Event_Attendee_ID" = excluded."Event_Attendee_ID",
    "Donor_User_ID" = excluded."Donor_User_ID",
    "Approved_By_User_ID" = coalesce(public."Cut_Hair_Inventory"."Approved_By_User_ID", excluded."Approved_By_User_ID"),
    "Updated_At" = now();

  return new;
end;
$fn$;

create or replace function public.sync_cut_hair_inventory_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_wig_id integer;
  v_status text;
begin
  if not exists (
    select 1 from public."Cut_Hair_Inventory" chi
    where chi."Submission_ID" = new."Submission_ID"
  ) then
    return new;
  end if;

  if public.normalize_flow_key(new."Status") = 'wigcreated' then
    v_status := 'Wig Created';
    select w."Wig_ID" into v_wig_id
    from public."Wigs" w
    where w."Bundle_ID" = new."Bundle_ID"
    order by w."Wig_ID" desc
    limit 1;
  elsif new."Bundle_ID" is not null
        or public.normalize_flow_key(new."Status") = 'wiginproduction' then
    v_status := 'Bundling';
  else
    v_status := 'Cut';
  end if;

  update public."Cut_Hair_Inventory"
  set
    "Event_Request_ID" = new."Event_Request_ID",
    "Event_Attendee_ID" = new."Event_Attendee_ID",
    "Bundle_ID" = new."Bundle_ID",
    "Wig_ID" = case when v_status = 'Wig Created' then v_wig_id else null end,
    "Status" = v_status,
    "Bundled_At" = case
      when v_status in ('Bundling', 'Wig Created') then coalesce("Bundled_At", now())
      else null
    end,
    "Wig_Created_At" = case
      when v_status = 'Wig Created' then coalesce("Wig_Created_At", now())
      else null
    end,
    "Updated_At" = now()
  where "Submission_ID" = new."Submission_ID";

  return new;
end;
$fn$;

drop trigger if exists trg_sync_cut_hair_inventory_from_detail on public."Hair_Submission_Details";
create trigger trg_sync_cut_hair_inventory_from_detail
after insert or update of "Status"
on public."Hair_Submission_Details"
for each row execute function public.sync_cut_hair_inventory_from_detail();

drop trigger if exists trg_sync_cut_hair_inventory_lifecycle on public."Hair_Submissions";
create trigger trg_sync_cut_hair_inventory_lifecycle
after update of "Status", "Bundle_ID", "Event_Request_ID", "Event_Attendee_ID"
on public."Hair_Submissions"
for each row execute function public.sync_cut_hair_inventory_lifecycle();

-- Backfill all previously approved cut hair. Rejected Cut is deliberately excluded.
insert into public."Cut_Hair_Inventory" (
  "Submission_ID", "Event_Request_ID", "Event_Attendee_ID", "Donor_User_ID",
  "Approved_By_User_ID", "Bundle_ID", "Wig_ID", "Source_Type", "Status",
  "Approved_At", "Bundled_At", "Wig_Created_At", "Updated_At"
)
select
  hs."Submission_ID", hs."Event_Request_ID", hs."Event_Attendee_ID", hs."User_ID",
  hsd."Updated_By", hs."Bundle_ID", w."Wig_ID",
  case when coalesce(hs."From_Event", false) then 'Event' else 'Non-Event' end,
  case
    when public.normalize_flow_key(hs."Status") = 'wigcreated' then 'Wig Created'
    when hs."Bundle_ID" is not null or public.normalize_flow_key(hs."Status") = 'wiginproduction' then 'Bundling'
    else 'Cut'
  end,
  coalesce(hsd."Updated_At" at time zone 'Asia/Manila', hs."Cut_At" at time zone 'Asia/Manila', now()),
  case when hs."Bundle_ID" is not null then coalesce(hs."Updated_At" at time zone 'Asia/Manila', now()) end,
  case when public.normalize_flow_key(hs."Status") = 'wigcreated' then coalesce(w."Completed_At" at time zone 'Asia/Manila', now()) end,
  now()
from public."Hair_Submissions" hs
join lateral (
  select d.* from public."Hair_Submission_Details" d
  where d."Submission_ID" = hs."Submission_ID"
  order by d."Submission_Detail_ID" desc limit 1
) hsd on public.normalize_flow_key(hsd."Status") = 'approved'
left join public."Wigs" w on w."Bundle_ID" = hs."Bundle_ID"
where public.normalize_flow_key(hs."Status") in ('cut', 'wiginproduction', 'wigcreated')
on conflict ("Submission_ID") do nothing;

-- ---------------------------------------------------------------------------
-- Immutable AI baseline and staff comparison
-- ---------------------------------------------------------------------------

create table if not exists public."Hair_AI_Review_Comparisons" (
  "Comparison_ID" bigint generated always as identity primary key,
  "Submission_Detail_ID" integer not null unique
    references public."Hair_Submission_Details"("Submission_Detail_ID") on delete cascade,
  "Submission_ID" integer not null
    references public."Hair_Submissions"("Submission_ID") on delete cascade,
  "Event_Request_ID" integer
    references public."Event_Requests"("Event_Request_ID") on delete set null,
  "AI_Values" jsonb not null,
  "Staff_Values" jsonb,
  "Is_AI_Source" boolean not null default false,
  "Changed_Fields" text[] not null default '{}',
  "Critical_Changed_Fields" text[] not null default '{}',
  "Minor_Changed_Fields" text[] not null default '{}',
  "Comparable_Field_Count" integer not null default 0,
  "Matched_Field_Count" integer not null default 0,
  "AI_Accuracy_Percent" numeric(5,2),
  "Length_Difference_Inches" numeric(6,2),
  "Length_Within_Tolerance" boolean,
  "Final_Decision" text,
  "Reviewed_By_User_ID" integer references public.users(user_id) on delete set null,
  "Captured_At" timestamp with time zone not null default now(),
  "Reviewed_At" timestamp with time zone,
  "Updated_At" timestamp with time zone not null default now(),
  constraint hair_ai_review_final_decision_check check (
    "Final_Decision" is null or "Final_Decision" in ('Approved', 'Rejected', 'Rejected Cut')
  )
);

create index if not exists idx_hair_ai_review_submission
  on public."Hair_AI_Review_Comparisons" ("Submission_ID");
create index if not exists idx_hair_ai_review_event
  on public."Hair_AI_Review_Comparisons" ("Event_Request_ID", "Reviewed_At" desc);
create index if not exists idx_hair_ai_review_accuracy
  on public."Hair_AI_Review_Comparisons" ("AI_Accuracy_Percent")
  where "Is_AI_Source" and "Reviewed_At" is not null;
create index if not exists idx_hair_ai_review_reviewer
  on public."Hair_AI_Review_Comparisons" ("Reviewed_By_User_ID");

alter table public."Hair_AI_Review_Comparisons" enable row level security;
drop policy if exists hair_ai_review_select_authorized on public."Hair_AI_Review_Comparisons";
create policy hair_ai_review_select_authorized
on public."Hair_AI_Review_Comparisons"
for select
to authenticated
using (
  exists (
    select 1 from public.users u
    where u.auth_user_id = (select auth.uid())
      and public.normalize_app_role(u.role) in ('admin', 'specialist')
  )
  or exists (
    select 1
    from public.users u
    join public."Event_Requests" er on er."Assigned_Staff_User_ID" = u.user_id
    where u.auth_user_id = (select auth.uid())
      and public.normalize_app_role(u.role) = 'staff'
      and er."Event_Request_ID" = "Hair_AI_Review_Comparisons"."Event_Request_ID"
  )
);

revoke all on table public."Hair_AI_Review_Comparisons" from anon, authenticated;
grant select on table public."Hair_AI_Review_Comparisons" to authenticated;

do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'Cut_Hair_Inventory'
    ) then
      alter publication supabase_realtime add table public."Cut_Hair_Inventory";
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'Hair_AI_Review_Comparisons'
    ) then
      alter publication supabase_realtime add table public."Hair_AI_Review_Comparisons";
    end if;
  end if;
end;
$do$;

create or replace function public.capture_hair_ai_review_baseline()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_event_request_id integer;
begin
  if exists (
    select 1 from public."Hair_AI_Review_Comparisons" c
    where c."Submission_Detail_ID" = old."Submission_Detail_ID"
  ) then
    return new;
  end if;

  select hs."Event_Request_ID" into v_event_request_id
  from public."Hair_Submissions" hs
  where hs."Submission_ID" = old."Submission_ID";

  insert into public."Hair_AI_Review_Comparisons" (
    "Submission_Detail_ID", "Submission_ID", "Event_Request_ID", "AI_Values", "Is_AI_Source"
  ) values (
    old."Submission_Detail_ID",
    old."Submission_ID",
    v_event_request_id,
    jsonb_build_object(
      'length', old."Declared_Length",
      'color', old."Declared_Color",
      'texture', old."Declared_Texture",
      'density', old."Declared_Density",
      'condition', old."Declared_Condition",
      'chemicallyTreated', coalesce(old."Is_Chemically_Treated", false),
      'colored', coalesce(old."Is_Colored", false),
      'bleached', coalesce(old."Is_Bleached", false),
      'rebonded', coalesce(old."Is_Rebonded", false)
    ),
    public.normalize_flow_key(old."Input_Method") = 'aianalysis'
  )
  on conflict ("Submission_Detail_ID") do nothing;

  return new;
end;
$fn$;

create or replace function public.finalize_hair_ai_review_comparison()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public."Hair_AI_Review_Comparisons"%rowtype;
  v_staff jsonb;
  v_changed text[] := '{}';
  v_critical text[] := '{}';
  v_minor text[] := '{}';
  v_comparable integer := 0;
  v_matched integer := 0;
  v_ai_text text;
  v_staff_text text;
  v_ai_length numeric;
  v_staff_length numeric;
  v_length_diff numeric;
  v_length_ok boolean;
  v_field text;
  v_ai_bool boolean;
  v_staff_bool boolean;
begin
  if not public.is_hair_detail_final_status(new."Status") then
    return new;
  end if;

  select * into v_row
  from public."Hair_AI_Review_Comparisons" c
  where c."Submission_Detail_ID" = new."Submission_Detail_ID"
  for update;

  if v_row."Comparison_ID" is null then
    return new;
  end if;

  if v_row."Reviewed_At" is not null then
    return new;
  end if;

  v_staff := jsonb_build_object(
    'length', new."Declared_Length",
    'color', new."Declared_Color",
    'texture', new."Declared_Texture",
    'density', new."Declared_Density",
    'condition', new."Declared_Condition",
    'chemicallyTreated', coalesce(new."Is_Chemically_Treated", false),
    'colored', coalesce(new."Is_Colored", false),
    'bleached', coalesce(new."Is_Bleached", false),
    'rebonded', coalesce(new."Is_Rebonded", false)
  );

  if nullif(v_row."AI_Values"->>'length', '') is not null then
    v_comparable := v_comparable + 1;
    v_ai_length := (v_row."AI_Values"->>'length')::numeric;
    v_staff_length := new."Declared_Length";
    if v_staff_length is not null then
      v_length_diff := abs(v_ai_length - v_staff_length);
      v_length_ok := v_length_diff <= 6;
      if v_length_diff > 0 then
        v_changed := array_append(v_changed, 'length');
        v_minor := array_append(v_minor, 'length');
      end if;
      if v_length_ok then v_matched := v_matched + 1; end if;
    else
      v_length_ok := false;
      v_changed := array_append(v_changed, 'length');
      v_minor := array_append(v_minor, 'length');
    end if;
  end if;

  foreach v_field in array array['color', 'condition', 'texture', 'density'] loop
    v_ai_text := nullif(lower(trim(coalesce(v_row."AI_Values"->>v_field, ''))), '');
    v_staff_text := nullif(lower(trim(coalesce(v_staff->>v_field, ''))), '');
    if v_ai_text is not null then
      v_comparable := v_comparable + 1;
      if v_ai_text is not distinct from v_staff_text then
        v_matched := v_matched + 1;
      else
        v_changed := array_append(v_changed, v_field);
        if v_field in ('color', 'condition') then
          v_critical := array_append(v_critical, v_field);
        else
          v_minor := array_append(v_minor, v_field);
        end if;
      end if;
    end if;
  end loop;

  foreach v_field in array array['chemicallyTreated', 'colored', 'bleached', 'rebonded'] loop
    v_comparable := v_comparable + 1;
    v_ai_bool := coalesce((v_row."AI_Values"->>v_field)::boolean, false);
    v_staff_bool := coalesce((v_staff->>v_field)::boolean, false);
    if v_ai_bool = v_staff_bool then
      v_matched := v_matched + 1;
    else
      v_changed := array_append(v_changed, v_field);
      v_critical := array_append(v_critical, v_field);
    end if;
  end loop;

  update public."Hair_AI_Review_Comparisons"
  set
    "Staff_Values" = v_staff,
    "Changed_Fields" = v_changed,
    "Critical_Changed_Fields" = v_critical,
    "Minor_Changed_Fields" = v_minor,
    "Comparable_Field_Count" = v_comparable,
    "Matched_Field_Count" = v_matched,
    "AI_Accuracy_Percent" = case
      when v_row."Is_AI_Source" and v_comparable > 0
        then round((v_matched::numeric / v_comparable::numeric) * 100, 2)
      else null
    end,
    "Length_Difference_Inches" = v_length_diff,
    "Length_Within_Tolerance" = v_length_ok,
    "Final_Decision" = case
      when public.normalize_flow_key(new."Status") = 'approved' then 'Approved'
      when public.normalize_flow_key(new."Status") = 'rejectedcut' then 'Rejected Cut'
      else 'Rejected'
    end,
    "Reviewed_By_User_ID" = new."Updated_By",
    "Reviewed_At" = coalesce(new."Updated_At" at time zone 'Asia/Manila', now()),
    "Updated_At" = now()
  where "Comparison_ID" = v_row."Comparison_ID";

  return new;
end;
$fn$;

drop trigger if exists trg_00_capture_hair_ai_review_baseline on public."Hair_Submission_Details";
create trigger trg_00_capture_hair_ai_review_baseline
before update on public."Hair_Submission_Details"
for each row execute function public.capture_hair_ai_review_baseline();

drop trigger if exists trg_finalize_hair_ai_review_comparison on public."Hair_Submission_Details";
create trigger trg_finalize_hair_ai_review_comparison
after update of "Status" on public."Hair_Submission_Details"
for each row execute function public.finalize_hair_ai_review_comparison();

-- ---------------------------------------------------------------------------
-- Two explicit scanner modes
-- ---------------------------------------------------------------------------

create or replace function public.open_event_hair_intake_review(
  p_event_request_id integer,
  p_qr_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.users%rowtype;
  v_role_key text;
  v_attendee public."Event_Attendees"%rowtype;
  v_submission public."Hair_Submissions"%rowtype;
  v_raw text := trim(coalesce(p_qr_payload, ''));
  v_payload jsonb;
  v_waybill text;
  v_attendee_id integer;
  v_user_id integer;
  v_details jsonb := '[]'::jsonb;
begin
  select * into v_user from public.users u where u.auth_user_id = auth.uid() limit 1;
  if v_user.user_id is null then raise exception 'Unable to resolve authenticated user.'; end if;
  v_role_key := public.normalize_app_role(v_user.role);
  if v_role_key not in ('staff', 'admin') then
    raise exception 'Only staff/admin can open event hair intake review.';
  end if;
  if v_role_key = 'staff' and not exists (
    select 1 from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_user.user_id
  ) then raise exception 'You are not assigned to this event.'; end if;

  if v_raw <> '' and left(v_raw, 1) = '{' then
    begin v_payload := v_raw::jsonb; exception when others then v_payload := null; end;
  end if;
  if v_payload is not null then
    v_waybill := nullif(trim(coalesce(
      v_payload->>'Waybill_Code', v_payload->>'waybill_code', v_payload->>'waybillCode',
      v_payload->>'code', v_payload->>'value', v_payload->'data'->>'Waybill_Code',
      v_payload->'data'->>'waybill_code', v_payload->'data'->>'waybillCode'
    )), '');
    begin
      v_attendee_id := nullif(trim(coalesce(
        v_payload->>'Event_Attendee_ID', v_payload->>'event_attendee_id',
        v_payload->'data'->>'Event_Attendee_ID', v_payload->'data'->>'event_attendee_id'
      )), '')::integer;
    exception when others then v_attendee_id := null; end;
    begin
      v_user_id := nullif(trim(coalesce(
        v_payload->>'User_ID', v_payload->>'user_id', v_payload->>'userId',
        v_payload->'data'->>'User_ID', v_payload->'data'->>'user_id'
      )), '')::integer;
    exception when others then v_user_id := null; end;
  else
    v_waybill := nullif(v_raw, '');
  end if;

  select * into v_attendee
  from public."Event_Attendees" ea
  where ea."Event_Request_ID" = p_event_request_id
    and (
      (v_attendee_id is not null and ea."Event_Attendee_ID" = v_attendee_id)
      or (v_waybill is not null and upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(v_waybill))
      or (v_user_id is not null and ea."User_ID" = v_user_id)
    )
  order by
    case when ea."Event_Attendee_ID" = v_attendee_id then 0
         when upper(trim(coalesce(ea."Waybill_Code", ''))) = upper(coalesce(v_waybill, '')) then 1
         else 2 end
  limit 1;

  if v_attendee."Event_Attendee_ID" is null then
    raise exception 'No attendee matched for this event and scan payload.';
  end if;
  if lower(trim(coalesce(v_attendee."Attendee_Type", 'Donor'))) = 'voluntary' then
    raise exception 'Voluntary attendees only require RSVP check-in; they have no hair intake review.';
  end if;
  if v_attendee."RSVP_Scanned_At" is null
     or public.normalize_flow_key(v_attendee."Attendance_Status") <> 'present' then
    raise exception 'RSVP Check-in must be completed before Hair Intake & Review.';
  end if;

  select * into v_submission
  from public."Hair_Submissions" hs
  where hs."Event_Request_ID" = p_event_request_id
    and (hs."Event_Attendee_ID" = v_attendee."Event_Attendee_ID" or hs."User_ID" = v_attendee."User_ID")
  order by case when hs."Event_Attendee_ID" = v_attendee."Event_Attendee_ID" then 0 else 1 end,
    hs."Submission_ID" desc
  limit 1;

  if v_submission."Submission_ID" is null then
    raise exception 'No linked hair submission found for this donor.';
  end if;
  if exists (
    select 1 from public."Hair_Submission_Details" d
    where d."Submission_ID" = v_submission."Submission_ID"
      and public.is_hair_detail_final_status(d."Status")
  ) then raise exception 'Hair quality decision is already final and locked.'; end if;

  select coalesce(jsonb_agg(to_jsonb(d) order by d."Submission_Detail_ID"), '[]'::jsonb)
  into v_details
  from public."Hair_Submission_Details" d
  where d."Submission_ID" = v_submission."Submission_ID";

  return jsonb_build_object(
    'attendee', to_jsonb(v_attendee),
    'submission', to_jsonb(v_submission),
    'details', v_details,
    'waybill_code', coalesce(v_attendee."Waybill_Code", v_submission."Submission_Code"),
    'submission_status', v_submission."Status",
    'attendee_type', 'Donor',
    'requires_hair_review', true
  );
end;
$fn$;

create or replace function public.scan_event_attendee_operation(
  p_event_request_id integer,
  p_qr_payload text,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_mode text := public.normalize_flow_key(p_mode);
  v_event public."Event_Requests"%rowtype;
begin
  perform public.mark_ended_event_requests();
  select * into v_event from public."Event_Requests" er
  where er."Event_Request_ID" = p_event_request_id;
  if v_event."Event_Request_ID" is null then raise exception 'Event was not found.'; end if;

  if v_mode in ('rsvp', 'rsvpcheckin', 'checkin') then
    if public.normalize_flow_key(v_event."Status") = 'ended'
       or (v_event."End_Date" is not null and v_event."End_Date" <= timezone('Asia/Manila', now())) then
      raise exception 'This event has ended. New RSVP check-ins are closed.';
    end if;
    return public.scan_event_attendee_rsvp_by_type(p_event_request_id, p_qr_payload)
      || jsonb_build_object('scan_mode', 'rsvp');
  elsif v_mode in ('hairreview', 'hairintake', 'hairintakereview') then
    return public.open_event_hair_intake_review(p_event_request_id, p_qr_payload)
      || jsonb_build_object('scan_mode', 'hair_review');
  end if;
  raise exception 'Scanner mode must be RSVP Check-in or Hair Intake & Review.';
end;
$fn$;

revoke all on function public.open_event_hair_intake_review(integer, text) from public, anon;
revoke all on function public.scan_event_attendee_operation(integer, text, text) from public, anon;
grant execute on function public.open_event_hair_intake_review(integer, text) to authenticated;
grant execute on function public.scan_event_attendee_operation(integer, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Ended-event operational summary
-- ---------------------------------------------------------------------------

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
  select * into v_user from public.users u where u.auth_user_id = auth.uid() limit 1;
  if v_user.user_id is null then raise exception 'Unable to resolve authenticated user.'; end if;
  v_role := public.normalize_app_role(v_user.role);
  if v_role not in ('admin', 'specialist') and not exists (
    select 1 from public."Event_Requests" er
    where er."Event_Request_ID" = p_event_request_id
      and er."Assigned_Staff_User_ID" = v_user.user_id
      and v_role = 'staff'
  ) then raise exception 'You do not have access to this event summary.'; end if;

  with attendee_stats as (
    select
      count(*) filter (where public.normalize_flow_key(ea."Registration_Status") <> 'cancelled')::integer as registered,
      count(*) filter (where ea."RSVP_Scanned_At" is not null and public.normalize_flow_key(ea."Attendance_Status") = 'present')::integer as present,
      count(*) filter (where lower(trim(coalesce(ea."Attendee_Type", 'Donor'))) = 'donor')::integer as donors,
      count(*) filter (where lower(trim(coalesce(ea."Attendee_Type", 'Donor'))) = 'voluntary')::integer as voluntary
    from public."Event_Attendees" ea
    where ea."Event_Request_ID" = p_event_request_id
  ), decisions as (
    select
      count(*) filter (where public.normalize_flow_key(d."Status") = 'approved')::integer as approved_cut,
      count(*) filter (where public.normalize_flow_key(d."Status") = 'rejected')::integer as rejected,
      count(*) filter (where public.normalize_flow_key(d."Status") = 'rejectedcut')::integer as rejected_cut,
      count(*) filter (where public.normalize_flow_key(d."Status") = 'pending')::integer as pending
    from public."Hair_Submissions" hs
    join lateral (
      select hsd."Status" from public."Hair_Submission_Details" hsd
      where hsd."Submission_ID" = hs."Submission_ID"
      order by hsd."Submission_Detail_ID" desc limit 1
    ) d on true
    where hs."Event_Request_ID" = p_event_request_id
  ), inventory_stats as (
    select count(*)::integer as inventory_added
    from public."Cut_Hair_Inventory" chi
    where chi."Event_Request_ID" = p_event_request_id
  ), ai_stats as (
    select
      count(*) filter (where c."Is_AI_Source" and c."Reviewed_At" is not null)::integer as ai_reviews,
      coalesce(sum(cardinality(c."Changed_Fields")) filter (where c."Is_AI_Source"), 0)::integer as ai_corrections,
      coalesce(sum(cardinality(c."Critical_Changed_Fields")) filter (where c."Is_AI_Source"), 0)::integer as critical_corrections,
      round(avg(c."AI_Accuracy_Percent") filter (where c."Is_AI_Source" and c."Reviewed_At" is not null), 2) as ai_accuracy
    from public."Hair_AI_Review_Comparisons" c
    where c."Event_Request_ID" = p_event_request_id
  )
  select jsonb_build_object(
    'registered', a.registered,
    'present', a.present,
    'no_show', greatest(a.registered - a.present, 0),
    'donors', a.donors,
    'voluntary', a.voluntary,
    'approved_cut', d.approved_cut,
    'rejected', d.rejected,
    'rejected_cut', d.rejected_cut,
    'pending', d.pending,
    'inventory_added', i.inventory_added,
    'ai_reviews', ai.ai_reviews,
    'ai_corrections', ai.ai_corrections,
    'critical_corrections', ai.critical_corrections,
    'ai_accuracy_percent', ai.ai_accuracy
  ) into v_result
  from attendee_stats a cross join decisions d cross join inventory_stats i cross join ai_stats ai;

  return coalesce(v_result, '{}'::jsonb);
end;
$fn$;

revoke all on function public.get_event_operations_summary(integer) from public, anon;
grant execute on function public.get_event_operations_summary(integer) to authenticated;

select public.mark_ended_event_requests();

commit;
