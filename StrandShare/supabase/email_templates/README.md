# Event Workflow Email Templates

HTML templates rendered by the SMTP worker that drains the
`public."SMTP_Email_Outbox"` table. Each file here corresponds to a single
`Template_Key` enqueued by the workflow triggers.

## File naming

```
<template_key>.html
```

The file basename **must** match the `Template_Key` value passed to
`enqueue_smtp_email_outbox(...)` in the SQL trigger functions.

## Templates

| Template Key                          | Sent When                                                                          | SQL source                                                       |
|---------------------------------------|------------------------------------------------------------------------------------|------------------------------------------------------------------|
| `event_application_received`          | Applicant submits the public Event Application form (after INSERT).               | `083_event_application_received_smtp_receipt.sql`                |
| `event_staff_endorsed_pending_admin`  | Staff endorses the application by creating an Event_Request (status → Pending Admin Decision). | `076_remove_admin_fields_from_event_applications_and_use_utc8_timestamps.sql` |
| `event_staff_rejected`                | Staff rejects the application at intake.                                          | `076_remove_admin_fields_from_event_applications_and_use_utc8_timestamps.sql` |
| `event_admin_approved`                | Admin approves the linked Event_Request.                                          | `076_remove_admin_fields_from_event_applications_and_use_utc8_timestamps.sql` |
| `event_admin_rejected`                | Admin rejects the linked Event_Request.                                           | `076_remove_admin_fields_from_event_applications_and_use_utc8_timestamps.sql` |
| `event_auto_cancelled`                | Staff/Admin review is unfinished when the proposed start time arrives.             | `20260908130000_cancel_unfinished_event_applications_at_start.sql` |

## Variable interpolation

Placeholders use `{{variable_name}}` syntax matching the keys in the
`Payload` JSONB column of `SMTP_Email_Outbox`. The SMTP worker is responsible
for substitution. Conditional blocks use:

```
{{#variable_name}}...{{/variable_name}}   <!-- shown when truthy -->
{{^variable_name}}...{{/variable_name}}   <!-- shown when falsy/missing -->
```

This matches Mustache/Handlebars conventions. If your SMTP worker uses a
different engine (Go templates, Liquid, etc.), keep the variable *names*
identical and adapt the placeholder syntax accordingly.

## Common variables

All event templates receive these from the payload JSONB:

- `event_name`, `event_overview`
- `proposed_start_at`, `proposed_end_at`, `expected_attendees`
- `venue_address`, `street`, `barangay`, `city`, `province`, `region`, `country`
- `preferred_contact_method`, `preferred_contact_detail`
- `message` — free-form body text that gives the canonical wording for the
  specific notification (already localized in the SQL trigger).

Template-specific extras are documented inline in each file's header
comment.
