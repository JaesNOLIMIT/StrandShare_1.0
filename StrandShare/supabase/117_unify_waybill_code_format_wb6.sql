-- 117_unify_waybill_code_format_wb6.sql
-- Standardize waybill codes to: WB + 6 uppercase alphanumeric characters.

begin;

create or replace function public.is_waybill_code(p_code text)
returns boolean
language sql
immutable
as $fn$
  select
    p_code is not null
    and upper(trim(p_code)) ~ '^WB[A-Z0-9]{6}$'
$fn$;

create or replace function public.generate_waybill_code()
returns text
language plpgsql
volatile
as $fn$
declare
  v_chars constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  v_code text;
  v_idx integer;
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    v_code := 'WB';

    for v_idx in 1..6 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * 36)::integer, 1);
    end loop;

    if not exists (
      select 1
      from public."Event_Attendees" ea
      where upper(trim(coalesce(ea."Waybill_Code", ''))) = v_code
    )
    and not exists (
      select 1
      from public."Hair_Submission_Bundles" hb
      where upper(trim(coalesce(hb."Bundle_Waybill_Code", ''))) = v_code
    )
    and not exists (
      select 1
      from public."Wigs" w
      where upper(trim(coalesce(w."Wig_Code", ''))) = v_code
    ) then
      return v_code;
    end if;

    if v_try >= 200 then
      raise exception 'Unable to generate unique waybill code after % attempts.', v_try;
    end if;
  end loop;
end;
$fn$;

create or replace function public.set_event_attendees_defaults()
returns trigger
language plpgsql
as $fn$
begin
  if public.is_waybill_code(new."Waybill_Code") then
    new."Waybill_Code" := upper(trim(new."Waybill_Code"));
  else
    new."Waybill_Code" := public.generate_waybill_code();
  end if;

  if new."Created_At" is null then
    new."Created_At" := timezone('Asia/Manila', now());
  end if;
  new."Updated_At" := timezone('Asia/Manila', now());
  return new;
end;
$fn$;

drop trigger if exists trg_set_event_attendees_defaults on public."Event_Attendees";
create trigger trg_set_event_attendees_defaults
before insert or update on public."Event_Attendees"
for each row
execute function public.set_event_attendees_defaults();

drop trigger if exists trg_set_hair_submissions_waybill_defaults on public."Hair_Submissions";
drop function if exists public.set_hair_submissions_waybill_defaults();

create or replace function public.get_bundle_waybill_code(
  p_bundle_id integer,
  p_created_at timestamp without time zone default null
)
returns text
language plpgsql
volatile
as $fn$
begin
  return public.generate_waybill_code();
end;
$fn$;

update public."Event_Attendees"
set "Waybill_Code" = upper(trim("Waybill_Code"))
where public.is_waybill_code("Waybill_Code");

update public."Hair_Submission_Bundles"
set "Bundle_Waybill_Code" = upper(trim("Bundle_Waybill_Code"))
where public.is_waybill_code("Bundle_Waybill_Code");

update public."Event_Attendees" ea
set "Waybill_Code" = public.generate_waybill_code()
where not public.is_waybill_code(ea."Waybill_Code");

update public."Hair_Submission_Bundles" hb
set "Bundle_Waybill_Code" = public.generate_waybill_code()
where hb."Bundle_Waybill_Code" is not null
  and not public.is_waybill_code(hb."Bundle_Waybill_Code");

update public."Wigs" w
set "Wig_Code" = b."Bundle_Waybill_Code"
from public."Hair_Submission_Bundles" b
where w."Bundle_ID" = b."Bundle_ID"
  and public.is_waybill_code(b."Bundle_Waybill_Code")
  and upper(trim(coalesce(w."Wig_Code", ''))) <> upper(trim(b."Bundle_Waybill_Code"));

alter table public."Event_Attendees"
  drop constraint if exists event_attendees_waybill_code_format_check;
alter table public."Event_Attendees"
  add constraint event_attendees_waybill_code_format_check
  check ("Waybill_Code" is null or public.is_waybill_code("Waybill_Code"));

alter table public."Hair_Submission_Bundles"
  drop constraint if exists hair_submission_bundles_waybill_code_format_check;
alter table public."Hair_Submission_Bundles"
  add constraint hair_submission_bundles_waybill_code_format_check
  check ("Bundle_Waybill_Code" is null or public.is_waybill_code("Bundle_Waybill_Code"));

alter table public."Hair_Submissions"
  drop column if exists "Submission_Code";

drop index if exists public."idx_Hair_Submissions_Submission_Code_unique";

commit;

