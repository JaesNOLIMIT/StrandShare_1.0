begin;

-- These are timestamp-without-time-zone columns. Keep them as Philippine
-- wall-clock values so activation policies and clients agree in every locale.
-- Existing legal-document values came from UTC ISO strings/default now(), so
-- repair that legacy eight-hour offset before changing the write behavior.
update public.legal_documents
set effective_at = effective_at + interval '8 hours',
    created_at = created_at + interval '8 hours';

-- Do not backfill Event_Applications here. Rejected/auto-rejected rows are
-- intentionally immutable, and a bulk UPDATE would fire their workflow locks.
-- The trigger replacement below makes every new acceptance authoritative and
-- records it with the Manila server clock.

alter table public.legal_documents
  alter column effective_at set default timezone('Asia/Manila', now()),
  alter column created_at set default timezone('Asia/Manila', now());

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
    raise exception 'Review and accept the active Program Application Terms PDF before submitting';
  end if;

  -- Use the server clock; a browser-supplied ISO value may represent another
  -- timezone when cast into a timestamp-without-time-zone column.
  new."Terms_Accepted_At" := timezone('Asia/Manila', now());
  return new;
end;
$fn$;

create or replace function public.get_patient_application_setup(p_hospital_id integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_hospital public."Hospitals"%rowtype;
  v_terms public.legal_documents%rowtype;
begin
  select * into v_hospital
  from public."Hospitals"
  where "Hospital_ID" = p_hospital_id
    and "Is_Approved" is true
    and lower(coalesce("Approval_Status", '')) = 'approved';

  if v_hospital."Hospital_ID" is null then
    raise exception 'Partner hospital was not found';
  end if;

  select * into v_terms
  from public.legal_documents
  where document_type = 'patient_application_terms'
    and is_active is true
    and effective_at <= timezone('Asia/Manila', now())
  order by effective_at desc, created_at desc
  limit 1;

  return jsonb_build_object(
    'hospital', jsonb_build_object(
      'id', v_hospital."Hospital_ID",
      'name', v_hospital."Hospital_Name",
      'logo', v_hospital."Hospital_Logo",
      'location', concat_ws(', ', nullif(v_hospital."Street",''), nullif(v_hospital."Barangay",''), nullif(v_hospital."City",''), nullif(v_hospital."Province",'')),
      'contact_number', v_hospital."Contact_Number",
      'applications_open', v_hospital."Patient_Applications_Open",
      'conditions', v_hospital."Patient_Application_Conditions",
      'requirements', v_hospital."Patient_Application_Requirements",
      'requirements_pdf_path', v_hospital."Patient_Application_PDF_Path",
      'settings_updated_at', v_hospital."Patient_Application_Settings_Updated_At"
    ),
    'donivra_terms', case when v_terms.legal_document_id is null then null else jsonb_build_object(
      'id', v_terms.legal_document_id,
      'title', v_terms.title,
      'version', v_terms.version,
      'content', v_terms.content,
      'file_path', v_terms.file_path,
      'effective_at', v_terms.effective_at,
      'created_at', v_terms.created_at
    ) end
  );
end;
$fn$;

revoke all on function public.get_patient_application_setup(integer) from public;
grant execute on function public.get_patient_application_setup(integer) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
