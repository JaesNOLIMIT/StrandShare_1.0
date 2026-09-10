import { createClient } from 'npm:@supabase/supabase-js@2';

const LOCAL_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const OTP_TTL_MINUTES = 10;
const TOKEN_TTL_MINUTES = 30;
const OTP_RESEND_SECONDS = 60;
const MAX_OTP_FAILURES = 5;
const MEDICAL_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
const PATIENT_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
const PH_MOBILE_PATTERN = /^\+63 9\d{2} \d{3} \d{4}$/;
const CONDITION_CATEGORIES = new Set(['Cancer', 'Alopecia', 'Other Hair-Loss Disease']);

function getAllowedOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const configured = String(Deno.env.get('PATIENT_APPLICATION_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (LOCAL_ORIGINS.has(origin) || configured.includes(origin)) return origin;
  return '';
}

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    },
  });
}

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRole(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function randomDigits(length: number) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => String(value % 10)).join('');
}

function randomHex(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function buildTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  const randomPart = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
  return `Dn!${randomPart}9`;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

async function checkPatientEmailAvailability(
  admin: ReturnType<typeof createClient>,
  email: string,
) {
  const accountResult = await admin.from('users')
    .select('user_id')
    .ilike('email', email)
    .limit(10);
  if (accountResult.error) throw accountResult.error;

  const userIds = (accountResult.data || [])
    .map((account) => Number(account.user_id || 0))
    .filter((userId) => userId > 0);
  if (userIds.length > 0) {
    return {
      available: false,
      reason: 'existing_account',
      message: 'This email is already used by a Donivra account and cannot be used for a patient application.',
    };
  }

  const applicationResult = await admin.from('Patient_Applications')
    .select('Patient_Application_ID,Status')
    .eq('Applicant_Email', email)
    .order('Submitted_At', { ascending: false });
  if (applicationResult.error) throw applicationResult.error;

  const activeApplication = (applicationResult.data || []).find((application) => {
    const status = String(application.Status || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return status === 'submitted' || status === 'accepted';
  });
  if (activeApplication) {
    return {
      available: false,
      reason: 'active_application',
      message: 'This email already has an active patient application. Please wait for the hospital decision before applying again.',
    };
  }

  return {
    available: true,
    reason: null,
    message: 'This email can be used for a new patient application.',
  };
}

function addMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function safeFileName(value: string) {
  return String(value || 'file')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(-120) || 'file';
}

function asText(value: unknown, maxLength = 4000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function asBoolean(value: unknown) {
  if (value === true || value === 'true' || value === 'yes') return true;
  if (value === false || value === 'false' || value === 'no') return false;
  return null;
}

async function enqueueEmail(
  admin: ReturnType<typeof createClient>,
  values: {
    queueKey: string;
    sourceId?: number;
    type: string;
    recipient: string;
    subject: string;
    template: string;
    payload: Record<string, unknown>;
    createdBy?: number | null;
  },
) {
  const { error } = await admin.from('SMTP_Email_Outbox').insert({
    Queue_Key: values.queueKey.slice(0, 160),
    Source_Table: 'Patient_Applications',
    Source_ID: values.sourceId || 0,
    Notification_Type: values.type,
    Recipient_Email: values.recipient,
    Subject: values.subject,
    Template_Key: values.template,
    Payload: values.payload,
    Status: 'Pending',
    Created_By_User_ID: values.createdBy || null,
  });
  if (error && error.code !== '23505') throw error;
}

async function createPatientCode(admin: ReturnType<typeof createClient>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `PT${randomDigits(6)}`;
    const { data, error } = await admin.from('Patients').select('Patient_ID').eq('Patient_Code', candidate).maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error('Unable to generate a unique patient code. Please retry.');
}

async function uploadApplicationFile(
  admin: ReturnType<typeof createClient>,
  applicationCode: string,
  file: File,
  kind: 'patient-picture' | 'medical-document',
) {
  const maxBytes = kind === 'patient-picture' ? PATIENT_PICTURE_MAX_BYTES : MEDICAL_DOCUMENT_MAX_BYTES;
  if (file.size <= 0 || file.size > maxBytes) {
    throw new Error(`${kind === 'patient-picture' ? 'Patient picture' : 'Medical document'} exceeds the allowed file size.`);
  }
  const type = String(file.type || '').toLowerCase();
  const isImage = type.startsWith('image/');
  const isPdf = type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (kind === 'patient-picture' && !isImage) throw new Error('Patient picture must be an image.');
  if (kind === 'medical-document' && !isImage && !isPdf) {
    throw new Error('Medical document must be a PDF or image.');
  }
  const path = `applications/${applicationCode}/${kind}-${Date.now()}-${safeFileName(file.name)}`;
  const bytes = await file.arrayBuffer();
  const { error } = await admin.storage.from('patient-application-assets').upload(path, bytes, {
    contentType: file.type || (isPdf ? 'application/pdf' : 'application/octet-stream'),
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
  return path;
}

async function promoteFile(
  admin: ReturnType<typeof createClient>,
  sourcePath: string | null,
  authUserId: string,
  kind: 'patient-picture' | 'medical-document',
) {
  if (!sourcePath) return null;
  const { data, error } = await admin.storage.from('patient-application-assets').download(sourcePath);
  if (error || !data) throw error || new Error(`Unable to read ${kind}.`);
  const fileName = safeFileName(sourcePath.split('/').pop() || `${kind}.bin`);
  const destination = `${authUserId}/${kind}/${Date.now()}-${fileName}`;
  const upload = await admin.storage.from('patient_assets').upload(destination, await data.arrayBuffer(), {
    contentType: data.type || 'application/octet-stream',
    cacheControl: '3600',
    upsert: false,
  });
  if (upload.error) throw upload.error;
  return destination;
}

Deno.serve(async (request) => {
  const allowedOrigin = getAllowedOrigin(request);
  if (request.method === 'OPTIONS') {
    return allowedOrigin === ''
      ? jsonResponse({ error: 'Origin is not allowed.' }, 403, null)
      : jsonResponse({}, 200, allowedOrigin);
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, allowedOrigin || null);
  if (allowedOrigin === '') return jsonResponse({ error: 'Origin is not allowed.' }, 403, null);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Patient application service is not configured.' }, 503, allowedOrigin || null);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const contentType = String(request.headers.get('content-type') || '').toLowerCase();
    let body: Record<string, unknown> = {};
    let formData: FormData | null = null;
    if (contentType.includes('multipart/form-data')) {
      formData = await request.formData();
      body = JSON.parse(String(formData.get('payload') || '{}'));
      body.action = String(formData.get('action') || body.action || 'submit');
      body.email = String(formData.get('email') || body.email || '');
      body.submissionToken = String(formData.get('submissionToken') || body.submissionToken || '');
    } else {
      body = await request.json();
    }

    const action = String(body.action || '').trim().toLowerCase();

    if (action === 'check-email') {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400, allowedOrigin || null);
      return jsonResponse(await checkPatientEmailAvailability(admin, email), 200, allowedOrigin || null);
    }

    if (action === 'send-otp') {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400, allowedOrigin || null);

      const availability = await checkPatientEmailAvailability(admin, email);
      if (!availability.available) return jsonResponse({ error: availability.message, reason: availability.reason }, 409, allowedOrigin || null);

      const existing = await admin.from('patient_application_email_verifications')
        .select('last_sent_at').eq('email', email).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data?.last_sent_at) {
        const seconds = (Date.now() - new Date(existing.data.last_sent_at).getTime()) / 1000;
        if (seconds < OTP_RESEND_SECONDS) {
          return jsonResponse({ error: `Wait ${Math.ceil(OTP_RESEND_SECONDS - seconds)} seconds before requesting another code.` }, 429, allowedOrigin || null);
        }
      }

      const otp = randomDigits(6);
      const salt = randomHex(16);
      const otpHash = await sha256(`${salt}:${otp}`);
      const { error: verificationError } = await admin.from('patient_application_email_verifications').upsert({
        email,
        otp_hash: otpHash,
        otp_salt: salt,
        expires_at: addMinutes(OTP_TTL_MINUTES),
        last_sent_at: new Date().toISOString(),
        failed_attempts: 0,
        verified_at: null,
        submission_token_hash: null,
        submission_token_salt: null,
        token_expires_at: null,
        consumed_at: null,
      }, { onConflict: 'email' });
      if (verificationError) throw verificationError;

      await enqueueEmail(admin, {
        queueKey: `patient-application-otp:${await sha256(email)}:${Date.now()}`,
        type: 'patient_application_otp',
        recipient: email,
        subject: 'Your Donivra patient application verification code',
        template: 'patient_application_otp',
        payload: { otp_code: otp, expires_minutes: OTP_TTL_MINUTES },
      });
      return jsonResponse({ sent: true, cooldownSeconds: OTP_RESEND_SECONDS }, 200, allowedOrigin || null);
    }

    if (action === 'verify-otp') {
      const email = normalizeEmail(body.email);
      const otp = String(body.otp || '').replace(/\D/g, '').slice(0, 6);
      if (!isValidEmail(email) || otp.length !== 6) {
        return jsonResponse({ error: 'Enter the email and 6-digit verification code.' }, 400, allowedOrigin || null);
      }
      const result = await admin.from('patient_application_email_verifications').select('*').eq('email', email).maybeSingle();
      if (result.error) throw result.error;
      const verification = result.data;
      if (!verification || new Date(verification.expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: 'The verification code has expired. Request a new code.' }, 400, allowedOrigin || null);
      }
      if (Number(verification.failed_attempts || 0) >= MAX_OTP_FAILURES) {
        return jsonResponse({ error: 'Too many incorrect attempts. Request a new code.' }, 429, allowedOrigin || null);
      }
      const candidate = await sha256(`${verification.otp_salt}:${otp}`);
      if (candidate !== verification.otp_hash) {
        await admin.from('patient_application_email_verifications')
          .update({ failed_attempts: Number(verification.failed_attempts || 0) + 1 }).eq('email', email);
        return jsonResponse({ error: 'The verification code is incorrect.' }, 400, allowedOrigin || null);
      }
      const token = randomHex(32);
      const tokenSalt = randomHex(16);
      const tokenHash = await sha256(`${tokenSalt}:${token}`);
      const verifiedAt = new Date().toISOString();
      const update = await admin.from('patient_application_email_verifications').update({
        verified_at: verifiedAt,
        submission_token_hash: tokenHash,
        submission_token_salt: tokenSalt,
        token_expires_at: addMinutes(TOKEN_TTL_MINUTES),
        failed_attempts: 0,
      }).eq('email', email);
      if (update.error) throw update.error;
      return jsonResponse({ verified: true, verifiedAt, submissionToken: token, tokenExpiresMinutes: TOKEN_TTL_MINUTES }, 200, allowedOrigin || null);
    }

    if (action === 'submit') {
      const email = normalizeEmail(body.email);
      const submissionToken = String(body.submissionToken || '').trim();
      const verificationResult = await admin.from('patient_application_email_verifications')
        .select('*').eq('email', email).maybeSingle();
      if (verificationResult.error) throw verificationResult.error;
      const verification = verificationResult.data;
      if (!verification?.verified_at || verification.consumed_at || !verification.submission_token_salt
        || !verification.submission_token_hash || new Date(verification.token_expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: 'Email verification expired. Verify the email again.' }, 401, allowedOrigin || null);
      }
      const submittedTokenHash = await sha256(`${verification.submission_token_salt}:${submissionToken}`);
      if (submittedTokenHash !== verification.submission_token_hash) {
        return jsonResponse({ error: 'Email verification is invalid. Verify the email again.' }, 401, allowedOrigin || null);
      }

      const availability = await checkPatientEmailAvailability(admin, email);
      if (!availability.available) return jsonResponse({ error: availability.message, reason: availability.reason }, 409, allowedOrigin || null);

      const hospitalId = Number(body.hospitalId || 0);
      const hospitalResult = await admin.from('Hospitals').select([
        'Hospital_ID', 'Hospital_Name', 'Is_Approved', 'Approval_Status',
        'Patient_Applications_Open', 'Patient_Application_Conditions',
        'Patient_Application_Requirements', 'Patient_Application_PDF_Path',
        'Patient_Application_Settings_Updated_At',
      ].join(',')).eq('Hospital_ID', hospitalId).maybeSingle();
      if (hospitalResult.error) throw hospitalResult.error;
      const hospital = hospitalResult.data;
      if (!hospital || hospital.Is_Approved !== true || String(hospital.Approval_Status || '').toLowerCase() !== 'approved') {
        return jsonResponse({ error: 'The selected partner hospital is unavailable.' }, 400, allowedOrigin || null);
      }
      if (hospital.Patient_Applications_Open !== true) {
        return jsonResponse({ error: 'The selected hospital is not accepting patient applications.' }, 400, allowedOrigin || null);
      }
      const acceptedHospitalSettingsAt = String(body.hospitalSettingsUpdatedAt || '');
      const currentHospitalSettingsAt = String(hospital.Patient_Application_Settings_Updated_At || '');
      if (!acceptedHospitalSettingsAt || new Date(acceptedHospitalSettingsAt).getTime() !== new Date(currentHospitalSettingsAt).getTime()) {
        return jsonResponse({ error: 'The hospital conditions changed. Return to the first step and review the current requirements.' }, 409, allowedOrigin || null);
      }

      const termsId = Number(body.donivraTermsDocumentId || 0);
      const termsVersion = String(body.donivraTermsVersion || '').trim();
      const termsResult = await admin.from('legal_documents')
        .select('legal_document_id,version,is_active,effective_at')
        .eq('legal_document_id', termsId).eq('document_type', 'patient_application_terms')
        .eq('version', termsVersion).eq('is_active', true).maybeSingle();
      if (termsResult.error) throw termsResult.error;
      if (!termsResult.data || new Date(termsResult.data.effective_at).getTime() > Date.now()) {
        return jsonResponse({ error: 'Donivra terms changed. Return to the terms page and review the current version.' }, 409, allowedOrigin || null);
      }
      if (body.acceptDonivraTerms !== true || body.acceptHospitalConditions !== true) {
        return jsonResponse({ error: 'Accept both Donivra terms and the selected hospital conditions.' }, 400, allowedOrigin || null);
      }

      const required = [
        'firstName', 'lastName', 'birthdate', 'gender', 'contactNumber',
        'street', 'barangay', 'city', 'province', 'region', 'country',
        'conditionCategory', 'medicalCondition', 'dateOfDiagnosis', 'doctorName',
        'physicianContact', 'treatmentHospitalClinic', 'treatmentPlan', 'treatmentStatus',
        'guardian', 'guardianRelationship', 'guardianContactNumber',
      ];
      for (const field of required) {
        if (!String(body[field] || '').trim()) return jsonResponse({ error: `Complete the required field: ${field}.` }, 400, allowedOrigin || null);
      }
      const conditionCategory = String(body.conditionCategory || '').trim();
      if (!CONDITION_CATEGORIES.has(conditionCategory)) {
        return jsonResponse({ error: 'Select a valid medical condition.' }, 400, allowedOrigin || null);
      }
      if ((conditionCategory === 'Cancer' || conditionCategory === 'Alopecia') && !String(body.conditionStage || '').trim()) {
        return jsonResponse({ error: 'Enter the condition stage or severity.' }, 400, allowedOrigin || null);
      }
      const birthdate = new Date(`${String(body.birthdate)}T00:00:00Z`);
      const diagnosisDate = body.dateOfDiagnosis ? new Date(`${String(body.dateOfDiagnosis)}T00:00:00Z`) : null;
      if (Number.isNaN(birthdate.getTime()) || birthdate.getTime() > Date.now()) {
        return jsonResponse({ error: 'Enter a valid birthdate that is not in the future.' }, 400, allowedOrigin || null);
      }
      if (diagnosisDate && (Number.isNaN(diagnosisDate.getTime()) || diagnosisDate.getTime() > Date.now())) {
        return jsonResponse({ error: 'Date of diagnosis cannot be in the future.' }, 400, allowedOrigin || null);
      }
      if (!PH_MOBILE_PATTERN.test(String(body.contactNumber || '').trim())) {
        return jsonResponse({ error: 'Patient mobile number must use +63 912 345 6789 format.' }, 400, allowedOrigin || null);
      }
      if (!PH_MOBILE_PATTERN.test(String(body.physicianContact || '').trim())) {
        return jsonResponse({ error: 'Physician mobile number must use +63 912 345 6789 format.' }, 400, allowedOrigin || null);
      }
      const guardianContact = String(body.guardianContactNumber || '').trim();
      const secondaryGuardian = String(body.secondaryGuardian || '').trim();
      const secondaryRelationship = String(body.secondaryGuardianRelationship || '').trim();
      const secondaryContact = String(body.secondaryGuardianContactNumber || '').trim();
      if (!PH_MOBILE_PATTERN.test(guardianContact)) {
        return jsonResponse({ error: 'Guardian mobile number must use +63 912 345 6789 format.' }, 400, allowedOrigin || null);
      }
      if ([secondaryGuardian, secondaryRelationship, secondaryContact].some(Boolean)
        && [secondaryGuardian, secondaryRelationship, secondaryContact].some((value) => !value)) {
        return jsonResponse({ error: 'Complete all secondary contact fields, or leave all three blank.' }, 400, allowedOrigin || null);
      }
      if (secondaryContact && !PH_MOBILE_PATTERN.test(secondaryContact)) {
        return jsonResponse({ error: 'Secondary mobile number must use +63 912 345 6789 format.' }, 400, allowedOrigin || null);
      }
      if (secondaryContact && secondaryContact === guardianContact) {
        return jsonResponse({ error: 'Primary and secondary contacts must use different mobile numbers.' }, 400, allowedOrigin || null);
      }
      const safetyAnswers = [body.hasKnownAllergies, body.hasSensitiveScalp, body.hasScalpIrritation,
        body.hasOpenScalpWounds, body.hasMedicalRestriction];
      if (safetyAnswers.some((answer) => typeof answer !== 'boolean')) {
        return jsonResponse({ error: 'Answer every allergy and wig-safety question.' }, 400, allowedOrigin || null);
      }
      if (body.hasKnownAllergies === true && !String(body.allergyDetails || '').trim()) {
        return jsonResponse({ error: 'Enter allergy details.' }, 400, allowedOrigin || null);
      }
      if (body.hasMedicalRestriction === true && !String(body.medicalRestrictionDetails || '').trim()) {
        return jsonResponse({ error: 'Enter medical restriction details.' }, 400, allowedOrigin || null);
      }
      if (body.safetyInformationConfirmed !== true) {
        return jsonResponse({ error: 'Confirm that the safety information is complete and accurate.' }, 400, allowedOrigin || null);
      }

      const medicalDocument = formData?.get('medicalDocument');
      const patientPicture = formData?.get('patientPicture');
      if (!(medicalDocument instanceof File) || medicalDocument.size === 0) {
        return jsonResponse({ error: 'Upload the required medical document.' }, 400, allowedOrigin || null);
      }

      const applicationCode = `PA${randomDigits(8)}`;
      const uploadedPaths: string[] = [];
      try {
        const medicalPath = await uploadApplicationFile(admin, applicationCode, medicalDocument, 'medical-document');
        uploadedPaths.push(medicalPath);
        let picturePath: string | null = null;
        if (patientPicture instanceof File && patientPicture.size > 0) {
          picturePath = await uploadApplicationFile(admin, applicationCode, patientPicture, 'patient-picture');
          uploadedPaths.push(picturePath);
        }
        const now = new Date().toISOString();
        const insert = await admin.from('Patient_Applications').insert({
          Application_Code: applicationCode,
          Hospital_ID: hospitalId,
          Applicant_Email: email,
          Email_Verified_At: verification.verified_at,
          Status: 'submitted',
          Submitted_At: now,
          First_Name: asText(body.firstName, 255),
          Middle_Name: asText(body.middleName, 255),
          Last_Name: asText(body.lastName, 255),
          Suffix: asText(body.suffix, 50),
          Birthdate: asText(body.birthdate, 10),
          Gender: asText(body.gender, 20),
          Contact_Number: asText(body.contactNumber, 50),
          Street: asText(body.street, 255), Barangay: asText(body.barangay, 255),
          City: asText(body.city, 255), Province: asText(body.province, 255),
          Region: asText(body.region, 255), Country: asText(body.country, 255) || 'Philippines',
          Date_of_Diagnosis: asText(body.dateOfDiagnosis, 10),
          Condition_Category: conditionCategory,
          Medical_Condition: conditionCategory === 'Other Hair-Loss Disease'
            ? asText(body.medicalCondition, 255)
            : conditionCategory,
          Condition_Stage_Severity: asText(body.conditionStage, 255),
          Doctor_Name: asText(body.doctorName),
          Attending_Physician_Contact: asText(body.physicianContact),
          Treatment_Hospital_Clinic: asText(body.treatmentHospitalClinic),
          Treatment_Plan: asText(body.treatmentPlan),
          Current_Treatment_Status: asText(body.treatmentStatus),
          Allergies_Current_Medications: asText(body.allergiesCurrentMedications),
          Insurance_PhilHealth_Info: asText(body.insurancePhilHealthInfo),
          Clinical_Special_Note: asText(body.clinicalSpecialNote),
          Guardian: asText(body.guardian, 255),
          Guardian_Relationship: asText(body.guardianRelationship, 100),
          Guardian_Contact_Number: asText(body.guardianContactNumber, 50),
          Secondary_Guardian: asText(body.secondaryGuardian),
          Secondary_Guardian_Relationship: asText(body.secondaryGuardianRelationship),
          Secondary_Guardian_Contact_Number: asText(body.secondaryGuardianContactNumber),
          Has_Known_Allergies: asBoolean(body.hasKnownAllergies),
          Allergy_Details: asText(body.allergyDetails),
          Has_Sensitive_Scalp: asBoolean(body.hasSensitiveScalp),
          Has_Scalp_Irritation: asBoolean(body.hasScalpIrritation),
          Has_Open_Scalp_Wounds: asBoolean(body.hasOpenScalpWounds),
          Has_Medical_Restriction: asBoolean(body.hasMedicalRestriction),
          Medical_Restriction_Details: asText(body.medicalRestrictionDetails),
          Safety_Information_Confirmed: true,
          Patient_Picture_Path: picturePath,
          Medical_Document_Path: medicalPath,
          Donivra_Terms_Document_ID: termsId,
          Donivra_Terms_Version: termsVersion,
          Donivra_Terms_Accepted_At: now,
          Hospital_Conditions_Accepted_At: now,
          Hospital_Conditions_Snapshot: {
            conditions: hospital.Patient_Application_Conditions,
            requirements: hospital.Patient_Application_Requirements,
            requirements_pdf_path: hospital.Patient_Application_PDF_Path,
            settings_updated_at: hospital.Patient_Application_Settings_Updated_At,
          },
        }).select('Patient_Application_ID,Application_Code').single();
        if (insert.error) throw insert.error;

        await admin.from('patient_application_email_verifications')
          .update({ consumed_at: now }).eq('email', email);
        return jsonResponse({ submitted: true, applicationId: insert.data.Patient_Application_ID, applicationCode }, 200, allowedOrigin || null);
      } catch (error) {
        if (uploadedPaths.length) await admin.storage.from('patient-application-assets').remove(uploadedPaths);
        throw error;
      }
    }

    if (action === 'decide') {
      const authorization = request.headers.get('Authorization') || '';
      const jwt = authorization.replace(/^Bearer\s+/i, '').trim();
      if (!jwt) return jsonResponse({ error: 'Authentication required.' }, 401, allowedOrigin || null);
      const authResult = await admin.auth.getUser(jwt);
      if (authResult.error || !authResult.data.user) return jsonResponse({ error: 'Invalid or expired session.' }, 401, allowedOrigin || null);
      const actorResult = await admin.from('users').select('user_id,email,role,is_active')
        .eq('auth_user_id', authResult.data.user.id).maybeSingle();
      if (actorResult.error) throw actorResult.error;
      const actor = actorResult.data;
      if (!actor || actor.is_active === false || normalizeRole(actor.role) !== 'hrepresentative') {
        return jsonResponse({ error: 'Only an active H-Representative can decide patient applications.' }, 403, allowedOrigin || null);
      }
      const applicationId = Number(body.applicationId || 0);
      const decision = String(body.decision || '').trim().toLowerCase();
      const reason = String(body.reason || '').trim();
      if (!applicationId || !['accepted', 'rejected'].includes(decision)) {
        return jsonResponse({ error: 'Application and decision are required.' }, 400, allowedOrigin || null);
      }
      if (decision === 'rejected' && !reason) {
        return jsonResponse({ error: 'A rejection reason is required.' }, 400, allowedOrigin || null);
      }
      const applicationResult = await admin.from('Patient_Applications').select('*')
        .eq('Patient_Application_ID', applicationId).maybeSingle();
      if (applicationResult.error) throw applicationResult.error;
      const application = applicationResult.data;
      if (!application) return jsonResponse({ error: 'Application was not found.' }, 404, allowedOrigin || null);
      if (normalizeRole(application.Status) !== 'submitted') {
        return jsonResponse({ error: 'This application has already been decided.' }, 409, allowedOrigin || null);
      }
      const assignmentResult = await admin.from('Hospital_Representative').select('Link_ID')
        .eq('User_ID', actor.user_id).eq('Hospital_ID', application.Hospital_ID).maybeSingle();
      if (assignmentResult.error) throw assignmentResult.error;
      if (!assignmentResult.data) return jsonResponse({ error: 'This application belongs to another hospital.' }, 403, allowedOrigin || null);

      const hospitalResult = await admin.from('Hospitals').select('Hospital_Name')
        .eq('Hospital_ID', application.Hospital_ID).maybeSingle();
      if (hospitalResult.error) throw hospitalResult.error;
      const applicantName = [application.First_Name, application.Middle_Name, application.Last_Name, application.Suffix].filter(Boolean).join(' ');

      if (decision === 'rejected') {
        const rejected = await admin.rpc('reject_patient_application', {
          p_application_id: applicationId,
          p_actor_user_id: actor.user_id,
          p_reason: reason,
        });
        if (rejected.error) throw rejected.error;
        return jsonResponse({ decided: true, decision: 'rejected' }, 200, allowedOrigin || null);
      }

      const patientCode = await createPatientCode(admin);
      const temporaryPassword = buildTemporaryPassword();
      const invite = await admin.auth.admin.inviteUserByEmail(application.Applicant_Email, {
        data: {
          account_type: 'patient', decision: 'approved', role_label: 'Patient',
          account_label: 'Patient Code', account_value: patientCode,
          patient_code: patientCode, recipient_email: application.Applicant_Email,
          recipient_name: applicantName, hospital_name: hospitalResult.data?.Hospital_Name || '',
          display_name: applicantName, full_name: applicantName, name: applicantName,
          temporary_password: temporaryPassword,
        },
      });
      if (invite.error || !invite.data.user?.id) {
        throw invite.error || new Error('Patient account invitation did not return an auth user.');
      }
      const authUserId = invite.data.user.id;
      const passwordUpdate = await admin.auth.admin.updateUserById(authUserId, {
        email_confirm: true,
        password: temporaryPassword,
      });
      if (passwordUpdate.error) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
        throw passwordUpdate.error;
      }
      const promotedPaths: string[] = [];
      try {
        const picturePath = await promoteFile(admin, application.Patient_Picture_Path, authUserId, 'patient-picture');
        if (picturePath) promotedPaths.push(picturePath);

        const finalized = await admin.rpc('finalize_patient_application_acceptance', {
          p_application_id: applicationId,
          p_auth_user_id: authUserId,
          p_actor_user_id: actor.user_id,
          p_patient_code: patientCode,
          p_patient_picture_path: picturePath,
          p_account_setup_url: 'sent-by-supabase-auth-invite',
        });
        if (finalized.error) throw finalized.error;
        const applicationSourcePaths = [application.Patient_Picture_Path].filter(Boolean);
        if (applicationSourcePaths.length) {
          await admin.storage.from('patient-application-assets').remove(applicationSourcePaths);
        }
        return jsonResponse({ decided: true, decision: 'accepted', patientCode, ...finalized.data }, 200, allowedOrigin || null);
      } catch (error) {
        if (promotedPaths.length) await admin.storage.from('patient_assets').remove(promotedPaths);
        await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
        throw error;
      }
    }

    return jsonResponse({ error: 'Unsupported action.' }, 400, allowedOrigin || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to process the patient application.';
    return jsonResponse({ error: message }, 400, allowedOrigin || null);
  }
});
