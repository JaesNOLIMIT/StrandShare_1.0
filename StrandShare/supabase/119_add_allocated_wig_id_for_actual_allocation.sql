-- Keep Requested_Wig_ID as patient preference, and store actual staff allocation separately.
begin;

alter table public."Wig_Requests"
  add column if not exists "Allocated_Wig_ID" integer null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'Wig_Requests_Allocated_Wig_fkey'
      and conrelid = 'public."Wig_Requests"'::regclass
  ) then
    alter table public."Wig_Requests"
      add constraint "Wig_Requests_Allocated_Wig_fkey"
      foreign key ("Allocated_Wig_ID")
      references public."Wigs" ("Wig_ID")
      on delete set null;
  end if;
end
$$;

create index if not exists "idx_Wig_Requests_Allocated_Wig_ID"
  on public."Wig_Requests" using btree ("Allocated_Wig_ID");

-- Backfill historical rows that are already in an allocated/release path.
update public."Wig_Requests"
set "Allocated_Wig_ID" = "Requested_Wig_ID"
where "Allocated_Wig_ID" is null
  and "Requested_Wig_ID" is not null
  and lower(regexp_replace(coalesce("Status", '')::text, '[^a-z0-9]+', '', 'g')) = any (
    array[
      'acceptedwigallocated',
      'acceptedallocatedwig',
      'acceptedwithallocatedwig',
      'acceptedallocated',
      'allocated',
      'allocatedwig',
      'toberelease',
      'releasing',
      'released'
    ]
  );

commit;
