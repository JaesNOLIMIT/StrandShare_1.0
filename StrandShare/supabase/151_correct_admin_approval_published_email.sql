-- Admin approval immediately publishes a program. Normalize the approval outbox
-- entry so both future and already-queued emails state that it is live and joinable.

begin;

create or replace function public.normalize_event_admin_approved_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_notification_key text;
  v_visibility_key text;
  v_message text;
begin
  v_notification_key := lower(replace(replace(replace(coalesce(new."Notification_Type", ''), '_', ''), ' ', ''), '-', ''));

  if v_notification_key <> 'adminapproved' then
    return new;
  end if;

  v_visibility_key := lower(replace(replace(replace(coalesce(new."Payload" ->> 'event_visibility', ''), '_', ''), ' ', ''), '-', ''));
  v_message := 'Your program was approved by admin and automatically published in Donivra. It is now live and ready for participants to access and join.';

  new."Subject" := case
    when v_visibility_key = 'private'
      then 'Private Program Approved and Published - Ready to Join'
    else 'Program Approved and Published - Ready to Join'
  end;
  new."Payload" := jsonb_set(
    coalesce(new."Payload", '{}'::jsonb),
    '{message}',
    to_jsonb(v_message),
    true
  );

  return new;
end;
$fn$;

drop trigger if exists trg_normalize_event_admin_approved_email
  on public."SMTP_Email_Outbox";
create trigger trg_normalize_event_admin_approved_email
before insert or update on public."SMTP_Email_Outbox"
for each row execute function public.normalize_event_admin_approved_email();

-- Correct approval messages that are still waiting to be sent or retried.
update public."SMTP_Email_Outbox"
set "Updated_At" = timezone('Asia/Manila', now())
where lower(replace(replace(replace(coalesce("Notification_Type", ''), '_', ''), ' ', ''), '-', '')) = 'adminapproved'
  and "Sent_At" is null
  and lower(replace(replace(replace(coalesce("Status", ''), '_', ''), ' ', ''), '-', '')) <> 'cancelled';

commit;
