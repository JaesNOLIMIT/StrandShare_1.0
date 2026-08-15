begin;

alter table public."Patients"
  add column if not exists "Condition_Category" text,
  add column if not exists "Other_Hair_Loss_Disease" text,
  add column if not exists "Condition_Stage_Severity" text,
  add column if not exists "Attending_Physician_Contact" text,
  add column if not exists "Treatment_Hospital_Clinic" text,
  add column if not exists "Treatment_Plan" text,
  add column if not exists "Current_Treatment_Status" text,
  add column if not exists "Allergies_Current_Medications" text,
  add column if not exists "Insurance_PhilHealth_Info" text,
  add column if not exists "Clinical_Special_Note" text,
  add column if not exists "Created_By" integer references public.users(user_id) on delete set null,
  add column if not exists "Secondary_Guardian" text,
  add column if not exists "Secondary_Guardian_Relationship" text,
  add column if not exists "Secondary_Guardian_Contact_Number" text;

create index if not exists patients_created_by_idx on public."Patients" ("Created_By");

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'patients_condition_category_check'
      and conrelid = 'public."Patients"'::regclass
  ) then
    alter table public."Patients"
      add constraint patients_condition_category_check
      check (
        "Condition_Category" is null
        or "Condition_Category" in ('Cancer', 'Alopecia', 'Other Hair-Loss Disease')
      );
  end if;
end
$$;

create table if not exists public."Patient_Hospital_Transfer_Requests" (
  "Transfer_Request_ID" bigint generated always as identity primary key,
  "Patient_ID" integer not null references public."Patients"("Patient_ID") on delete restrict,
  "From_Hospital_ID" integer not null references public."Hospitals"("Hospital_ID") on delete restrict,
  "To_Hospital_ID" integer not null references public."Hospitals"("Hospital_ID") on delete restrict,
  "Requested_By" integer not null references public.users(user_id) on delete restrict,
  "Patient_Code_Snapshot" text not null,
  "Patient_Name_Snapshot" text not null,
  "Medical_Condition_Snapshot" text,
  "Status" text not null default 'pending',
  "Request_Note" text,
  "Responded_By" integer references public.users(user_id) on delete restrict,
  "Response_Note" text,
  "Requested_At" timestamp with time zone not null default now(),
  "Responded_At" timestamp with time zone,
  "Effective_At" timestamp with time zone,
  constraint patient_hospital_transfer_different_hospitals
    check ("From_Hospital_ID" <> "To_Hospital_ID"),
  constraint patient_hospital_transfer_status_check
    check ("Status" in ('pending', 'accepted', 'rejected', 'cancelled'))
);

alter table public."Patient_Hospital_Transfer_Requests"
  add column if not exists "Patient_Code_Snapshot" text,
  add column if not exists "Patient_Name_Snapshot" text,
  add column if not exists "Medical_Condition_Snapshot" text;

update public."Patient_Hospital_Transfer_Requests" transfer
set "Patient_Code_Snapshot" = coalesce(transfer."Patient_Code_Snapshot", patient."Patient_Code", 'N/A'),
    "Patient_Name_Snapshot" = coalesce(transfer."Patient_Name_Snapshot", 'Patient #' || transfer."Patient_ID"::text),
    "Medical_Condition_Snapshot" = coalesce(transfer."Medical_Condition_Snapshot", patient."Medical_Condition")
from public."Patients" patient
where patient."Patient_ID" = transfer."Patient_ID"
  and (transfer."Patient_Code_Snapshot" is null or transfer."Patient_Name_Snapshot" is null);

alter table public."Patient_Hospital_Transfer_Requests"
  alter column "Patient_Code_Snapshot" set not null,
  alter column "Patient_Name_Snapshot" set not null;

create index if not exists patient_hospital_transfer_patient_idx
  on public."Patient_Hospital_Transfer_Requests" ("Patient_ID");
create index if not exists patient_hospital_transfer_from_status_idx
  on public."Patient_Hospital_Transfer_Requests" ("From_Hospital_ID", "Status", "Requested_At" desc);
create index if not exists patient_hospital_transfer_to_status_idx
  on public."Patient_Hospital_Transfer_Requests" ("To_Hospital_ID", "Status", "Requested_At" desc);
create index if not exists patient_hospital_transfer_requested_by_idx
  on public."Patient_Hospital_Transfer_Requests" ("Requested_By");
create index if not exists patient_hospital_transfer_responded_by_idx
  on public."Patient_Hospital_Transfer_Requests" ("Responded_By");
create unique index if not exists patient_hospital_transfer_one_pending_per_patient_idx
  on public."Patient_Hospital_Transfer_Requests" ("Patient_ID")
  where "Status" = 'pending';

alter table public."Patient_Hospital_Transfer_Requests" enable row level security;
grant select, insert, update on public."Patient_Hospital_Transfer_Requests" to authenticated;
grant usage, select on sequence public."Patient_Hospital_Transfer_Requests_Transfer_Request_ID_seq" to authenticated;

drop policy if exists hospitals_select_approved_transfer_targets
on public."Hospitals";

