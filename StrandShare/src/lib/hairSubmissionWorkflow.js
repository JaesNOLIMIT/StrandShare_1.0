import { isSupabaseConfigured, supabase } from './supabaseClient';

const HAIR_SUBMISSIONS_TABLE = 'Hair_Submissions';
const HAIR_SUBMISSION_BUNDLES_TABLE = 'Hair_Submission_Bundles';
const NOTIFICATIONS_TABLE = 'Notifications';
const HAIR_BUNDLE_TRACKING_TABLE = 'Hair_Bundle_Tracking_History';
const WIGS_TABLE = 'Wigs';
const WIG_SPECIFICATIONS_TABLE = 'Wig_Specifications';

export const HAIR_BUNDLE_STATUS = {
  DRAFT: 'Draft',
  IN_PRODUCTION: 'In Production',
  WIG_CREATED: 'Wig Created',
  // Backward-compatible alias used by older pages/components.
  WIG_COMPLETED: 'Wig Created',
  CANCELLED: 'Cancelled',
};

export const BUNDLE_HAIR_COUNT_TARGET_MIN = 8;
export const BUNDLE_HAIR_COUNT_TARGET_MAX = 10;

export const HAIR_SUBMISSION_STATUS = {
  PENDING: 'Pending',
  CUT: 'Cut',
  WIG_IN_PRODUCTION: 'Wig In Production',
  WIG_CREATED: 'Wig Created',
  CANCELLED: 'Cancelled',
  // Legacy aliases kept so older UI paths do not crash while we migrate pages.
  CUT_SHIPPED: 'Cut',
  RECEIVED: 'Cut',
  APPROVED: 'Cut',
  REJECTED: 'Cancelled',
  BUNDLED: 'Wig In Production',
};

export const HAIR_SUBMISSION_STATUS_ORDER = [
  HAIR_SUBMISSION_STATUS.PENDING,
  HAIR_SUBMISSION_STATUS.CUT,
  HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
  HAIR_SUBMISSION_STATUS.WIG_CREATED,
  HAIR_SUBMISSION_STATUS.CANCELLED,
];

const UTC8_OFFSET_MINUTES = 8 * 60;
export const WAYBILL_CODE_LENGTH = 8;

export function normalizeWaybillCodeInput(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, WAYBILL_CODE_LENGTH);
}

export function isValidWaybillCode(value) {
  return /^WB[A-Z0-9]{6}$/.test(String(value || '').trim().toUpperCase());
}

export function getManilaSqlTimestamp(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return getManilaSqlTimestamp(new Date());
  }
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  const manilaShiftedDate = new Date(utcMs + (UTC8_OFFSET_MINUTES * 60 * 1000));
  return manilaShiftedDate.toISOString().slice(0, 19).replace('T', ' ');
}

function isBundleCompletedStatus(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');
  return normalized === 'wig completed' || normalized === 'wig created';
}

function normalizeCapSizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function toCanonicalCapSize(value) {
  const key = normalizeCapSizeKey(value);
  if (!key) return '';
  if (['small', 's', 'xs'].includes(key) || key.startsWith('small')) return 'Small';
  if (['medium', 'm'].includes(key) || key.startsWith('medium')) return 'Medium';
  if (['large', 'l', 'xl'].includes(key) || key.startsWith('large')) return 'Large';
  return '';
}

function encodeWaybillSuffixFromId(idValue) {
  const numericId = Number(idValue || 0);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return '';
  }
  return Math.trunc(numericId)
    .toString(36)
    .toUpperCase()
    .padStart(6, '0')
    .slice(-6);
}

export function buildWaybillCode({ submissionId, createdAt = new Date() }) {
  void createdAt;
  const suffix = encodeWaybillSuffixFromId(submissionId);
  if (!suffix) return '';
  return `WB${suffix}`;
}

export function buildWaybillQrPayload({ submissionId, waybillCode, donationDriveId, eventRequestId }) {
  return JSON.stringify({
    type: 'hair_submission',
    submission_id: Number(submissionId) || null,
    waybill_code: String(waybillCode || ''),
    donation_drive_id: Number(donationDriveId) || null,
    event_request_id: Number(eventRequestId) || null,
  });
}

