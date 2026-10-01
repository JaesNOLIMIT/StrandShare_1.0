-- Route repaired direct-patient wigs to pickup and keep concern evidence readable.

begin;

-- Concern evidence is displayed through short-lived signed URLs. Keep the
-- bucket readable for existing public URLs and restore the original read
-- policy in environments where it is missing.
insert into storage.buckets (id, name, public)
values ('patient_assets', 'patient_assets', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists patient_assets_select_public on storage.objects;
create policy patient_assets_select_public
on storage.objects
for select
to public
using (bucket_id = 'patient_assets');

-- A repaired direct-patient request has no hospital release scheduler. It must
-- return to the direct pickup queue; only hospital-linked requests are routed
-- through To Be Release.
create or replace function public.sync_wig_request_appeal_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now timestamp without time zone := timezone('Asia/Manila',now());
  v_request public."Wig_Requests"%rowtype;
  v_bundle public."Hair_Submission_Bundles"%rowtype;
begin
  if new.return_status='Completed' then return new; end if;
  if new.status='Rejected' then
    update public."Wig_Requests" set "Status"='Released',"Status_Reason"='After-release concern was not accepted; the original release remains complete',"Updated_At"=v_now where "Req_ID"=new.req_id;
  elsif new.return_status='Return Completed' then
    select * into v_request from public."Wig_Requests" where "Req_ID"=new.req_id for update;
    if old.return_status is distinct from 'Return Completed' and v_request."Allocated_Wig_ID" is not null then
      perform set_config('wig.stock_reason',format('Returned wig from request %s restored to stock',new.req_id),true);
      update public."Wigs" set "Stock_Count"=greatest(0,coalesce("Stock_Count",0))+1,
        "Wig_Status"='available',"Updated_At"=v_now where "Wig_ID"=v_request."Allocated_Wig_ID";
      if v_request."Fulfillment_Bundle_ID" is not null then
        update public."Hair_Submission_Bundles" set "Allocated_To_Wig_Request_ID"=null,
          "Allocated_At"=null,"Allocated_By"=null,"Returned_To_Stock_At"=v_now,"Updated_At"=v_now
        where "Bundle_ID"=v_request."Fulfillment_Bundle_ID" returning * into v_bundle;
      end if;
    end if;
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set "Status"='Returned - Completed',
      "Status_Reason"='Returned wig received and restored to available stock; request closed',"Updated_At"=v_now where "Req_ID"=new.req_id;
  elsif new.return_status='Ready for Re-release' then
    update public."Release_Schedules" set "Is_Current"=false,"Updated_At"=v_now where "Req_ID"=new.req_id and "Is_Current"=true;
    update public."Wig_Requests" set
      "Status"=case when "Hospital_ID" is null then 'Ready for Pick-up' else 'To Be Release' end,
      "Status_Reason"=case
        when "Hospital_ID" is null then 'Repair completed; ready for direct patient pickup'
        else 'Repair completed; waiting for a new release schedule'
      end,
      "Updated_At"=v_now
    where "Req_ID"=new.req_id;
  else
    update public."Wig_Requests" set "Status"='Appealed',"Status_Reason"=case
      when new.status='Pending Staff Review' then 'After-release concern awaiting Staff confirmation'
      when new.return_status='Awaiting Return' then 'Concern confirmed; waiting for wig return'
      when new.return_status='In Transit' then 'Wig return is in transit'
      when new.return_status='Return Received' then 'Returned wig waiting for repair or replacement'
      when new.return_status='Under Repair' then 'Returned wig is under repair or replacement'
      else 'After-release concern is active' end,"Updated_At"=v_now where "Req_ID"=new.req_id;
  end if;
  return new;
end;
$fn$;

-- Re-run the lifecycle trigger for direct-patient repairs that were already
-- placed in To Be Release by the previous unconditional implementation.
update public.wig_release_appeals appeal
set
  return_status = appeal.return_status,
  updated_at = coalesce(appeal.updated_at, timezone('Asia/Manila',now()))
where appeal.return_status = 'Ready for Re-release'
  and exists (
    select 1
    from public."Wig_Requests" request
    where request."Req_ID" = appeal.req_id
      and request."Hospital_ID" is null
      and public.normalize_flow_key(request."Status") in ('toberelease','appealed')
  );

notify pgrst, 'reload schema';

commit;
