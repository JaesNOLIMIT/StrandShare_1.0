begin;

-- Keep the global wig requirements singleton recoverable if an older deployment
-- created the table without its seed row (or the row was removed manually).
insert into public.wig_requirements (
  "Minimum_Number_Donor", "Minimum_Hair_Length",
  "Chemical_Treatment_Status", "Colored_Hair_Status",
  "Bleached_Hair_Status", "Rebonded_Hair_Status",
  "Hair_Texture_Status", "Notes"
)
select null, null, false, false, false, false, null, null
where not exists (select 1 from public.wig_requirements);

create or replace function public.get_or_create_wig_requirements()
returns setof public.wig_requirements
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  insert into public.wig_requirements (
    "Minimum_Number_Donor", "Minimum_Hair_Length",
    "Chemical_Treatment_Status", "Colored_Hair_Status",
    "Bleached_Hair_Status", "Rebonded_Hair_Status",
    "Hair_Texture_Status", "Notes"
  )
  select null, null, false, false, false, false, null, null
  where not exists (select 1 from public.wig_requirements);

  return query select * from public.wig_requirements order by "Wig_Requirement_ID" limit 1;
end;
$fn$;

revoke all on function public.get_or_create_wig_requirements() from public, anon;
grant execute on function public.get_or_create_wig_requirements() to authenticated;

-- Legal PDFs used by public application gates must be readable before the user
-- starts an application. Writes remain limited to internal administrators/staff.
drop policy if exists legal_documents_select_public on public.legal_documents;
create policy legal_documents_select_public
on public.legal_documents for select to anon, authenticated
using (is_active = true and effective_at <= timezone('Asia/Manila', now()));

drop policy if exists legal_documents_insert_staff_super_admin on public.legal_documents;
create policy legal_documents_insert_staff_super_admin
on public.legal_documents for insert to authenticated
with check (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active is distinct from false
      and public.normalize_app_role(u.role) in ('staff', 'admin', 'superadmin')
  )
);

drop policy if exists legal_documents_update_staff_super_admin on public.legal_documents;
create policy legal_documents_update_staff_super_admin
on public.legal_documents for update to authenticated
using (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active is distinct from false
      and public.normalize_app_role(u.role) in ('staff', 'admin', 'superadmin')
  )
)
with check (
  exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active is distinct from false
      and public.normalize_app_role(u.role) in ('staff', 'admin', 'superadmin')
  )
);

drop policy if exists legal_documents_bucket_select_public on storage.objects;
create policy legal_documents_bucket_select_public
on storage.objects for select to anon, authenticated
using (bucket_id = 'legal-documents');

drop policy if exists legal_documents_bucket_insert_staff_super_admin on storage.objects;
create policy legal_documents_bucket_insert_staff_super_admin
on storage.objects for insert to authenticated
with check (
  bucket_id = 'legal-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
  and (storage.foldername(name))[2] = 'legal-documents'
  and lower(storage.extension(name)) = 'pdf'
  and exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active is distinct from false
      and public.normalize_app_role(u.role) in ('staff', 'admin', 'superadmin')
  )
);

-- Store the exact active PDF/version accepted for each submitted workflow.
alter table public."Event_Applications"
  add column if not exists "Terms_Document_ID" integer references public.legal_documents(legal_document_id) on delete restrict,
  add column if not exists "Terms_Version" text,
  add column if not exists "Terms_Accepted_At" timestamp without time zone;

create or replace function public.enforce_event_application_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not exists (
    select 1 from public.legal_documents document
    where document.legal_document_id = new."Terms_Document_ID"
      and document.document_type = 'event_application_terms'
      and document.version = new."Terms_Version"
      and document.is_active = true
      and document.effective_at <= timezone('Asia/Manila', now())
  ) then
    raise exception 'Review and accept the active Event Application Terms PDF before submitting';
  end if;
  new."Terms_Accepted_At" := coalesce(new."Terms_Accepted_At", timezone('Asia/Manila', now()));
  return new;