export function buildNonEventDonationQrPayload({ userId, waybillCode = '' }) {
  return JSON.stringify({
    type: 'hair_submission_non_event',
    user_id: Number(userId) || null,
    waybill_code: String(waybillCode || ''),
  });
}

export function parseWaybillQrPayload(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (parsed.type === 'hair_submission') {
        return {
          submissionId: Number(parsed.submission_id) || null,
          waybillCode: String(parsed.waybill_code || ''),
          donationDriveId: Number(parsed.donation_drive_id) || null,
          eventRequestId: Number(parsed.event_request_id) || null,
          userId: Number(parsed.user_id) || null,
        };
      }
      if (parsed.type === 'hair_submission_non_event') {
        return {
          submissionId: Number(parsed.submission_id) || null,
          waybillCode: String(parsed.waybill_code || ''),
          donationDriveId: null,
          eventRequestId: null,
          userId: Number(parsed.user_id) || null,
        };
      }
    }
  } catch {
    // Fall through to plain-text matching.
  }

  const codeMatch = text.match(/^WB[A-Z0-9]{6}$/i);
  if (codeMatch) {
    return {
      submissionId: null,
      waybillCode: text.toUpperCase(),
      donationDriveId: null,
      eventRequestId: null,
    };
  }

  const legacyCodeMatch = text.match(/^(HS|WB)-\d{4}-\d{4,8}$/i);
  if (legacyCodeMatch) {
    return {
      submissionId: null,
      waybillCode: text.toUpperCase(),
      donationDriveId: null,
      eventRequestId: null,
    };
  }

  const numericId = Number(text);
  if (Number.isInteger(numericId) && numericId > 0) {
    return {
      submissionId: numericId,
      waybillCode: '',
      donationDriveId: null,
      eventRequestId: null,
    };
  }

  return null;
}

export async function scanNonEventHairSubmission({ qrPayload, notes = '' }) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }

  const payload = String(qrPayload || '').trim();
  if (!payload) {
    return { data: null, error: new Error('qrPayload is required.') };
  }

  const { data, error } = await supabase.rpc('scan_non_event_hair_submission', {
    p_qr_payload: payload,
    p_notes: String(notes || '').trim() || null,
  });

  return { data, error };
}

export function buildBundleSubmissionCode({ bundleId, createdAt = new Date() }) {
  void createdAt;
  const suffix = encodeWaybillSuffixFromId(bundleId);
  if (!suffix) return '';
  return `WB${suffix}`;
}

export function buildWigCode({ wigId, createdAt = new Date() }) {
  const id = Number(wigId || 0);
  if (!id) return '';
  const year = new Date(createdAt || Date.now()).getFullYear();
  return `WIG-${year}-${String(id).padStart(6, '0')}`;
}

export function buildBundleWaybillQrPayload({ bundleId, bundleWaybillCode }) {
  const code = String(bundleWaybillCode || '');
  return JSON.stringify({
    type: 'hair_submission_bundle',
    bundle_id: Number(bundleId) || null,
    bundle_waybill_code: code,
  });
}

export function parseBundleWaybillQrPayload(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.type === 'hair_submission_bundle') {
      const code = String(parsed.bundle_waybill_code || '').trim();
      return {
        bundleId: Number(parsed.bundle_id) || null,
        bundleWaybillCode: code,
      };
    }
  } catch {
    // Fall through.
  }

  const codeMatch = text.match(/^WB[A-Z0-9]{6}$/i);
  if (codeMatch) {
    const code = text.toUpperCase();
    return { bundleId: null, bundleWaybillCode: code };
  }

  const legacyCodeMatch = text.match(/^WB-\d{4}-\d{4,8}$/i);
  if (legacyCodeMatch) {
    const code = text.toUpperCase();
    return { bundleId: null, bundleWaybillCode: code };
  }

  return null;
}

