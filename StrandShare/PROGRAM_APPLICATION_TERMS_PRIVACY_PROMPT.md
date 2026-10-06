# Prompt: Program Application Terms and Privacy Notice

Copy the prompt below into a capable legal-drafting assistant. Replace every
`[BRACKETED PLACEHOLDER]` with verified organization information before use.
The generated documents must be reviewed by a Philippine privacy lawyer or
qualified Data Protection Officer before publication.

---

You are a Philippine technology, nonprofit, events, and data-privacy legal
drafting specialist. Draft production-ready legal text for Donivra's online
hair-donation program application. Use clear, plain English suitable for the
general Philippine public. Do not invent facts, legal bases, registrations,
certifications, guarantees, or contact details. Mark unresolved information as
`[TO COMPLETE: ...]` and include a final missing-information checklist.

Before drafting, verify the current law using authoritative Philippine sources,
especially Republic Act No. 10173 (Data Privacy Act of 2012), its Implementing
Rules and Regulations, and current National Privacy Commission circulars and
guidance. Cite the official source links in drafting notes, but keep the public
documents readable. State that final legal review is required.

Organization facts:

- Platform/brand: Donivra (repository name: StrandShare)
- Personal Information Controller legal name: [LEGAL ENTITY NAME]
- Registered/business address: [FULL ADDRESS]
- General contact email and phone: [CONTACT DETAILS]
- Data Protection Officer/privacy contact: [DPO NAME OR TITLE, EMAIL, ADDRESS]
- Program purpose: receive, assess, approve, schedule, operate, and document
  hair-donation programs and communicate with program applicants/organizers.
- Applicants must be at least 18 years old.
- Systems/processors currently used: Supabase for database, authentication,
  private file storage, and Edge Functions; Didit for identity verification;
  [SMTP/EMAIL PROVIDER]; [HOSTING PROVIDER]; [OTHER PROCESSORS].
- Data may be processed or hosted outside the Philippines depending on the
  verified locations and contractual terms of these providers. Do not claim a
  location until verified.
- Application data collected: first, middle, and last name; email; birthdate;
  gender; mobile number; preferred contact method/detail; government ID type,
  number, image, address and other fields returned by identity verification;
  Didit verification status/session data; requesting group and social-page
  details; proposed program name, description, dates, venue/address/map
  coordinates; estimated attendance; venue/poster images; attendee-list file
  or attendee names and ages; application status, review notes, and audit
  timestamps.
- After the linked event is marked Successful, the system keeps sensitive
  applicant data for three months. It then permanently deletes the ID image,
  ID metadata/number/address, Didit verification record, birthdate, gender,
  phone/contact detail, and attendee-list file/details. Cleanup runs daily and
  may also be initiated manually by an authorized administrator, but the same
  three-month eligibility rule applies.
- Applicant name, email, application/event relationship, status, timestamps,
  certificate/communication history, and non-personal operational records are
  retained for [DEFINE AND JUSTIFY RETENTION PERIOD]. Do not describe these as
  anonymous because name and email remain personal information.
- Rejected, cancelled, withdrawn, abandoned, and never-completed applications
  require a separate retention rule: [DEFINE PERIOD AND TRIGGER]. Recommend a
  proportionate period if none is supplied, but label it for counsel approval.
- Backups, provider logs, email copies, and legal holds may follow separate
  technically necessary or legally required deletion periods, which must be
  accurately disclosed.

Produce the following distinct documents and UI text:

1. **Program Application Terms and Conditions**
   Cover eligibility and authority to apply; truthful and complete information;
   authority and notice obligations when submitting attendee information;
   venue permissions; program review and approval; no guaranteed approval or
   schedule; rescheduling, cancellation, event closure, and no-show rules;
   participant conduct and safety; hair-donation eligibility/quality review;
   health and safety disclaimer without excluding liability that cannot legally
   be excluded; organizer responsibilities; communications; certificates;
   acceptable uploads and prohibited content; intellectual-property permissions
   limited to what is necessary; photography/publicity only under separate
   optional consent; account/platform availability; suspension; complaints;
   lawful limitation of liability; indemnity only if fair and enforceable;
   severability; changes and notice; Philippine governing law; dispute/contact
   process; version and effective date.