end;
$fn$;

drop trigger if exists trg_enforce_event_application_terms on public."Event_Applications";
create trigger trg_enforce_event_application_terms
before insert on public."Event_Applications"
for each row execute function public.enforce_event_application_terms();

create table if not exists public.legal_document_acceptances (
  acceptance_id bigint generated by default as identity primary key,
  legal_document_id integer not null references public.legal_documents(legal_document_id) on delete restrict,
  document_type text not null,
  document_version text not null,
  context_type text not null,
  context_id bigint not null,
  accepted_by_auth_user uuid not null,
  accepted_by_user integer references public.users(user_id) on delete set null,
  accepted_email text,
  accepted_at timestamp without time zone not null default timezone('Asia/Manila', now()),
  constraint legal_document_acceptances_context_check check (
    context_type in ('event_application', 'hospital_application', 'wig_request')
  ),
  constraint legal_document_acceptances_one_per_context unique (context_type, context_id)
);

alter table public.legal_document_acceptances enable row level security;
grant select on public.legal_document_acceptances to authenticated;

drop policy if exists legal_document_acceptances_select_authorized on public.legal_document_acceptances;
create policy legal_document_acceptances_select_authorized
on public.legal_document_acceptances for select to authenticated
using (
  accepted_by_auth_user = auth.uid()
  or exists (
    select 1 from public.users actor
    where actor.auth_user_id = auth.uid()
      and actor.is_active is distinct from false
      and public.normalize_app_role(actor.role) in ('staff', 'admin', 'superadmin')
  )
);

