alter table if exists public."Wigs"
add column if not exists "In_Stock" boolean;

update public."Wigs"
set "In_Stock" = case
  when lower(replace(replace(replace(coalesce("Wig_Status", ''), '_', ' '), '-', ' '), '  ', ' ')) in ('in production', 'ready for release')
    then true
  else false
end
where "In_Stock" is null;

alter table public."Wigs"
alter column "In_Stock" set default true;

alter table public."Wigs"
alter column "In_Stock" set not null;

create index if not exists "idx_Wigs_In_Stock"
  on public."Wigs" using btree ("In_Stock");
