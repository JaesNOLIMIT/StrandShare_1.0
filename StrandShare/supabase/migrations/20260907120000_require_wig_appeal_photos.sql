begin;

-- Appeals are intentionally short: one fixed reason, one to four required
-- photos, and an optional additional note. The office return address is
-- created only after Staff approves the appeal.
create or replace function public.hrep_submit_wig_release_appeal(
  p_req_id integer,
  p_reason text,
  p_description text default null,
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
  v_photo_count integer;
begin
  select * into v_actor
  from public.users
  where auth_user_id = auth.uid() and is_active is distinct from false
  limit 1;
  if v_actor.user_id is null then raise exception 'Authentication required'; end if;

  select * into v_request
  from public."Wig_Requests"
  where "Req_ID" = p_req_id;
  if v_request."Req_ID" is null then raise exception 'Wig request was not found'; end if;
  if public.normalize_flow_key(v_request."Status") <> 'released' then
    raise exception 'Only a Released wig request can begin a new appeal';
  end if;
  if not exists (
    select 1
    from public."Hospital_Representative" assignment
    where assignment."User_ID" = v_actor.user_id
      and assignment."Hospital_ID" = v_request."Hospital_ID"
  ) then
    raise exception 'You are not authorized for this hospital request';
  end if;

  select * into v_receipt
  from public.wig_release_receipts
  where req_id = p_req_id
  order by release_cycle desc
  limit 1
  for update;
  if v_receipt.receipt_id is null or v_receipt.terms_accepted_at is null then
    raise exception 'Confirm receipt and accept the terms before submitting an appeal';
  end if;
  if v_now > v_receipt.appeal_deadline then
    raise exception 'The seven-day appeal period has ended';
  end if;

  if trim(coalesce(p_reason, '')) not in ('Damaged on Receipt', 'Wrong Wig', 'Poor Fit', 'Other') then
    raise exception 'Choose one valid appeal reason';
  end if;
  if length(trim(coalesce(p_description, ''))) > 1000 then
    raise exception 'Additional details must be 1,000 characters or fewer';
  end if;
  if jsonb_typeof(coalesce(p_evidence_paths, '[]'::jsonb)) <> 'array' then
    raise exception 'Appeal photos must be supplied as a list';
  end if;
  if jsonb_array_length(coalesce(p_evidence_paths, '[]'::jsonb)) not between 1 and 4 then
    raise exception 'Attach between one and four wig photos';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_evidence_paths, '[]'::jsonb)) item
    where jsonb_typeof(item) <> 'string'
  ) then
    raise exception 'Every appeal photo must be an uploaded file path';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_evidence_paths, '[]'::jsonb)) path(value)
    where path.value not like auth.uid()::text || '/wig-appeals/' || p_req_id::text || '/%'
  ) then
    raise exception 'Appeal photos must come from your own request upload folder';
  end if;

  select count(*) into v_photo_count
  from jsonb_array_elements_text(p_evidence_paths) path(value)
  join storage.objects object_row
    on object_row.bucket_id = 'patient_assets'
   and object_row.name = path.value
  where lower(coalesce(object_row.metadata ->> 'mimetype', '')) like 'image/%';
  if v_photo_count <> jsonb_array_length(p_evidence_paths) then
    raise exception 'Only uploaded image files can be used as appeal photos';
  end if;

  insert into public.wig_release_appeals (
    receipt_id, req_id, submitted_by, reason, description,
    evidence_paths, submitted_at, updated_at
  ) values (
    v_receipt.receipt_id, p_req_id, v_actor.user_id, trim(p_reason),
    trim(coalesce(p_description, '')), p_evidence_paths, v_now, v_now
  )
  returning * into v_appeal;

  return to_jsonb(v_appeal);
end;
$fn$;

revoke all on function public.hrep_submit_wig_release_appeal(integer,text,text,jsonb) from public, anon;
grant execute on function public.hrep_submit_wig_release_appeal(integer,text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
