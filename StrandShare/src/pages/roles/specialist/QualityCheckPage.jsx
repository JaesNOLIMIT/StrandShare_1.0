import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  PackageOpen,
  ScanLine,
  XCircle,
} from 'lucide-react';
import jsQR from 'jsqr';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import useRealtimeRefresh from '../../../hooks/useRealtimeRefresh';
import PageHeaderActions from '../../../components/PageHeaderActions';
import WaybillScanResult from '../../../components/scanning/WaybillScanResult';
import {
  HAIR_SUBMISSION_STATUS,
  WAYBILL_CODE_LENGTH,
  isValidWaybillCode,
  normalizeWaybillCodeInput,
  parseWaybillQrPayload,
} from '../../../lib/hairSubmissionWorkflow';

const HAIR_SUBMISSIONS_TABLE = 'Hair_Submissions';
const HAIR_SUBMISSION_DETAILS_TABLE = 'Hair_Submission_Details';
const HAIR_SUBMISSION_IMAGES_TABLE = 'Hair_Submission_Images';
const HAIR_SUBMISSION_LOGISTICS_TABLE = 'Hair_Submission_Logistics';
const AI_SCREENINGS_TABLE = 'AI_Screenings';
const USER_DETAILS_TABLE = 'user_details';
const PROFILE_PICTURES_BUCKET = 'profile_pictures';
const HAIR_SUBMISSIONS_BUCKET = 'hair-submissions';
const SCAN_DEBOUNCE_MS = 2500;
const QUALITY_SCAN_OUTCOMES = [
  'Received non-event hair: submission details load and await Approve or Reject.',
  'Approved: the non-event submission becomes Available for specialist Bundling.',
  'Rejected: the quality result is Rejected; it is not recorded as a donor cancellation.',
  'Already approved or rejected: the final locked result is shown without changing it.',
  'Only Hair_Submissions.Waybill_Code is accepted on this page.',
  'Not received, already bundled, cancelled, unknown, or malformed waybill: scan is blocked with the exact reason.',
];

const EMPTY_DETAIL_DRAFT = Object.freeze({
  declaredLength: '',
  declaredColor: '',
  declaredTexture: '',
  declaredDensity: '',
  declaredCondition: '',
  isChemicallyTreated: false,
  isColored: false,
  isBleached: false,
  isRebonded: false,
  detailNotes: '',
});

const ACTIVE_STATUSES = [
  HAIR_SUBMISSION_STATUS.PENDING,
  HAIR_SUBMISSION_STATUS.CUT,
  HAIR_SUBMISSION_STATUS.AVAILABLE,
  HAIR_SUBMISSION_STATUS.CANCELLED,
  'Rejected',
];

function withColorAlpha(colorValue, alpha, fallback = '#0275d8') {
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  const input = String(colorValue || '').trim();
  const hexMatch = input.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const r = parseInt(hexMatch[1].slice(0, 2), 16);
    const g = parseInt(hexMatch[1].slice(2, 4), 16);
    const b = parseInt(hexMatch[1].slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
  }
  return withColorAlpha(fallback, safeAlpha, '#0275d8');
}

function buildFullName(first, middle, last, suffix) {
  return [first, middle, last, suffix]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function statusBadgeStyle(status, primaryColor, tertiaryColor) {
  const key = String(status || '').toLowerCase().replace(/[_\s-]+/g, '');
  if (key === 'cut' || key === 'available' || key === 'approved') {
    return { backgroundColor: withColorAlpha(tertiaryColor, 0.16), color: tertiaryColor, borderColor: withColorAlpha(tertiaryColor, 0.4) };
  }
  if (key === 'cancelled' || key === 'rejected') {
    return { backgroundColor: '#fef2f2', color: '#b91c1c', borderColor: '#fecaca' };
  }
  if (key === 'pending') {
    return { backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' };
  }
  return { backgroundColor: '#f1f5f9', color: '#475569', borderColor: '#cbd5e1' };
}

function logisticsIsReceived(row) {
  if (!row) return false;
  const type = String(row.Logistics_Type || '').toLowerCase();
  const dropoff = String(row.Dropoff_Status || '').toLowerCase().replace(/[_\s-]+/g, '');
  const shipment = String(row.Shipment_Status || '').toLowerCase().replace(/[_\s-]+/g, '');
  if (type.includes('walk-in') || type.includes('dropoff')) {
    return dropoff === 'completed' && Boolean(row.Completed_At || row.Received_At);
  }
  return Boolean(row.Received_At) || ['received', 'completed', 'delivered'].includes(shipment);
}

function formatDateTime(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function humanizeLabel(value) {
  const text = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Not provided';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeComparisonValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[_\s-]+/g, '');
}

function calculateLiveAiAccuracy(screening, draft) {
  if (!screening) return { comparable: 0, matched: 0, changed: [], aiPercent: 0, humanPercent: 0 };
  const comparisons = [
    ['length', screening.Estimated_Length, draft.declaredLength, (ai, human) => String(human ?? '').trim() !== '' && Number(ai) === Number(human)],
    ['color', screening.Detected_Color, draft.declaredColor],
    ['texture', screening.Detected_Texture, draft.declaredTexture],
    ['density', screening.Detected_Density, draft.declaredDensity],
    ['condition', screening.Detected_Condition, draft.declaredCondition],
  ].filter(([, ai]) => ai != null && String(ai).trim() !== '');
  const changed = comparisons.filter(([, ai, human, matcher]) => (
    matcher ? !matcher(ai, human) : normalizeComparisonValue(ai) !== normalizeComparisonValue(human)
  )).map(([field]) => field);
  const comparable = comparisons.length;
  const matched = comparable - changed.length;
  const aiPercent = comparable ? (matched / comparable) * 100 : 0;
  return { comparable, matched, changed, aiPercent, humanPercent: comparable ? 100 - aiPercent : 0 };
}

function draftFromAiScreening(screening) {
  return {
    ...EMPTY_DETAIL_DRAFT,
    declaredLength: screening?.Estimated_Length == null ? '' : String(screening.Estimated_Length),
    declaredColor: String(screening?.Detected_Color || ''),
    declaredTexture: String(screening?.Detected_Texture || ''),
    declaredDensity: String(screening?.Detected_Density || ''),
    declaredCondition: String(screening?.Detected_Condition || ''),
  };
}

function detailDraftWithAiFallback(detail, screening) {
  if (!detail) return draftFromAiScreening(screening);
  const saved = detailRowToDraft(detail);
  const ai = draftFromAiScreening(screening);
  return {
    ...saved,
    declaredLength: saved.declaredLength || ai.declaredLength,
    declaredColor: saved.declaredColor || ai.declaredColor,
    declaredTexture: saved.declaredTexture || ai.declaredTexture,
    declaredDensity: saved.declaredDensity || ai.declaredDensity,
    declaredCondition: saved.declaredCondition || ai.declaredCondition,
  };
}

function formatAnswerValue(value) {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(formatAnswerValue).join(', ') : 'None';
  if (typeof value === 'object') return 'Recorded';
  return humanizeLabel(value).replace(/(\d)\s+(\d)/g, '$1-$2');
}

function splitLeadingJson(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw.startsWith('{')) return { jsonText: '', trailingText: raw };

  let depth = 0;
  let insideString = false;
  let isEscaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (insideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === '\\') {
        isEscaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }
    if (character === '"') {
      insideString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          jsonText: raw.slice(0, index + 1),
          trailingText: raw.slice(index + 1).trim(),
        };
      }
    }
  }

  return { jsonText: '', trailingText: raw };
}

