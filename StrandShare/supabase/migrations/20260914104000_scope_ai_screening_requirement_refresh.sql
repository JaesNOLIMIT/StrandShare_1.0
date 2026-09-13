begin;

-- Requirement changes intentionally re-evaluate every AI screening. The
-- original trigger performed that refresh with an UPDATE that had no WHERE
-- clause, so databases using the safe-update guard rejected the entire save.
-- Keep the same recalculation behavior while explicitly scoping every row by
-- the non-null primary key.
create or replace function public.refresh_ai_screening_decisions_after_requirement_change()
returns trigger
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $fn$
begin
  update public."AI_Screenings" screening
  set "Decision" = screening."Decision"
  where screening."AI_Screening_ID" is not null;

  return null;
end;
$fn$;

comment on function public.refresh_ai_screening_decisions_after_requirement_change() is
  'Re-evaluates AI screening decisions after requirements change using a safe-update-compatible primary-key scope.';

notify pgrst, 'reload schema';
commit;
