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

function cleanDocument(report: Record<string, unknown>) {
  const allowedFields = [
    'status',
    'document_type',
    'document_subtype',
    'document_number',
    'first_name',
    'last_name',
    'full_name',
    'gender',
    'address',
    'formatted_address',
  ];

  const cleaned: Record<string, unknown> = Object.fromEntries(
    allowedFields
      .filter((field) => report[field] !== undefined && report[field] !== null)
      .map((field) => [field, report[field]]),
  );
  const extraFields = report.extra_fields && typeof report.extra_fields === 'object'
    ? report.extra_fields as Record<string, unknown>
    : {};
  const middleNameKey = Object.keys(extraFields).find((key) => (
    ['middlename', 'middle'].includes(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
  ));
  if (middleNameKey && extraFields[middleNameKey]) {
    cleaned.middle_name = String(extraFields[middleNameKey]);
  }
  return cleaned;
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
        .select('Session_ID, Client_Token_Hash, Vendor_Data, ID_Front_Image_Path')
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

      const idReports = Array.isArray(decision?.id_verifications) ? decision.id_verifications : [];
      const selectedReport = idReports.find((report: Record<string, unknown>) => (
        String(report?.status || '').toLowerCase() === 'approved'
      )) || idReports[0] || null;
      const document = selectedReport ? cleanDocument(selectedReport) : null;
      const status = String(decision?.status || 'Unknown');
      const featureStatus = String(selectedReport?.status || '');
      const verified = status.toLowerCase() === 'approved' && featureStatus.toLowerCase() === 'approved';
      const warnings = Array.isArray(selectedReport?.warnings) ? selectedReport.warnings : [];
      const manilaTimestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).replace(' ', 'T');
      let frontImagePath = String(storedSession.ID_Front_Image_Path || '').trim();

      if (verified && !frontImagePath) {
        const frontImageUrl = String(selectedReport?.front_image || '').trim();
        if (!frontImageUrl) {
          throw new Error('The verification completed, but its front ID image was unavailable. Please retry the ID scan.');
        }
        frontImagePath = await saveVerifiedIdFrontImage(admin, sessionId, frontImageUrl);
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

      return jsonResponse({ status, featureStatus, verified, document, warnings }, 200, allowedOrigin || null);
    }

    return jsonResponse({ error: 'Unknown action.' }, 400, allowedOrigin || null);
  } catch (error) {
    return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 500, allowedOrigin || null);
  }
});
