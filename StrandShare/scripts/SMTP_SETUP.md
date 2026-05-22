# SMTP Worker Setup (Gmail)

Use this to send queued emails from `public."SMTP_Email_Outbox"`.

## 1) Prepare Gmail sender

1. Use a dedicated Gmail or Google Workspace mailbox for Donivra.
2. Enable 2-Step Verification on that account.
3. Generate an App Password (16 characters).
4. Keep that password for `SMTP_PASS`.

## 2) Prepare environment variables

Create a local env file for the worker, for example `scripts/.env.smtp.local`.

Use this template:

```env
SUPABASE_URL=https:/jsveoaisfwjkdxlauucy.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzdmVvYWlzZndqa2R4bGF1dWN5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDI5NDg4NiwiZXhwIjoyMDg5ODcwODg2fQ.eZkseF3gmoUGFppJGgcPTCHbDVyURxRjxrSd8B9BhiI

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=suriagaadrian@gmail.com
SMTP_PASS=dvsk ixhd zjva juaq
SMTP_FROM_EMAIL=suriagaadrian@gmail.com
SMTP_FROM_NAME=Donivra
SMTP_REPLY_TO=<optional-reply-address>

SMTP_BATCH_SIZE=25
SMTP_MAX_ATTEMPTS=5
SMTP_RETRY_BASE_MINUTES=5
SMTP_DRY_RUN=false
```

Notes:
- `SMTP_SECURE=false` for port `587` (STARTTLS).
- If you use port `465`, set `SMTP_SECURE=true`.

## 3) Run once (manual test)

From project root:

```powershell
$env:SUPABASE_URL="https://<your-project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
$env:SMTP_HOST="smtp.gmail.com"
$env:SMTP_PORT="587"
$env:SMTP_SECURE="false"
$env:SMTP_USER="<your-gmail-address>"
$env:SMTP_PASS="<gmail-app-password>"
$env:SMTP_FROM_EMAIL="<your-gmail-address>"
$env:SMTP_FROM_NAME="Donivra"
npm run smtp:worker:once
```

If you want to validate without sending real emails:

```powershell
npm run smtp:worker:once -- --dry-run
```

## 4) Run continuously (worker mode)

```powershell
npm run smtp:worker:loop
```

Optional custom interval:

```powershell
node scripts/processSmtpOutbox.mjs --loop --interval=30
```

## 5) Production recommendation

Run this worker as a background service (PM2, Windows Task Scheduler, systemd, container, etc.) so queued notifications are delivered automatically.


