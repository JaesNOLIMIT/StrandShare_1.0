-- Only quality-approved non-event hair may enter a bundle.
-- This trigger protects every bundling path, including direct table updates
-- and older bundle_scan_add_waybill RPC implementations.

begin;

create or replace function public.enforce_hair_bundle_quality_eligibility()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_submission_status text := public.normalize_flow_key(new."Status");
  v_detail_status text;
begin
  if new."Bundle_ID" is null
     or new."Bundle_ID" is not distinct from old."Bundle_ID" then
    return new;
  end if;

  if v_submission_status = 'cancelled' then
    raise exception
      'Submission % was rejected or cancelled and cannot be added to Bundling.',
      new."Submission_ID";
  end if;

  if v_submission_status <> 'cut' then
    raise exception
      'Submission % must be in Cut status before Bundling. Current status: %.',
      new."Submission_ID",
      coalesce(new."Status", 'N/A');
  end if;

  if coalesce(new."From_Event", false) = false then
    select public.normalize_flow_key(hsd."Status")
    into v_detail_status
    from public."Hair_Submission_Details" hsd
    where hsd."Submission_ID" = new."Submission_ID"
    order by hsd."Submission_Detail_ID" desc
    limit 1;

    if coalesce(v_detail_status, '') = 'rejected' then
      raise exception
        'Submission % was rejected or cancelled and cannot be added to Bundling.',
        new."Submission_ID";
    end if;

    if coalesce(v_detail_status, '') <> 'approved' then
      raise exception
        'Non-event submission % must be Approved in Quality Check before Bundling. Current detail status: %.',
        new."Submission_ID",
        coalesce(v_detail_status, 'Missing');
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_enforce_hair_bundle_quality_eligibility
  on public."Hair_Submissions";

create trigger trg_enforce_hair_bundle_quality_eligibility
before update of "Bundle_ID", "Status"
on public."Hair_Submissions"
for each row
when (new."Bundle_ID" is not null)
execute function public.enforce_hair_bundle_quality_eligibility();

commit;
