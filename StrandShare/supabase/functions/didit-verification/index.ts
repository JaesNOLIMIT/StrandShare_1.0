import { createClient } from 'npm:@supabase/supabase-js@2';

const DIDIT_API_BASE_URL = 'https://verification.didit.me/v3';
const PRIVATE_ID_BUCKET = 'event_application_private_ids';
const MAX_ID_IMAGE_SIZE_BYTES = 12 * 1024 * 1024;
const LOCAL_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const PRODUCTION_ORIGINS = new Set(['https://donivra.vercel.app']);

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

function getAllowedOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const configured = String(Deno.env.get('DIDIT_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (LOCAL_ORIGINS.has(origin) || PRODUCTION_ORIGINS.has(origin) || configured.includes(origin)) return origin;
  return '';
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function reportSources(report: Record<string, unknown>) {
  const sources: Record<string, unknown>[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: report, depth: 0 }];
  const visited = new Set<object>();

  while (queue.length && sources.length < 60) {
    const current = queue.shift();
    if (!current || !current.value || typeof current.value !== 'object' || visited.has(current.value)) continue;
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.depth < 4) {
        current.value.forEach((entry) => queue.push({ value: entry, depth: current.depth + 1 }));
      }
      continue;
    }

    const record = current.value as Record<string, unknown>;
    sources.push(record);
    if (current.depth < 4) {
      Object.values(record).forEach((entry) => queue.push({ value: entry, depth: current.depth + 1 }));
    }
  }

  return sources;
}

function mergeDocuments(
  storedDocument: Record<string, unknown> | null,
  currentDocument: Record<string, unknown> | null,
) {
  if (!storedDocument) return currentDocument;
  if (!currentDocument) return storedDocument;
  const merged = { ...storedDocument };
  Object.entries(currentDocument).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') merged[key] = value;
  });
  return merged;
}

function pickValue(sources: Record<string, unknown>[], keys: string[]) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
  }
  return '';
}

function validIsoDate(year: number, month: number, day: number) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeBirthdate(value: unknown): string {
  const nested = asRecord(value);
  if (nested) {
    const year = Number(nested.year ?? nested.yyyy);
    const month = Number(nested.month ?? nested.mm);
    const day = Number(nested.day ?? nested.dd);
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
      return validIsoDate(year, month, day);
    }
    return normalizeBirthdate(pickValue([nested], ['date_of_birth', 'birth_date', 'date', 'value', 'iso', 'raw']));
  }

  const raw = String(value || '').trim();
  if (!raw) return '';
  const yearFirst = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (yearFirst) return validIsoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));

  const dayFirst = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\D|$)/);
  if (dayFirst) return validIsoDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return validIsoDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

