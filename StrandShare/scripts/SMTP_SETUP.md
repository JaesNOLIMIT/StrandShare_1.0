# Local SMTP Worker Setup

The Donivra SMTP worker sends rows queued in `public."SMTP_Email_Outbox"`.
It runs on this Windows computer, independently from the React development
server. Email delivery therefore continues when localhost is closed, provided
this computer is powered on, signed in, and connected to the internet.

## Private configuration

Keep credentials only in the ignored project-root file `.env.smtp.local`:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@example.com
SMTP_PASS=your-provider-app-password
SMTP_FROM_EMAIL=your-email@example.com
SMTP_FROM_NAME=Donivra
SMTP_REPLY_TO=
PUBLIC_APP_URL=https://donivra.vercel.app

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-secret

SMTP_BATCH_SIZE=25
SMTP_MAX_ATTEMPTS=5
SMTP_RETRY_BASE_MINUTES=5
SMTP_QUOTA_RETRY_HOURS=24
SMTP_DRY_RUN=false
```

Never commit this file or paste its password into documentation. For Gmail,
use a dedicated App Password and revoke it immediately if it has ever appeared
in a public repository.

## Install once

```powershell
npm run smtp:install
```

This installs a Current User Windows startup shortcut and starts the worker.
The worker checks the queue every five seconds. Useful commands:

```powershell
npm run smtp:start
npm run smtp:stop
npm run smtp:restart
npm run smtp:status
npm run smtp:templates:verify
```

Logs and PID files are written under the ignored `.run` directory.

All HTML templates are rendered inside the same responsive Donivra email
layout. The template verification command checks the branding, production
link, action button, responsive shell, and assigned-person display.

Gmail daily sending-limit responses do not consume the normal attempt budget.
Those messages remain `Pending` and are retried after
`SMTP_QUOTA_RETRY_HOURS`; they must not be reported to staff as permanently
failed. Gmail still controls when its account quota becomes available again.
