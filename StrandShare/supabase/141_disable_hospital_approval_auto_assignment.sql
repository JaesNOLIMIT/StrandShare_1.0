-- 141_disable_hospital_approval_auto_assignment.sql
-- Hospital approval now activates the applicant/manager account directly.
-- Manual or automatic Hospital_Representative assignment is no longer used.

begin;

drop trigger if exists trg_sync_hospital_representative_on_hospital_approval on public."Hospitals";

commit;
