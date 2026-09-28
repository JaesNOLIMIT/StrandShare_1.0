begin;

-- Approved, rejected, and cancelled applications are all terminal. They must
-- remain in history without preventing the applicant from submitting a new
-- program application with the same email address.
create or replace function public.check_event_application_email_active(
  p_email text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public."Event_Applications" application
    where lower(trim(coalesce(application."Applicant_Email", '')))
          = lower(trim(coalesce(p_email, '')))
      and nullif(trim(coalesce(p_email, '')), '') is not null
      and public.normalize_flow_key(application."Status") not in (
        'approved',
        'rejected',
        'cancelled'
      )
  );
$fn$;

revoke all on function public.check_event_application_email_active(text)
from public, anon, authenticated;
grant execute on function public.check_event_application_email_active(text)
to anon, authenticated;

notify pgrst, 'reload schema';
commit;
