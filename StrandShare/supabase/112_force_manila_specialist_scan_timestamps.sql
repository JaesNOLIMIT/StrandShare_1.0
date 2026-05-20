-- 112_force_manila_specialist_scan_timestamps.sql
-- Ensure specialist-side scan workflows persist Manila (UTC+8) timestamps.

begin;

-- ---------------------------------------------------------------------------
-- Defaults for core specialist workflow tables (timestamp without time zone).
-- ---------------------------------------------------------------------------
alter table public."Hair_Submission_Bundles"
  alter column "Created_At" set default timezone('Asia/Manila', now()),
  alter column "Updated_At" set default timezone('Asia/Manila', now());

alter table public."Wigs"
  alter column "Created_At" set default timezone('Asia/Manila', now()),
  alter column "Updated_At" set default timezone('Asia/Manila', now());

alter table public."Hair_Submissions"
  alter column "Created_At" set default timezone('Asia/Manila', now()),
  alter column "Updated_At" set default timezone('Asia/Manila', now());

alter table public."Hair_Submission_Details"
  alter column "Created_At" set default timezone('Asia/Manila', now()),
  alter column "Updated_At" set default timezone('Asia/Manila', now());

alter table public."Wig_AI_Filters"
  alter column "Created_At" set default timezone('Asia/Manila', now()),
  alter column "Updated_At" set default timezone('Asia/Manila', now());

-- ---------------------------------------------------------------------------
-- Triggers that auto-set Updated_At must also use Manila time.
-- ---------------------------------------------------------------------------
create or replace function public.set_hair_submission_bundles_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new."Updated_At" = timezone('Asia/Manila', now());
  return new;
end;
$fn$;

create or replace function public.set_wigs_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new."Updated_At" = timezone('Asia/Manila', now());
  return new;
end;
$fn$;

create or replace function public.set_wig_specifications_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new."Updated_At" = timezone('Asia/Manila', now());
  return new;
end;
$fn$;

create or replace function public.set_wig_ai_filters_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new."Updated_At" = timezone('Asia/Manila', now());
  return new;
end;
$fn$;

commit;

