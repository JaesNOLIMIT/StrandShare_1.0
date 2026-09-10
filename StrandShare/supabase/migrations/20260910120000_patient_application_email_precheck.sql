begin;

-- Rejected applications may apply again, but an email can have only one
-- pending/accepted application at a time. Existing patient accounts are also
-- rejected by the patient-application Edge Function before an OTP is sent.
drop index if exists public.patient_applications_one_email_idx;

create unique index if not exists patient_applications_one_active_email_idx
  on public."Patient_Applications" (lower("Applicant_Email"))
  where lower(
    replace(
      replace(
        replace(coalesce("Status", ''), '*', ''),
        ' ',
        ''
      ),
      '-',
      ''
    )
  ) in ('submitted', 'accepted');

comment on index public.patient_applications_one_active_email_idx is
  'Allows a rejected applicant to reapply while preventing concurrent or already accepted applications for the same email.';

notify pgrst, 'reload schema';
commit;