function pickLabeledValue(sources: Record<string, unknown>[], labels: string[]) {
  const acceptedLabels = new Set(labels.map((label) => label.toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const source of sources) {
    const label = String(source.key || source.name || source.label || source.field || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!acceptedLabels.has(label)) continue;
    const value = pickValue([source], ['value', 'extracted_value', 'raw_value', 'text']);
    if (value !== '') return value;
  }
  return '';
}

function normalizeAddress(value: unknown) {
  const address = asRecord(value);
  if (!address) return String(value || '').trim();
  return [
    address.street_1,
    address.street_2,
    address.street,
    address.barangay,
    address.city,
    address.municipality,
    address.province,
    address.region,
    address.postal_code,
    address.country,
  ].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
}

function cleanDocument(report: Record<string, unknown>) {
  const sources = reportSources(report);
  const extraSources = sources
    .map((source) => asRecord(source.extra_fields))
    .filter((value): value is Record<string, unknown> => Boolean(value));

  const birthdate = pickValue(sources, ['date_of_birth', 'birth_date', 'birthdate', 'dob'])
    || pickLabeledValue(sources, ['date_of_birth', 'birth_date', 'birthdate', 'dob']);

  return {
    status: String(pickValue(sources, ['status']) || '').trim(),
    document_type: String(pickValue(sources, ['document_type', 'documentType', 'type']) || '').trim(),
    document_subtype: String(pickValue(sources, ['document_subtype', 'documentSubtype', 'subtype']) || '').trim(),
    document_number: String(pickValue(sources, ['document_number', 'documentNumber', 'id_number', 'personal_number']) || '').trim(),
    first_name: String(pickValue(sources, ['first_name', 'firstName', 'given_name', 'given_names']) || '').trim(),
    middle_name: String(pickValue([...sources, ...extraSources], ['middle_name', 'middleName', 'middlename', 'middle']) || '').trim(),
    last_name: String(pickValue(sources, ['last_name', 'lastName', 'surname', 'family_name']) || '').trim(),
    full_name: String(pickValue(sources, ['full_name', 'fullName', 'name']) || '').trim(),
    date_of_birth: normalizeBirthdate(birthdate),
    gender: String(pickValue(sources, ['gender', 'sex']) || '').trim(),
    formatted_address: normalizeAddress(pickValue(sources, ['formatted_address', 'full_address', 'address', 'parsed_address'])),
  };
}

function getIdFrontImageUrl(report: Record<string, unknown> | null) {
  if (!report) return '';
  const sources = reportSources(report);
  return String(pickValue(sources, [
    'front_image',
    'full_front_image',
    'front_document_image',
    'front_image_url',
  ]) || '').trim();
}

async function saveVerifiedIdFrontImage(
  admin: ReturnType<typeof createClient>,
  sessionId: string,
  imageUrl: string,
) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Unable to download the verified ID front image (${response.status}).`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('The verified ID front image was empty.');
  if (bytes.length > MAX_ID_IMAGE_SIZE_BYTES) {
    throw new Error('The verified ID front image exceeded the 12 MB storage limit.');
  }

  let contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  if (!extensions[contentType]) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) contentType = 'image/jpeg';
    else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) contentType = 'image/png';
    else if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) contentType = 'image/webp';
  }
  const extension = extensions[contentType];
  if (!extension) throw new Error('The verified ID front image used an unsupported file format.');

  const path = `verified-sessions/${sessionId}/front.${extension}`;
  const { error } = await admin.storage
    .from(PRIVATE_ID_BUCKET)
    .upload(path, bytes, { contentType, upsert: true, cacheControl: '3600' });
  if (error) throw new Error(`Unable to save the verified ID front image: ${error.message}`);
  return path;
}

Deno.serve(async (request) => {
  const allowedOrigin = getAllowedOrigin(request);
  if (request.method === 'OPTIONS') {
    return allowedOrigin === ''
      ? jsonResponse({ error: 'Origin is not allowed.' }, 403, null)
      : jsonResponse({}, 200, allowedOrigin);
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, allowedOrigin || null);
  }

  if (allowedOrigin === '') {
    return jsonResponse({ error: 'Origin is not allowed.' }, 403, null);
  }

  const diditApiKey = Deno.env.get('DIDIT_API_KEY');
  const diditWorkflowId = Deno.env.get('DIDIT_WORKFLOW_ID');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!diditApiKey || !diditWorkflowId || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({
      error: 'The identity verification service is not configured. Check the Edge Function secrets.',
    }, 503, allowedOrigin || null);
  }

  try {
    const payload = await request.json();
    const action = String(payload?.action || '').trim().toLowerCase();
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === 'create') {
      const clientToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
      const clientTokenHash = await sha256(clientToken);
      const vendorData = `program-${crypto.randomUUID()}`;

      const diditResponse = await fetch(`${DIDIT_API_BASE_URL}/session/`, {
        method: 'POST',
        headers: {
          'x-api-key': diditApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: diditWorkflowId,
          vendor_data: vendorData,
          language: 'en',
          metadata: { source: 'strandshare-program-application', country: 'PHL' },
          expected_details: { id_country: 'PHL' },
        }),
      });

      const diditBody = await diditResponse.json().catch(() => ({}));
      if (!diditResponse.ok) {
        return jsonResponse({
          error: String(diditBody?.detail || diditBody?.message || 'The verification service could not create a session.'),
        }, diditResponse.status, allowedOrigin || null);
      }

      const sessionId = String(diditBody?.session_id || '');
      const verificationUrl = String(diditBody?.url || '');
      if (!sessionId || !verificationUrl) {
        return jsonResponse({ error: 'The verification service returned an incomplete session.' }, 502, allowedOrigin || null);
      }

      const { error: insertError } = await admin
        .from('Didit_Verification_Sessions')
        .insert({
          Session_ID: sessionId,
          Client_Token_Hash: clientTokenHash,
          Vendor_Data: vendorData,
          Status: String(diditBody?.status || 'Not Started'),
        });

      if (insertError) {
        throw new Error(`Unable to save the verification session: ${insertError.message}`);
      }

      return jsonResponse({ sessionId, clientToken, verificationUrl }, 200, allowedOrigin || null);
    }

    if (action === 'status') {
      const sessionId = String(payload?.sessionId || '').trim();
      const clientToken = String(payload?.clientToken || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || clientToken.length < 32) {
        return jsonResponse({ error: 'Invalid verification session.' }, 400, allowedOrigin || null);
      }

      const tokenHash = await sha256(clientToken);
      const { data: storedSession, error: sessionError } = await admin
        .from('Didit_Verification_Sessions')
        .select('Session_ID, Client_Token_Hash, Vendor_Data, ID_Front_Image_Path, Document_Data')
        .eq('Session_ID', sessionId)
        .maybeSingle();

      if (sessionError || !storedSession || storedSession.Client_Token_Hash !== tokenHash) {
        return jsonResponse({ error: 'Verification session was not found.' }, 404, allowedOrigin || null);
      }

      const diditResponse = await fetch(`${DIDIT_API_BASE_URL}/session/${sessionId}/decision/`, {
        headers: { 'x-api-key': diditApiKey },
      });
      const decision = await diditResponse.json().catch(() => ({}));
      if (!diditResponse.ok) {
        return jsonResponse({
          error: String(decision?.detail || decision?.message || 'Unable to retrieve the verification decision.'),
        }, diditResponse.status, allowedOrigin || null);
      }

      if (decision?.vendor_data && decision.vendor_data !== storedSession.Vendor_Data) {
        return jsonResponse({ error: 'Verification session ownership check failed.' }, 403, allowedOrigin || null);
      }

      const rawIdReports = decision?.id_verifications ?? decision?.id_verification;
      const idReports = Array.isArray(rawIdReports)
        ? rawIdReports
        : asRecord(rawIdReports)
          ? [rawIdReports]
          : [];
      const selectedReport = idReports.find((report: Record<string, unknown>) => (
        String(report?.status || '').toLowerCase() === 'approved'
      )) || idReports[0] || null;
      const storedDocument = asRecord(storedSession.Document_Data);
      const currentDocument = selectedReport ? cleanDocument(selectedReport) : null;
      const document = mergeDocuments(storedDocument, currentDocument);
      const status = String(decision?.status || 'Unknown');
      const featureStatus = String(selectedReport?.status || '');
      const verified = status.toLowerCase() === 'approved' && featureStatus.toLowerCase() === 'approved';
      const warnings = Array.isArray(selectedReport?.warnings) ? selectedReport.warnings : [];
      const manilaTimestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).replace(' ', 'T');
      let frontImagePath = String(storedSession.ID_Front_Image_Path || '').trim();
      const providerFrontImageUrl = getIdFrontImageUrl(selectedReport);
      let idImageNotice = '';

      if (verified && !frontImagePath) {
        if (providerFrontImageUrl) {
          try {
            frontImagePath = await saveVerifiedIdFrontImage(admin, sessionId, providerFrontImageUrl);
          } catch (imageError) {
            idImageNotice = String(imageError instanceof Error ? imageError.message : imageError);
          }
        } else {
          idImageNotice = 'The verification provider did not return a front ID image.';
        }
      }

      const { error: updateError } = await admin
        .from('Didit_Verification_Sessions')
        .update({
          Status: status,
          Document_Data: document,
          Warnings: warnings,
          ID_Front_Image_Path: frontImagePath || null,
          Verified_At: verified ? manilaTimestamp : null,
          Updated_At: manilaTimestamp,
        })
        .eq('Session_ID', sessionId);

      if (updateError) {
        throw new Error(`Unable to save the verification decision: ${updateError.message}`);
      }

      let idFrontImageUrl = '';
      if (verified && frontImagePath) {
        const { data: signedImage, error: signedImageError } = await admin.storage
          .from(PRIVATE_ID_BUCKET)
          .createSignedUrl(frontImagePath, 15 * 60);
        idFrontImageUrl = String(signedImage?.signedUrl || '');
        if (signedImageError) idImageNotice = signedImageError.message;
      }

      // Didit image URLs are short-lived signed URLs. Use one only as a
      // temporary fallback if copying the image into private storage failed.
      if (verified && !idFrontImageUrl && providerFrontImageUrl) {
        idFrontImageUrl = providerFrontImageUrl;
      }

      return jsonResponse({
        status,
        featureStatus,
        verified,
        document,
        birthdate: normalizeBirthdate(document?.date_of_birth),
        warnings,
        idFrontImageUrl,
        idImageNotice: idFrontImageUrl ? '' : idImageNotice,
      }, 200, allowedOrigin || null);
    }

    return jsonResponse({ error: 'Unknown action.' }, 400, allowedOrigin || null);
  } catch (error) {
    return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 500, allowedOrigin || null);
  }
});
