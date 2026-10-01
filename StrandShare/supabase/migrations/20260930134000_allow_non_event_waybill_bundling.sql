-- Resolve approved non-event hair by its issued waybill during bundling.

begin;

create or replace function public.bundle_scan_add_waybill(
  p_bundle_id integer,
  p_waybill_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_raw text := trim(coalesce(p_waybill_payload, ''));
  v_payload jsonb;
  v_waybill text;
  v_submission_id integer;
  v_submission public."Hair_Submissions"%rowtype;
  v_result jsonb;
  v_original_status text;
begin
  if left(v_raw, 1) = '{' then
    begin
      v_payload := v_raw::jsonb;
    exception
      when others then
        v_payload := null;
    end;
  end if;

  v_waybill := nullif(upper(trim(coalesce(
    v_payload ->> 'Waybill_Code',
    v_payload ->> 'waybill_code',
    v_payload ->> 'waybillCode',
    v_payload ->> 'code',
    v_payload ->> 'value',
    v_payload -> 'data' ->> 'Waybill_Code',
    v_payload -> 'data' ->> 'waybill_code',
    v_payload -> 'data' ->> 'waybillCode',
    case when v_payload is null then v_raw end
  ))), '');

  begin
    v_submission_id := nullif(trim(coalesce(
      v_payload ->> 'Submission_ID',
      v_payload ->> 'submission_id',
      v_payload -> 'data' ->> 'Submission_ID',
      v_payload -> 'data' ->> 'submission_id'
    )), '')::integer;
  exception
    when others then
      v_submission_id := null;
  end;

  select submission.*
  into v_submission
  from public."Hair_Submissions" submission
  where (
      v_submission_id is not null
      and submission."Submission_ID" = v_submission_id
    ) or (
      v_waybill is not null
      and upper(trim(coalesce(submission."Waybill_Code", ''))) = v_waybill
    )
  order by case
    when submission."Submission_ID" = v_submission_id then 0
    else 1
  end
  limit 1
  for update;

  -- The legacy scanner already owns authorization, draft capacity, duplicate,
  -- Cut-status, audit, and inventory lifecycle checks. Give it the resolved
  -- submission ID because its plain-waybill fallback is event-attendee-only.
  if v_submission."Submission_ID" is not null
    and not coalesce(v_submission."From_Event", false) then
    v_original_status := v_submission."Status";
    v_waybill := coalesce(
      nullif(upper(trim(coalesce(v_submission."Waybill_Code", ''))), ''),
      v_waybill
    );

    -- Compatibility for older approved rows created before non-event hair was
    -- standardized as Cut. New approvals already enter this function as Cut.
    if public.normalize_flow_key(v_original_status) = 'available' then
      update public."Hair_Submissions"
      set "Status" = 'Cut'
      where "Submission_ID" = v_submission."Submission_ID";
    end if;

    v_result := public.bundle_scan_add_waybill_legacy_20260905(
      p_bundle_id,
      jsonb_build_object(
        'Submission_ID', v_submission."Submission_ID",
        'Waybill_Code', v_waybill
      )::text
    );

    if public.normalize_flow_key(v_original_status) = 'available' then
      update public."Hair_Submissions"
      set
        "Status" = 'Available',
        "Updated_At" = timezone('Asia/Manila', now())
      where "Submission_ID" = v_submission."Submission_ID"
      returning * into v_submission;

      return v_result || jsonb_build_object(
        'submission', to_jsonb(v_submission) || jsonb_build_object(
          'Waybill_Code', v_waybill
        )
      );
    end if;

    return v_result;
  end if;

  -- Event hair continues through the existing attendee-waybill implementation.
  return public.bundle_scan_add_waybill_legacy_20260905(
    p_bundle_id,
    p_waybill_payload
  );
end;
$fn$;

revoke all on function public.bundle_scan_add_waybill(integer, text)
  from public, anon;
grant execute on function public.bundle_scan_add_waybill(integer, text)
  to authenticated;

comment on function public.bundle_scan_add_waybill(integer, text) is
  'Adds eligible event or non-event Cut hair to a draft bundle using its issued waybill or scan payload.';

notify pgrst, 'reload schema';

commit;