const STATUS_NOTIFICATION_TEMPLATES = {
  [HAIR_SUBMISSION_STATUS.PENDING]: {
    title: 'Waybill issued',
    message: ({ waybillCode, eventTitle }) =>
      `Your waybill ${waybillCode} has been issued${eventTitle ? ` for ${eventTitle}` : ''}. Please bring it to the event for hair collection.`,
  },
  [HAIR_SUBMISSION_STATUS.CUT]: {
    title: 'Hair collected',
    message: ({ waybillCode }) =>
      `Your donated hair (waybill ${waybillCode}) has been cut and tagged for wig production.`,
  },
  [HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION]: {
    title: 'Hair assigned to wig production',
    message: ({ waybillCode, bundleId }) =>
      `Your donated hair (waybill ${waybillCode}) is now in wig production under bundle #${bundleId}.`,
  },
  [HAIR_SUBMISSION_STATUS.CANCELLED]: {
    title: 'Hair donation cancelled',
    message: ({ waybillCode, reason }) =>
      `Your donation (waybill ${waybillCode}) was marked cancelled${reason ? `: ${reason}` : '.'}.`,
  },
  [HAIR_SUBMISSION_STATUS.WIG_CREATED]: {
    title: 'A wig was made from your donation',
    message: ({ waybillCode, bundleId }) =>
      `A wig has been completed using donated hair from bundle #${bundleId}, including yours (waybill ${waybillCode}). Thank you for changing a life.`,
  },
};

function buildStatusNotification({ status, waybillCode, eventTitle, reason, bundleId }) {
  const template = STATUS_NOTIFICATION_TEMPLATES[status];
  if (!template) {
    return {
      title: `Waybill ${waybillCode || ''}`.trim(),
      message: `Status updated to ${status}.`,
    };
  }
  return {
    title: template.title,
    message: template.message({ waybillCode, eventTitle, reason, bundleId }),
  };
}

export async function insertNotification({ userId, title, message, submissionId = null, bundleId = null }) {
  if (!isSupabaseConfigured || !supabase) return { error: null };
  const targetUserId = Number(userId || 0) || null;
  if (!targetUserId) return { error: null };

  const { error } = await supabase.from(NOTIFICATIONS_TABLE).insert({
    User_ID: targetUserId,
    Title: String(title || '').slice(0, 255),
    Message: String(message || ''),
    Submission_ID: submissionId ? Number(submissionId) : null,
    Bundle_ID: bundleId ? Number(bundleId) : null,
  });

  return { error };
}

export async function logBundleTracking({
  submissionId,
  submissionDetailId = null,
  status,
  title,
  description = '',
  changedBy = null,
}) {
  if (!isSupabaseConfigured || !supabase) return { error: null };
  if (!submissionId) return { error: null };

  const { error } = await supabase.from(HAIR_BUNDLE_TRACKING_TABLE).insert({
    Submission_ID: Number(submissionId),
    Submission_Detail_ID: submissionDetailId ? Number(submissionDetailId) : null,
    Status: String(status || '').slice(0, 100),
    Title: String(title || '').slice(0, 255),
    Description: String(description || ''),
    Changed_By: changedBy ? Number(changedBy) : null,
  });

  return { error };
}

export async function updateSubmissionStatus({
  submissionId,
  nextStatus,
  donorUserId,
  waybillCode,
  eventTitle = '',
  reason = '',
  bundleId = null,
  changedBy = null,
}) {
  if (!isSupabaseConfigured || !supabase) {
    return { error: new Error('Supabase is not configured.') };
  }
  if (!submissionId) {
    return { error: new Error('submissionId is required.') };
  }

  const { error: updateError } = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .update({ Status: nextStatus, Updated_At: getManilaSqlTimestamp() })
    .eq('Submission_ID', submissionId);

  if (updateError) {
    return { error: updateError };
  }

  const notification = buildStatusNotification({
    status: nextStatus,
    waybillCode,
    eventTitle,
    reason,
    bundleId,
  });

  await insertNotification({
    userId: donorUserId,
    title: notification.title,
    message: notification.message,
    submissionId,
    bundleId,
  });

  await logBundleTracking({
    submissionId,
    status: nextStatus,
    title: notification.title,
    description: reason || notification.message,
    changedBy,
  });

  return { error: null };
}

