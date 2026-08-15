-- Keep only selected high-value audit actions.
-- This filters inserts from all sources (frontend + SQL/RPC functions).

begin;

create or replace function public.is_important_audit_action(p_action text)
returns boolean
language sql
immutable
as $fn$
  select coalesce(p_action, '') = any (
    array[
      'auth.sign_in',
      'auth.sign_out',
      'hospital_release_completed',
      'staff_wig_request_action',
      'wig_requests.schedule_release',
      'wig_requests.complete_release',
      'event_attendees.rsvp_scan',
      'hair_submissions.staff_quality_review',
      'hair_submissions.specialist_non_event_quality_review',
      'hair_submissions.staff_update_details',
      'hair_submissions.scan_non_event',
      'hair_submission_bundles.open_draft',
      'hair_submission_bundles.scan_waybill',
      'hair_submission_bundles.close_draft',
      'wigs.complete_stock_from_bundle_scan',
      'wigs.completed_from_bundle',
      'wig_catalog_bundle_scan_completed',
      'wig_catalog_item_created',
      'wig_catalog_stock_adjusted',
      'backup.create',
      'backup.verify',
      'backup.download'
    ]
  );
$fn$;

create or replace function public.filter_audit_logs_to_important_actions()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if public.is_important_audit_action(new.action) then
    return new;
  end if;

  -- Returning NULL from a BEFORE INSERT trigger skips the row.
  return null;
end;
$fn$;

drop trigger if exists trg_filter_audit_logs_to_important_actions on public.audit_logs;
create trigger trg_filter_audit_logs_to_important_actions
before insert on public.audit_logs
for each row
execute function public.filter_audit_logs_to_important_actions();

notify pgrst, 'reload schema';
commit;