create or replace function public.accept_active_legal_document(
  p_legal_document_id integer,
  p_document_version text,
  p_context_type text,
  p_context_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_document public.legal_documents%rowtype;
  v_actor public.users%rowtype;
  v_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_acceptance public.legal_document_acceptances%rowtype;
  v_expected_type text;
begin
  if auth.uid() is null then raise exception 'Authentication required to record terms acceptance'; end if;
  if coalesce(p_context_id, 0) <= 0 then raise exception 'A submitted record is required'; end if;

  v_expected_type := case p_context_type
    when 'event_application' then 'event_application_terms'
    when 'hospital_application' then 'hospital_representative_application_terms'
    when 'wig_request' then 'wig_request_terms'
    else null
  end;
  if v_expected_type is null then raise exception 'Unsupported terms context'; end if;

  select * into v_document
  from public.legal_documents
  where legal_document_id = p_legal_document_id
    and document_type = v_expected_type
    and version = trim(coalesce(p_document_version, ''))
    and is_active = true
    and effective_at <= timezone('Asia/Manila', now());
  if v_document.legal_document_id is null then
    raise exception 'The terms changed. Refresh and review the current PDF before submitting';
  end if;

  select * into v_actor from public.users where auth_user_id = auth.uid() limit 1;

  if p_context_type = 'event_application' and not exists (
    select 1 from public."Event_Applications" e
    where e."Event_Application_ID" = p_context_id
      and lower(coalesce(e."Applicant_Email", '')) = v_email
  ) then raise exception 'The event application does not belong to the verified email';
  elsif p_context_type = 'hospital_application' and not exists (
    select 1 from public."Hospitals" h
    join public.users u on u.user_id = h."Created_By"
    where h."Hospital_ID" = p_context_id and u.auth_user_id = auth.uid()
  ) then raise exception 'The hospital application does not belong to this account';
  elsif p_context_type = 'wig_request' and not exists (
    select 1 from public."Wig_Requests" w
    where w."Req_ID" = p_context_id
      and (
        w."Requested_By" = v_actor.user_id
        or exists (
          select 1 from public."Hospital_Representative" hr
          where hr."User_ID" = v_actor.user_id and hr."Hospital_ID" = w."Hospital_ID"
        )
      )
  ) then raise exception 'The wig request does not belong to this hospital account';
  end if;

  insert into public.legal_document_acceptances (
    legal_document_id, document_type, document_version, context_type, context_id,
    accepted_by_auth_user, accepted_by_user, accepted_email
  ) values (
    v_document.legal_document_id, v_document.document_type, v_document.version,
    p_context_type, p_context_id, auth.uid(), v_actor.user_id, nullif(v_email, '')
  )
  on conflict (context_type, context_id) do update
  set legal_document_id = excluded.legal_document_id,
      document_type = excluded.document_type,
      document_version = excluded.document_version,
      accepted_by_auth_user = excluded.accepted_by_auth_user,
      accepted_by_user = excluded.accepted_by_user,
      accepted_email = excluded.accepted_email,
      accepted_at = timezone('Asia/Manila', now())
  returning * into v_acceptance;

  return to_jsonb(v_acceptance);
end;
$fn$;

revoke all on function public.accept_active_legal_document(integer, text, text, bigint) from public, anon;
grant execute on function public.accept_active_legal_document(integer, text, text, bigint) to authenticated;

-- Atomic wrappers keep the original business RPCs stable while making terms
-- acceptance part of the same transaction as the submitted record.
create or replace function public.submit_partner_hospital_application_with_terms(
  p_email text,
  p_first_name text,
  p_middle_name text default null,
  p_last_name text default null,
  p_suffix text default null,
  p_birthdate date default null,
  p_gender text default null,
  p_lead_contact_number text default null,
  p_lead_street text default null,
  p_lead_barangay text default null,
  p_lead_city text default null,
  p_lead_province text default null,
  p_lead_region text default null,
  p_lead_country text default null,
  p_hospital_name text default null,
  p_hospital_logo_url text default null,
  p_hospital_head_name text default null,
  p_hospital_head_title text default null,
  p_hospital_head_contact_number text default null,
  p_hospital_head_email text default null,
  p_hospital_contact_number text default null,
  p_hospital_street text default null,
  p_hospital_barangay text default null,
  p_hospital_city text default null,
  p_hospital_province text default null,
  p_hospital_region text default null,
  p_hospital_country text default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_terms_document_id integer default null,
  p_terms_version text default null
)
returns table (user_id integer, hospital_id integer)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_result record;
begin
  select * into v_result
  from public.submit_partner_hospital_application(
    p_email, p_first_name, p_middle_name, p_last_name, p_suffix, p_birthdate,
    p_gender, p_lead_contact_number, p_lead_street, p_lead_barangay,
    p_lead_city, p_lead_province, p_lead_region, p_lead_country,
    p_hospital_name, p_hospital_logo_url, p_hospital_head_name,
    p_hospital_head_title, p_hospital_head_contact_number,
    p_hospital_head_email, p_hospital_contact_number, p_hospital_street,
    p_hospital_barangay, p_hospital_city, p_hospital_province,
    p_hospital_region, p_hospital_country, p_latitude, p_longitude
  );

  perform public.accept_active_legal_document(
    p_terms_document_id, p_terms_version, 'hospital_application', v_result.hospital_id
  );
  return query select v_result.user_id::integer, v_result.hospital_id::integer;
end;
$fn$;

create or replace function public.create_wig_request_with_terms(
  p_hospital_id integer,
  p_patient_id integer,
  p_wig_specification_id integer,
  p_special_notes text default null,
  p_preferred_color text default null,
  p_preferred_length text default null,
  p_hair_texture text default null,
  p_cap_size text default null,
  p_style_preference text default null,
  p_terms_document_id integer default null,
  p_terms_version text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req_id integer;
begin
  v_req_id := public.create_wig_request_with_spec(
    p_hospital_id, p_patient_id, p_wig_specification_id, p_special_notes,
    p_preferred_color, p_preferred_length, p_hair_texture, p_cap_size,
    p_style_preference
  );
  perform public.accept_active_legal_document(
    p_terms_document_id, p_terms_version, 'wig_request', v_req_id
  );
  return v_req_id;
end;
$fn$;

revoke all on function public.submit_partner_hospital_application_with_terms(
  text, text, text, text, text, date,
  text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, text,
  numeric, numeric, integer, text
) from public, anon;
grant execute on function public.submit_partner_hospital_application_with_terms(
  text, text, text, text, text, date,
  text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, text,
  numeric, numeric, integer, text
) to authenticated;
revoke all on function public.create_wig_request_with_terms(
  integer, integer, integer, text, text, text, text, text, text, integer, text
) from public, anon;
grant execute on function public.create_wig_request_with_terms(
  integer, integer, integer, text, text, text, text, text, text, integer, text
) to authenticated;

-- A request may be released more than once after an approved return/repair.
alter table public.wig_release_receipts
  drop constraint if exists wig_release_receipts_req_id_key;
alter table public.wig_release_receipts
  add column if not exists release_cycle integer not null default 1;
create unique index if not exists wig_release_receipts_req_cycle_unique
  on public.wig_release_receipts(req_id, release_cycle);

alter table public.wig_release_appeals
  add column if not exists return_status text,
  add column if not exists return_destination_snapshot jsonb,
  add column if not exists return_courier text,
  add column if not exists return_tracking_number text,
  add column if not exists return_note text,
  add column if not exists return_shipped_at timestamp without time zone,
  add column if not exists return_received_at timestamp without time zone,
  add column if not exists repair_started_at timestamp without time zone,
  add column if not exists repair_completed_at timestamp without time zone,
  add column if not exists return_updated_by integer references public.users(user_id) on delete set null;

alter table public.wig_release_appeals drop constraint if exists wig_release_appeals_return_status_check;
alter table public.wig_release_appeals add constraint wig_release_appeals_return_status_check check (
  return_status is null or return_status in (
    'Awaiting Return', 'In Transit', 'Return Received', 'Under Repair',
    'Ready for Re-release', 'Completed'
  )
);

create or replace function public.hrep_confirm_wig_receipt_terms(
  p_req_id integer,
  p_terms_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_receipt public.wig_release_receipts%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null then raise exception 'Authentication required'; end if;
  select * into v_request from public."Wig_Requests" where "Req_ID" = p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if public.normalize_flow_key(v_request."Status") <> 'released' then raise exception 'Only a released wig can be confirmed as received'; end if;
  if not exists (
    select 1 from public."Hospital_Representative" assignment
    where assignment."User_ID" = v_actor.user_id and assignment."Hospital_ID" = v_request."Hospital_ID"
  ) then raise exception 'You are not authorized for this hospital request'; end if;

  select * into v_receipt from public.wig_release_receipts
  where req_id = p_req_id order by release_cycle desc limit 1 for update;
  if v_receipt.receipt_id is null then raise exception 'Release receipt record is unavailable'; end if;
  if trim(coalesce(p_terms_version, '')) <> v_receipt.terms_version then raise exception 'The terms changed. Refresh and review the current version'; end if;

  update public.wig_release_receipts
  set received_confirmed_at = coalesce(received_confirmed_at, v_now),
      terms_accepted_at = coalesce(terms_accepted_at, v_now),
      accepted_by = coalesce(accepted_by, v_actor.user_id), updated_at = v_now
  where receipt_id = v_receipt.receipt_id returning * into v_receipt;
  return to_jsonb(v_receipt);
end;
$fn$;

create or replace function public.hrep_submit_wig_release_appeal(
  p_req_id integer,
  p_reason text,
  p_description text,
  p_evidence_paths jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_receipt public.wig_release_receipts%rowtype;
  v_appeal public.wig_release_appeals%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null then raise exception 'Authentication required'; end if;
  select * into v_request from public."Wig_Requests" where "Req_ID" = p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if not exists (
    select 1 from public."Hospital_Representative" assignment
    where assignment."User_ID" = v_actor.user_id and assignment."Hospital_ID" = v_request."Hospital_ID"
  ) then raise exception 'You are not authorized for this hospital request'; end if;

  select * into v_receipt from public.wig_release_receipts
  where req_id = p_req_id order by release_cycle desc limit 1 for update;
  if v_receipt.receipt_id is null or v_receipt.terms_accepted_at is null then raise exception 'Confirm receipt and accept the terms before submitting an appeal'; end if;
  if v_now > v_receipt.appeal_deadline then raise exception 'The seven-day appeal period has ended'; end if;
  if trim(coalesce(p_reason, '')) not in ('Damaged on Receipt', 'Wrong Wig', 'Poor Fit', 'Other') then raise exception 'Select a valid appeal reason'; end if;
  if length(trim(coalesce(p_description, ''))) < 20 then raise exception 'Describe the issue using at least 20 characters'; end if;
  if jsonb_typeof(coalesce(p_evidence_paths, '[]'::jsonb)) <> 'array' then raise exception 'Evidence must be a list of uploaded files'; end if;

  insert into public.wig_release_appeals (receipt_id, req_id, submitted_by, reason, description, evidence_paths, submitted_at, updated_at)
  values (v_receipt.receipt_id, p_req_id, v_actor.user_id, trim(p_reason), trim(p_description), coalesce(p_evidence_paths, '[]'::jsonb), v_now, v_now)
  returning * into v_appeal;
  return to_jsonb(v_appeal);
end;
$fn$;

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

create or replace function public.staff_review_wig_release_appeal(
  p_appeal_id bigint,
  p_decision text,
  p_decision_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_appeal public.wig_release_appeals%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_destination jsonb;
  v_recipient integer;
  v_status text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin') then
    raise exception 'Only active staff or admin accounts can review appeals';
  end if;
  v_status := case lower(trim(coalesce(p_decision, ''))) when 'approve' then 'Approved for Replacement' when 'reject' then 'Rejected' else null end;
  if v_status is null then raise exception 'Decision must be approve or reject'; end if;
  if length(trim(coalesce(p_decision_note, ''))) < 10 then raise exception 'Add a decision note using at least 10 characters'; end if;

  select * into v_appeal from public.wig_release_appeals where appeal_id = p_appeal_id for update;
  if v_appeal.appeal_id is null then raise exception 'Appeal was not found'; end if;
  if v_appeal.status <> 'Pending Staff Review' then raise exception 'This appeal has already been reviewed'; end if;

  if v_status = 'Approved for Replacement' then
    select to_jsonb(destination) into v_destination
    from public."Logistics_Settings" destination
    order by destination."Logistics_Settings_ID" limit 1;
    if v_destination is null then raise exception 'Configure the office logistics destination before approving a return'; end if;
  end if;

  update public.wig_release_appeals
  set status = v_status,
      reviewed_by = v_actor.user_id,
      reviewed_at = v_now,
      decision_note = trim(p_decision_note),
      return_status = case when v_status = 'Approved for Replacement' then 'Awaiting Return' else null end,
      return_destination_snapshot = case when v_status = 'Approved for Replacement' then v_destination else null end,
      return_updated_by = v_actor.user_id,
      updated_at = v_now
  where appeal_id = p_appeal_id returning * into v_appeal;

  select * into v_request from public."Wig_Requests" where "Req_ID" = v_appeal.req_id;
  for v_recipient in select distinct x from (values (v_request."Requested_By")) r(x) where x is not null loop
    insert into public."Notification" ("User_ID", "Type", "Title", "Message", "Status", "Reference_Type", "Reference_ID", "Updated_At")
    values (v_recipient, 'Wig Appeal', case when v_status = 'Approved for Replacement' then 'Wig return authorized' else 'Wig appeal rejected' end,
      case when v_status = 'Approved for Replacement' then format('%s is approved for return. Send the wig to the displayed office destination.', coalesce(v_request."Request_Code", 'Wig request')) else format('%s appeal was rejected.', coalesce(v_request."Request_Code", 'Wig request')) end,
      'Unread', 'wig_release_appeals', p_appeal_id::text, v_now);
  end loop;
  return to_jsonb(v_appeal);
end;
$fn$;

create or replace function public.hrep_submit_wig_return(
  p_appeal_id bigint,
  p_courier text,
  p_tracking_number text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_appeal public.wig_release_appeals%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null then raise exception 'Authentication required'; end if;
  select * into v_appeal from public.wig_release_appeals where appeal_id = p_appeal_id for update;
  if v_appeal.return_status <> 'Awaiting Return' then raise exception 'This wig is not awaiting return shipment'; end if;
  select * into v_request from public."Wig_Requests" where "Req_ID" = v_appeal.req_id;
  if not exists (select 1 from public."Hospital_Representative" hr where hr."User_ID" = v_actor.user_id and hr."Hospital_ID" = v_request."Hospital_ID") then
    raise exception 'You are not authorized for this hospital request';
  end if;
  if length(trim(coalesce(p_courier, ''))) < 2 or length(trim(coalesce(p_tracking_number, ''))) < 3 then
    raise exception 'Courier and tracking/reference number are required';
  end if;
  update public.wig_release_appeals
  set return_status = 'In Transit', return_courier = trim(p_courier),
      return_tracking_number = trim(p_tracking_number), return_note = nullif(trim(coalesce(p_note, '')), ''),
      return_shipped_at = v_now, return_updated_by = v_actor.user_id, updated_at = v_now
  where appeal_id = p_appeal_id returning * into v_appeal;
  return to_jsonb(v_appeal);
end;
$fn$;

create or replace function public.staff_update_wig_return(
  p_appeal_id bigint,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_appeal public.wig_release_appeals%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_next_status text;
  v_now timestamp without time zone := timezone('Asia/Manila', now());
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() and is_active is distinct from false limit 1;
  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) not in ('staff', 'admin', 'superadmin') then
    raise exception 'Only active staff or admin accounts can update returned wigs';
  end if;
  select * into v_appeal from public.wig_release_appeals where appeal_id = p_appeal_id for update;
  if v_appeal.appeal_id is null then raise exception 'Appeal was not found'; end if;

  if v_action = 'receive' and v_appeal.return_status = 'In Transit' then v_next_status := 'Return Received';
  elsif v_action = 'start_repair' and v_appeal.return_status = 'Return Received' then v_next_status := 'Under Repair';
  elsif v_action = 'complete_repair' and v_appeal.return_status = 'Under Repair' then v_next_status := 'Ready for Re-release';
  else raise exception 'That return action is not valid for the current status';
  end if;

  update public.wig_release_appeals
  set return_status = v_next_status,
      return_received_at = case when v_action = 'receive' then v_now else return_received_at end,
      repair_started_at = case when v_action = 'start_repair' then v_now else repair_started_at end,
      repair_completed_at = case when v_action = 'complete_repair' then v_now else repair_completed_at end,
      return_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), return_note),
      return_updated_by = v_actor.user_id, updated_at = v_now
  where appeal_id = p_appeal_id returning * into v_appeal;

  if v_action = 'complete_repair' then
    update public."Release_Schedules" set "Is_Current" = false, "Updated_At" = v_now
    where "Req_ID" = v_appeal.req_id and "Is_Current" = true;
    update public."Wig_Requests"
    set "Status" = 'Accepted - Wig Allocated',
        "Status_Reason" = 'Returned wig repaired and ready for a new release schedule',
        "Updated_At" = v_now
    where "Req_ID" = v_appeal.req_id returning * into v_request;
  end if;
  return to_jsonb(v_appeal);
end;
$fn$;

revoke all on function public.hrep_submit_wig_return(bigint, text, text, text) from public, anon;
revoke all on function public.staff_update_wig_return(bigint, text, text) from public, anon;
grant execute on function public.hrep_submit_wig_return(bigint, text, text, text) to authenticated;
grant execute on function public.staff_update_wig_return(bigint, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
