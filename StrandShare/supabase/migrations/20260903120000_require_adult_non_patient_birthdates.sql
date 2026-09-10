begin;

-- Event organizers must be adults. Existing event applications remain valid,
-- while every new or edited application must include an adult birthdate.
alter table public."Event_Applications"
  add column if not exists "Applicant_Birthdate" date;

create or replace function public.enforce_adult_event_applicant()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new."Applicant_Birthdate" is null then
    raise exception 'Applicant birthdate is required';
  end if;

  if new."Applicant_Birthdate" > (timezone('Asia/Manila', now())::date - interval '18 years')::date then
    raise exception 'The event applicant must be at least 18 years old';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_enforce_adult_event_applicant on public."Event_Applications";
create trigger trg_enforce_adult_event_applicant
before insert or update of "Applicant_Birthdate"
on public."Event_Applications"
for each row execute function public.enforce_adult_event_applicant();

-- Account holders must also be adults. Patient profiles are explicitly
-- exempt because a patient can be a child and uses the same user_details table.
create or replace function public.enforce_adult_non_patient_user_details()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_role text;
begin
  if new.birthdate is null then return new; end if;

  select public.normalize_app_role(account.role)
  into v_role
  from public.users account
  where account.user_id = new.user_id;

  if coalesce(v_role, '') <> 'patient'
    and new.birthdate > (timezone('Asia/Manila', now())::date - interval '18 years')::date
  then
    raise exception 'Account holders must be at least 18 years old';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_enforce_adult_non_patient_user_details on public.user_details;
create trigger trg_enforce_adult_non_patient_user_details
before insert or update of birthdate, user_id
on public.user_details
for each row execute function public.enforce_adult_non_patient_user_details();

notify pgrst, 'reload schema';
commit;
