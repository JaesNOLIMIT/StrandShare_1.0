-- 147_event_email_precheck_and_management_realtime.sql
-- Allow the public application form to check for an existing active
-- application as soon as a syntactically valid email is entered, and ensure
-- both management tables publish changes through Supabase Realtime.

begin;

create or replace function public.check_event_application_email_active(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public."Event_Applications" ea
    where lower(trim(coalesce(ea."Applicant_Email", ''))) = lower(trim(coalesce(p_email, '')))
      and nullif(trim(coalesce(p_email, '')), '') is not null
      and lower(replace(replace(replace(coalesce(ea."Status", ''), '_', ''), ' ', ''), '-', ''))
        not in ('approved', 'rejected')
  );
$fn$;

revoke all on function public.check_event_application_email_active(text) from public;
grant execute on function public.check_event_application_email_active(text) to anon, authenticated;

do $fn$
begin
  alter publication supabase_realtime add table public."Event_Applications";
exception
  when duplicate_object then null;
end;
$fn$;

do $fn$
begin
  alter publication supabase_realtime add table public."Event_Requests";
exception
  when duplicate_object then null;
end;
$fn$;

commit;
