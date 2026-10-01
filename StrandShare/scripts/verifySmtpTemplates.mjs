import { readdirSync } from 'node:fs';
import path from 'node:path';
import { buildEmailContent } from './processSmtpOutbox.mjs';

const templateDirectory = path.resolve(process.cwd(), 'supabase', 'email_templates');
const templateKeys = readdirSync(templateDirectory)
  .filter((name) => name.endsWith('.html'))
  .map((name) => name.replace(/\.html$/i, ''));

const failures = [];
for (const templateKey of templateKeys) {
  const { html } = buildEmailContent({
    Notification_Type: templateKey,
    Template_Key: templateKey,
    Recipient_Email: 'preview@example.com',
    Subject: 'Donivra notification preview',
    Source_ID: 1,
    Payload: {
      recipient_name: 'Sample Recipient',
      applicant_first_name: 'Sample',
      applicant_last_name: 'Recipient',
      assigned_staff_name: 'Adrian Staff',
      event_name: 'Sample Program',
      program_name: 'Sample Program',
      event_request_id: 1,
      event_application_id: 1,
      waybill_code: 'WB123456',
      message: 'This is a Donivra notification preview.',
    },
  });

  const checks = [
    ['brand', html.includes('DONIVRA')],
    ['no website button', !html.includes('Open Donivra') && !html.includes('Go To Login')],
    ['no website link', !html.includes('https://donivra.vercel.app')],
    ['responsive shell', html.includes('max-width:640px')],
    ['assigned person', html.includes('Adrian Staff')],
  ];
  for (const [label, passed] of checks) {
    if (!passed) failures.push(`${templateKey}: missing ${label}`);
  }
}

if (failures.length > 0) {
  throw new Error(`SMTP template verification failed:\n${failures.join('\n')}`);
}

console.log(`Verified ${templateKeys.length} SMTP templates with the shared Donivra layout.`);
