-- Program applicants must be able to review the current wig requirements
-- before Step 1. Public access is read-only; staff/admin update rules remain.

begin;

grant select on public.wig_requirements to anon;
revoke insert, update, delete, truncate, references, trigger
  on public.wig_requirements from anon;

drop policy if exists wig_requirements_select_public
  on public.wig_requirements;

create policy wig_requirements_select_public
on public.wig_requirements
for select
to anon
using (true);

commit;