create policy hospitals_select_approved_transfer_targets
on public."Hospitals"
as permissive
for select
to authenticated
using (
  (
    "Hospitals"."Is_Approved" is true
    or public.normalize_app_role("Hospitals"."Approval_Status") = 'approved'
  )
  and exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative'
      )
  )
);

drop policy if exists patient_transfers_select_participating_hospitals
on public."Patient_Hospital_Transfer_Requests";

create policy patient_transfers_select_participating_hospitals
on public."Patient_Hospital_Transfer_Requests"
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.users actor
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and (
        public.normalize_app_role(actor.role) in ('admin', 'superadmin')
        or exists (
          select 1
          from public."Hospital_Representative" assignment
          where assignment."User_ID" = actor.user_id
            and assignment."Hospital_ID" in (
              "Patient_Hospital_Transfer_Requests"."From_Hospital_ID",
              "Patient_Hospital_Transfer_Requests"."To_Hospital_ID"
            )
        )
      )
  )
);

drop policy if exists patient_transfers_insert_source_hospital
on public."Patient_Hospital_Transfer_Requests";

create policy patient_transfers_insert_source_hospital
on public."Patient_Hospital_Transfer_Requests"
as permissive
for insert
to authenticated
with check (
  "Status" = 'pending'
  and "Responded_By" is null
  and "Responded_At" is null
  and "Effective_At" is null
  and exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
     and assignment."Hospital_ID" = "Patient_Hospital_Transfer_Requests"."From_Hospital_ID"
    join public."Patients" patient
      on patient."Patient_ID" = "Patient_Hospital_Transfer_Requests"."Patient_ID"
     and patient."Hospital_ID" = "Patient_Hospital_Transfer_Requests"."From_Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.user_id = "Patient_Hospital_Transfer_Requests"."Requested_By"
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative'
      )
  )
);

drop policy if exists patient_transfers_update_destination_hospital
on public."Patient_Hospital_Transfer_Requests";

create policy patient_transfers_update_destination_hospital
on public."Patient_Hospital_Transfer_Requests"
as permissive
for update
to authenticated
using (
  "Status" = 'pending'
  and exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
     and assignment."Hospital_ID" = "Patient_Hospital_Transfer_Requests"."To_Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative'
      )
  )
)
with check (
  "Status" in ('accepted', 'rejected')
  and exists (
    select 1
    from public.users actor
    join public."Hospital_Representative" assignment
      on assignment."User_ID" = actor.user_id
     and assignment."Hospital_ID" = "Patient_Hospital_Transfer_Requests"."To_Hospital_ID"
    where actor.auth_user_id = (select auth.uid())
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in (
        'hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative'
      )
  )
);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.apply_patient_hospital_transfer_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  actor_user_id integer;
  actor_role text;
  moved_patient_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if new."Patient_ID" <> old."Patient_ID"
    or new."From_Hospital_ID" <> old."From_Hospital_ID"
    or new."To_Hospital_ID" <> old."To_Hospital_ID"
    or new."Requested_By" <> old."Requested_By"
    or new."Requested_At" <> old."Requested_At"
    or new."Patient_Code_Snapshot" is distinct from old."Patient_Code_Snapshot"
    or new."Patient_Name_Snapshot" is distinct from old."Patient_Name_Snapshot"
    or new."Medical_Condition_Snapshot" is distinct from old."Medical_Condition_Snapshot"
  then
    raise exception 'Transfer request identity fields cannot be changed';
  end if;

  if old."Status" <> 'pending' then
    raise exception 'This transfer request has already been decided';
  end if;

  if new."Status" not in ('accepted', 'rejected') then
    raise exception 'Transfer decision must be accepted or rejected';
  end if;

  select actor.user_id, public.normalize_app_role(actor.role)
  into actor_user_id, actor_role
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if coalesce(actor_user_id, 0) <= 0 then
    raise exception 'Active H-Representative account was not found';
  end if;

  if actor_role not in ('admin', 'superadmin') and not exists (
    select 1
    from public."Hospital_Representative" assignment
    where assignment."User_ID" = actor_user_id
      and assignment."Hospital_ID" = new."To_Hospital_ID"
  ) then
    raise exception 'Only the receiving hospital can decide this transfer';
  end if;

  new."Responded_By" := actor_user_id;
  new."Responded_At" := now();

  if new."Status" = 'accepted' then
    update public."Patients"
    set "Hospital_ID" = new."To_Hospital_ID",
        "Updated_At" = timezone('Asia/Manila', now())
    where "Patient_ID" = new."Patient_ID"
      and "Hospital_ID" = new."From_Hospital_ID";

    get diagnostics moved_patient_count = row_count;
    if moved_patient_count <> 1 then
      raise exception 'Patient is no longer assigned to the sending hospital';
    end if;

    new."Effective_At" := now();
  else
    new."Effective_At" := null;
  end if;

  return new;
end;
$fn$;

revoke all on function private.apply_patient_hospital_transfer_decision()
from public, anon, authenticated, service_role;

drop trigger if exists patient_hospital_transfer_decision_trigger
on public."Patient_Hospital_Transfer_Requests";

create trigger patient_hospital_transfer_decision_trigger
before update on public."Patient_Hospital_Transfer_Requests"
for each row
execute function private.apply_patient_hospital_transfer_decision();

commit;