export async function ensureSubmissionForRegistration({
  eventRequestId = null,
  donationDriveId,
  organizationId = null,
  userId,
  createdBy = null,
}) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }
  const resolvedEventRequestId = Number(eventRequestId || donationDriveId || 0);
  if (!resolvedEventRequestId || !userId) {
    return { data: null, error: new Error('eventRequestId and userId are required.') };
  }

  const existing = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .select('Submission_ID, User_ID, Event_Request_ID, Status, Created_At')
    .eq('Event_Request_ID', resolvedEventRequestId)
    .eq('User_ID', userId)
    .maybeSingle();

  if (existing.error && existing.error.code !== 'PGRST116') {
    return { data: null, error: existing.error };
  }

  if (existing.data?.Submission_ID) {
    return { data: existing.data, error: null };
  }

  const insertResult = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .insert({
      User_ID: Number(userId),
      Event_Request_ID: resolvedEventRequestId,
      Status: HAIR_SUBMISSION_STATUS.PENDING,
    })
    .select('Submission_ID, User_ID, Event_Request_ID, Status, Created_At')
    .single();

  if (insertResult.error) {
    return { data: null, error: insertResult.error };
  }

  return { data: insertResult.data, error: null };
}

export async function createWigBundle({ submissionIds, createdBy, notes = '' }) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }
  const ids = Array.from(new Set((Array.isArray(submissionIds) ? submissionIds : []).map((id) => Number(id) || 0).filter(Boolean)));
  if (!ids.length) {
    return { data: null, error: new Error('Pick at least one Cut hair submission.') };
  }

  const submissionsResult = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .select('Submission_ID, User_ID, Status, Bundle_ID')
    .in('Submission_ID', ids);

  if (submissionsResult.error) {
    return { data: null, error: submissionsResult.error };
  }

  const eligible = (submissionsResult.data || []).filter((row) =>
    String(row.Status || '').toLowerCase() === HAIR_SUBMISSION_STATUS.CUT.toLowerCase()
    && !row.Bundle_ID,
  );

  if (eligible.length !== ids.length) {
    return {
      data: null,
      error: new Error('Some selected submissions are not in Cut status or already belong to a bundle. Refresh and retry.'),
    };
  }

  const bundleInsertResult = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .insert({
      Status: HAIR_BUNDLE_STATUS.IN_PRODUCTION,
      Created_By: createdBy ? Number(createdBy) : null,
      Notes: String(notes || '').trim() || null,
    })
    .select('Bundle_ID, Status, Created_At, Bundle_Waybill_Code')
    .single();

  if (bundleInsertResult.error) {
    return { data: null, error: bundleInsertResult.error };
  }

  const bundle = bundleInsertResult.data;

  if (!bundle?.Bundle_Waybill_Code) {
    const code = buildBundleSubmissionCode({ bundleId: bundle.Bundle_ID, createdAt: bundle.Created_At });
    const { error: codeError } = await supabase
      .from(HAIR_SUBMISSION_BUNDLES_TABLE)
      .update({ Bundle_Waybill_Code: code })
      .eq('Bundle_ID', bundle.Bundle_ID);
    if (!codeError) {
      bundle.Bundle_Waybill_Code = code;
    }
  }

  const { error: linkError } = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .update({
      Bundle_ID: bundle.Bundle_ID,
      Status: HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
      Updated_At: getManilaSqlTimestamp(),
    })
    .in('Submission_ID', ids);

  if (linkError) {
    return { data: null, error: linkError };
  }

  await Promise.all(eligible.map(async (row) => {
    const notification = buildStatusNotification({
      status: HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
      waybillCode: buildWaybillCode({ submissionId: row.Submission_ID }),
      bundleId: bundle.Bundle_ID,
    });
    await insertNotification({
      userId: row.User_ID,
      title: notification.title,
      message: notification.message,
      submissionId: row.Submission_ID,
      bundleId: bundle.Bundle_ID,
    });
    await logBundleTracking({
      submissionId: row.Submission_ID,
      status: HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
      title: notification.title,
      description: notification.message,
      changedBy: createdBy ? Number(createdBy) : null,
    });
  }));

  return { data: { ...bundle, members: eligible }, error: null };
}

