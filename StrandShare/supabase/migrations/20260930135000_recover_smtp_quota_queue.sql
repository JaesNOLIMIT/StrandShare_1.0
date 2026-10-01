-- Keep Gmail quota-delayed messages visibly queued and recover old rows.

begin;

update public."SMTP_Email_Outbox"
set
  "Status" = 'Pending',
  "Attempt_Count" = 0,
  "Updated_At" = timezone('Asia/Manila', now())
where public.normalize_flow_key(coalesce("Status", '')) in ('failed', 'cancelled')
  and (
    coalesce("Last_Error", '') ilike '%daily user sending limit exceeded%'
    or coalesce("Last_Error", '') ilike '%daily sending quota exceeded%'
    or coalesce("Last_Error", '') ilike '%daily recipient quota exceeded%'
    or (
      coalesce("Last_Error", '') ilike '%quota%'
      and coalesce("Last_Error", '') ilike '%exceed%'
    )
  );

comment on table public."SMTP_Email_Outbox" is
  'Transactional email queue. Pending rows may include messages delayed until an SMTP provider quota resets.';

notify pgrst, 'reload schema';

commit;
