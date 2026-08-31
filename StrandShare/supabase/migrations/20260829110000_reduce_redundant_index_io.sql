-- Remove provably redundant indexes that multiply write I/O.
-- Every drop is guarded by the presence of an equivalent unique index so
-- deployments with an older or partially applied schema retain coverage.

begin;

do $fn$
begin
  if to_regclass('public.uq_event_attendees_waybill_code') is not null then
    drop index if exists public.idx_event_attendees_waybill_code_unique;
  end if;

  if to_regclass('public.uq_hair_submission_details_submission') is not null then
    drop index if exists public."idx_Hair_Submission_Details_Submission_ID";
    drop index if exists public.idx_hair_submission_details_submission_id;
  end if;

  if to_regclass('public.uq_hair_submissions_user_event_request_full') is not null then
    drop index if exists public.uq_hair_submissions_user_event_request;
  end if;
end;
$fn$;

commit;