export async function completeWigBundle({
  bundleId,
  completedBy,
  frontImagePath,
  sideImagePath,
  topImagePath,
  wigName,
  hairLength = null,
  hairColor = '',
  hairTexture = '',
  hairDensity = '',
  hairStyle = '',
  capSize = '',
  notes = '',
}) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }
  if (!bundleId) {
    return { data: null, error: new Error('bundleId is required.') };
  }
  if (!frontImagePath || !sideImagePath || !topImagePath) {
    return { data: null, error: new Error('Front, side, and top photos are all required.') };
  }
  const trimmedWigName = String(wigName || '').trim();
  if (!trimmedWigName) {
    return { data: null, error: new Error('Wig name is required.') };
  }

  const bundleResult = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .select('Bundle_ID, Status, Bundle_Waybill_Code, Wig_Completed_At')
    .eq('Bundle_ID', bundleId)
    .maybeSingle();

  if (bundleResult.error) {
    return { data: null, error: bundleResult.error };
  }

  const bundle = bundleResult.data;
  if (!bundle?.Bundle_ID) {
    return { data: null, error: new Error('Bundle not found.') };
  }

  const statusKey = String(bundle.Status || '').toLowerCase();
  if (statusKey === HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()) {
    return { data: null, error: new Error('Bundle is still a Draft. Finalize it on the Bundling page first.') };
  }

  const existingWigResult = await supabase
    .from(WIGS_TABLE)
    .select('Wig_ID, Bundle_ID, Wig_Name, Wig_Status, Completed_At')
    .eq('Bundle_ID', bundleId)
    .maybeSingle();

  if (existingWigResult.error) {
    return { data: null, error: existingWigResult.error };
  }

  const existingWig = existingWigResult.data || null;
  if ((isBundleCompletedStatus(statusKey) || bundle.Wig_Completed_At) && existingWig?.Wig_ID) {
    const membersSnapshot = await supabase
      .from(HAIR_SUBMISSIONS_TABLE)
      .select('Submission_ID, User_ID')
      .eq('Bundle_ID', bundleId);

    return {
      data: {
        bundle,
        wig: existingWig,
        members: membersSnapshot.error ? [] : (membersSnapshot.data || []),
        alreadyComplete: true,
      },
      error: null,
    };
  }

  const membersResult = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .select('Submission_ID, User_ID, Status')
    .eq('Bundle_ID', bundleId);

  if (membersResult.error) {
    return { data: null, error: membersResult.error };
  }
  const members = membersResult.data || [];

  const nowIso = getManilaSqlTimestamp();

  const completedByNumeric = completedBy ? Number(completedBy) : null;

  const wigUpsertResult = await supabase
    .from(WIGS_TABLE)
    .upsert({
      Bundle_ID: bundleId,
      Wig_Code: String(bundle.Bundle_Waybill_Code || '').trim() || null,
      Wig_Name: trimmedWigName,
      Total_Donated_Hairs: members.length,
      Total_Bundles_Used: 1,
      Stock_Count: 1,
      Added_By: completedByNumeric,
      Created_By: completedByNumeric,
      Completed_At: nowIso,
      Production_Notes: String(notes || '').trim() || null,
      Wig_Status: 'available',
      Wig_Front_Image_Path: frontImagePath,
      Wig_Side_Image_Path: sideImagePath,
      Wig_Top_Image_Path: topImagePath,
    }, {
      onConflict: 'Bundle_ID',
    })
    .select('Wig_ID, Wig_Name, Bundle_ID, Total_Donated_Hairs, Completed_At, Wig_Status, Created_At')
    .single();

  if (wigUpsertResult.error) {
    return { data: null, error: wigUpsertResult.error };
  }

  const wig = wigUpsertResult.data;
  const canonicalCapSize = toCanonicalCapSize(capSize);

  if (wig?.Wig_ID) {
    const specUpsertResult = await supabase
      .from(WIG_SPECIFICATIONS_TABLE)
      .upsert({
        Wig_ID: wig.Wig_ID,
        Hair_Length: hairLength === '' || hairLength === null || hairLength === undefined ? null : Number(hairLength),
        Hair_Color: String(hairColor || '').trim() || null,
        Hair_Texture: String(hairTexture || '').trim() || null,
        Hair_Density: String(hairDensity || '').trim() || null,
        Style: String(hairStyle || '').trim() || null,
        Cap_Size: canonicalCapSize || null,
      }, {
        onConflict: 'Wig_ID',
      });

    if (specUpsertResult.error) {
      return { data: null, error: specUpsertResult.error };
    }
  }

  const { error: bundleUpdateError } = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .update({
      Status: HAIR_BUNDLE_STATUS.WIG_COMPLETED,
      Wig_Completed_At: nowIso,
    })
    .eq('Bundle_ID', bundleId);

  if (bundleUpdateError) {
    return { data: null, error: bundleUpdateError };
  }

  if (members.length) {
    const membersToNotify = members.filter(
      (row) => String(row.Status || '').toLowerCase() !== HAIR_SUBMISSION_STATUS.WIG_CREATED.toLowerCase(),
    );

    await supabase
      .from(HAIR_SUBMISSIONS_TABLE)
      .update({ Status: HAIR_SUBMISSION_STATUS.WIG_CREATED, Updated_At: nowIso })
      .eq('Bundle_ID', bundleId);

    await Promise.all(membersToNotify.map(async (row) => {
      const notification = buildStatusNotification({
        status: HAIR_SUBMISSION_STATUS.WIG_CREATED,
        waybillCode: buildWaybillCode({ submissionId: row.Submission_ID }),
        bundleId,
      });
      await insertNotification({
        userId: row.User_ID,
        title: notification.title,
        message: notification.message,
        submissionId: row.Submission_ID,
        bundleId,
      });
      await logBundleTracking({
        submissionId: row.Submission_ID,
        status: HAIR_SUBMISSION_STATUS.WIG_CREATED,
        title: notification.title,
        description: notification.message,
        changedBy: completedBy ? Number(completedBy) : null,
      });
    }));
  }

  return {
    data: {
      bundle: { ...bundle, Status: HAIR_BUNDLE_STATUS.WIG_COMPLETED, Wig_Completed_At: nowIso },
      wig,
      members,
      alreadyComplete: false,
    },
    error: null,
  };
}

