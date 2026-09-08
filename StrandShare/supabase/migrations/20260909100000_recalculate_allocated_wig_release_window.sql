begin;

-- Requesters initially see the general 1-2 week estimate. Once Staff scans a
-- matching physical wig and approves allocation, replace that provisional
-- estimate with the exact window of 3-9 days after the Staff approval time.
create or replace function public.set_wig_request_expected_release_window()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_has_stock boolean;
  v_base timestamp with time zone;
  v_status text := public.normalize_flow_key(new."Status");
begin
  if tg_op = 'INSERT'
    or new."Requested_Wig_Specification_ID" is distinct from old."Requested_Wig_Specification_ID"
  then
    select exists (
      select 1
      from public."Hair_Submission_Bundles" bundle
      where bundle."Wig_Specification_ID" = new."Requested_Wig_Specification_ID"
        and public.normalize_flow_key(bundle."Status") in ('wigcreated','wigcompleted')
        and bundle."Stock_Added_At" is not null
        and bundle."Allocated_To_Wig_Request_ID" is null
    ) into v_has_stock;

    v_base := now();
    new."Expected_Release_Earliest_At" := v_base + case
      when v_has_stock then interval '7 days'
      else interval '1 month'
    end;
    new."Expected_Release_Latest_At" := v_base + case
      when v_has_stock then interval '14 days'
      else interval '2 months'
    end;
    new."Expected_Release_At" := new."Expected_Release_Latest_At";
    new."Expected_Release_Note" := case
      when v_has_stock then
        'Initial estimate: 1-2 weeks. Exact dates will be recalculated from the Staff approval date.'
      else
        'Initial estimate: 1-2 months while a matching wig is produced. Exact dates will be recalculated from the Staff approval date.'
    end;
    new."Expected_Release_Updated_At" := now();
  end if;

  if tg_op = 'UPDATE'
    and (
      new."Status" is distinct from old."Status"
      or new."Approved_At" is distinct from old."Approved_At"
    )
    and v_status in ('acceptedwigallocated','acceptedinproduction')
  then
    v_base := coalesce(
      new."Approved_At" at time zone 'Asia/Manila',
      now()
    );

    new."Expected_Release_Earliest_At" := v_base + case
      when v_status = 'acceptedwigallocated' then interval '3 days'
      else interval '1 month'
    end;
    new."Expected_Release_Latest_At" := v_base + case
      when v_status = 'acceptedwigallocated' then interval '9 days'
      else interval '2 months'
    end;
    new."Expected_Release_At" := new."Expected_Release_Latest_At";
    new."Expected_Release_Note" := case
      when v_status = 'acceptedwigallocated' then
        'Approved with a matching scanned wig. Expected release is 3-9 days after Staff approval.'
      else
        'Approved for production. Expected release is 1-2 months after Staff approval.'
    end;
    new."Expected_Release_Updated_At" := now();
    new."Expected_Release_Updated_By" := new."Approved_By";
  end if;

  return new;
end;
$fn$;

-- Repair requests which were already approved under the former 7-14 day
-- allocation rule so stored dates and the UI use the same 3-9 day window.
select set_config('strandshare.backfill_wig_expected_release', 'on', true);

update public."Wig_Requests" request
set
  "Expected_Release_Earliest_At" = (
    coalesce(
      request."Approved_At",
      request."Updated_At",
      timezone('Asia/Manila', now())
    ) at time zone 'Asia/Manila'
  ) + interval '3 days',
  "Expected_Release_Latest_At" = (
    coalesce(
      request."Approved_At",
      request."Updated_At",
      timezone('Asia/Manila', now())
    ) at time zone 'Asia/Manila'
  ) + interval '9 days',
  "Expected_Release_At" = (
    coalesce(
      request."Approved_At",
      request."Updated_At",
      timezone('Asia/Manila', now())
    ) at time zone 'Asia/Manila'
  ) + interval '9 days',
  "Expected_Release_Note" =
    'Approved with a matching scanned wig. Expected release is 3-9 days after Staff approval.',
  "Expected_Release_Updated_At" = now(),
  "Expected_Release_Updated_By" = request."Approved_By"
where public.normalize_flow_key(request."Status") = 'acceptedwigallocated'
  and request."Approved_At" is not null;

select set_config('strandshare.backfill_wig_expected_release', 'off', true);

comment on function public.set_wig_request_expected_release_window()
  is 'Sets provisional request estimates and recalculates allocated-wig approvals to 3-9 days after Staff approval.';

comment on column public."Wig_Requests"."Expected_Release_Latest_At"
  is 'Latest expected PH release date: 9 days after Staff allocation approval or 2 months after production approval.';

notify pgrst, 'reload schema';
commit;
