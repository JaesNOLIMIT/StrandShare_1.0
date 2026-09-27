# Email Delivery Setup

Donivra has two separate email paths:

1. Supabase Auth sends confirmation, recovery, invitation, magic-link, and OTP
   emails. With custom SMTP disabled, Supabase uses its restricted default
   mailer.
2. `public."SMTP_Email_Outbox"` stores Donivra application notifications such
   as walk-in QR codes, event results, status updates, and certificates. These
   require the optional Node SMTP worker and are not sent by Supabase's default
   Auth mailer.

## Current mode: Supabase default Auth mailer

No SMTP password is stored in this repository. The default Auth mailer is for
development and testing only. It sends only to email addresses belonging to
members of the Supabase organization and is subject to a very low rate limit.
Custom Donivra notifications remain queued until a private SMTP worker is
configured.

## Optional custom outbox worker

If a transactional provider is added later, copy `.env.smtp.example` to
`.env.smtp.local`. The local file is ignored by Git. Never put real passwords,
API keys, or service-role keys in this guide or any tracked file.

The worker accepts `SUPABASE_SECRET_KEY` (recommended) and retains
`SUPABASE_SERVICE_ROLE_KEY` only as a legacy fallback. Use a separate,
revocable secret key created specifically for the outbox worker.

Run one batch:

```powershell
npm run smtp:worker:once
```

Run continuously:

```powershell
npm run smtp:worker:loop
```

The normal `npm start` command launches the SMTP helper only when a private
SMTP environment file or process-level SMTP credentials are present.