export async function saveBundleDraft({ submissionIds, createdBy, notes = '' }) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }
  const ids = Array.from(new Set((Array.isArray(submissionIds) ? submissionIds : []).map((id) => Number(id) || 0).filter(Boolean)));
  if (!ids.length) {
    return { data: null, error: new Error('Pick at least one Cut hair submission.') };
  }

  const submissionsResult = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .select('Submission_ID, Status, Bundle_ID')
    .in('Submission_ID', ids);

  if (submissionsResult.error) {
    return { data: null, error: submissionsResult.error };
  }

  const eligible = (submissionsResult.data || []).filter((row) =>
    String(row.Status || '').toLowerCase() === HAIR_SUBMISSION_STATUS.CUT.toLowerCase()
    && !row.Bundle_ID,
  );
  if (eligible.length !== ids.length) {
    return {
      data: null,
      error: new Error('Some selected submissions are not in Cut status or already belong to another bundle. Refresh and retry.'),
    };
  }

  const insertResult = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .insert({
      Status: HAIR_BUNDLE_STATUS.DRAFT,
      Created_By: createdBy ? Number(createdBy) : null,
      Notes: String(notes || '').trim() || null,
    })
    .select('Bundle_ID, Status, Notes, Created_At, Updated_At')
    .single();

  if (insertResult.error) {
    return { data: null, error: insertResult.error };
  }

  const bundle = insertResult.data;
  const { error: linkError } = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .update({
      Bundle_ID: bundle.Bundle_ID,
      Updated_At: getManilaSqlTimestamp(),
    })
    .in('Submission_ID', ids);

  if (linkError) {
    return { data: null, error: linkError };
  }

  return { data: bundle, error: null };
}

