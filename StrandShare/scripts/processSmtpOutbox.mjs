import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TABLE_NAME = 'SMTP_Email_Outbox';
const TEMPLATE_DIR = path.resolve(process.cwd(), 'supabase', 'email_templates');
const templateCache = new Map();

function readEnv(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function requireEnv(name, fallback = '') {
  const value = readEnv(name, fallback);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function toUtc8SqlTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const utcMilliseconds = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  const utc8Date = new Date(utcMilliseconds + (8 * 60 * 60 * 1000));
  return utc8Date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function normalizePreferredContactLabel(value) {
  const key = normalizeKey(value);
  if (key === 'phonecall' || key === 'phone' || key === 'call') return 'Phone Call';
  if (key === 'messenger') return 'Messenger';
  if (key === 'sms') return 'SMS';
  return 'Email';
}

function formatDate(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toJoinedAddress(payload) {
  const parts = [
    payload?.street,
    payload?.barangay,
    payload?.city ?? payload?.city_municipality,
    payload?.province,
    payload?.region,
    payload?.country,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  return parts.join(', ') || 'N/A';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function textToHtml(text) {
  return `<div style="font-family:Arial,sans-serif;line-height:1.5;white-space:pre-line;">${escapeHtml(text)}</div>`;
}

function normalizeTemplateKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

function getTemplateHtml(templateKey) {
  const key = normalizeTemplateKey(templateKey);
  if (!key) return null;
  if (templateCache.has(key)) return templateCache.get(key);

  const filePath = path.join(TEMPLATE_DIR, `${key}.html`);
  if (!existsSync(filePath)) {
    templateCache.set(key, null);
    return null;
  }

  const template = readFileSync(filePath, 'utf8');
  templateCache.set(key, template);
  return template;
}

function getContextValue(context, keyPath) {
  const pathParts = String(keyPath || '').split('.').filter(Boolean);
  if (pathParts.length === 0) return '';
  let cursor = context;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
      return '';
    }
    cursor = cursor[part];
  }
  return cursor;
}

function isTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function renderTemplate(template, context) {
  if (!template) return '';
  let output = String(template);
  const sectionPattern = /{{\s*([#^])\s*([a-zA-Z0-9_.]+)\s*}}([\s\S]*?){{\s*\/\s*\2\s*}}/g;

  // Resolve section/inverted blocks repeatedly to support nesting.
  for (let i = 0; i < 20; i += 1) {
    if (!sectionPattern.test(output)) break;
    sectionPattern.lastIndex = 0;
    output = output.replace(sectionPattern, (fullMatch, sectionType, key, inner) => {
      const value = getContextValue(context, key);
      const truthy = isTruthy(value);

      if (sectionType === '#') {
        if (!truthy) return '';
        if (Array.isArray(value)) {
          return value
            .map((item) => {
              const scopedContext = item && typeof item === 'object'
                ? { ...context, ...item }
                : { ...context, '.': item };
              return renderTemplate(inner, scopedContext);
            })
            .join('');
        }
        if (value && typeof value === 'object') {
          return renderTemplate(inner, { ...context, ...value });
        }
        return renderTemplate(inner, context);
      }

      // Inverted section
      return truthy ? '' : renderTemplate(inner, context);
    });
  }

  return output.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (fullMatch, key) => {
    const value = getContextValue(context, key);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
    return escapeHtml(String(value));
  });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|td|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&mdash;/g, '—')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTemplateContext(row, payload) {
  const context = { ...(payload && typeof payload === 'object' ? payload : {}) };
  context.notification_type = row?.Notification_Type || '';
  context.template_key = row?.Template_Key || '';
  context.recipient_email = row?.Recipient_Email || '';

  // Display-friendly values for templates.
  context.preferred_contact_method = normalizePreferredContactLabel(context.preferred_contact_method || context.preferred_contact_method_label || '');
  if (context.country) {
    context.country = String(context.country).toUpperCase();
  }
  if (context.event_visibility) {
    context.event_visibility = normalizeKey(context.event_visibility) === 'private' ? 'Private' : 'Public';
  }

  const dateKeys = [
    'proposed_start_at',
    'proposed_end_at',
    'submitted_at',
    'start_date',
    'end_date',
    'staff_contacted_at',
    'admin_reviewed_at',
    'private_event_code_sent_at',
  ];
  for (const key of dateKeys) {
    const raw = context[key];
    if (!raw) continue;
    const formatted = formatDate(raw);
    context[key] = formatted;
    context[`${key}_formatted`] = formatted;
  }

  return context;
}

function buildEmailContent(row) {
  const payload = row?.Payload && typeof row.Payload === 'object' ? row.Payload : {};
  const notificationKey = normalizeKey(row?.Notification_Type);
  const subject = String(row?.Subject || '').trim() || 'Event Application Update';

  const templateHtml = getTemplateHtml(row?.Template_Key);
  if (templateHtml) {
    const templateContext = buildTemplateContext(row, payload);
    const html = renderTemplate(templateHtml, templateContext);
    const text = htmlToText(html);
    return { subject, text, html };
  }

  let lines = [];

  if (notificationKey === 'eventapplicationreceived') {
    lines = [
      'Your event application was received successfully.',
      '',
      `Event: ${payload.event_name || 'N/A'}`,
      `Proposed Start: ${formatDate(payload.proposed_start_at)}`,
      `Proposed End: ${formatDate(payload.proposed_end_at)}`,
      `Expected Attendees: ${payload.expected_attendees ?? 'N/A'}`,
      `Venue: ${payload.venue_address || toJoinedAddress(payload)}`,
      '',
      String(payload.message || 'Our staff will contact you using your preferred contact method.'),
    ];
  } else if (notificationKey === 'staffrejected') {
    lines = [
      'Your event application was not approved by staff.',
      '',
      `Event: ${payload.event_name || 'N/A'}`,
      `Proposed Start: ${formatDate(payload.proposed_start_at)}`,
      `Proposed End: ${formatDate(payload.proposed_end_at)}`,
      `Expected Attendees: ${payload.expected_attendees ?? 'N/A'}`,
      `Venue: ${payload.venue_address || toJoinedAddress(payload)}`,
      `Reason: ${payload.staff_rejection_reason || 'No reason provided'}`,
      '',
      'You may submit again with updated details.',
    ];
  } else if (notificationKey === 'staffendorsedpendingadmin') {
    lines = [
      'Your event application passed staff review and is now pending admin decision.',
      '',
      `Event: ${payload.event_name || 'N/A'}`,
      `Proposed Start: ${formatDate(payload.proposed_start_at)}`,
      `Proposed End: ${formatDate(payload.proposed_end_at)}`,
      `Expected Attendees: ${payload.expected_attendees ?? 'N/A'}`,
      `Venue: ${payload.venue_address || toJoinedAddress(payload)}`,
      `Reference IDs: EA-${payload.event_application_id || 'N/A'} / ER-${payload.linked_event_request_id || 'N/A'}`,
      '',
      String(payload.message || 'Our staff will contact you through your selected contact method.'),
    ];
  } else if (notificationKey === 'adminapproved') {
    const visibilityKey = normalizeKey(payload.event_visibility || '');
    const isPrivate = visibilityKey === 'private';
    lines = [
      'Your event request has been approved by admin.',
      '',
      `Event: ${payload.event_name || 'N/A'}`,
      `Event Type: ${isPrivate ? 'Private' : 'Public'}`,
      `Start: ${formatDate(payload.start_date)}`,
      `End: ${formatDate(payload.end_date)}`,
      `Venue Name: ${payload.venue_name || 'N/A'}`,
      `Venue Address: ${toJoinedAddress(payload)}`,
      `Event By: ${payload.event_by || 'N/A'}`,
      `Partnered With: ${payload.partnered_with || 'N/A'}`,
      `Partner Social: ${payload.partner_social_media_link || 'N/A'}`,
      '',
      String(payload.message || 'Our team will contact you with final publication details.'),
    ];
    if (isPrivate) {
      lines.push(`Private Event Code: ${payload.private_event_code || 'N/A'}`);
      lines.push('Keep this code secure. It will be used for private event access in the mobile app.');
    }
  } else if (notificationKey === 'adminrejected') {
    lines = [
      'Your event request was reviewed by admin and was not approved.',
      '',
      `Event: ${payload.event_name || 'N/A'}`,
      `Reason: ${payload.admin_decision_reason || 'No reason provided'}`,
      '',
      String(payload.message || 'You may coordinate with staff for possible adjustments.'),
    ];
  } else {
    lines = [
      'Event application notification.',
      '',
      `Type: ${row?.Notification_Type || 'N/A'}`,
      '',
      JSON.stringify(payload, null, 2),
    ];
  }

  const text = lines.join('\n');
  const html = textToHtml(text);
  return { subject, text, html };
}

function loadWorkerEnv(envFileHint = '') {
  const candidates = [];
  const fromEnv = readEnv('SMTP_ENV_FILE');

  if (envFileHint) candidates.push(envFileHint);
  if (fromEnv && fromEnv !== envFileHint) candidates.push(fromEnv);

  candidates.push('.env.smtp.local', 'scripts/.env.smtp.local');

  for (const relativeOrAbsolutePath of candidates) {
    const absolutePath = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.resolve(process.cwd(), relativeOrAbsolutePath);

    if (!existsSync(absolutePath)) {
      continue;
    }

    loadDotenv({
      path: absolutePath,
      override: false,
    });

    console.log(`[SMTP] Loaded env file: ${absolutePath}`);
    return absolutePath;
  }

  console.log('[SMTP] No .env.smtp.local file found. Using current process environment variables.');
  return '';
}

function parseArgs(argv) {
  let intervalSeconds = 45;
  let envFile = '';
  let loop = false;
  let dryRunFlag = false;

  for (const arg of argv.slice(2)) {
    if (arg === '--loop') {
      loop = true;
      continue;
    }

    if (arg === '--dry-run') {
      dryRunFlag = true;
      continue;
    }

    if (arg.startsWith('--interval=')) {
      intervalSeconds = toPositiveInt(arg.split('=')[1], 45);
      continue;
    }

    if (arg.startsWith('--env-file=')) {
      envFile = String(arg.split('=')[1] || '').trim();
    }
  }

  return {
    loop,
    intervalSeconds,
    dryRunFlag,
    envFile,
  };
}

function createTransport() {
  const host = requireEnv('SMTP_HOST', 'smtp.gmail.com');
  const port = toPositiveInt(readEnv('SMTP_PORT', '587'), 587);
  const secure = toBool(readEnv('SMTP_SECURE', port === 465 ? 'true' : 'false'));
  const user = requireEnv('SMTP_USER');
  const pass = requireEnv('SMTP_PASS');

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function createSupabaseAdminClient() {
  const supabaseUrl = requireEnv('SUPABASE_URL', readEnv('REACT_APP_SUPABASE_URL'));
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function claimRow(supabase, rowId) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      Status: 'Processing',
      Updated_At: toUtc8SqlTimestamp(),
    })
    .eq('SMTP_Email_Outbox_ID', rowId)
    .in('Status', ['Pending', 'Failed'])
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`Claim failed for outbox row ${rowId}: ${error.message}`);
  }
  return data || null;
}

async function updateRowAfterSend(supabase, row, values) {
  const { error } = await supabase
    .from(TABLE_NAME)
    .update(values)
    .eq('SMTP_Email_Outbox_ID', row.SMTP_Email_Outbox_ID);

  if (error) {
    throw new Error(`Update failed for outbox row ${row.SMTP_Email_Outbox_ID}: ${error.message}`);
  }
}

function nextAttemptDate(attemptCount, baseMinutes) {
  const multiplier = 2 ** Math.max(0, attemptCount - 1);
  const waitMinutes = Math.max(1, baseMinutes * multiplier);
  return toUtc8SqlTimestamp(new Date(Date.now() + waitMinutes * 60 * 1000));
}

async function processBatch({
  supabase,
  transporter,
  fromEmail,
  fromName,
  replyTo,
  batchSize,
  maxAttempts,
  retryBaseMinutes,
  dryRun,
}) {
  const nowIso = toUtc8SqlTimestamp();

  let query = supabase
    .from(TABLE_NAME)
    .select('*')
    .in('Status', ['Pending', 'Failed'])
    .lte('Next_Attempt_At', nowIso)
    .order('Next_Attempt_At', { ascending: true })
    .order('SMTP_Email_Outbox_ID', { ascending: true })
    .limit(batchSize);

  if (maxAttempts > 0) {
    query = query.lt('Attempt_Count', maxAttempts);
  }

  const { data: queuedRows, error: queueError } = await query;
  if (queueError) {
    throw new Error(`Failed to read outbox: ${queueError.message}`);
  }

  const rows = Array.isArray(queuedRows) ? queuedRows : [];
  if (rows.length === 0) {
    console.log(`[SMTP] No pending rows at ${new Date().toISOString()}.`);
    return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  }

  console.log(`[SMTP] Processing ${rows.length} queued row(s)...`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    let claimedRow = null;
    try {
      claimedRow = await claimRow(supabase, row.SMTP_Email_Outbox_ID);
    } catch (error) {
      skipped += 1;
      console.error(`[SMTP] ${error.message}`);
      continue;
    }

    if (!claimedRow) {
      skipped += 1;
      continue;
    }

    const attemptCount = Number(claimedRow.Attempt_Count || 0) + 1;
    const { subject, text, html } = buildEmailContent(claimedRow);

    try {
      if (dryRun) {
        console.log(`[SMTP][DRY-RUN] Would send to ${claimedRow.Recipient_Email} | ${subject}`);
      } else {
        await transporter.sendMail({
          from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
          to: claimedRow.Recipient_Email,
          replyTo: replyTo || undefined,
          subject,
          text,
          html,
        });
      }

      await updateRowAfterSend(supabase, claimedRow, {
        Status: 'Sent',
        Attempt_Count: attemptCount,
        Last_Error: null,
        Sent_At: toUtc8SqlTimestamp(),
        Next_Attempt_At: toUtc8SqlTimestamp(),
      });

      sent += 1;
      console.log(`[SMTP] Sent row ${claimedRow.SMTP_Email_Outbox_ID} to ${claimedRow.Recipient_Email}`);
    } catch (error) {
      const nextStatus = maxAttempts > 0 && attemptCount >= maxAttempts ? 'Cancelled' : 'Failed';
      const nextAttemptAt = nextStatus === 'Cancelled'
        ? toUtc8SqlTimestamp()
        : nextAttemptDate(attemptCount, retryBaseMinutes);

      try {
        await updateRowAfterSend(supabase, claimedRow, {
          Status: nextStatus,
          Attempt_Count: attemptCount,
          Last_Error: String(error?.message || error || 'SMTP send failed').slice(0, 4000),
          Next_Attempt_At: nextAttemptAt,
        });
      } catch (updateError) {
        console.error(`[SMTP] ${updateError.message}`);
      }

      failed += 1;
      console.error(`[SMTP] Failed row ${claimedRow.SMTP_Email_Outbox_ID}: ${error?.message || error}`);
    }
  }

  return {
    processed: rows.length,
    sent,
    failed,
    skipped,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  loadWorkerEnv(args.envFile);
  const dryRun = args.dryRunFlag || toBool(readEnv('SMTP_DRY_RUN', 'false'));

  const batchSize = toPositiveInt(readEnv('SMTP_BATCH_SIZE', '25'), 25);
  const maxAttempts = toPositiveInt(readEnv('SMTP_MAX_ATTEMPTS', '5'), 5);
  const retryBaseMinutes = toPositiveInt(readEnv('SMTP_RETRY_BASE_MINUTES', '5'), 5);
  const fromEmail = requireEnv('SMTP_FROM_EMAIL', readEnv('SMTP_USER'));
  const fromName = readEnv('SMTP_FROM_NAME', 'Donivra');
  const replyTo = readEnv('SMTP_REPLY_TO', '');

  const supabase = createSupabaseAdminClient();
  const transporter = createTransport();

  if (!dryRun) {
    await transporter.verify();
    console.log('[SMTP] Transport verified.');
  } else {
    console.log('[SMTP] DRY RUN mode enabled.');
  }

  const execute = async () => {
    const summary = await processBatch({
      supabase,
      transporter,
      fromEmail,
      fromName,
      replyTo,
      batchSize,
      maxAttempts,
      retryBaseMinutes,
      dryRun,
    });

    console.log(
      `[SMTP] Batch summary | processed=${summary.processed} sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}`,
    );
  };

  if (!args.loop) {
    await execute();
    return;
  }

  console.log(`[SMTP] Loop mode enabled. Interval: ${args.intervalSeconds}s`);
  while (true) {
    try {
      await execute();
    } catch (error) {
      console.error(`[SMTP] Loop iteration failed: ${error?.message || error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

run().catch((error) => {
  console.error(`[SMTP] Fatal error: ${error?.message || error}`);
  process.exit(1);
});

