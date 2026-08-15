begin;

update public."Wig_Requests"
set "Status" = 'Pending',
    "Approved_By" = null,
    "Approved_At" = null,
    "Fulfillment_Status" = case
      when lower(coalesce("Fulfillment_Status", '')) = 'catalog_allocated' then null
      else "Fulfillment_Status"
    end,
    "Updated_At" = timezone('Asia/Manila', now())
where public.normalize_flow_key("Status") = 'acceptedwigallocated'
  and "Allocated_Wig_ID" is null;

create or replace function public.guard_allocated_wig_request_has_wig()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if public.normalize_flow_key(new."Status") = 'acceptedwigallocated'
    and new."Allocated_Wig_ID" is null
  then
    raise exception 'Accepted - Wig Allocated requires an allocated wig';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_allocated_wig_request_has_wig on public."Wig_Requests";
create trigger trg_guard_allocated_wig_request_has_wig
before insert or update of "Status", "Allocated_Wig_ID" on public."Wig_Requests"
for each row execute function public.guard_allocated_wig_request_has_wig();

notify pgrst, 'reload schema';
commit;