function normalizeActivityNote(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  const isDonorCancellation = /(?:status changed to cancelled by donor|donation cancelled by donor)/i.test(raw);
  if (isDonorCancellation) {
    const reasonMatch = raw.match(/\breason:\s*(.+)$/i);
    const rawReason = String(reasonMatch?.[1] || '')
      .replace(/[.\s]+$/, '')
      .trim();
    const isModuleReason = /cancelled by donor from donor donation module/i.test(rawReason);
    return {
      tone: 'cancelled',
      title: 'Donation cancelled by donor',
      detail: rawReason
        ? (isModuleReason ? 'Cancelled through the donor donation module.' : rawReason)
        : '',
    };
  }

  return {
    tone: 'note',
    title: 'Donation update',
    detail: raw,
  };
}

function parseDonorNotes(notes) {
  const raw = String(notes || '').trim();
  if (!raw) return null;
  const { jsonText, trailingText } = splitLeadingJson(raw);
  try {
    const parsed = JSON.parse(jsonText || raw);
    const answers = parsed?.questionnaire_answers;
    if (parsed && typeof parsed === 'object' && answers && typeof answers === 'object') {
      return {
        structured: true,
        source: parsed.source,
        donorAge: parsed.donor_age_at_submission,
        consentCheckedAt: parsed.consent_checked_at,
        answers: Object.entries(answers),
        activityNote: normalizeActivityNote(trailingText),
      };
    }
  } catch {
    // Plain-text donor notes are rendered below.
  }
  return { structured: false, raw };
}