2. **Program Application Privacy Notice**
   Clearly identify the Personal Information Controller and DPO; distinguish
   personal information from sensitive personal information; list every data
   category and whether it is required or optional; state each specific purpose;
   identify and justify the applicable lawful basis for each purpose, without
   treating the privacy notice itself as consent; explain Didit verification and
   whether any automated decision is made; identify recipients/classes of
   recipients and processors; explain international/cross-border processing;
   security safeguards at a truthful high level; give the exact retention and
   secure-deletion rules above; separately address unsuccessful applications,
   backups, logs, emails, certificates, and legal holds; explain Philippine data
   subject rights (information, access, objection, rectification, erasure or
   blocking, portability where applicable, damages, and complaint to the NPC);
   provide a request-verification and response process; explain consequences of
   not providing required data; explain how changes are notified; provide DPO
   and National Privacy Commission complaint details; include version/effective
   date.

3. **Just-in-time notices**
   Write short notices displayed immediately before:
   (a) government-ID verification through Didit,
   (b) attendee-list upload,
   (c) venue/photo upload, and
   (d) final submission.
   Each notice must say what is collected, why, who receives it, whether it is
   required, and the applicable retention trigger in concise language.

4. **Checkbox and consent design**
   Provide exact labels and validation rules. Keep these separate:
   - Required checkbox: acceptance of Terms and Conditions.
   - Required checkbox: acknowledgment that the Privacy Notice was read (do not
     mislabel mere acknowledgment as blanket consent).
   - Any consent genuinely required as a legal basis for a specified processing
     purpose must be specific, informed, evidenced, and separately worded.
   - Optional photography/publicity consent must be unticked by default and must
     not prevent application when refused.
   - Optional marketing consent must be unticked by default and separate from
     service/application emails.
   - Attendee-data declaration confirming the applicant is authorized to submit
     the information and has provided the attendee/guardian the relevant notice.
   Do not bundle unrelated purposes or use pre-checked boxes.

5. **Retention schedule table**
   For each data category, provide: purpose, lawful basis for counsel review,
   system/location, access roles, trigger, retention duration, deletion method,
   backup/log exception, and owner responsible for deletion. Explicitly include
   ID images, ID metadata, Didit records, attendee files/details, name/email,
   application history, event history, audit logs, certificates, email outbox
   and delivered-email records, backups, and rejected/cancelled/abandoned
   applications.

6. **Implementation/compliance checklist**
   Include privacy impact assessment; processor/data-processing agreements;
   vendor and hosting-location verification; role-based access; encryption;
   signed/private file access; audit logging without duplicating personal data;
   tested deletion including Storage objects and backups; incident/breach
   response; data-subject request workflow; staff confidentiality/training;
   retention-job monitoring; legal-hold override; document versioning and proof
   of acceptance; separate parental/guardian workflow if information about
   minors is allowed; and periodic review by the DPO.

Drafting constraints:

- Do not say “we may use data for any purpose,” “absolute security,” or other
  vague or misleading language.
- Do not use consent when another legal basis is intended without explaining
  the choice for counsel review.
- Do not imply that accepting Terms waives statutory privacy rights.
- Do not authorize sale of data, unrelated marketing, facial-recognition model
  training, or public attendee disclosure.
- Do not promise immediate deletion if backups or provider logs make that
  technically inaccurate; give a verified outer limit or placeholder.
- Flag whether collecting gender and every government-ID field is necessary and
  proportionate. Recommend removing fields that are not required for the stated
  purpose.
- Treat attendee names/ages, government identifiers, and ID images with enhanced
  safeguards. If minors may appear in attendee information, require a legally
  reviewed guardian/notice process and strict minimization.
- Use headings, short paragraphs, and layered notices. Target approximately an
  eighth-grade reading level without sacrificing accuracy.

Output order:

A. Assumptions and missing facts
B. Program Application Terms and Conditions
C. Program Application Privacy Notice
D. Just-in-time notices
E. Checkbox labels and validation rules
F. Retention schedule
G. Implementation/compliance checklist
H. Clauses requiring Philippine counsel/DPO approval
I. Official legal sources consulted

---