export async function updateBundleDraft({ bundleId, submissionIds, notes = '' }) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }
  if (!bundleId) {
    return { data: null, error: new Error('bundleId is required.') };
  }
  const ids = Array.from(new Set((Array.isArray(submissionIds) ? submissionIds : []).map((id) => Number(id) || 0).filter(Boolean)));
  if (!ids.length) {
    return { data: null, error: new Error('Pick at least one Cut hair submission.') };
  }

  const draftResult = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .select('Bundle_ID, Status, Notes, Created_At, Updated_At')
    .eq('Bundle_ID', bundleId)
    .eq('Status', HAIR_BUNDLE_STATUS.DRAFT)
    .maybeSingle();

  if (draftResult.error) {
    return { data: null, error: draftResult.error };
  }
  if (!draftResult.data?.Bundle_ID) {
    return { data: null, error: new Error('Draft bundle not found.') };
  }

  const existingResult = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .select('Submission_ID')
    .eq('Bundle_ID', bundleId);

  if (existingResult.error) {
    return { data: null, error: existingResult.error };
  }

  const existingIds = new Set((existingResult.data || []).map((row) => Number(row.Submission_ID || 0)).filter(Boolean));
  const requestedIds = new Set(ids);
  const idsToUnlink = Array.from(existingIds).filter((id) => !requestedIds.has(id));
  const idsToLink = ids.filter((id) => !existingIds.has(id));

  if (idsToUnlink.length) {
    const { error: unlinkError } = await supabase
      .from(HAIR_SUBMISSIONS_TABLE)
      .update({
        Bundle_ID: null,
        Updated_At: getManilaSqlTimestamp(),
      })
      .in('Submission_ID', idsToUnlink)
      .eq('Bundle_ID', bundleId);
    if (unlinkError) {
      return { data: null, error: unlinkError };
    }
  }

  if (idsToLink.length) {
    const candidatesResult = await supabase
      .from(HAIR_SUBMISSIONS_TABLE)
      .select('Submission_ID, Status, Bundle_ID')
      .in('Submission_ID', idsToLink);
    if (candidatesResult.error) {
      return { data: null, error: candidatesResult.error };
    }

    const candidateMap = new Map((candidatesResult.data || []).map((row) => [Number(row.Submission_ID), row]));
    const invalid = idsToLink.filter((id) => {
      const row = candidateMap.get(id);
      if (!row) return true;
      const isCut = String(row.Status || '').toLowerCase() === HAIR_SUBMISSION_STATUS.CUT.toLowerCase();
      const hasOtherBundle = row.Bundle_ID && Number(row.Bundle_ID) !== Number(bundleId);
      return !isCut || hasOtherBundle;
    });
    if (invalid.length) {
      return {
        data: null,
        error: new Error('Some selected submissions are no longer eligible for this draft. Refresh and retry.'),
      };
    }

    const { error: linkError } = await supabase
      .from(HAIR_SUBMISSIONS_TABLE)
      .update({
        Bundle_ID: bundleId,
        Updated_At: getManilaSqlTimestamp(),
      })
      .in('Submission_ID', idsToLink);
    if (linkError) {
      return { data: null, error: linkError };
    }
  }

  const { data, error } = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .update({
      Notes: String(notes || '').trim() || null,
    })
    .eq('Bundle_ID', bundleId)
    .eq('Status', HAIR_BUNDLE_STATUS.DRAFT)
    .select('Bundle_ID, Status, Notes, Created_At, Updated_At')
    .single();

  return { data, error };
}

export async function deleteBundleDraft({ bundleId }) {
  if (!isSupabaseConfigured || !supabase) {
    return { error: new Error('Supabase is not configured.') };
  }
  if (!bundleId) {
    return { error: new Error('bundleId is required.') };
  }

  const { error: unlinkError } = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .update({
      Bundle_ID: null,
      Updated_At: getManilaSqlTimestamp(),
    })
    .eq('Bundle_ID', bundleId);

  if (unlinkError) {
    return { error: unlinkError };
  }

  const { error } = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .delete()
    .eq('Bundle_ID', bundleId)
    .eq('Status', HAIR_BUNDLE_STATUS.DRAFT);

  return { error };
}

