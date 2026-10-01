import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TABLE_NAME = 'SMTP_Email_Outbox';
const TEMPLATE_DIR = path.resolve(process.cwd(), 'supabase', 'email_templates');
const templateCache = new Map();
let quotaBlockedUntilMs = 0;

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

function isDailySendingLimitError(error) {
  const details = [error?.message, error?.response, error?.responseCode, error?.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return details.includes('daily user sending limit exceeded')
    || details.includes('daily sending quota exceeded')
    || details.includes('daily recipient quota exceeded')
    || (details.includes('quota') && details.includes('exceed'));
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
  // Date#getTime() is already UTC. Add eight hours directly so the SQL
  // timestamp is the Philippine wall-clock time regardless of host timezone.
  const utc8Date = new Date(date.getTime() + (8 * 60 * 60 * 1000));
  return utc8Date.toISOString().slice(0, 19).replace('T', ' ');
}

function quotaRetryDate(hours) {
  return toUtc8SqlTimestamp(new Date(Date.now() + (hours * 60 * 60 * 1000)));
}

function parseDatabaseTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  // The current schema stores Philippine wall-clock values in timestamp
  // columns without a zone. Attach +08:00 explicitly so a worker running in
  // another Windows timezone does not shift the displayed event time.
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = raw.replace(' ', 'T');
  const parsed = new Date(hasZone ? normalized : `${normalized}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  const parsed = parseDatabaseTimestamp(value);
  if (!parsed) return String(value);
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
    .replaceAll('\u00c2\u00b7', ' · ')
    .replaceAll('\u00e2\u20ac\u201c', '–')
    .replaceAll('\u00e2\u20ac\u201d', '—')
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
    'reviewed_at',
    'ended_at',
    'successful_at',
    'cancelled_at',
    'certificate_issued_at',
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

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function resolveEmailPresentation(row) {
  const key = normalizeKey(row?.Notification_Type);
  if (/(reject|cancel|declin|fail)/.test(key)) {
    return {
      badge: 'Decision update',
      accent: '#b42318',
      soft: '#fff1f0',
      border: '#fecaca',
    };
  }
  if (/(approv|accept|success|received|ready|created|released|assigned|confirm)/.test(key)) {
    return {
      badge: 'Confirmed',
      accent: '#047857',
      soft: '#ecfdf5',
      border: '#a7f3d0',
    };
  }
  if (/(pending|review|ended|transit|repair|bundl)/.test(key)) {
    return {
      badge: 'Status update',
      accent: '#1d4ed8',
      soft: '#eff6ff',
      border: '#bfdbfe',
    };
  }
  return {
    badge: titleCase(row?.Notification_Type || 'Donivra update'),
    accent: '#5b0b16',
    soft: '#fff7f8',
    border: '#ead7da',
  };
}

function resolveAssignedPeople(context) {
  const candidates = [
    ['Assigned staff', context.assigned_staff_name],
    [
      'Assigned specialist',
      context.assigned_specialist_name || context.specialist_name,
    ],
    [
      'Reviewed by',
      context.reviewed_by_name
        || context.reviewer_name
        || context.staff_reviewer_name,
    ],
    ['Coordinator', context.coordinator_name],
    ['Account manager', context.manager_name],
    ['Hospital representative', context.representative_name],
    ['Updated by', context.cancelled_by],
    ['Issued by', context.issued_by_name],
  ];
  const seen = new Set();
  return candidates
    .map(([label, value]) => [label, String(value || '').trim()])
    .filter(([, value]) => value && !/^assigned donivra/i.test(value))
    .filter(([, value]) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function cleanEmailLines(text) {
  const footerPattern = /^(automated|official|issued by) .*donivra/i;
  return String(text || '')
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !/^(donivra|where hair becomes hope)$/i.test(line))
    .filter((line) => !footerPattern.test(line));
}

function buildProfessionalEmailHtml({ row, subject, text, context }) {
  const presentation = resolveEmailPresentation(row);
  const assignedPeople = resolveAssignedPeople(context);
  const notificationKey = normalizeKey(row?.Notification_Type);
  const lines = cleanEmailLines(text);
  const details = [];
  const paragraphs = [];
  const seenDetails = new Set();

  for (const line of lines) {
    const match = line.match(/^([^:{}]{2,42}):\s+(.+)$/);
    if (match && !/^https?$/i.test(match[1])) {
      const label = match[1].trim();
      const value = match[2].trim();
      const key = `${label.toLowerCase()}:${value.toLowerCase()}`;
      if (!seenDetails.has(key)) {
        seenDetails.add(key);
        details.push([label, value]);
      }
    } else if (
      line !== subject
      && !line.startsWith('{')
      && !line.startsWith('}')
    ) {
      paragraphs.push(line);
    }
  }

  for (const [label, value] of assignedPeople) {
    const key = `${label.toLowerCase()}:${value.toLowerCase()}`;
    if (!seenDetails.has(key)) {
      seenDetails.add(key);
      details.push([label, value]);
    }
  }

  const recipientName = String(
    context.recipient_name
      || context.applicant_name
      || context.patient_name
      || context.applicant_first_name
      || '',
  ).trim();
  const greeting = recipientName ? `Hello ${recipientName},` : 'Hello,';
  const bodyParagraphs = paragraphs
    .filter((line) => !line.toLowerCase().startsWith('hello '))
    .slice(0, 8);
  const detailRows = details
    .slice(0, 14)
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:7px 12px 7px 0;color:#64748b;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:7px 0;color:#1f2937;font-size:13px;font-weight:600;line-height:1.5;">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join('');
  const qrBlock = notificationKey === 'walkinregistrationreceived'
    ? '<div style="margin:22px 0;text-align:center;"><img src="cid:walk-in-waybill-qr" width="220" height="220" alt="Donation waybill QR" style="display:block;width:220px;height:220px;margin:0 auto;border:10px solid #fff;border-radius:16px;box-shadow:0 4px 16px rgba(15,23,42,.10);"></div>'
    : '';
  const reference = [
    context.event_request_id ? `ER-${context.event_request_id}` : '',
    context.event_application_id ? `EA-${context.event_application_id}` : '',
    context.waybill_code || '',
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f5f3f1;color:#1f2937;font-family:Segoe UI,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(subject)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f5f3f1;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;overflow:hidden;border:1px solid #e5d6d8;border-radius:18px;background:#ffffff;box-shadow:0 10px 30px rgba(66,15,22,.08);">
        <tr><td style="height:7px;background:#5b0b16;"></td></tr>
        <tr><td style="padding:22px 28px;border-bottom:1px solid #eee7e3;">
          <div style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#5b0b16;">DONIVRA</div>
          <div style="margin-top:3px;font-size:12px;color:#9a6a62;">Where Hair Becomes Hope</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <span style="display:inline-block;padding:6px 10px;border:1px solid ${presentation.border};border-radius:999px;background:${presentation.soft};color:${presentation.accent};font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(presentation.badge)}</span>
          <h1 style="margin:15px 0 10px;font-size:27px;line-height:1.25;color:#1f2937;">${escapeHtml(subject)}</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#475569;">${escapeHtml(greeting)}</p>
          ${bodyParagraphs.map((line) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#475569;">${escapeHtml(line)}</p>`).join('')}
          ${detailRows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border:1px solid ${presentation.border};border-radius:12px;background:${presentation.soft};"><tr><td style="padding:13px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${detailRows}</table></td></tr></table>` : ''}
          ${qrBlock}
        </td></tr>
        <tr><td style="padding:15px 28px;border-top:1px solid #eee7e3;background:#faf9f8;font-size:11px;line-height:1.5;color:#94a3b8;">Automated notification from Donivra${reference ? ` · ${escapeHtml(reference)}` : ''}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function safeFilePart(value, fallback = 'certificate') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);
  return cleaned || fallback;
}

function buildCertificateAttachment(row) {
  const payload = row?.Payload && typeof row.Payload === 'object' ? row.Payload : {};
  const notificationKey = normalizeKey(row?.Notification_Type);
  if (!['programsuccessfulapplicant', 'programsuccessfulattendee'].includes(notificationKey)) {
    return null;
  }

  const isProgramCertificate = notificationKey === 'programsuccessfulapplicant';
  const recipientName = String(payload.recipient_name || (isProgramCertificate ? 'Program Applicant' : 'Participant')).trim();
  const programName = String(payload.program_name || payload.event_name || 'Donivra Program').trim();
  const recipientRole = String(payload.recipient_role || 'Participant').trim();
  const staffName = String(payload.assigned_staff_name || 'Assigned Donivra Staff').trim();
  const certificateId = String(payload.certificate_id || `DONIVRA-${row?.Source_ID || 'CERT'}`).trim();
  const schedule = [formatDate(payload.start_date), formatDate(payload.end_date)].join(' - ');
  const venue = [payload.venue_name, payload.venue_address].map((value) => String(value || '').trim()).filter(Boolean).join(' - ') || 'Donivra Program Venue';
  const issuedAt = formatDate(payload.certificate_issued_at || payload.successful_at || new Date());

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const centerX = width / 2;

  doc.setProperties({
    title: isProgramCertificate ? 'Donivra Program Completion Certificate' : 'Donivra Participation Certificate',
    subject: programName,
    author: 'Donivra',
    creator: 'Donivra SMTP Certificate Service',
  });

  doc.setFillColor(250, 248, 246);
  doc.rect(0, 0, width, height, 'F');
  doc.setDrawColor(91, 11, 22);
  doc.setLineWidth(5);
  doc.rect(20, 20, width - 40, height - 40);
  doc.setDrawColor(184, 134, 74);
  doc.setLineWidth(1.2);
  doc.rect(31, 31, width - 62, height - 62);

  doc.setFillColor(91, 11, 22);
  doc.rect(31, 31, width - 62, 12, 'F');
  doc.setFillColor(184, 134, 74);
  doc.circle(66, 69, 13, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('D', 66, 73, { align: 'center' });

  doc.setTextColor(91, 11, 22);
  doc.setFontSize(21);
  doc.text('DONIVRA', centerX, 74, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(126, 91, 83);
  doc.text('WHERE HAIR BECOMES HOPE', centerX, 89, { align: 'center', charSpace: 1.5 });

  doc.setTextColor(55, 65, 81);
  doc.setFont('times', 'bold');
  doc.setFontSize(28);
  doc.text(isProgramCertificate ? 'CERTIFICATE OF PROGRAM COMPLETION' : 'CERTIFICATE OF PARTICIPATION', centerX, 137, { align: 'center' });
  doc.setDrawColor(184, 134, 74);
  doc.setLineWidth(1);
  doc.line(centerX - 150, 148, centerX + 150, 148);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(100, 116, 139);
  doc.text(isProgramCertificate ? 'This certificate is proudly presented to' : 'This certificate recognizes the participation of', centerX, 178, { align: 'center' });

  doc.setFont('times', 'bolditalic');
  doc.setFontSize(recipientName.length > 42 ? 27 : 34);
  doc.setTextColor(91, 11, 22);
  doc.text(doc.splitTextToSize(recipientName, 620), centerX, 220, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(71, 85, 105);
  const recognitionText = isProgramCertificate
    ? `for the successful completion of the Donivra program "${programName}".`
    : `for meaningful participation as a ${recipientRole} in the Donivra program "${programName}".`;
  doc.text(doc.splitTextToSize(recognitionText, 610), centerX, 264, { align: 'center', lineHeightFactor: 1.5 });

  doc.setFillColor(245, 241, 238);
  doc.roundedRect(112, 309, width - 224, 80, 8, 8, 'F');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`Schedule: ${schedule}`, centerX, 332, { align: 'center' });
  doc.text(doc.splitTextToSize(`Venue: ${venue}`, 560), centerX, 352, { align: 'center' });
  doc.text(`Successfully completed: ${issuedAt}`, centerX, 376, { align: 'center' });

  doc.setDrawColor(148, 163, 184);
  doc.line(155, 458, 335, 458);
  doc.line(width - 335, 458, width - 155, 458);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(55, 65, 81);
  doc.text(`/s/ ${staffName}`, 245, 449, { align: 'center' });
  doc.text('DONIVRA', width - 245, 449, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('Assigned Staff - Digital Confirmation', 245, 474, { align: 'center' });
  doc.text('Program Team', width - 245, 474, { align: 'center' });

  doc.setFontSize(8.5);
  doc.setTextColor(126, 91, 83);
  doc.text(`Certificate ID: ${certificateId}`, 47, height - 47);
  doc.text('Generated after final staff confirmation', width - 47, height - 47, { align: 'right' });

  const fileLabel = isProgramCertificate ? 'Program_Completion' : 'Participation';
  return {
    filename: `Donivra_${fileLabel}_${safeFilePart(recipientName)}_${safeFilePart(certificateId)}.pdf`,
    content: Buffer.from(doc.output('arraybuffer')),
    contentType: 'application/pdf',
  };
}

async function buildWaybillQrAttachment(row) {
  const notificationKey = normalizeKey(row?.Notification_Type);
  if (notificationKey !== 'walkinregistrationreceived') return null;

  const payload = row?.Payload && typeof row.Payload === 'object' ? row.Payload : {};
  const waybillCode = String(payload.waybill_code || '').trim().toUpperCase();
  if (!waybillCode) return null;

  const qrPayload = JSON.stringify({
    Payload_Type: 'Event_RSVP_Waybill',
    Event_Request_ID: Number(payload.event_request_id || 0) || null,
    Event_Attendee_ID: Number(payload.event_attendee_id || row?.Source_ID || 0) || null,
    User_ID: null,
    Waybill_Code: waybillCode,
  });
  const content = await QRCode.toBuffer(qrPayload, {
    type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 360,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
  return {
    filename: `Donivra_Waybill_${safeFilePart(waybillCode, 'walk_in')}.png`,
    content,
    contentType: 'image/png',
    cid: 'walk-in-waybill-qr',
    contentDisposition: 'inline',
  };
}

async function buildEmailAttachments(row) {
  const certificate = buildCertificateAttachment(row);
  const waybillQr = await buildWaybillQrAttachment(row);
  return [certificate, waybillQr].filter(Boolean);
}

function buildEmailContent(row) {
  const payload = row?.Payload && typeof row.Payload === 'object' ? row.Payload : {};
  const notificationKey = normalizeKey(row?.Notification_Type);
  const visibilityKey = normalizeKey(payload.event_visibility || '');
  const isPrivateApprovedProgram = notificationKey === 'adminapproved' && visibilityKey === 'private';
  const subject = notificationKey === 'adminapproved'
    ? (
      isPrivateApprovedProgram
        ? 'Private Program Approved and Published - Ready to Join'
        : 'Program Approved and Published - Ready to Join'
    )
    : (String(row?.Subject || '').trim() || 'Program Application Update');

  const templateHtml = getTemplateHtml(row?.Template_Key);
  if (templateHtml) {
    const templateContext = buildTemplateContext(row, payload);
    const renderedTemplate = renderTemplate(templateHtml, templateContext);
    const text = htmlToText(renderedTemplate);
    const html = buildProfessionalEmailHtml({
      row,
      subject,
      text,
      context: templateContext,
    });
    return { subject, text, html };
  }

  let lines = [];

  if (notificationKey === 'eventapplicationreceived') {
    lines = [
      'Your program application was received successfully.',
      '',
      `Program: ${payload.event_name || 'N/A'}`,
      `Proposed Start: ${formatDate(payload.proposed_start_at)}`,
      `Proposed End: ${formatDate(payload.proposed_end_at)}`,
      `Expected Attendees: ${payload.expected_attendees ?? 'N/A'}`,
      `Venue: ${payload.venue_address || toJoinedAddress(payload)}`,
      '',
      String(payload.message || 'Our staff will contact you using your preferred contact method.'),
    ];
  } else if (notificationKey === 'staffrejected') {
    lines = [
      payload.rejected_after_admin_decision
        ? 'Your program appeal was rejected permanently by staff.'
        : 'Your program application was not approved by staff.',
      '',
      `Program: ${payload.event_name || 'N/A'}`,
      `Proposed Start: ${formatDate(payload.proposed_start_at)}`,
      `Proposed End: ${formatDate(payload.proposed_end_at)}`,
      `Expected Attendees: ${payload.expected_attendees ?? 'N/A'}`,
      `Venue: ${payload.venue_address || toJoinedAddress(payload)}`,
      `Reason: ${payload.staff_rejection_reason || 'No reason provided'}`,
      '',
      'This application is permanently closed and cannot be reopened or appealed.',
      'Correct the issues described above, then submit a new program application. You may use the same email address.',
      'Reply to this email first if you need the staff to clarify what must be corrected.',
    ];
  } else if (notificationKey === 'staffendorsedpendingadmin') {
    lines = [
      'Your program application passed staff review and is now pending admin decision.',
      '',
      `Program: ${payload.event_name || 'N/A'}`,
      `Proposed Start: ${formatDate(payload.proposed_start_at)}`,
      `Proposed End: ${formatDate(payload.proposed_end_at)}`,
      `Expected Attendees: ${payload.expected_attendees ?? 'N/A'}`,
      `Venue: ${payload.venue_address || toJoinedAddress(payload)}`,
      `Reference IDs: EA-${payload.event_application_id || 'N/A'} / ER-${payload.linked_event_request_id || 'N/A'}`,
      '',
      String(payload.message || 'Our staff will contact you through your selected contact method.'),
    ];
  } else if (notificationKey === 'adminapproved') {
    const isPrivate = visibilityKey === 'private';
    lines = [
      'Your program has been approved by admin and is now live.',
      '',
      `Program: ${payload.event_name || 'N/A'}`,
      `Program Visibility: ${isPrivate ? 'Private' : 'Public'}`,
      `Start: ${formatDate(payload.start_date)}`,
      `End: ${formatDate(payload.end_date)}`,
      `Venue Name: ${payload.venue_name || 'N/A'}`,
      `Venue Address: ${toJoinedAddress(payload)}`,
      `Program Organizer: ${payload.event_by || 'N/A'}`,
      `Partnered With: ${payload.partnered_with || 'N/A'}`,
      `Partner Social: ${payload.partner_social_media_link || 'N/A'}`,
      '',
      'The program was automatically published in Donivra after approval.',
      'Participants can now access the program and join it.',
      'Our team may still contact you for operational coordination before the program date.',
    ];
    if (isPrivate) {
      lines.push(`Private Program Code: ${payload.private_event_code || 'N/A'}`);
      lines.push('Keep this code secure. It will be used for private program access in the mobile app.');
    }
  } else if (notificationKey === 'adminrejected') {
    lines = [
      'Your program request was reviewed by admin and was not approved.',
      '',
      `Program: ${payload.event_name || 'N/A'}`,
      `Reason: ${payload.admin_decision_reason || 'No reason provided'}`,
      '',
      String(payload.message || 'Your program request was not approved at this time.'),
      'Please wait for our staff to contact you about the next steps for an appeal.',
      'You may also email us directly at donivraproject@gmail.com if you need assistance.',
    ];
  } else {
    lines = [
      'Program application notification.',
      '',
      `Type: ${row?.Notification_Type || 'N/A'}`,
      '',
      JSON.stringify(payload, null, 2),
    ];
  }

  const text = lines.join('\n');
  const context = buildTemplateContext(row, payload);
  const html = buildProfessionalEmailHtml({ row, subject, text, context });
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
  const serviceRoleKey = requireEnv(
    'SUPABASE_SECRET_KEY',
    readEnv('SUPABASE_SERVICE_ROLE_KEY'),
  );

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

const personNameCache = new Map();

async function getPersonName(supabase, userId) {
  const id = Number(userId || 0);
  if (!Number.isInteger(id) || id <= 0) return '';
  if (personNameCache.has(id)) return personNameCache.get(id);

  const [{ data: account }, { data: details }] = await Promise.all([
    supabase.from('users').select('email').eq('user_id', id).maybeSingle(),
    supabase
      .from('user_details')
      .select('first_name,middle_name,last_name,suffix')
      .eq('user_id', id)
      .maybeSingle(),
  ]);
  const name = [
    details?.first_name,
    details?.middle_name,
    details?.last_name,
    details?.suffix,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ') || String(account?.email || '').trim();
  personNameCache.set(id, name);
  return name;
}

async function enrichEmailRow(supabase, row) {
  const payload = {
    ...(row?.Payload && typeof row.Payload === 'object' ? row.Payload : {}),
  };
  const sourceTable = String(row?.Source_Table || '').trim();
  const sourceId = Number(row?.Source_ID || 0);

  try {
    if (sourceTable === 'Event_Requests' && sourceId > 0) {
      const { data: request } = await supabase
        .from('Event_Requests')
        .select('Assigned_Staff_User_ID,Cancelled_Assigned_Staff_User_ID')
        .eq('Event_Request_ID', sourceId)
        .maybeSingle();
      const staffId = request?.Assigned_Staff_User_ID
        || request?.Cancelled_Assigned_Staff_User_ID;
      payload.assigned_staff_name = payload.assigned_staff_name
        || await getPersonName(supabase, staffId);
    }

    if (sourceTable === 'Event_Applications' && sourceId > 0) {
      const { data: application } = await supabase
        .from('Event_Applications')
        .select('Staff_Reviewer_User_ID')
        .eq('Event_Application_ID', sourceId)
        .maybeSingle();
      payload.reviewed_by_name = payload.reviewed_by_name
        || await getPersonName(supabase, application?.Staff_Reviewer_User_ID);
    }

    const linkedEventRequestId = Number(
      payload.event_request_id || payload.linked_event_request_id || 0,
    );
    if (!payload.assigned_staff_name && linkedEventRequestId > 0) {
      const { data: request } = await supabase
        .from('Event_Requests')
        .select('Assigned_Staff_User_ID,Cancelled_Assigned_Staff_User_ID')
        .eq('Event_Request_ID', linkedEventRequestId)
        .maybeSingle();
      payload.assigned_staff_name = await getPersonName(
        supabase,
        request?.Assigned_Staff_User_ID || request?.Cancelled_Assigned_Staff_User_ID,
      );
    }
  } catch (error) {
    console.warn(
      `[SMTP] Could not enrich personnel for row ${row?.SMTP_Email_Outbox_ID}: ${error?.message || error}`,
    );
  }

  return { ...row, Payload: payload };
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

async function recoverStaleProcessingRows(supabase) {
  const staleBefore = toUtc8SqlTimestamp(new Date(Date.now() - (10 * 60 * 1000)));
  const retryAt = toUtc8SqlTimestamp();
  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      Status: 'Failed',
      Last_Error: 'Recovered after the local SMTP worker stopped before completing delivery.',
      Next_Attempt_At: retryAt,
      Updated_At: retryAt,
    })
    .eq('Status', 'Processing')
    .lt('Updated_At', staleBefore);
  if (error) {
    throw new Error(`Failed to recover stale SMTP rows: ${error.message}`);
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
  quotaRetryHours,
  dryRun,
}) {
  if (quotaBlockedUntilMs > Date.now()) {
    console.log(
      `[SMTP] Sender quota cooldown is active until ${new Date(quotaBlockedUntilMs).toISOString()}.`,
    );
    return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  }

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
    console.log(`[SMTP] No queued rows are due at ${new Date().toISOString()}.`);
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
    const enrichedRow = await enrichEmailRow(supabase, claimedRow);
    const { subject, text, html } = buildEmailContent(enrichedRow);

    try {
      const attachments = await buildEmailAttachments(enrichedRow);
      if (dryRun) {
        console.log(`[SMTP][DRY-RUN] Would send to ${claimedRow.Recipient_Email} | ${subject} | ${attachments.length} attachment(s)`);
      } else {
        await transporter.sendMail({
          from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
          to: claimedRow.Recipient_Email,
          replyTo: replyTo || undefined,
          subject,
          text,
          html,
          attachments,
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
      const quotaLimited = isDailySendingLimitError(error);
      const nextStatus = quotaLimited
        ? 'Pending'
        : (maxAttempts > 0 && attemptCount >= maxAttempts ? 'Cancelled' : 'Failed');
      const nextAttemptAt = quotaLimited
        ? quotaRetryDate(quotaRetryHours)
        : (nextStatus === 'Cancelled'
          ? toUtc8SqlTimestamp()
          : nextAttemptDate(attemptCount, retryBaseMinutes));

      try {
        await updateRowAfterSend(supabase, claimedRow, {
          Status: nextStatus,
          Attempt_Count: quotaLimited ? Number(claimedRow.Attempt_Count || 0) : attemptCount,
          Last_Error: String(error?.message || error || 'SMTP send failed').slice(0, 4000),
          Next_Attempt_At: nextAttemptAt,
        });
      } catch (updateError) {
        console.error(`[SMTP] ${updateError.message}`);
      }

      failed += 1;
      console.error(`[SMTP] Failed row ${claimedRow.SMTP_Email_Outbox_ID}: ${error?.message || error}`);
      if (quotaLimited) {
        quotaBlockedUntilMs = Date.now() + (quotaRetryHours * 60 * 60 * 1000);
        const { error: deferError } = await supabase
          .from(TABLE_NAME)
          .update({
            Status: 'Pending',
            Next_Attempt_At: nextAttemptAt,
            Updated_At: toUtc8SqlTimestamp(),
          })
          .in('Status', ['Pending', 'Failed'])
          .lte('Next_Attempt_At', toUtc8SqlTimestamp());
        if (deferError) {
          console.error(
            `[SMTP] Could not defer the remaining quota-blocked queue: ${deferError.message}`,
          );
        }
        console.error(`[SMTP] Daily sender quota reached. Remaining messages stay queued until ${nextAttemptAt}.`);
        break;
      }
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
  const quotaRetryHours = toPositiveInt(readEnv('SMTP_QUOTA_RETRY_HOURS', '24'), 24);
  const fromEmail = requireEnv('SMTP_FROM_EMAIL', readEnv('SMTP_USER'));
  const fromName = readEnv('SMTP_FROM_NAME', 'Donivra');
  const replyTo = readEnv('SMTP_REPLY_TO', '');

  const supabase = createSupabaseAdminClient();
  const transporter = createTransport();
  let transportVerified = dryRun;

  if (dryRun) {
    console.log('[SMTP] DRY RUN mode enabled.');
  }

  const ensureTransport = async () => {
    if (transportVerified) return;
    await transporter.verify();
    transportVerified = true;
    console.log('[SMTP] Transport verified.');
  };

  const execute = async () => {
    await ensureTransport();
    await recoverStaleProcessingRows(supabase);
    const summary = await processBatch({
      supabase,
      transporter,
      fromEmail,
      fromName,
      replyTo,
      batchSize,
      maxAttempts,
      retryBaseMinutes,
      quotaRetryHours,
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

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  run().catch((error) => {
    console.error(`[SMTP] Fatal error: ${error?.message || error}`);
    process.exit(1);
  });
}

export { buildEmailContent, buildProfessionalEmailHtml, isDailySendingLimitError };