function DonorScreeningSummary({ notes }) {
  const parsed = parseDonorNotes(notes);
  if (!parsed) return null;

  if (!parsed.structured) {
    return (
      <section className="min-w-0 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">Donor notes</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-blue-950 [overflow-wrap:anywhere]">
          {parsed.raw}
        </p>
      </section>
    );
  }

  const highlightKeys = [
    'screening_intent',
    'hair_texture',
    'wash_frequency',
    'scalp_itch',
    'dandruff_or_flakes',
    'chemical_process_history',
  ];
  const highlightAnswers = highlightKeys
    .map((key) => parsed.answers.find(([answerKey]) => answerKey === key))
    .filter(Boolean);
  const remainingAnswers = parsed.answers.filter(([key, value]) => (
    !highlightKeys.includes(key)
    && value !== null
    && value !== undefined
    && String(value).trim() !== ''
  ));
  const unansweredCount = parsed.answers.filter(([, value]) => (
    value === null || value === undefined || String(value).trim() === ''
  )).length;

  return (
    <section className="min-w-0 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">Donor screening summary</p>
          <p className="mt-0.5 text-xs text-slate-500">Answers submitted before the hair was sent.</p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {parsed.source ? (
            <span className="rounded-full border border-blue-200 bg-white px-2.5 py-1 font-medium text-blue-700">
              {formatAnswerValue(parsed.source)}
            </span>
          ) : null}
          {parsed.donorAge !== null && parsed.donorAge !== undefined ? (
            <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-600">
              Age {parsed.donorAge}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {highlightAnswers.map(([key, value]) => (
          <div key={key} className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-400" title={humanizeLabel(key)}>
              {humanizeLabel(key)}
            </p>
            <p className="mt-0.5 break-words text-sm font-medium text-slate-700 [overflow-wrap:anywhere]">
              {formatAnswerValue(value)}
            </p>
          </div>
        ))}
      </div>

      {remainingAnswers.length ? (
        <details className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50">
            View {remainingAnswers.length} more screening answers
          </summary>
          <div className="grid min-w-0 gap-px border-t border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-3">
            {remainingAnswers.map(([key, value]) => (
              <div key={key} className="min-w-0 bg-white px-3 py-2.5">
                <p className="break-words text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {humanizeLabel(key)}
                </p>
                <p className="mt-0.5 break-words text-xs font-medium text-slate-700 [overflow-wrap:anywhere]">
                  {formatAnswerValue(value)}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {parsed.consentCheckedAt ? (
        <p className="mt-2 text-[10px] text-slate-400">
          Consent checked {formatDateTime(parsed.consentCheckedAt)}
        </p>
      ) : null}

      {unansweredCount ? (
        <p className="mt-1 text-[10px] text-slate-400">
          {unansweredCount} screening {unansweredCount === 1 ? 'answer was' : 'answers were'} not provided.
        </p>
      ) : null}

      {parsed.activityNote ? (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 ${
          parsed.activityNote.tone === 'cancelled'
            ? 'border-rose-200 bg-rose-50 text-rose-800'
            : 'border-slate-200 bg-white text-slate-700'
        }`}>
          <p className="text-xs font-semibold">{parsed.activityNote.title}</p>
          {parsed.activityNote.detail ? <p className="mt-0.5 text-[11px]">{parsed.activityNote.detail}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function detailRowToDraft(row) {
  return {
    declaredLength: row?.Declared_Length === null || row?.Declared_Length === undefined
      ? ''
      : String(row.Declared_Length),
    declaredColor: String(row?.Declared_Color || ''),
    declaredTexture: String(row?.Declared_Texture || ''),
    declaredDensity: String(row?.Declared_Density || ''),
    declaredCondition: String(row?.Declared_Condition || ''),
    isChemicallyTreated: Boolean(row?.Is_Chemically_Treated),
    isColored: Boolean(row?.Is_Colored),
    isBleached: Boolean(row?.Is_Bleached),
    isRebonded: Boolean(row?.Is_Rebonded),
    detailNotes: String(row?.Detail_Notes || ''),
  };
}

export default function QualityCheckPage() {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0275d8';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const tertiaryTextColor = theme?.tertiaryTextColor || '#94a3b8';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const rootStyle = { color: primaryTextColor, fontFamily: `${bodyFont}, sans-serif` };
  const headingStyle = { color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` };

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const lastScanRef = useRef({ raw: '', at: 0 });
  const isScanProcessingRef = useRef(false);

  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraStatus, setCameraStatus] = useState({ tone: 'info', message: 'Camera is off. Turn it on to scan a waybill.' });
  const [manualWaybillCode, setManualWaybillCode] = useState('');

  const [queue, setQueue] = useState([]);
  const [activeSubmissionId, setActiveSubmissionId] = useState(null);
  const [activeDetail, setActiveDetail] = useState(null);
  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isProcessingAction, setIsProcessingAction] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejectionInput, setShowRejectionInput] = useState(false);
  const [decisionConfirmation, setDecisionConfirmation] = useState(null);
  const [imageUrlsByPath, setImageUrlsByPath] = useState({});
  const [detailDraft, setDetailDraft] = useState({ ...EMPTY_DETAIL_DRAFT });
  const [scanOutcome, setScanOutcome] = useState(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const loadQueue = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }

    setIsLoadingQueue(true);
    setNotice({ kind: '', text: '' });

    try {
      const submissionsResult = await supabase
        .from(HAIR_SUBMISSIONS_TABLE)
        .select('Submission_ID, User_ID, Status, Created_At, Updated_At, Bundle_ID, From_Event, Donor_Notes, Waybill_Code, AI_Screening_ID')
        .eq('From_Event', false)
        .in('Status', ACTIVE_STATUSES)
        .is('Bundle_ID', null)
        .order('Updated_At', { ascending: false })
        .limit(150);

      if (submissionsResult.error) throw submissionsResult.error;

      const rows = submissionsResult.data || [];
      const userIds = Array.from(new Set(rows.map((row) => Number(row.User_ID || 0)).filter(Boolean)));
      const submissionIds = rows.map((row) => Number(row.Submission_ID || 0)).filter(Boolean);

      let usersByUserId = {};
      let detailsBySubmissionId = {};
      let logisticsBySubmissionId = {};
      if (userIds.length) {
        const { data, error } = await supabase
          .from(USER_DETAILS_TABLE)
          .select('user_id, first_name, middle_name, last_name, suffix, photo_path')
          .in('user_id', userIds);
        if (error) throw error;
        usersByUserId = (data || []).reduce((acc, row) => {
          acc[Number(row.user_id)] = row;
          return acc;
        }, {});
      }
      if (submissionIds.length) {
        const [detailsResult, logisticsResult] = await Promise.all([
          supabase.from(HAIR_SUBMISSION_DETAILS_TABLE).select('Submission_ID, Status').in('Submission_ID', submissionIds),
          supabase.from(HAIR_SUBMISSION_LOGISTICS_TABLE).select('*').in('Submission_ID', submissionIds),
        ]);
        if (detailsResult.error) throw detailsResult.error;
        if (logisticsResult.error) throw logisticsResult.error;
        detailsBySubmissionId = (detailsResult.data || []).reduce((acc, row) => {
          acc[Number(row.Submission_ID)] = row;
          return acc;
        }, {});
        logisticsBySubmissionId = (logisticsResult.data || []).reduce((acc, row) => {
          acc[Number(row.Submission_ID)] = row;
          return acc;
        }, {});
      }

      const enriched = rows.map((row) => {
        const userId = Number(row.User_ID || 0);
        const userDetails = usersByUserId[userId] || {};
        const qualityDetail = detailsBySubmissionId[Number(row.Submission_ID)] || {};
        const logistics = logisticsBySubmissionId[Number(row.Submission_ID)] || null;
        const isCancelled = String(row.Status || '').toLowerCase() === 'cancelled';
        return {
          submissionId: row.Submission_ID,
          userId,
          status: row.Status,
          qualityStatus: isCancelled ? 'Cancelled' : (qualityDetail.Status || 'Pending'),
          submissionCode: String(row.Waybill_Code || '').trim().toUpperCase() || `Submission #${row.Submission_ID}`,
          logistics,
          aiScreeningId: row.AI_Screening_ID,
          isPhysicallyReceived: logisticsIsReceived(logistics),
          createdAt: row.Created_At,
          updatedAt: row.Updated_At,
          donorNotes: row.Donor_Notes || '',
          donorName: buildFullName(userDetails.first_name, userDetails.middle_name, userDetails.last_name, userDetails.suffix) || `User #${userId}`,
          donorPhotoPath: userDetails.photo_path || '',
        };
      });

      const visibleQueue = enriched.filter((row) => (
        row.isPhysicallyReceived || String(row.status || '').toLowerCase() === 'cancelled'
      ));
      setQueue(visibleQueue);

      if (visibleQueue.length && !visibleQueue.some((r) => r.submissionId === activeSubmissionId)) {
        setActiveSubmissionId(visibleQueue[0].submissionId);
      } else if (!visibleQueue.length) {
        setActiveSubmissionId(null);
        setActiveDetail(null);
      }

      const photoPaths = Array.from(new Set(
        visibleQueue.map((r) => r.donorPhotoPath).filter((path) => path && !imageUrlsByPath[path]),
      ));
      if (photoPaths.length) {
        const resolved = await Promise.all(
          photoPaths.map(async (path) => {
            try {
              if (isAbsoluteUrl(path)) return [path, path];
              const { data } = supabase.storage.from(PROFILE_PICTURES_BUCKET).getPublicUrl(path);
              return [path, data?.publicUrl || ''];
            } catch {
              return [path, ''];
            }
          }),
        );
        setImageUrlsByPath((prev) => {
          const next = { ...prev };
          resolved.forEach(([path, url]) => {
            if (url) next[path] = url;
          });
          return next;
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load QA queue.' });
    } finally {
      setIsLoadingQueue(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubmissionId]);

  const loadDetail = useCallback(async (submissionId) => {
    if (!submissionId || !isSupabaseConfigured || !supabase) {
      setActiveDetail(null);
      return;
    }

    setIsLoadingDetail(true);

    try {
      const detailsResult = await supabase
        .from(HAIR_SUBMISSION_DETAILS_TABLE)
        .select('*')
        .eq('Submission_ID', submissionId)
        .order('Submission_Detail_ID', { ascending: true });

      if (detailsResult.error) throw detailsResult.error;
      const detailRows = detailsResult.data || [];
      const submissionResult = await supabase
        .from(HAIR_SUBMISSIONS_TABLE)
        .select('AI_Screening_ID')
        .eq('Submission_ID', submissionId)
        .maybeSingle();
      if (submissionResult.error) throw submissionResult.error;
      let aiScreening = null;
      if (submissionResult.data?.AI_Screening_ID) {
        const aiResult = await supabase
          .from(AI_SCREENINGS_TABLE)
          .select('*')
          .eq('AI_Screening_ID', submissionResult.data.AI_Screening_ID)
          .maybeSingle();
        if (aiResult.error) throw aiResult.error;
        aiScreening = aiResult.data || null;
      }
      const detailIds = detailRows.map((row) => Number(row.Submission_Detail_ID || 0)).filter(Boolean);

      let imagesByDetailId = {};
      if (detailIds.length) {
        const imagesResult = await supabase
          .from(HAIR_SUBMISSION_IMAGES_TABLE)
          .select('*')
          .in('Submission_Detail_ID', detailIds);
        if (imagesResult.error) throw imagesResult.error;
        imagesByDetailId = (imagesResult.data || []).reduce((acc, row) => {
          const key = Number(row.Submission_Detail_ID);
          if (!acc[key]) acc[key] = [];
          acc[key].push(row);
          return acc;
        }, {});
      }

      const allImagePaths = Array.from(new Set(
        Object.values(imagesByDetailId)
          .flat()
          .map((row) => row.File_Path)
          .filter((path) => path && !imageUrlsByPath[path]),
      ));

      if (allImagePaths.length) {
        const signedResult = await supabase.storage
          .from(HAIR_SUBMISSIONS_BUCKET)
          .createSignedUrls(allImagePaths, 60 * 60);
        if (signedResult.error) {
          setNotice({
            kind: 'error',
            text: `Submission details loaded, but the private hair photos could not be opened: ${signedResult.error.message}`,
          });
        } else {
          setImageUrlsByPath((prev) => {
            const next = { ...prev };
            (signedResult.data || []).forEach((row) => {
              if (row?.path && row?.signedUrl) next[row.path] = row.signedUrl;
            });
            return next;
          });
        }
      }

      setActiveDetail({
        details: detailRows,
        imagesByDetailId,
        aiScreening,
      });
      setDetailDraft(detailDraftWithAiFallback(detailRows[0], aiScreening));
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load submission detail.' });
      setActiveDetail(null);
      setDetailDraft({ ...EMPTY_DETAIL_DRAFT });
    } finally {
      setIsLoadingDetail(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadQueue();
    return () => {
      stopCamera();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtimeRefresh({
    channelName: 'specialist-quality-check-live',
    tables: [HAIR_SUBMISSIONS_TABLE, HAIR_SUBMISSION_DETAILS_TABLE, HAIR_SUBMISSION_IMAGES_TABLE, HAIR_SUBMISSION_LOGISTICS_TABLE, AI_SCREENINGS_TABLE],
    onChange: () => {
      void loadQueue();
      if (activeSubmissionId) {
        void loadDetail(activeSubmissionId);
      }
    },
  });

  useEffect(() => {
    if (activeSubmissionId) {
      void loadDetail(activeSubmissionId);
    } else {
      setActiveDetail(null);
      setDetailDraft({ ...EMPTY_DETAIL_DRAFT });
    }
    setShowRejectionInput(false);
    setRejectionReason('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubmissionId]);

  const handleScannedText = useCallback(async (decodedText) => {
    if (isScanProcessingRef.current) return;
    isScanProcessingRef.current = true;

    try {
      const waybill = parseWaybillQrPayload(decodedText);
      const compact = String(waybill?.waybillCode || decodedText || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!isValidWaybillCode(compact)) {
        setCameraStatus({ tone: 'error', message: 'Scan did not match a hair submission waybill.' });
        setScanOutcome({ tone: 'error', title: 'Invalid waybill', action: 'No database change', status: 'Blocked', nextStep: 'Use the WB + 6-character code printed for this hair submission' });
        return;
      }

      const lookup = await supabase
        .from(HAIR_SUBMISSIONS_TABLE)
        .select('Submission_ID, User_ID, Status, From_Event, Bundle_ID, Waybill_Code')
        .eq('Waybill_Code', compact)
        .maybeSingle();

      if (lookup?.error) throw lookup.error;
      const submission = lookup?.data;

      if (!submission?.Submission_ID) {
        setCameraStatus({ tone: 'error', message: `No Hair_Submissions record uses waybill ${compact}.` });
        setScanOutcome({
          tone: 'error', title: 'Submission not found', waybill: compact,
          action: 'No database change', status: 'Blocked', nextStep: 'Check the waybill and scan again',
        });
        return;
      }

      if (submission.From_Event !== false) {
        setCameraStatus({
          tone: 'warning',
          message: `Waybill ${compact} is not a non-event Hair_Submissions waybill.`,
        });
        setScanOutcome({
          tone: 'warning', title: 'Unsupported waybill', waybill: compact,
          action: 'No specialist quality change', status: 'Use event workflow', nextStep: 'Use Staff Assigned Event Operations',
        });
        return;
      }

      if (submission.Bundle_ID) {
        setCameraStatus({
          tone: 'info',
          message: `Waybill ${compact} is already assigned to a bundle.`,
        });
        setScanOutcome({
          tone: 'info', title: 'Hair is already bundled', waybill: compact,
          action: 'Loaded current state only', status: 'Bundling', nextStep: 'Manage it from the Bundling page',
        });
        return;
      }

      const statusKey = String(submission.Status || '').toLowerCase().replace(/[_\s-]+/g, '');
      const submissionLabel = compact;
      const logisticsResult = await supabase
        .from(HAIR_SUBMISSION_LOGISTICS_TABLE)
        .select('*')
        .eq('Submission_ID', submission.Submission_ID)
        .maybeSingle();
      if (logisticsResult.error) throw logisticsResult.error;
      const received = logisticsIsReceived(logisticsResult.data);
      const detailResult = await supabase
        .from(HAIR_SUBMISSION_DETAILS_TABLE)
        .select('Status')
        .eq('Submission_ID', submission.Submission_ID)
        .maybeSingle();
      if (detailResult.error) throw detailResult.error;
      const qualityStatusKey = String(detailResult.data?.Status || 'Pending').toLowerCase().replace(/[_\s-]+/g, '');

      if (statusKey === 'cancelled') {
        setCameraStatus({
          tone: 'info',
          message: `Waybill ${submissionLabel} is Cancelled and cannot be bundled.`,
        });
        setScanOutcome({ tone: 'warning', title: 'Cancelled hair', waybill: submissionLabel, action: 'No database change', status: 'Cancelled', nextStep: 'No further processing allowed' });
      } else if (!received) {
        setCameraStatus({ tone: 'warning', message: `Waybill ${submissionLabel} has not been received yet.` });
        setScanOutcome({ tone: 'warning', title: 'Hair not received', waybill: submissionLabel, action: 'No database change', status: 'Awaiting arrival', nextStep: 'Complete receiving in Salon Schedule or courier receiving first' });
      } else if (['pending', 'cut'].includes(statusKey) && qualityStatusKey === 'pending') {
        setCameraStatus({
          tone: 'info',
          message: `Waybill ${submissionLabel} loaded. Inspect the hair and choose Approve or Reject below.`,
        });
        setScanOutcome({ tone: 'success', title: 'Quality review loaded', waybill: submissionLabel, action: 'Loaded donor and hair details', status: 'Awaiting decision', nextStep: 'Inspect and choose Approve or Reject', statusChanges: [] });
      } else if (qualityStatusKey === 'approved') {
        setCameraStatus({
          tone: 'info',
          message: `Waybill ${submissionLabel} is already Approved and ready for Bundling.`,
        });
        setScanOutcome({ tone: 'info', title: 'Quality review already complete', waybill: submissionLabel, action: 'Loaded locked result', status: 'Approved', nextStep: 'Scan this waybill into an open bundle' });
      } else if (qualityStatusKey === 'rejected') {
        setCameraStatus({
          tone: 'info',
          message: `Waybill ${submissionLabel} is Rejected and cannot be bundled.`,
        });
        setScanOutcome({ tone: 'warning', title: 'Quality review already complete', waybill: submissionLabel, action: 'Loaded locked result', status: 'Rejected', nextStep: 'No further processing allowed' });
      } else if (!['pending', 'cut'].includes(statusKey)) {
        setCameraStatus({
          tone: 'warning',
          message: `Waybill ${submissionLabel} is not awaiting specialist quality review.`,
        });
        setScanOutcome({ tone: 'warning', title: 'Hair is not ready for quality review', waybill: submissionLabel, action: 'No database change', status: submission.Status || 'Not ready', nextStep: 'Staff must receive it in Salon Schedule first' });
      } else {
        setCameraStatus({
          tone: 'info',
          message: `Waybill ${submissionLabel} is already ${submission.Status}. Read-only.`,
        });
        setScanOutcome({ tone: 'info', title: 'Current waybill state loaded', waybill: submissionLabel, action: 'Read-only lookup', status: submission.Status || 'Read-only', nextStep: 'No quality action is available' });
      }

      await loadQueue();
      setActiveSubmissionId(submission.Submission_ID);
    } catch (error) {
      setCameraStatus({ tone: 'error', message: error?.message || 'Unable to load scanned waybill.' });
      setScanOutcome({ tone: 'error', title: 'Waybill could not be processed', action: 'No database change', status: 'Blocked', nextStep: error?.message || 'Try scanning again' });
    } finally {
      isScanProcessingRef.current = false;
    }
  }, [loadQueue]);

  const handleToggleCamera = async () => {
    if (isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraStatus({ tone: 'info', message: 'Camera is off. Turn it on to scan a waybill.' });
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus({ tone: 'error', message: 'Camera API is unavailable on this browser/device.' });
      return;
    }

    setIsStartingCamera(true);
    setCameraStatus({ tone: 'info', message: 'Initializing camera...' });

    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }

      setIsCameraOn(true);
      setCameraStatus({ tone: 'success', message: 'Scanner is running. Point camera at a waybill QR.' });
    } catch (error) {
      setCameraStatus({ tone: 'error', message: error?.message || 'Could not access the camera.' });
    } finally {
      setIsStartingCamera(false);
    }
  };

  const handleManualWaybillLookup = async () => {
    const code = normalizeWaybillCodeInput(manualWaybillCode);
    if (!isValidWaybillCode(code)) {
      setCameraStatus({
        tone: 'warning',
        message: 'Enter a complete waybill: WB followed by 6 letters or numbers.',
      });
      return;
    }

    await handleScannedText(code);
  };

  useEffect(() => {
    if (!isCameraOn) return undefined;

    const intervalId = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || isScanProcessingRef.current) return;

      const frameWidth = video.videoWidth;
      const frameHeight = video.videoHeight;
      if (!frameWidth || !frameHeight) return;

      try {
        if (!scannerCanvasRef.current) {
          scannerCanvasRef.current = document.createElement('canvas');
        }
        const canvas = scannerCanvasRef.current;
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, frameWidth, frameHeight);
        const imageData = ctx.getImageData(0, 0, frameWidth, frameHeight);
        const code = jsQR(imageData.data, frameWidth, frameHeight, { inversionAttempts: 'attemptBoth' });
        const decoded = String(code?.data || '').trim();
        if (!decoded) return;

        const now = Date.now();
        if (lastScanRef.current.raw === decoded && now - lastScanRef.current.at < SCAN_DEBOUNCE_MS) return;
        lastScanRef.current = { raw: decoded, at: now };

        void handleScannedText(decoded);
      } catch {
        // ignore frame-level decode errors
      }
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [isCameraOn, handleScannedText]);

  const activeQueueRow = queue.find((row) => row.submissionId === activeSubmissionId) || null;

  const setDetailField = (field, value) => {
    setDetailDraft((previous) => ({ ...previous, [field]: value }));
  };

  const getDetailUpdates = () => {
    const lengthText = String(detailDraft.declaredLength || '').trim();
    const declaredLength = lengthText ? Number(lengthText) : null;
    if (lengthText && (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > 999.99)) {
      throw new Error('Hair length must be between 0 and 999.99 inches.');
    }
    return {
      declaredLength,
      declaredColor: detailDraft.declaredColor.trim() || null,
      declaredTexture: detailDraft.declaredTexture.trim() || null,
      declaredDensity: detailDraft.declaredDensity.trim() || null,
      declaredCondition: detailDraft.declaredCondition.trim() || null,
      isChemicallyTreated: Boolean(detailDraft.isChemicallyTreated),
      isColored: Boolean(detailDraft.isColored),
      isBleached: Boolean(detailDraft.isBleached),
      isRebonded: Boolean(detailDraft.isRebonded),
      detailNotes: detailDraft.detailNotes.trim() || null,
    };
  };

  const handleApprove = async () => {
    if (!activeQueueRow) return;
    setIsProcessingAction(true);
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('specialist_review_non_event_hair_quality_v2', {
        p_submission_id: activeQueueRow.submissionId,
        p_decision: 'Approved',
        p_rejection_reason: null,
        p_detail_updates: getDetailUpdates(),
      });
      if (result.error) throw result.error;

      const payload = result.data || {};
      const updatedDetails = Array.isArray(payload?.details) ? payload.details : [];
      if (updatedDetails.length) {
        setActiveDetail((prev) => ({
          details: updatedDetails,
          imagesByDetailId: prev?.imagesByDetailId || {},
          aiScreening: prev?.aiScreening || null,
        }));
        setDetailDraft(detailRowToDraft(updatedDetails[0]));
      }

      setCameraStatus({
        tone: 'success',
        message: `Waybill ${activeQueueRow.submissionCode} quality result is now Approved.`,
      });
      setScanOutcome({
        tone: 'success', title: 'Quality review approved', waybill: activeQueueRow.submissionCode,
        subject: activeQueueRow.donorName, action: 'Saved final quality decision', status: 'Approved / Available',
        nextStep: 'Hair is now available for Bundling',
        statusChanges: [
          { label: 'Quality detail', before: activeQualityStatus || 'Pending', after: 'Approved' },
          { label: 'Hair submission', before: activeQueueRow.status || 'Pending', after: 'Available' },
          { label: 'Cut inventory', before: 'Not available', after: 'Cut / Available' },
        ],
      });
      setNotice({ kind: 'success', text: 'Quality review approved. The non-event hair is now Available for bundling.' });
      await loadQueue();
      await loadDetail(activeQueueRow.submissionId);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to approve.' });
    } finally {
      setIsProcessingAction(false);
    }
  };

  const handleReject = async () => {
    if (!activeQueueRow) return;
    const reason = String(rejectionReason || '').trim();
    if (!reason) {
      setNotice({ kind: 'warning', text: 'Provide a rejection reason.' });
      return;
    }

    setIsProcessingAction(true);
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('specialist_review_non_event_hair_quality_v2', {
        p_submission_id: activeQueueRow.submissionId,
        p_decision: 'Rejected',
        p_rejection_reason: reason,
        p_detail_updates: getDetailUpdates(),
      });
      if (result.error) throw result.error;

      const payload = result.data || {};
      const updatedDetails = Array.isArray(payload?.details) ? payload.details : [];
      if (updatedDetails.length) {
        setActiveDetail((prev) => ({
          details: updatedDetails,
          imagesByDetailId: prev?.imagesByDetailId || {},
          aiScreening: prev?.aiScreening || null,
        }));
        setDetailDraft(detailRowToDraft(updatedDetails[0]));
      }

      setCameraStatus({
        tone: 'warning',
        message: `Waybill ${activeQueueRow.submissionCode} quality result is now Rejected.`,
      });
      setScanOutcome({
        tone: 'warning', title: 'Quality review rejected', waybill: activeQueueRow.submissionCode,
        subject: activeQueueRow.donorName, action: 'Saved final quality decision', status: 'Rejected',
        nextStep: 'No further bundling or production is allowed',
        statusChanges: [
          { label: 'Quality detail', before: activeQualityStatus || 'Pending', after: 'Rejected' },
          { label: 'Hair submission', before: activeQueueRow.status || 'Pending', after: activeQueueRow.status || 'Pending' },
          { label: 'Cut inventory', before: 'Not available', after: 'Not available' },
        ],
      });
      setNotice({ kind: 'success', text: 'Quality review rejected. The submission is marked Rejected and cannot enter Bundling.' });
      setShowRejectionInput(false);
      setRejectionReason('');
      await loadQueue();
      await loadDetail(activeQueueRow.submissionId);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to reject.' });
    } finally {
      setIsProcessingAction(false);
    }
  };

  const requestApprove = () => {
    if (!activeQueueRow || isProcessingAction) return;
    setDecisionConfirmation({
      decision: 'Approved',
      submissionCode: activeQueueRow.submissionCode,
    });
  };

  const requestReject = () => {
    if (!activeQueueRow || isProcessingAction) return;
    const reason = String(rejectionReason || '').trim();
    if (!reason) {
      setNotice({ kind: 'warning', text: 'Provide a rejection reason.' });
      return;
    }
    setDecisionConfirmation({
      decision: 'Rejected',
      submissionCode: activeQueueRow.submissionCode,
      reason,
    });
  };

  const confirmDecision = async () => {
    const decision = decisionConfirmation?.decision;
    setDecisionConfirmation(null);
    if (decision === 'Approved') {
      await handleApprove();
    } else if (decision === 'Rejected') {
      await handleReject();
    }
  };

  const queueByStatus = useMemo(() => {
    const groups = { Pending: [], Approved: [], Rejected: [], Cancelled: [] };
    queue.forEach((row) => {
      const key = String(row.qualityStatus || '').toLowerCase().replace(/[_\s-]+/g, '');
      if (key === 'pending' && row.isPhysicallyReceived) groups.Pending.push(row);
      else if (key === 'approved') groups.Approved.push(row);
      else if (key === 'rejected') groups.Rejected.push(row);
      else if (key === 'cancelled') groups.Cancelled.push(row);
    });
    return groups;
  }, [queue]);

  const cameraNoticeStyle = (() => {
    switch (cameraStatus.tone) {
      case 'success':
        return { backgroundColor: withColorAlpha(tertiaryColor, 0.14), color: tertiaryColor, borderColor: withColorAlpha(tertiaryColor, 0.5) };
      case 'error':
        return { backgroundColor: '#fef2f2', color: '#b91c1c', borderColor: '#fecaca' };
      case 'warning':
        return { backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' };
      default:
        return { backgroundColor: withColorAlpha(primaryColor, 0.12), color: primaryColor, borderColor: withColorAlpha(primaryColor, 0.45) };
    }
  })();

  const activeImages = Object.values(activeDetail?.imagesByDetailId || {}).flat();
  const activeDetailRow = activeDetail?.details?.[0] || null;
  const activeStatusKey = String(activeQueueRow?.status || '').toLowerCase().replace(/[_\s-]+/g, '');
  const activeQualityStatus = activeStatusKey === 'cancelled'
    ? 'Cancelled'
    : (activeDetailRow?.Status || activeQueueRow?.qualityStatus || 'Pending');
  const activeQualityStatusKey = String(activeQualityStatus).toLowerCase().replace(/[_\s-]+/g, '');
  const canDecide = activeQueueRow?.isPhysicallyReceived && ['pending', 'cut'].includes(activeStatusKey) && activeQualityStatusKey === 'pending';
  const activeAiScreening = activeDetail?.aiScreening || null;
  const liveAiAccuracy = calculateLiveAiAccuracy(activeAiScreening, detailDraft);

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden" style={rootStyle}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="role-page-title text-2xl font-bold" style={headingStyle}>Hair Quality Check</h1>
          <p className="text-sm" style={{ color: secondaryTextColor }}>
            Scan the exact Hair Submissions waybill. Only physically received hair can be reviewed.
          </p>
        </div>
        <PageHeaderActions
          onRefresh={() => loadQueue()}
          refreshLoading={isLoadingQueue}
          helpTitle="About Hair Quality Check"
          helpContent={<p>This page accepts only Hair_Submissions.Waybill_Code. Walk-in hair must be completed in Salon Schedule and courier hair must be received before quality review.</p>}
        />
      </header>

      {notice.text && (
        <div
          className="rounded-xl border px-3 py-2 text-sm font-medium"
          style={
            notice.kind === 'error' ? { borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c' }
              : notice.kind === 'success' ? { borderColor: '#a7f3d0', backgroundColor: '#ecfdf5', color: '#047857' }
                : { borderColor: '#fde68a', backgroundColor: '#fffbeb', color: '#b45309' }
          }
        >
          {notice.text}
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="rounded-2xl border bg-white p-5 shadow-sm xl:sticky xl:top-4" style={{ borderColor: '#e2e8f0' }}>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <ScanLine size={20} style={{ color: primaryColor }} />
              <div>
                <h2 className="text-base font-semibold" style={headingStyle}>QR waybill scanner</h2>
                <p className="mt-0.5 text-[11px]" style={{ color: tertiaryTextColor }}>Scan with camera or enter the code</p>
              </div>
            </div>
            <span
              className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold"
              style={isCameraOn
                ? { borderColor: '#a7f3d0', backgroundColor: '#ecfdf5', color: '#047857' }
                : { borderColor: '#e2e8f0', backgroundColor: '#f8fafc', color: '#64748b' }}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${isCameraOn ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {isCameraOn ? 'Scanning' : 'Off'}
            </span>
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-2xl bg-slate-950 shadow-inner">
            <video
              ref={videoRef}
              className={`absolute inset-0 h-full w-full object-cover ${isCameraOn ? '' : 'hidden'}`}
              autoPlay
              playsInline
              muted
            />
            {!isCameraOn ? (
              <div className="flex h-full flex-col items-center justify-center px-7 text-center text-slate-300">
                <span className="mb-3 rounded-2xl bg-white/10 p-4">
                  <ScanLine size={34} />
                </span>
                <p className="text-sm font-semibold text-white">Scanner is off</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">Start the camera and place the printed waybill QR inside the frame.</p>
              </div>
            ) : null}
            {isCameraOn ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
                <div className="relative h-[62%] w-[62%] rounded-2xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,0.28)]">
                  <span className="absolute left-1/2 top-1/2 h-px w-[82%] -translate-x-1/2 bg-emerald-300/80 shadow-[0_0_8px_rgba(110,231,183,0.9)]" />
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5" style={cameraNoticeStyle}>
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{cameraStatus.message}</span>
          </div>

          <button
            type="button"
            onClick={handleToggleCamera}
            disabled={isStartingCamera}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-60"
            style={{ backgroundColor: isCameraOn ? '#dc2626' : primaryColor }}
          >
            {isStartingCamera
              ? <Loader2 className="animate-spin" size={16} />
              : isCameraOn ? <CameraOff size={16} /> : <Camera size={16} />}
            {isStartingCamera ? 'Starting camera...' : isCameraOn ? 'Stop scanner' : 'Start QR scanner'}
          </button>

          <div className="my-4 flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            No camera available?
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          <label htmlFor="quality-waybill-manual" className="block text-xs font-semibold text-slate-700">
            Enter donor waybill
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="quality-waybill-manual"
              type="text"
              value={manualWaybillCode}
              onChange={(event) => setManualWaybillCode(normalizeWaybillCodeInput(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleManualWaybillLookup();
                }
              }}
              placeholder="WBXXXXXX"
              maxLength={WAYBILL_CODE_LENGTH}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm uppercase tracking-wider text-slate-900 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
            />
            <button
              type="button"
              onClick={() => { void handleManualWaybillLookup(); }}
              disabled={isScanProcessingRef.current || !isValidWaybillCode(manualWaybillCode)}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: primaryColor }}
            >
              <ScanLine size={15} />
              Find
            </button>
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
            <span>WB + 6 uppercase letters or numbers</span>
            <span className="font-mono">{manualWaybillCode.length}/{WAYBILL_CODE_LENGTH}</span>
          </div>
          <div className="mt-4">
            <WaybillScanResult outcome={scanOutcome} possibleOutcomes={QUALITY_SCAN_OUTCOMES} />
          </div>
        </aside>

        <div className="min-w-0 overflow-hidden rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: '#e2e8f0' }}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={headingStyle}>Submission Review</h2>
            {activeQueueRow ? (
              <span
                className="rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                style={statusBadgeStyle(activeQualityStatus, primaryColor, tertiaryColor)}
              >
                {activeQualityStatus}
              </span>
            ) : null}
          </div>

          {!activeQueueRow ? (
            <p className="text-sm" style={{ color: secondaryTextColor }}>
              Scan a waybill or pick a row from the queue to begin.
            </p>
          ) : (
            <div className="min-w-0 space-y-4">
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full"
                  style={{ backgroundColor: withColorAlpha(primaryColor, 0.12) }}
                >
                  {activeQueueRow.donorPhotoPath && imageUrlsByPath[activeQueueRow.donorPhotoPath] ? (
                    <img src={imageUrlsByPath[activeQueueRow.donorPhotoPath]} alt={activeQueueRow.donorName} className="h-full w-full object-cover" />
                  ) : (
                    <PackageOpen size={24} style={{ color: primaryColor }} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: primaryTextColor }}>{activeQueueRow.donorName}</p>
                  <p className="font-mono text-xs" style={{ color: secondaryTextColor }}>
                    {activeQueueRow.submissionCode}
                  </p>
                  <p className="mt-0.5 text-[11px]" style={{ color: tertiaryTextColor }}>
                    Submitted {formatDateTime(activeQueueRow.createdAt)}
                  </p>
                </div>
              </div>

              <DonorScreeningSummary notes={activeQueueRow.donorNotes} />

              {isLoadingDetail ? (
                <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-6 text-sm" style={{ color: secondaryTextColor }}>
                  <Loader2 size={14} className="animate-spin" /> Loading submission details...
                </div>
              ) : (
                <>
                  <section className="border-t border-slate-200 pt-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold" style={{ color: primaryTextColor }}>
                        Submitted hair photos
                        <span className="ml-2 font-normal" style={{ color: tertiaryTextColor }}>
                          ({activeImages.length})
                        </span>
                      </h3>
                    </div>
                    {activeImages.length ? (
                      <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
                        {activeImages.map((image) => {
                          const url = imageUrlsByPath[image.File_Path];
                          return (
                            <a
                              key={image.Image_ID}
                              href={url || undefined}
                              target={url ? '_blank' : undefined}
                              rel={url ? 'noreferrer' : undefined}
                              className="group relative aspect-[4/3] min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white"
                              title={url ? 'Open full-size photo' : 'Photo unavailable'}
                              onClick={(event) => {
                                if (!url) event.preventDefault();
                              }}
                            >
                              {url ? (
                                <img
                                  src={url}
                                  alt={image.Image_Type || 'Submitted hair'}
                                  className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                                  loading="lazy"
                                />
                              ) : (
                                <span className="flex h-full w-full items-center justify-center" style={{ color: tertiaryTextColor }}>
                                  <ImageIcon size={24} />
                                </span>
                              )}
                              <span className="absolute inset-x-0 bottom-0 truncate bg-slate-950/70 px-2 py-1.5 text-[10px] font-semibold text-white">
                                {humanizeLabel(image.Image_Type || 'Hair photo')}
                              </span>
                            </a>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-5 text-sm text-slate-500">
                        <ImageIcon size={18} />
                        No submitted hair photos are attached to this detail record.
                      </div>
                    )}
                  </section>

                  <section className="border-t border-slate-200 pt-4">
                    <h3 className="text-sm font-semibold" style={{ color: primaryTextColor }}>Inspection details</h3>
                    <p className="mb-4 mt-0.5 text-xs" style={{ color: secondaryTextColor }}>
                      {canDecide
                        ? 'Correct any donor-declared values. Changes save when you approve or reject.'
                        : 'This review is complete - inspection details are read-only.'}
                    </p>

                    {!activeDetailRow ? (
                      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        No detail row exists yet. One will be created automatically when this review is submitted.
                      </div>
                    ) : null}

                    <fieldset disabled={!canDecide || isProcessingAction} className="space-y-4 disabled:opacity-75">
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="block text-sm font-medium text-slate-700">
                          Hair length
                          <div className="relative mt-1">
                            <input
                              type="number"
                              min="0"
                              max="999.99"
                              step="0.01"
                              value={detailDraft.declaredLength}
                              onChange={(event) => setDetailField('declaredLength', event.target.value)}
                              placeholder="e.g. 12"
                              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 pr-9 text-sm text-slate-900 outline-none focus:border-slate-500"
                            />
                            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">in</span>
                          </div>
                        </label>

                        <label className="block text-sm font-medium text-slate-700">
                          Hair color
                          <input
                            value={detailDraft.declaredColor}
                            onChange={(event) => setDetailField('declaredColor', event.target.value)}
                            placeholder="e.g. Black"
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
                          />
                        </label>

                        <label className="block text-sm font-medium text-slate-700">
                          Hair texture
                          <input
                            value={detailDraft.declaredTexture}
                            onChange={(event) => setDetailField('declaredTexture', event.target.value)}
                            placeholder="e.g. Straight or Wavy"
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
                          />
                        </label>

                        <label className="block text-sm font-medium text-slate-700">
                          Hair density
                          <input
                            value={detailDraft.declaredDensity}
                            onChange={(event) => setDetailField('declaredDensity', event.target.value)}
                            placeholder="e.g. Light, Medium, or Heavy"
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
                          />
                        </label>

                        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
                          Hair condition
                          <input
                            value={detailDraft.declaredCondition}
                            onChange={(event) => setDetailField('declaredCondition', event.target.value)}
                            placeholder="Describe the received condition"
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
                          />
                        </label>
                      </div>

                      <div>
                        <p className="text-sm font-medium text-slate-700">Treatment indicators</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                          {[
                            ['isChemicallyTreated', 'Chemically treated'],
                            ['isColored', 'Colored'],
                            ['isBleached', 'Bleached'],
                            ['isRebonded', 'Rebonded'],
                          ].map(([field, label]) => (
                            <label
                              key={field}
                              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                                detailDraft[field]
                                  ? 'border-rose-200 bg-rose-50 text-rose-800'
                                  : 'border-slate-200 bg-slate-50 text-slate-600'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={detailDraft[field]}
                                onChange={(event) => setDetailField(field, event.target.checked)}
                                className="h-4 w-4 rounded border-slate-300"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>

                      <label className="block text-sm font-medium text-slate-700">
                        Inspection notes
                        <textarea
                          value={detailDraft.detailNotes}
                          onChange={(event) => setDetailField('detailNotes', event.target.value)}
                          rows={3}
                          placeholder="Add inspection notes for this hair submission"
                          className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
                        />
                      </label>
                    </fieldset>

                    {activeDetailRow?.Rejection_Reason ? (
                      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                        <span className="font-semibold">Rejection reason: </span>
                        {activeDetailRow.Rejection_Reason}
                      </div>
                    ) : null}
                  </section>

                  <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">Original AI Screening vs Human Inspection</h3>
                        <p className="mt-0.5 text-xs text-slate-500">Changing any comparable human field immediately updates the percentages below.</p>
                      </div>
                      {activeAiScreening && liveAiAccuracy.comparable > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                            AI correct {Number(liveAiAccuracy.aiPercent.toFixed(1))}%
                          </span>
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                            Human changes {Number(liveAiAccuracy.humanPercent.toFixed(1))}%
                          </span>
                        </div>
                      ) : null}
                    </div>
                    {!activeAiScreening ? (
                      <p className="m-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">No AI screening is linked to this submission. Human quality review is still available, but AI accuracy cannot be calculated.</p>
                    ) : (
                      <div className="p-4">
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                          {[
                            ['Length', `${activeAiScreening.Estimated_Length ?? 'N/A'} in`, detailDraft.declaredLength ? `${detailDraft.declaredLength} in` : 'Not provided', 'length'],
                            ['Color', activeAiScreening.Detected_Color, detailDraft.declaredColor || 'Not provided', 'color'],
                            ['Texture', activeAiScreening.Detected_Texture, detailDraft.declaredTexture || 'Not provided', 'texture'],
                            ['Density', activeAiScreening.Detected_Density, detailDraft.declaredDensity || 'Not provided', 'density'],
                            ['Condition', activeAiScreening.Detected_Condition, detailDraft.declaredCondition || 'Not provided', 'condition'],
                          ].map(([label, aiValue, humanValue, field]) => {
                            const changed = liveAiAccuracy.changed.includes(field);
                            return (
                              <div key={field} className={`rounded-lg border p-3 ${changed ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
                                <p className="mt-2 text-[10px] font-semibold uppercase text-slate-400">AI</p>
                                <p className="truncate text-xs font-semibold text-slate-900" title={String(aiValue || '')}>{aiValue || 'Not provided'}</p>
                                <p className="mt-2 text-[10px] font-semibold uppercase text-slate-400">Human</p>
                                <p className="truncate text-xs font-semibold text-slate-900" title={String(humanValue)}>{humanValue}</p>
                                <p className={`mt-2 text-[10px] font-bold ${changed ? 'text-amber-700' : 'text-emerald-700'}`}>{changed ? 'Changed by human' : 'Matches AI'}</p>
                              </div>
                            );
                          })}
                        </div>
                        {liveAiAccuracy.changed.length ? <p className="mt-3 text-xs text-amber-700">Changed fields: {liveAiAccuracy.changed.join(', ')}</p> : null}
                      </div>
                    )}
                  </section>
                </>
              )}

              {showRejectionInput ? (
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: primaryTextColor }}>
                    Rejection reason
                  </label>
                  <textarea
                    value={rejectionReason}
                    onChange={(event) => setRejectionReason(event.target.value)}
                    rows={3}
                    placeholder="Explain why this hair did not pass QA (donor will see this)."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
                    style={{ color: primaryTextColor }}
                  />
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
                {canDecide ? (
                  <>
                    <button
                      type="button"
                      onClick={requestApprove}
                      disabled={isProcessingAction}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      style={{ backgroundColor: tertiaryColor }}
                    >
                      {isProcessingAction ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                      Approve
                    </button>
                    {showRejectionInput ? (
                      <button
                        type="button"
                        onClick={requestReject}
                        disabled={isProcessingAction || !rejectionReason.trim()}
                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        style={{ backgroundColor: '#dc2626' }}
                      >
                        {isProcessingAction ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                        Confirm Rejection
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowRejectionInput(true)}
                        disabled={isProcessingAction}
                        className="inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold disabled:opacity-60"
                        style={{ borderColor: '#fecaca', color: '#b91c1c' }}
                      >
                        <XCircle size={14} />
                        Reject
                      </button>
                    )}
                  </>
                ) : null}

                {!canDecide ? (
                  <p className="text-xs" style={{ color: tertiaryTextColor }}>
                    No further QA action available for this status.
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: '#e2e8f0' }}>
        <div className="flex items-center justify-between gap-2 border-b px-5 py-4" style={{ borderColor: '#e2e8f0' }}>
          <div>
            <h2 className="text-lg font-semibold" style={headingStyle}>Received hair review queue</h2>
            <p className="mt-0.5 text-xs" style={{ color: secondaryTextColor }}>
              Clear groups separate work awaiting review from final quality decisions and cancellations.
            </p>
          </div>
          <span className="text-xs" style={{ color: tertiaryTextColor }}>{queue.length} non-event submissions</span>
        </div>

        {!queue.length && !isLoadingQueue ? (
          <div className="px-4 py-8 text-center text-sm" style={{ color: secondaryTextColor }}>
            No submissions in the QA queue yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
            {Object.entries(queueByStatus).map(([statusLabel, rows]) => (
              <div key={statusLabel} className="rounded-lg border bg-slate-50 p-3" style={{ borderColor: '#e2e8f0' }}>
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                    style={statusBadgeStyle(statusLabel, primaryColor, tertiaryColor)}
                  >
                    {statusLabel}
                  </span>
                  <span className="text-xs font-semibold" style={{ color: tertiaryTextColor }}>{rows.length}</span>
                </div>
                <div className="space-y-2">
                  {!rows.length ? (
                    <p className="text-xs" style={{ color: tertiaryTextColor }}>None.</p>
                  ) : (
                    rows.map((row) => {
                      const isActive = row.submissionId === activeSubmissionId;
                      return (
                        <button
                          key={row.submissionId}
                          type="button"
                          onClick={() => setActiveSubmissionId(row.submissionId)}
                          className="w-full rounded-lg border bg-white px-3 py-2 text-left transition"
                          style={
                            isActive
                              ? { borderColor: primaryColor, backgroundColor: withColorAlpha(primaryColor, 0.08) }
                              : { borderColor: '#e2e8f0' }
                          }
                        >
                          <p className="font-mono text-xs font-semibold" style={{ color: primaryTextColor }}>{row.submissionCode}</p>
                          <p className="mt-0.5 truncate text-xs" style={{ color: secondaryTextColor }}>{row.donorName}</p>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {decisionConfirmation && typeof document !== 'undefined' ? createPortal((
        <div
          className="fixed inset-0 flex items-center justify-center px-4 py-6"
          style={{
            inset: 0,
            zIndex: 2147483000,
            backgroundColor: 'rgba(15, 23, 42, 0.68)',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="quality-decision-title"
            className="w-full max-w-md rounded-2xl border border-slate-200 p-5 shadow-2xl"
            style={{
              backgroundColor: '#ffffff',
              opacity: 1,
              isolation: 'isolate',
            }}
          >
            <div className="flex items-start gap-3">
              <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                decisionConfirmation.decision === 'Approved'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-rose-50 text-rose-700'
              }`}>
                {decisionConfirmation.decision === 'Approved' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
              </span>
              <div>
                <h2 id="quality-decision-title" className="text-lg font-semibold text-slate-900">
                  {decisionConfirmation.decision === 'Approved' ? 'Approve this hair?' : 'Reject this hair?'}
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Waybill <span className="font-mono font-semibold text-slate-800">{decisionConfirmation.submissionCode}</span>
                  {decisionConfirmation.decision === 'Approved'
                    ? ' will be marked Approved and its non-event submission status will become Available for Bundling.'
                    : ' will be marked Rejected. It will not be treated as Cancelled and cannot enter Bundling.'}
                </p>
              </div>
            </div>

            {decisionConfirmation.reason ? (
              <div className="mt-4 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-500">Rejection reason</p>
                <p className="mt-1 text-sm text-rose-800">{decisionConfirmation.reason}</p>
              </div>
            ) : null}

            <p className="mt-4 text-xs text-slate-500">This quality decision cannot be changed after confirmation.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDecisionConfirmation(null)}
                disabled={isProcessingAction}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => void confirmDecision()}
                disabled={isProcessingAction}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
                  decisionConfirmation.decision === 'Approved' ? 'bg-emerald-700' : 'bg-rose-700'
                }`}
              >
                {isProcessingAction ? <Loader2 size={14} className="animate-spin" /> : null}
                Confirm {decisionConfirmation.decision === 'Approved' ? 'approval' : 'rejection'}
              </button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}