export async function finalizeBundleDraft({ bundleId, finalizedBy }) {
  if (!isSupabaseConfigured || !supabase) {
    return { data: null, error: new Error('Supabase is not configured.') };
  }
  if (!bundleId) {
    return { data: null, error: new Error('bundleId is required.') };
  }

  const draftResult = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .select('Bundle_ID, Status, Notes, Created_At')
    .eq('Bundle_ID', bundleId)
    .maybeSingle();

  if (draftResult.error) {
    return { data: null, error: draftResult.error };
  }

  const draft = draftResult.data;
  if (!draft?.Bundle_ID) {
    return { data: null, error: new Error('Draft bundle not found.') };
  }
  if (String(draft.Status || '').toLowerCase() !== HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()) {
    return { data: null, error: new Error('Bundle is no longer a Draft.') };
  }

  const submissionsResult = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .select('Submission_ID, User_ID, Status, Bundle_ID')
    .eq('Bundle_ID', draft.Bundle_ID);

  if (submissionsResult.error) {
    return { data: null, error: submissionsResult.error };
  }

  const draftRows = submissionsResult.data || [];
  const draftIds = draftRows.map((row) => Number(row.Submission_ID || 0)).filter(Boolean);
  if (!draftIds.length) {
    return { data: null, error: new Error('Draft has no selected hair submissions.') };
  }

  const eligible = draftRows.filter((row) =>
    String(row.Status || '').toLowerCase() === HAIR_SUBMISSION_STATUS.CUT.toLowerCase()
    && Number(row.Bundle_ID || 0) === Number(bundleId),
  );

  if (eligible.length !== draftRows.length) {
    return {
      data: null,
      error: new Error('Some hairs in this draft are no longer in Cut status or were bundled elsewhere. Edit the draft and remove them.'),
    };
  }

  const code = buildBundleSubmissionCode({ bundleId: draft.Bundle_ID, createdAt: draft.Created_At });
  const nowIso = getManilaSqlTimestamp();

  const { error: bundleUpdateError } = await supabase
    .from(HAIR_SUBMISSION_BUNDLES_TABLE)
    .update({
      Status: HAIR_BUNDLE_STATUS.IN_PRODUCTION,
      Bundle_Waybill_Code: code,
    })
    .eq('Bundle_ID', draft.Bundle_ID);

  if (bundleUpdateError) {
    return { data: null, error: bundleUpdateError };
  }

  const { error: linkError } = await supabase
    .from(HAIR_SUBMISSIONS_TABLE)
    .update({
      Bundle_ID: draft.Bundle_ID,
      Status: HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
      Updated_At: nowIso,
    })
    .in('Submission_ID', draftIds);

  if (linkError) {
    return { data: null, error: linkError };
  }

  await Promise.all(eligible.map(async (row) => {
    const notification = buildStatusNotification({
      status: HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
      waybillCode: buildWaybillCode({ submissionId: row.Submission_ID }),
      bundleId: draft.Bundle_ID,
    });
    await insertNotification({
      userId: row.User_ID,
      title: notification.title,
      message: notification.message,
      submissionId: row.Submission_ID,
      bundleId: draft.Bundle_ID,
    });
    await logBundleTracking({
      submissionId: row.Submission_ID,
      status: HAIR_SUBMISSION_STATUS.WIG_IN_PRODUCTION,
      title: notification.title,
      description: notification.message,
      changedBy: finalizedBy ? Number(finalizedBy) : null,
    });
  }));

  return {
    data: {
      Bundle_ID: draft.Bundle_ID,
      Status: HAIR_BUNDLE_STATUS.IN_PRODUCTION,
      Bundle_Waybill_Code: code,
      Notes: draft.Notes,
      Created_At: draft.Created_At,
      members: eligible,
    },
    error: null,
  };
}

