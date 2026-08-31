import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  Download,
  FileText,
  HelpCircle,
  Image as ImageIcon,
  Loader2,
  Package,
  Printer,
  ScanLine,
  Trash2,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import jsPDF from 'jspdf';
import jsQR from 'jsqr';
import { useTheme } from '../../../context/ThemeContext';
import { useToast } from '../../../context/ToastContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import {
  BUNDLE_HAIR_COUNT_TARGET_MAX,
  BUNDLE_HAIR_COUNT_TARGET_MIN,
  HAIR_BUNDLE_STATUS,
  WAYBILL_CODE_LENGTH,
  buildBundleSubmissionCode,
  buildBundleWaybillQrPayload,
  deleteBundleDraft,
  isValidWaybillCode,
  normalizeWaybillCodeInput,
} from '../../../lib/hairSubmissionWorkflow';
import WigSpecificationPicker from './wigCatalog/WigSpecificationPicker';
import useRealtimeRefresh from '../../../hooks/useRealtimeRefresh';
import WaybillScanResult from '../../../components/scanning/WaybillScanResult';
import PageHeaderActions from '../../../components/PageHeaderActions';

const HAIR_SUBMISSIONS_TABLE = 'Hair_Submissions';
const HAIR_SUBMISSION_BUNDLES_TABLE = 'Hair_Submission_Bundles';
const HAIR_SUBMISSION_DETAILS_TABLE = 'Hair_Submission_Details';
const EVENT_ATTENDEES_TABLE = 'Event_Attendees';
const EVENT_REQUESTS_TABLE = 'Event_Requests';
const WIG_SPECIFICATIONS_TABLE = 'Wig_Specifications';
const WIGS_TABLE = 'Wigs';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const PATIENTS_TABLE = 'Patients';
const USER_DETAILS_TABLE = 'user_details';
const SCAN_DEBOUNCE_MS = 2000;
const BUNDLING_SCAN_OUTCOMES = [
  'Eligible Approved/Cut waybill: hair is added to the active draft and inventory becomes Bundling.',
  'Duplicate in the same draft: blocked; member count and records do not change.',
  'Already assigned to another bundle: blocked and the existing bundle remains unchanged.',
  'Pending quality, rejected, cancelled, not Cut, unknown, or malformed waybill: blocked with the exact reason.',
  'Removed from a draft: Bundle_ID is cleared and the hair returns to Cut / Available inventory.',
  'Draft reaches 8-10 hairs and is closed: members move to Wig In Production and the bundle waybill can be printed.',
];
const INITIAL_CONFIRM_MODAL = {
  isOpen: false,
  title: '',
  message: '',
  action: '',
  bundleId: null,
  submissionId: null,
  submissionCode: '',
  tone: 'primary',
};

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

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toLocaleString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function bundleStatusStyle(statusKey, primaryColor, tertiaryColor, secondaryTextColor) {
  switch (statusKey) {
    case HAIR_BUNDLE_STATUS.WIG_COMPLETED.toLowerCase():
      return { backgroundColor: withColorAlpha(tertiaryColor, 0.16), color: tertiaryColor, borderColor: withColorAlpha(tertiaryColor, 0.4) };
    case HAIR_BUNDLE_STATUS.IN_PRODUCTION.toLowerCase():
      return { backgroundColor: withColorAlpha(primaryColor, 0.12), color: primaryColor, borderColor: withColorAlpha(primaryColor, 0.4) };
    case HAIR_BUNDLE_STATUS.DRAFT.toLowerCase():
      return { backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' };
    default:
      return { backgroundColor: '#f1f5f9', color: secondaryTextColor, borderColor: '#cbd5e1' };
  }
}

function normalizeErrorMessage(error, fallback) {
  const message = String(error?.message || '').trim();
  if (!message) return fallback;
  const key = message.toLowerCase();

  if (key.includes('already scanned in this bundle')) return 'This waybill is already scanned in the active draft.';
  if (key.includes('already assigned to bundle')) return 'This waybill is already reserved in another bundle.';
  if (
    key.includes('was rejected or cancelled')
    || (key.includes('cannot be bundled while status is') && key.includes('cancelled'))
  ) return 'This hair was rejected or cancelled and can no longer be scanned into Bundling.';
  if (key.includes('cannot be bundled while status is')) return 'This waybill cannot be bundled because its status is not eligible.';
  if (key.includes('must be in cut status')) return 'This waybill must be in Cut status before bundling.';
  if (key.includes('must be approved in quality check')) return 'This waybill must be approved in Quality Check before it can be bundled.';
  if (key.includes('bundle already has 10 hairs')) return 'This bundle already has 10 hairs. Close it and open a new draft.';
  if (key.includes('bundle must contain 8-10 hairs')) return 'Bundle must contain 8 to 10 hairs before closing.';
  if (key.includes('no hair submission matched')) return 'No hair submission matched this waybill QR.';
  if (key.includes('maximum of 3 open drafts')) return 'You already have 3 open drafts. Close or delete one before opening another.';
  if (key.includes('is not assigned to any bundle')) return 'This waybill is not currently assigned to a draft bundle.';
  if (key.includes('belongs to bundle')) return 'This waybill belongs to a different bundle.';
  if (key.includes('only cut submissions can be removed')) return 'Only Cut-status hairs can be removed from a draft.';
  if (key.includes('no waybill code detected')) return 'No waybill code detected from this QR payload.';
  if (key.includes('waybill payload is required')) return 'Waybill payload is required. Scan again or enter the code manually.';
  if (key.includes('is not draft')) return 'This bundle is already closed or in production.';
  if (key.includes('already in wig in production')) return 'This waybill is already in production and cannot be scanned again.';
  if (key.includes('already in wig created')) return 'This waybill is already completed as Wig Created.';
  if (key.includes('already scanned')) return 'This QR was already scanned.';
  if (key.includes('column hs.submission_code does not exist')) {
    return 'Bundling scan function is outdated in the database. Run the latest Supabase migrations, then refresh.';
  }
  if (key.includes('row-level security')) return 'You do not have permission for this operation. Please contact admin.';
  if (key.includes('not found')) return 'Record not found. Refresh and try again.';
  if (key.includes('permission') || key.includes('not assigned') || key.includes('only specialist/admin')) {
    return 'You do not have permission for this operation.';
  }

  return message || fallback;
}

export default function BundlingPage() {
  const { theme } = useTheme();
  const { showToast } = useToast();
  const primaryColor = theme?.primaryColor || '#0275d8';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const tertiaryTextColor = theme?.tertiaryTextColor || '#94a3b8';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const rootStyle = { color: primaryTextColor, fontFamily: `${bodyFont}, sans-serif` };
  const headingStyle = { color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` };

  const [bundles, setBundles] = useState([]);
  const [bundleMembersByBundleId, setBundleMembersByBundleId] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isFinalizingDraftId, setIsFinalizingDraftId] = useState(null);
  const [isDeletingDraftId, setIsDeletingDraftId] = useState(null);
  const [isRemovingSubmissionId, setIsRemovingSubmissionId] = useState(null);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [activePrintBundle, setActivePrintBundle] = useState(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [wigSpecOptions, setWigSpecOptions] = useState([]);
  const [wishRequests, setWishRequests] = useState([]);
  const [openingWishRequestId, setOpeningWishRequestId] = useState(null);
  const [scannerDraftBundleId, setScannerDraftBundleId] = useState(null);
  const [scannerWaybillCode, setScannerWaybillCode] = useState('');
  const [scannerSpecId, setScannerSpecId] = useState('');
  const [scannerNotes, setScannerNotes] = useState('');
  const [isOpeningScannerBundle, setIsOpeningScannerBundle] = useState(false);
  const [isScanningWaybill, setIsScanningWaybill] = useState(false);
  const [isClosingScannerBundle, setIsClosingScannerBundle] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraStatus, setCameraStatus] = useState({ kind: 'info', message: 'Camera is off. Start scanner to read waybill QR.' });
  const [confirmModal, setConfirmModal] = useState(INITIAL_CONFIRM_MODAL);
  // Master-detail selection: 'create' | `draft-<id>` | `bundle-<id>`.
  const [selectedKey, setSelectedKey] = useState('create');
  const [showHelp, setShowHelp] = useState(false);
  const [scanOutcome, setScanOutcome] = useState(null);

  const videoRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const isScanProcessingRef = useRef(false);
  const removingSubmissionIdRef = useRef(null);
  const lastScanRef = useRef({ raw: '', at: 0 });

  useEffect(() => {
    if (!notice.text || !['error', 'success'].includes(notice.kind)) return;
    showToast({
      type: notice.kind,
      title: notice.kind === 'success' ? 'Bundling updated' : 'Bundling error',
      message: notice.text,
    });
    setNotice({ kind: '', text: '' });
  }, [notice, showToast]);

  const loadData = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });

    try {
      let specRows = await supabase
        .from(WIG_SPECIFICATIONS_TABLE)
        .select('Wig_Specification_ID, Wig_ID, Hair_Length, Hair_Color, Hair_Texture, Hair_Density, Cap_Size, Style')
        .order('Wig_Specification_ID', { ascending: false })
        .limit(500);

      if (specRows.error) throw specRows.error;
      const specs = specRows.data || [];

      const specWigIds = Array.from(new Set(specs.map((row) => Number(row.Wig_ID || 0)).filter(Boolean)));
      let wigNamesById = {};
      if (specWigIds.length) {
        const wigResult = await supabase
          .from(WIGS_TABLE)
          .select('Wig_ID, Wig_Name, Wig_Code, Catalog_Family_Number, Catalog_Image_Path, Stock_Count, Low_Stock_Threshold')
          .in('Wig_ID', specWigIds);
        if (wigResult.error) throw wigResult.error;
        wigNamesById = (wigResult.data || []).reduce((acc, row) => {
          acc[Number(row.Wig_ID)] = row;
          return acc;
        }, {});
      }

      const nextSpecOptions = specs.map((row) => {
        const wig = wigNamesById[Number(row.Wig_ID || 0)] || {};
        const labelParts = [
          wig.Wig_Name || wig.Wig_Code || `Wig #${row.Wig_ID}`,
          row.Style || row.Hair_Texture || '',
          row.Hair_Color || '',
          row.Hair_Length ? `${row.Hair_Length}in` : '',
          row.Cap_Size ? `Cap ${row.Cap_Size}` : '',
        ].map((value) => String(value || '').trim()).filter(Boolean);
        return {
          ...row,
          wigName: wig.Wig_Name || `Wig #${row.Wig_ID}`,
          wigCode: wig.Wig_Code || '',
          familyNumber: wig.Catalog_Family_Number ?? null,
          catalogImagePath: wig.Catalog_Image_Path || '',
          stockCount: Math.max(0, Number(wig.Stock_Count || 0)),
          lowStockThreshold: Math.max(0, Number(wig.Low_Stock_Threshold ?? 2)),
          hairLength: row.Hair_Length ?? '',
          hairColor: row.Hair_Color || '',
          hairTexture: row.Hair_Texture || '',
          hairDensity: row.Hair_Density || '',
          capSize: row.Cap_Size || '',
          style: row.Style || '',
          label: labelParts.join(' | '),
        };
      });
      setWigSpecOptions(nextSpecOptions);

      const wishResult = await supabase
        .from(WIG_REQUESTS_TABLE)
        .select('Req_ID, Request_Code, Patient_ID, Hospital_ID, Status, Request_Date, Requested_Wig_ID, Requested_Wig_Specification_ID, Requested_Cap_Size, Is_Wish_Request, Fulfillment_Status, Fulfillment_Bundle_ID')
        .order('Request_Date', { ascending: true })
        .limit(200);
      const wishWorkflowUnavailable = Boolean(wishResult.error);
      const actionableWishRows = (wishResult.error ? [] : (wishResult.data || [])).filter((row) => {
        const statusKey = String(row.Status || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const fulfillmentKey = String(row.Fulfillment_Status || '').toLowerCase();
        return ['acceptedinproduction', 'acceptednowigavailable', 'inproduction'].includes(statusKey)
          && !['catalog_allocated', 'ready_for_release', 'fulfilled', 'released', 'rejected'].includes(fulfillmentKey);
      });

      const patientIds = Array.from(new Set(actionableWishRows.map((row) => Number(row.Patient_ID || 0)).filter(Boolean)));
      let patientById = {};
      if (patientIds.length) {
        const patientResult = await supabase
          .from(PATIENTS_TABLE)
          .select('Patient_ID, Patient_Code, User_ID, Medical_Condition')
          .in('Patient_ID', patientIds);
        if (patientResult.error) throw patientResult.error;
        patientById = (patientResult.data || []).reduce((acc, patient) => {
          acc[Number(patient.Patient_ID)] = patient;
          return acc;
        }, {});
      }

      setWishRequests(actionableWishRows.map((row) => {
        const specification = nextSpecOptions.find(
          (option) => Number(option.Wig_Specification_ID) === Number(row.Requested_Wig_Specification_ID),
        ) || nextSpecOptions.find((option) => Number(option.Wig_ID) === Number(row.Requested_Wig_ID)) || null;
        const patient = patientById[Number(row.Patient_ID)] || {};
        return {
          ...row,
          patientCode: patient.Patient_Code || `Patient #${row.Patient_ID}`,
          medicalCondition: patient.Medical_Condition || '',
          specification,
        };
      }));

      if (wishWorkflowUnavailable) {
        setNotice({ kind: 'warning', text: 'Requested-wig production queue is not active yet. Apply the new Supabase fulfillment migration to enable it.' });
      }

      let bundlesResult = await supabase
        .from(HAIR_SUBMISSION_BUNDLES_TABLE)
        .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At, Wig_Completed_At, Created_By, Wig_Specification_ID, Wig_Request_ID')
        .order('Created_At', { ascending: false })
        .limit(100);

      if (bundlesResult.error && String(bundlesResult.error.message || '').toLowerCase().includes('wig_request_id')) {
        bundlesResult = await supabase
          .from(HAIR_SUBMISSION_BUNDLES_TABLE)
          .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At, Wig_Completed_At, Created_By, Wig_Specification_ID')
          .order('Created_At', { ascending: false })
          .limit(100);
      }

      if (bundlesResult.error) throw bundlesResult.error;
      const bundleRows = bundlesResult.data || [];
      setBundles(bundleRows);

      const bundleIds = bundleRows
        .map((r) => Number(r.Bundle_ID || 0))
        .filter(Boolean);
      if (bundleIds.length) {
        const membersResult = await supabase
          .from(HAIR_SUBMISSIONS_TABLE)
          .select('Submission_ID, User_ID, Status, Bundle_ID, Event_Attendee_ID, Event_Request_ID, Updated_At')
          .in('Bundle_ID', bundleIds);
        if (membersResult.error) throw membersResult.error;

        const memberRows = membersResult.data || [];
        const userIds = Array.from(new Set(memberRows.map((r) => Number(r.User_ID || 0)).filter(Boolean)));
        const attendeeIds = Array.from(new Set(memberRows.map((r) => Number(r.Event_Attendee_ID || 0)).filter(Boolean)));
        const submissionIds = Array.from(new Set(memberRows.map((r) => Number(r.Submission_ID || 0)).filter(Boolean)));

        let usersByUserId = {};
        if (userIds.length) {
          const { data, error } = await supabase
            .from(USER_DETAILS_TABLE)
            .select('user_id, first_name, middle_name, last_name, suffix')
            .in('user_id', userIds);
          if (error) throw error;
          usersByUserId = (data || []).reduce((acc, r) => {
            acc[Number(r.user_id)] = r;
            return acc;
          }, {});
        }

        let attendeeToRequestId = {};
        let attendeeToWaybillCode = {};
        if (attendeeIds.length) {
          const { data, error } = await supabase
            .from(EVENT_ATTENDEES_TABLE)
            .select('Event_Attendee_ID, Event_Request_ID, Waybill_Code')
            .in('Event_Attendee_ID', attendeeIds);
          if (error) throw error;
          attendeeToRequestId = (data || []).reduce((acc, r) => {
            const attendeeId = Number(r.Event_Attendee_ID || 0);
            if (!attendeeId) return acc;
            acc[attendeeId] = Number(r.Event_Request_ID || 0) || null;
            return acc;
          }, {});
          attendeeToWaybillCode = (data || []).reduce((acc, r) => {
            const attendeeId = Number(r.Event_Attendee_ID || 0);
            if (!attendeeId) return acc;
            acc[attendeeId] = String(r.Waybill_Code || '').trim() || null;
            return acc;
          }, {});
        }

        const requestIds = Array.from(new Set(
          memberRows
            .map((r) => {
              const attendeeId = Number(r.Event_Attendee_ID || 0);
              return Number(attendeeToRequestId[attendeeId] || r.Event_Request_ID || 0);
            })
            .filter(Boolean),
        ));

        let eventsByRequestId = {};
        if (requestIds.length) {
          const { data, error } = await supabase
            .from(EVENT_REQUESTS_TABLE)
            .select('Event_Request_ID, Event_Name')
            .in('Event_Request_ID', requestIds);
          if (error) throw error;
          eventsByRequestId = (data || []).reduce((acc, r) => {
            acc[Number(r.Event_Request_ID)] = r;
            return acc;
          }, {});
        }

        let detailsBySubmissionId = {};
        if (submissionIds.length) {
          const detailResult = await supabase
            .from(HAIR_SUBMISSION_DETAILS_TABLE)
            .select('Submission_Detail_ID, Submission_ID, Declared_Length, Declared_Color, Declared_Texture, Declared_Density, Declared_Condition, Is_Chemically_Treated, Is_Colored, Is_Bleached, Is_Rebonded, Detail_Notes, Status, Updated_At')
            .in('Submission_ID', submissionIds)
            .order('Submission_Detail_ID', { ascending: false });
          if (detailResult.error) throw detailResult.error;
          detailsBySubmissionId = (detailResult.data || []).reduce((acc, row) => {
            const key = Number(row.Submission_ID || 0);
            if (!key || acc[key]) return acc;
            acc[key] = row;
            return acc;
          }, {});
        }

        const grouped = memberRows.reduce((acc, row) => {
          const key = Number(row.Bundle_ID || 0);
          if (!key) return acc;
          if (!acc[key]) acc[key] = [];

          const userId = Number(row.User_ID || 0);
          const attendeeId = Number(row.Event_Attendee_ID || 0);
          const requestId = Number(attendeeToRequestId[attendeeId] || row.Event_Request_ID || 0);
          const waybillCode = String(attendeeToWaybillCode[attendeeId] || '').trim();
          const userDetails = usersByUserId[userId] || {};
          const eventRequest = eventsByRequestId[requestId] || {};
          const detail = detailsBySubmissionId[Number(row.Submission_ID || 0)] || null;

          acc[key].push({
            submissionId: Number(row.Submission_ID || 0),
            userId,
            submissionCode: waybillCode || `#${Number(row.Submission_ID || 0)}`,
            status: row.Status || '',
            eventAttendeeId: attendeeId || null,
            eventRequestId: requestId || null,
            donorName: buildFullName(
              userDetails.first_name,
              userDetails.middle_name,
              userDetails.last_name,
              userDetails.suffix,
            ) || `User #${userId}`,
            eventTitle: eventRequest.Event_Name || (requestId ? `Event #${requestId}` : 'Event not linked'),
            updatedAt: row.Updated_At || null,
            detail,
          });

          return acc;
        }, {});

        setBundleMembersByBundleId(grouped);
      } else {
        setBundleMembersByBundleId({});
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load bundling data.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useRealtimeRefresh({
    channelName: 'specialist-bundling-live',
    tables: [
      HAIR_SUBMISSIONS_TABLE,
      HAIR_SUBMISSION_BUNDLES_TABLE,
      HAIR_SUBMISSION_DETAILS_TABLE,
      EVENT_ATTENDEES_TABLE,
      WIG_SPECIFICATIONS_TABLE,
      WIGS_TABLE,
    ],
    onChange: () => void loadData(),
  });

  const drafts = useMemo(() => bundles.filter((b) => String(b.Status || '').toLowerCase() === HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()), [bundles]);
  const activeBundles = useMemo(() => bundles.filter((b) => String(b.Status || '').toLowerCase() !== HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()), [bundles]);
  const scannerBundleRow = useMemo(
    () => bundles.find((bundle) => Number(bundle.Bundle_ID || 0) === Number(scannerDraftBundleId || 0)) || null,
    [bundles, scannerDraftBundleId],
  );
  const scannerBundleMemberCount = useMemo(
    () => {
      if (!scannerBundleRow) return 0;
      const memberRows = bundleMembersByBundleId[scannerBundleRow.Bundle_ID] || [];
      return memberRows.length;
    },
    [bundleMembersByBundleId, scannerBundleRow],
  );
  const draftCount = drafts.length;
  const activeDraftCounterLabel = `${scannerBundleMemberCount}/${BUNDLE_HAIR_COUNT_TARGET_MAX}`;
  const canCloseActiveDraft = scannerBundleMemberCount >= BUNDLE_HAIR_COUNT_TARGET_MIN
    && scannerBundleMemberCount <= BUNDLE_HAIR_COUNT_TARGET_MAX;

  const openConfirmModal = useCallback((payload) => {
    setConfirmModal({
      ...INITIAL_CONFIRM_MODAL,
      ...payload,
      isOpen: true,
    });
  }, []);

  const closeConfirmModal = useCallback(() => {
    setConfirmModal(INITIAL_CONFIRM_MODAL);
  }, []);

  const stopCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const handleToggleCamera = useCallback(async () => {
    if (isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraStatus({ kind: 'info', message: 'Camera is off. Start scanner to read waybill QR.' });
      return;
    }

    if (!scannerBundleRow) {
      setNotice({ kind: 'warning', text: 'Open or continue a draft bundle before starting the camera scanner.' });
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus({ kind: 'error', message: 'Camera API is unavailable on this browser/device.' });
      return;
    }

    setIsStartingCamera(true);
    setCameraStatus({ kind: 'info', message: 'Initializing camera scanner...' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }

      setIsCameraOn(true);
      setCameraStatus({ kind: 'success', message: 'Scanner is running. Point camera at a donor waybill QR.' });
    } catch (error) {
      setCameraStatus({ kind: 'error', message: normalizeErrorMessage(error, 'Could not access the camera.') });
    } finally {
      setIsStartingCamera(false);
    }
  }, [isCameraOn, scannerBundleRow, stopCamera]);

  const handleContinueDraft = useCallback((draft, { silent = false } = {}) => {
    const bundleId = Number(draft?.Bundle_ID || 0);
    if (!bundleId) return;
    setScannerDraftBundleId(bundleId);
    setScannerWaybillCode('');
    setScannerSpecId(String(draft?.Wig_Specification_ID || ''));
    setScannerNotes(String(draft?.Notes || ''));
    if (!silent) {
      setNotice({ kind: 'info', text: `Draft #${bundleId} is open. Scan waybills to reach ${BUNDLE_HAIR_COUNT_TARGET_MIN}-${BUNDLE_HAIR_COUNT_TARGET_MAX} and close it.` });
    }
  }, []);

  useEffect(() => {
    if (!drafts.length) {
      if (scannerDraftBundleId) setScannerDraftBundleId(null);
      return;
    }

    const currentExists = drafts.some((row) => Number(row.Bundle_ID || 0) === Number(scannerDraftBundleId || 0));
    if (!currentExists) {
      handleContinueDraft(drafts[0], { silent: true });
    }
  }, [drafts, handleContinueDraft, scannerDraftBundleId]);

  // When a draft becomes the active scanner draft (opened/continued), focus
  // the detail panel on it.
  useEffect(() => {
    if (scannerDraftBundleId) setSelectedKey(`draft-${scannerDraftBundleId}`);
  }, [scannerDraftBundleId]);

  const handleFinalizeDraftNow = useCallback(async (draft) => {
    if (!draft?.Bundle_ID) return;
    setIsFinalizingDraftId(draft.Bundle_ID);
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('bundle_close_draft', {
        p_bundle_id: Number(draft.Bundle_ID),
      });
      if (result.error) throw result.error;

      const payload = result.data || {};
      const closedBundle = payload.bundle || {};
      const bundleCode = closedBundle.Bundle_Waybill_Code || `WB${String(Number(draft.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;
      const memberCount = Number(payload.member_count || (bundleMembersByBundleId[draft.Bundle_ID] || []).length || 0);

      if (Number(scannerDraftBundleId || 0) === Number(draft.Bundle_ID)) {
        setScannerDraftBundleId(null);
        setScannerWaybillCode('');
        if (isCameraOn) {
          stopCamera();
          setIsCameraOn(false);
          setCameraStatus({ kind: 'info', message: 'Camera is off. Start scanner to read waybill QR.' });
        }
      }

      await loadData();
      setNotice({ kind: 'success', text: `Bundle ${bundleCode} closed with ${memberCount} hairs. Waybill is ready to print.` });
      setActivePrintBundle({
        bundleId: Number(closedBundle.Bundle_ID || draft.Bundle_ID),
        submissionCode: bundleCode,
        notes: closedBundle.Notes || '',
        memberCount,
        createdAt: closedBundle.Created_At || new Date().toISOString(),
        qrDataUrl: '',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: normalizeErrorMessage(error, 'Unable to finalize draft.') });
    } finally {
      setIsFinalizingDraftId(null);
    }
  }, [bundleMembersByBundleId, isCameraOn, loadData, scannerDraftBundleId, stopCamera]);

  const handleDeleteDraftNow = useCallback(async (draft) => {
    if (!draft?.Bundle_ID) return;
    setIsDeletingDraftId(draft.Bundle_ID);
    setNotice({ kind: '', text: '' });
    try {
      const { error } = await deleteBundleDraft({ bundleId: draft.Bundle_ID });
      if (error) throw error;
      setNotice({ kind: 'success', text: `Draft #${draft.Bundle_ID} deleted.` });
      if (Number(scannerDraftBundleId || 0) === Number(draft.Bundle_ID)) {
        setScannerDraftBundleId(null);
        setScannerWaybillCode('');
      }
      await loadData();
    } catch (error) {
      setNotice({ kind: 'error', text: normalizeErrorMessage(error, 'Unable to delete draft.') });
    } finally {
      setIsDeletingDraftId(null);
    }
  }, [loadData, scannerDraftBundleId]);

  const handleOpenDraftBundle = async () => {
    if (draftCount >= 3) {
      setNotice({ kind: 'warning', text: 'You already have 3 open drafts. Close or delete one before opening a new draft.' });
      return;
    }

    const numericSpecId = Number(scannerSpecId || 0);
    if (!numericSpecId) {
      setNotice({ kind: 'warning', text: 'Select a wig specification before opening a draft.' });
      return;
    }

    setIsOpeningScannerBundle(true);
    setNotice({ kind: '', text: '' });

    try {
      const result = await supabase.rpc('create_hair_bundle_draft', {
        p_wig_specification_id: numericSpecId,
        p_notes: String(scannerNotes || '').trim() || null,
      });
      if (result.error) throw result.error;

      const bundle = result.data || {};
      const nextBundleId = Number(bundle.Bundle_ID || 0);
      if (!nextBundleId) {
        throw new Error('Bundle draft was created but no Bundle_ID was returned.');
      }

      setScannerDraftBundleId(nextBundleId);
      await loadData();
      setNotice({ kind: 'success', text: `Draft #${nextBundleId} is open. Scan 8-10 waybills to close it.` });
    } catch (error) {
      setNotice({ kind: 'error', text: normalizeErrorMessage(error, 'Unable to open draft bundle.') });
    } finally {
      setIsOpeningScannerBundle(false);
    }
  };

  const handleOpenWishRequestDraft = async (requestRow) => {
    const requestId = Number(requestRow?.Req_ID || 0);
    if (!requestId) return;
    if (draftCount >= 3) {
      setNotice({ kind: 'warning', text: 'You already have 3 open drafts. Close or delete one before opening this requested wig.' });
      return;
    }

    setOpeningWishRequestId(requestId);
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('create_wig_request_bundle_draft', {
        p_wig_request_id: requestId,
        p_notes: `Requested wig for ${requestRow.patientCode || `patient #${requestRow.Patient_ID}`}`,
      });
      if (result.error) throw result.error;
      const bundle = result.data?.bundle || {};
      const bundleId = Number(bundle.Bundle_ID || 0);
      if (!bundleId) throw new Error('The linked draft was created but no Bundle_ID was returned.');

      setScannerSpecId(String(bundle.Wig_Specification_ID || requestRow.Requested_Wig_Specification_ID || ''));
      setScannerNotes(bundle.Notes || '');
      setScannerDraftBundleId(bundleId);
      setSelectedKey(`draft-${bundleId}`);
      await loadData();
      setNotice({
        kind: 'success',
        text: `${requestRow.Request_Code || `Request #${requestId}`} is linked to draft #${bundleId}. Wig, cap size, patient, and request references were assigned automatically.`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: normalizeErrorMessage(error, 'Unable to open the requested wig draft.') });
    } finally {
      setOpeningWishRequestId(null);
    }
  };

  const handleScanWaybillIntoBundle = useCallback(async (rawValue, { fromCamera = false } = {}) => {
    if (isScanProcessingRef.current) return;
    const bundleId = Number(scannerDraftBundleId || 0);
    const rawWaybill = String(rawValue || '').trim();
    const waybill = fromCamera && rawWaybill.startsWith('{')
      ? rawWaybill
      : normalizeWaybillCodeInput(rawWaybill);
    if (!bundleId) {
      setNotice({ kind: 'warning', text: 'Open a draft first.' });
      if (fromCamera) setCameraStatus({ kind: 'warning', message: 'Open a draft before scanning.' });
      setScanOutcome({ tone: 'warning', title: 'No active draft', action: 'No database change', status: 'Blocked', nextStep: 'Open or continue a draft bundle first' });
      return;
    }
    if (!waybill) {
      setNotice({ kind: 'warning', text: 'Enter or scan a waybill code.' });
      if (fromCamera) setCameraStatus({ kind: 'warning', message: 'No QR code was detected from camera frame.' });
      setScanOutcome({ tone: 'warning', title: 'No waybill detected', action: 'No database change', status: 'Blocked', nextStep: 'Scan a QR or enter the complete WB code' });
      return;
    }
    if (!fromCamera && !isValidWaybillCode(waybill)) {
      setNotice({ kind: 'warning', text: 'Enter a complete waybill: WB followed by 6 letters or numbers.' });
      setScanOutcome({ tone: 'warning', title: 'Incomplete waybill', waybill, action: 'No database change', status: 'Blocked', nextStep: 'Enter WB followed by 6 letters or numbers' });
      return;
    }

    isScanProcessingRef.current = true;
    setIsScanningWaybill(true);
    setNotice({ kind: '', text: '' });

    try {
      let rpcWaybillPayload = waybill;
      if (isValidWaybillCode(waybill)) {
        const attendeeLookup = await supabase
          .from(EVENT_ATTENDEES_TABLE)
          .select('Event_Attendee_ID')
          .eq('Waybill_Code', waybill)
          .maybeSingle();
        if (attendeeLookup.error) throw attendeeLookup.error;

        // Non-event waybills encode Submission_ID in base 36 and do not have an
        // Event_Attendees row. Give the RPC the decoded ID so both paths work.
        if (!attendeeLookup.data?.Event_Attendee_ID) {
          const decodedSubmissionId = Number.parseInt(waybill.slice(2), 36);
          if (Number.isInteger(decodedSubmissionId) && decodedSubmissionId > 0) {
            const submissionLookup = await supabase
              .from(HAIR_SUBMISSIONS_TABLE)
              .select('Submission_ID')
              .eq('Submission_ID', decodedSubmissionId)
              .eq('From_Event', false)
              .maybeSingle();
            if (submissionLookup.error) throw submissionLookup.error;
            if (submissionLookup.data?.Submission_ID) {
              rpcWaybillPayload = JSON.stringify({
                Submission_ID: submissionLookup.data.Submission_ID,
                Waybill_Code: waybill,
              });
            }
          }
        }
      }

      const result = await supabase.rpc('bundle_scan_add_waybill', {
        p_bundle_id: bundleId,
        p_waybill_payload: rpcWaybillPayload,
      });
      if (result.error) throw result.error;

      const payload = result.data || {};
      const memberCount = Number(payload?.member_count || 0);
      const submissionCode = payload?.submission?.Waybill_Code || waybill;

      setScannerWaybillCode('');
      await loadData();
      if (fromCamera) {
        setCameraStatus({
          kind: 'success',
          message: `Scanned ${submissionCode}. Bundle count is now ${memberCount}.`,
        });
      }
      setNotice({
        kind: 'success',
        text: `Waybill ${submissionCode} added to bundle #${bundleId}. Current count: ${memberCount}.`,
      });
      setScanOutcome({
        tone: 'success', title: 'Hair added to draft', waybill: submissionCode,
        subject: `Submission #${payload?.submission?.Submission_ID || 'N/A'}`,
        action: `Added to bundle #${bundleId}; count is now ${memberCount}`,
        status: 'Bundling',
        nextStep: memberCount >= BUNDLE_HAIR_COUNT_TARGET_MIN
          ? 'Close the draft now or scan up to 10 total hairs'
          : `Scan ${BUNDLE_HAIR_COUNT_TARGET_MIN - memberCount} more eligible hair${BUNDLE_HAIR_COUNT_TARGET_MIN - memberCount === 1 ? '' : 's'} to unlock closing`,
        statusChanges: [
          { label: 'Bundle assignment', before: 'None', after: `Draft #${bundleId}` },
          { label: 'Hair submission', before: 'Cut', after: 'Cut' },
          { label: 'Cut inventory', before: 'Cut / Available', after: 'Bundling' },
        ],
      });
    } catch (error) {
      const normalized = normalizeErrorMessage(error, 'Unable to scan waybill into bundle.');
      setNotice({ kind: 'error', text: normalized });
      if (fromCamera) setCameraStatus({ kind: 'error', message: normalized });
      setScanOutcome({
        tone: 'error', title: 'Hair was not added', waybill: isValidWaybillCode(waybill) ? waybill : '',
        action: 'No bundle or inventory change', status: 'Blocked', nextStep: normalized,
      });
    } finally {
      setIsScanningWaybill(false);
      isScanProcessingRef.current = false;
    }
  }, [loadData, scannerDraftBundleId]);

  const handleCloseScannerBundleNow = useCallback(async (bundleIdInput) => {
    const bundleId = Number(bundleIdInput || scannerDraftBundleId || 0);
    if (!bundleId) {
      setNotice({ kind: 'warning', text: 'Open a draft first.' });
      return;
    }

    setIsClosingScannerBundle(true);
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('bundle_close_draft', {
        p_bundle_id: bundleId,
      });
      if (result.error) throw result.error;

      const payload = result.data || {};
      const closedBundle = payload.bundle || {};
      const code = closedBundle.Bundle_Waybill_Code || `WB${String(Number(bundleId || 0)).padStart(6, '0').slice(-6)}`;
      const memberCount = Number(payload.member_count || scannerBundleMemberCount || 0);

      await loadData();
      setScannerDraftBundleId(null);
      setScannerWaybillCode('');
      if (isCameraOn) {
        stopCamera();
        setIsCameraOn(false);
        setCameraStatus({ kind: 'info', message: 'Camera is off. Start scanner to read waybill QR.' });
      }
      setNotice({ kind: 'success', text: `Bundle ${code} closed with ${memberCount} hairs. Waybill is ready to print.` });
      setScanOutcome({
        tone: 'success', title: 'Draft closed successfully', waybill: code,
        subject: `Bundle #${bundleId}`, action: `Finalized ${memberCount} hairs for production`,
        status: 'Wig In Production', nextStep: 'Print and attach the bundle waybill',
        statusChanges: [
          { label: 'Bundle', before: 'Draft', after: 'In Production' },
          { label: 'Member submissions', before: 'Cut', after: 'Wig In Production' },
          { label: 'Cut inventory', before: 'Bundling', after: 'Bundling' },
        ],
      });
      setActivePrintBundle({
        bundleId: Number(closedBundle.Bundle_ID || bundleId),
        submissionCode: code,
        notes: closedBundle.Notes || '',
        memberCount,
        createdAt: closedBundle.Created_At || new Date().toISOString(),
        qrDataUrl: '',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: normalizeErrorMessage(error, 'Unable to close draft bundle.') });
    } finally {
      setIsClosingScannerBundle(false);
    }
  }, [isCameraOn, loadData, scannerBundleMemberCount, scannerDraftBundleId, stopCamera]);

  const handleFinalizeDraft = (draft) => {
    const draftIds = (bundleMembersByBundleId[draft.Bundle_ID] || [])
      .map((row) => Number(row.submissionId || 0))
      .filter(Boolean);
    if (!draftIds.length) {
      setNotice({ kind: 'warning', text: 'This draft has no scanned hairs yet.' });
      return;
    }

    const outsideTarget = draftIds.length < BUNDLE_HAIR_COUNT_TARGET_MIN || draftIds.length > BUNDLE_HAIR_COUNT_TARGET_MAX;
    openConfirmModal({
      action: 'finalize-draft',
      bundleId: draft.Bundle_ID,
      tone: outsideTarget ? 'warning' : 'primary',
      title: `Finalize draft #${draft.Bundle_ID}?`,
      message: outsideTarget
        ? `This draft has ${draftIds.length} hairs. Recommended target is ${BUNDLE_HAIR_COUNT_TARGET_MIN}-${BUNDLE_HAIR_COUNT_TARGET_MAX}. Finalize anyway?`
        : `This draft has ${draftIds.length} hairs and will move to Wig In Production.`,
    });
  };

  const handleDeleteDraft = (draft) => {
    openConfirmModal({
      action: 'delete-draft',
      bundleId: draft.Bundle_ID,
      tone: 'danger',
      title: `Delete draft #${draft.Bundle_ID}?`,
      message: 'This action cannot be undone.',
    });
  };

  const handleRemoveDraftMember = useCallback((bundleId, member) => {
    const submissionId = Number(member?.submissionId || 0);
    if (!bundleId || !submissionId) return;
    openConfirmModal({
      action: 'remove-draft-member',
      bundleId: Number(bundleId),
      submissionId,
      submissionCode: member?.submissionCode || '',
      tone: 'warning',
      title: `Remove ${member?.submissionCode || 'waybill'} from draft?`,
      message: 'This will remove the hair from this draft and clear its Bundle_ID.',
    });
  }, [openConfirmModal]);

  const handleRemoveDraftMemberNow = useCallback(async ({ bundleId, submissionId, submissionCode }) => {
    if (!bundleId || !submissionId) return;
    if (removingSubmissionIdRef.current) return;
    removingSubmissionIdRef.current = Number(submissionId);
    setIsRemovingSubmissionId(Number(submissionId));
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('bundle_remove_waybill_from_draft', {
        p_bundle_id: Number(bundleId),
        p_submission_id: Number(submissionId),
      });
      if (result.error) throw result.error;
      const payload = result.data || {};
      const memberCount = Number(payload?.member_count || 0);
      setBundleMembersByBundleId((current) => ({
        ...current,
        [Number(bundleId)]: (current[Number(bundleId)] || []).filter(
          (member) => Number(member.submissionId) !== Number(submissionId),
        ),
      }));
      await loadData();
      setNotice({
        kind: 'success',
        text: `${submissionCode || `Submission #${submissionId}`} removed from draft #${bundleId}. Current count: ${memberCount}.`,
      });
      setScanOutcome({
        tone: 'info', title: 'Hair removed from draft', waybill: submissionCode,
        subject: `Submission #${submissionId}`, action: `Removed from bundle #${bundleId}`,
        status: 'Cut / Available', nextStep: 'The hair may be scanned into another eligible draft',
        statusChanges: [
          { label: 'Bundle assignment', before: `Draft #${bundleId}`, after: 'None' },
          { label: 'Hair submission', before: 'Cut', after: 'Cut' },
          { label: 'Cut inventory', before: 'Bundling', after: 'Cut / Available' },
        ],
      });
    } catch (error) {
      const message = normalizeErrorMessage(error, 'Unable to remove this hair from draft.');
      setNotice({ kind: 'error', text: message });
      setScanOutcome({
        tone: 'error', title: 'Hair was not removed', waybill: submissionCode,
        subject: `Submission #${submissionId}`, action: 'No bundle or inventory change',
        status: 'Blocked', nextStep: message,
      });
    } finally {
      removingSubmissionIdRef.current = null;
      setIsRemovingSubmissionId(null);
    }
  }, [loadData]);

  const handleCloseScannerBundle = () => {
    const bundleId = Number(scannerDraftBundleId || 0);
    if (!bundleId) {
      setNotice({ kind: 'warning', text: 'Open a draft first.' });
      return;
    }
    openConfirmModal({
      action: 'close-scanner-bundle',
      bundleId,
      tone: 'primary',
      title: `Close draft #${bundleId}?`,
      message: `This will finalize the draft and print-ready waybill if it has ${BUNDLE_HAIR_COUNT_TARGET_MIN}-${BUNDLE_HAIR_COUNT_TARGET_MAX} hairs.`,
    });
  };

  const handleConfirmModalSubmit = async () => {
    const {
      action,
      bundleId,
      submissionId,
      submissionCode,
    } = confirmModal;
    closeConfirmModal();
    if (!action || !bundleId) return;

    if (action === 'finalize-draft') {
      const draft = drafts.find((row) => Number(row.Bundle_ID || 0) === Number(bundleId));
      if (!draft) {
        setNotice({ kind: 'error', text: 'Draft not found. Refresh and try again.' });
        return;
      }
      await handleFinalizeDraftNow(draft);
      return;
    }

    if (action === 'delete-draft') {
      const draft = drafts.find((row) => Number(row.Bundle_ID || 0) === Number(bundleId));
      if (!draft) {
        setNotice({ kind: 'error', text: 'Draft not found. Refresh and try again.' });
        return;
      }
      await handleDeleteDraftNow(draft);
      return;
    }

    if (action === 'close-scanner-bundle') {
      await handleCloseScannerBundleNow(bundleId);
      return;
    }

    if (action === 'remove-draft-member') {
      await handleRemoveDraftMemberNow({
        bundleId,
        submissionId,
        submissionCode,
      });
    }
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
        if (!scannerCanvasRef.current) scannerCanvasRef.current = document.createElement('canvas');
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
        void handleScanWaybillIntoBundle(decoded, { fromCamera: true });
      } catch {
        // ignore frame-level scanner errors
      }
    }, 280);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isCameraOn, handleScanWaybillIntoBundle]);

  useEffect(() => {
    if (!scannerBundleRow && isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraStatus({ kind: 'info', message: 'Camera stopped because there is no active draft bundle.' });
    }
  }, [isCameraOn, scannerBundleRow, stopCamera]);

  useEffect(() => () => {
    stopCamera();
  }, [stopCamera]);

  const handleOpenPrint = async (bundleRow) => {
    const code = bundleRow.Bundle_Waybill_Code
      || buildBundleSubmissionCode({ bundleId: bundleRow.Bundle_ID, createdAt: bundleRow.Created_At });
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(
        buildBundleWaybillQrPayload({ bundleId: bundleRow.Bundle_ID, bundleWaybillCode: code }),
        { errorCorrectionLevel: 'M', margin: 1, scale: 8 },
      );
    } catch {
      qrDataUrl = '';
    }
    setActivePrintBundle({
      bundleId: bundleRow.Bundle_ID,
      submissionCode: code,
      notes: bundleRow.Notes || '',
      memberCount: (bundleMembersByBundleId[bundleRow.Bundle_ID] || []).length,
      createdAt: bundleRow.Created_At,
      qrDataUrl,
    });
  };

  useEffect(() => {
    if (activePrintBundle && !activePrintBundle.qrDataUrl && activePrintBundle.bundleId) {
      let cancelled = false;
      QRCode.toDataURL(
        buildBundleWaybillQrPayload({ bundleId: activePrintBundle.bundleId, bundleWaybillCode: activePrintBundle.submissionCode }),
        { errorCorrectionLevel: 'M', margin: 1, scale: 8 },
      ).then((url) => {
        if (!cancelled) {
          setActivePrintBundle((prev) => (prev && prev.bundleId === activePrintBundle.bundleId ? { ...prev, qrDataUrl: url } : prev));
        }
      });
      return () => { cancelled = true; };
    }
    return undefined;
  }, [activePrintBundle]);

  const handlePrint = () => {
    if (typeof window !== 'undefined' && window.print) window.print();
  };

  const handleSavePdf = () => {
    if (!activePrintBundle?.qrDataUrl) return;
    setIsExportingPdf(true);
    try {
      const pdf = new jsPDF({ unit: 'mm', format: 'a5', orientation: 'portrait' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      pdf.text('Donivra WIG BUNDLE WAYBILL', pageWidth / 2, margin + 6, { align: 'center' });

      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.text('Scan on Upload Wig Stocks after wig completion', pageWidth / 2, margin + 12, { align: 'center' });

      const qrSize = 70;
      pdf.addImage(activePrintBundle.qrDataUrl, 'PNG', (pageWidth - qrSize) / 2, margin + 18, qrSize, qrSize);

      pdf.setFontSize(13);
      pdf.setFont('helvetica', 'bold');
      pdf.text(activePrintBundle.submissionCode, pageWidth / 2, margin + 96, { align: 'center' });

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.text(`Hairs in bundle: ${activePrintBundle.memberCount}`, pageWidth / 2, margin + 104, { align: 'center' });
      if (activePrintBundle.notes) {
        pdf.setFontSize(9);
        pdf.text(activePrintBundle.notes, pageWidth / 2, margin + 110, { align: 'center', maxWidth: pageWidth - 2 * margin });
      }

      pdf.setFontSize(8);
      pdf.setTextColor(120);
      pdf.text(
        'Keep this waybill with the bundle. After the wig is finished, scan it on Upload Wig Stocks > Complete Wig from Bundle to fan-notify donors.',
        pageWidth / 2,
        pageHeight - margin,
        { align: 'center', maxWidth: pageWidth - 2 * margin },
      );

      pdf.save(`bundle-${activePrintBundle.submissionCode}.pdf`);
    } finally {
      setIsExportingPdf(false);
    }
  };

  const stats = useMemo(() => {
    const inProduction = activeBundles.filter((b) => String(b.Status || '').toLowerCase() === HAIR_BUNDLE_STATUS.IN_PRODUCTION.toLowerCase()).length;
    const wigCreated = activeBundles.filter((b) => String(b.Status || '').toLowerCase() === HAIR_BUNDLE_STATUS.WIG_COMPLETED.toLowerCase()).length;
    return [
      { id: 'drafts', label: 'Open Drafts', value: drafts.length, Icon: Package, accent: '#b45309', tint: '#fffbeb' },
      { id: 'inProduction', label: 'In Production', value: inProduction, Icon: ScanLine, accent: primaryColor, tint: withColorAlpha(primaryColor, 0.08) },
      { id: 'wigCompleted', label: 'Wig Created', value: wigCreated, Icon: CheckCircle2, accent: tertiaryColor, tint: withColorAlpha(tertiaryColor, 0.1) },
      { id: 'activeDraft', label: 'Hairs in Active Draft', value: scannerBundleMemberCount, Icon: FileText, accent: primaryColor, tint: withColorAlpha(primaryColor, 0.08) },
    ];
  }, [drafts, activeBundles, scannerBundleMemberCount, primaryColor, tertiaryColor]);

  // Highlight where the specialist currently is in the bundling process.
  const currentFlowStep = scannerBundleRow ? (canCloseActiveDraft ? 3 : 2) : 1;

  // Master-detail selection resolution.
  const selectedDraftRow = String(selectedKey).startsWith('draft-')
    ? drafts.find((d) => `draft-${d.Bundle_ID}` === selectedKey) || null
    : null;
  const selectedBundleRow = String(selectedKey).startsWith('bundle-')
    ? activeBundles.find((b) => `bundle-${b.Bundle_ID}` === selectedKey) || null
    : null;
  const showCreatePanel = selectedKey === 'create' || (!selectedDraftRow && !selectedBundleRow);
  const flowSteps = [
    { id: 1, title: 'Open Draft', detail: 'Pick a wig specification and open a draft bundle.' },
    { id: 2, title: 'Scan Waybills', detail: 'Scan each donor waybill once with the camera or by typing it.' },
    { id: 3, title: 'Close at 8-10', detail: `Finalize once the bundle has ${BUNDLE_HAIR_COUNT_TARGET_MIN}-${BUNDLE_HAIR_COUNT_TARGET_MAX} hairs.` },
    { id: 4, title: 'Print Waybill', detail: 'Print and attach the bundle waybill for production.' },
  ];

  const cameraNoticeStyle = (() => {
    if (cameraStatus.kind === 'error') return { borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c' };
    if (cameraStatus.kind === 'warning') return { borderColor: '#fde68a', backgroundColor: '#fffbeb', color: '#b45309' };
    if (cameraStatus.kind === 'success') return { borderColor: '#a7f3d0', backgroundColor: '#ecfdf5', color: '#047857' };
    return { borderColor: withColorAlpha(primaryColor, 0.3), backgroundColor: withColorAlpha(primaryColor, 0.08), color: primaryColor };
  })();

  const renderPortal = useCallback((node) => {
    if (typeof document === 'undefined') return node;
    return createPortal(node, document.body);
  }, []);

  const renderBundleHairDetails = useCallback((bundle, { allowRemove = false } = {}) => {
    const members = bundleMembersByBundleId[Number(bundle.Bundle_ID || 0)] || [];
    if (!members.length) {
      return (
        <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: '#e2e8f0', color: tertiaryTextColor }}>
          No hairs scanned in this bundle yet.
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {members.map((member) => {
          const detail = member.detail || {};
          return (
            <div key={`${bundle.Bundle_ID}-${member.submissionId}`} className="rounded-lg border bg-white p-3" style={{ borderColor: '#e2e8f0' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-mono text-xs font-semibold" style={{ color: primaryTextColor }}>{member.submissionCode}</p>
                  <p className="text-sm font-semibold" style={{ color: primaryTextColor }}>{member.donorName}</p>
                  <p className="text-xs" style={{ color: tertiaryTextColor }}>{member.eventTitle}</p>
                </div>
                {allowRemove ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveDraftMember(bundle.Bundle_ID, member)}
                    disabled={isRemovingSubmissionId !== null}
                    className="inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ borderColor: '#fecaca', color: '#b91c1c' }}
                  >
                    {isRemovingSubmissionId === member.submissionId
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Trash2 size={12} />}
                    {isRemovingSubmissionId === member.submissionId ? 'Removing...' : 'Remove'}
                  </button>
                ) : (
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ borderColor: '#cbd5e1', color: secondaryTextColor, backgroundColor: '#f8fafc' }}
                  >
                    {member.status || '-'}
                  </span>
                )}
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-3">
                <p style={{ color: secondaryTextColor }}>Length: <span style={{ color: primaryTextColor }}>{detail.Declared_Length ? `${detail.Declared_Length} in` : '-'}</span></p>
                <p style={{ color: secondaryTextColor }}>Color: <span style={{ color: primaryTextColor }}>{detail.Declared_Color || '-'}</span></p>
                <p style={{ color: secondaryTextColor }}>Texture: <span style={{ color: primaryTextColor }}>{detail.Declared_Texture || '-'}</span></p>
                <p style={{ color: secondaryTextColor }}>Density: <span style={{ color: primaryTextColor }}>{detail.Declared_Density || '-'}</span></p>
                <p style={{ color: secondaryTextColor }}>Condition: <span style={{ color: primaryTextColor }}>{detail.Declared_Condition || '-'}</span></p>
                <p style={{ color: secondaryTextColor }}>Chemically treated: <span style={{ color: primaryTextColor }}>{detail.Is_Chemically_Treated ? 'Yes' : 'No'}</span></p>
                <p style={{ color: secondaryTextColor }}>Colored: <span style={{ color: primaryTextColor }}>{detail.Is_Colored ? 'Yes' : 'No'}</span></p>
                <p style={{ color: secondaryTextColor }}>Bleached: <span style={{ color: primaryTextColor }}>{detail.Is_Bleached ? 'Yes' : 'No'}</span></p>
                <p style={{ color: secondaryTextColor }}>Rebonded: <span style={{ color: primaryTextColor }}>{detail.Is_Rebonded ? 'Yes' : 'No'}</span></p>
              </div>
              {detail.Detail_Notes ? (
                <p className="mt-2 text-[11px]" style={{ color: secondaryTextColor }}>
                  Notes: <span style={{ color: primaryTextColor }}>{detail.Detail_Notes}</span>
                </p>
              ) : null}
              <p className="mt-1 text-[10px]" style={{ color: tertiaryTextColor }}>
                Updated: {formatDateTime(member.updatedAt || detail.Updated_At)}
              </p>
            </div>
          );
        })}
      </div>
    );
  }, [bundleMembersByBundleId, handleRemoveDraftMember, isRemovingSubmissionId, primaryTextColor, secondaryTextColor, tertiaryTextColor]);

  return (
    <div className="space-y-6" style={rootStyle}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
            <h1 className="role-page-title text-2xl font-bold md:text-3xl" style={headingStyle}>Bundling</h1>
            <p className="text-sm" style={{ color: secondaryTextColor }}>
              Open a draft, scan {BUNDLE_HAIR_COUNT_TARGET_MIN}-{BUNDLE_HAIR_COUNT_TARGET_MAX} donor waybills, then close it to print the bundle waybill.
            </p>
        </div>
        <PageHeaderActions
          onHelp={() => setShowHelp(true)}
          helpTitle="How bundling works"
          onRefresh={() => loadData()}
          refreshLoading={isLoading}
        />
      </header>

      {notice.text && !['error', 'success'].includes(notice.kind) && (
        <div
          className="rounded-xl border px-3 py-2 text-sm font-medium"
          style={
            notice.kind === 'error' ? { borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c' }
              : notice.kind === 'success' ? { borderColor: '#a7f3d0', backgroundColor: '#ecfdf5', color: '#047857' }
                : notice.kind === 'info' ? { borderColor: withColorAlpha(primaryColor, 0.35), backgroundColor: withColorAlpha(primaryColor, 0.08), color: primaryColor }
                  : { borderColor: '#fde68a', backgroundColor: '#fffbeb', color: '#b45309' }
          }
        >
          {notice.text}
        </div>
      )}

      <WaybillScanResult outcome={scanOutcome} possibleOutcomes={BUNDLING_SCAN_OUTCOMES} />

      {wishRequests.length > 0 ? (
      <section className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-bold text-amber-950">
              <AlertCircle size={16} /> Requested wigs without stock
            </h2>
            <p className="mt-0.5 text-xs text-amber-800">Accepted hospital wishes appear here first. Opening a draft locks the request to one production bundle.</p>
          </div>
          <span className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-bold text-amber-950">{wishRequests.length} waiting</span>
        </div>
        <div className="grid gap-3 p-4 lg:grid-cols-2">
            {wishRequests.map((requestRow, requestIndex) => {
              const specification = requestRow.specification || {};
              const hasDraft = Boolean(requestRow.Fulfillment_Bundle_ID);
              return (
                <article key={requestRow.Req_ID} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-bold text-slate-900">{requestRow.Request_Code || `WR-${requestRow.Req_ID}`}</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{specification.wigName || `Wig #${requestRow.Requested_Wig_ID}`}</p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        {requestRow.patientCode} Â· Cap {requestRow.Requested_Cap_Size || specification.capSize || 'N/A'}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {specification.style || specification.hairTexture || 'Style N/A'}
                        {requestRow.medicalCondition ? ` Â· ${requestRow.medicalCondition}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="rounded-full bg-amber-900 px-2 py-1 text-[10px] font-bold uppercase text-white">Priority #{requestIndex + 1}</span>
                      <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold uppercase text-amber-800 ring-1 ring-amber-200">
                        {String(requestRow.Fulfillment_Status || 'awaiting production').replace(/_/g, ' ')}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleOpenWishRequestDraft(requestRow)}
                    disabled={hasDraft || openingWishRequestId === requestRow.Req_ID || draftCount >= 3}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-55"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {openingWishRequestId === requestRow.Req_ID ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
                    {hasDraft ? `Draft #${requestRow.Fulfillment_Bundle_ID} linked` : 'Open auto-filled draft'}
                  </button>
                </article>
              );
            })}
        </div>
      </section>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => {
          const StatIcon = s.Icon;
          return (
            <div key={s.id} className="flex items-center gap-3 rounded-xl border bg-white p-4" style={{ borderColor: '#e2e8f0' }}>
              <span
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                style={{ backgroundColor: s.tint, color: s.accent }}
              >
                <StatIcon size={18} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold uppercase tracking-wide" style={{ color: tertiaryTextColor }}>{s.label}</p>
                <p className="text-2xl font-bold leading-tight" style={{ color: primaryTextColor }}>{s.value}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px,1fr]">
        {/* LEFT: drafts + bundles list */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Package size={14} /> Drafts &amp; Bundles
            </h2>
            <button
              type="button"
              onClick={() => setSelectedKey('create')}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold text-white"
              style={{ backgroundColor: primaryColor }}
            >
              + New
            </button>
          </div>
          <div className="max-h-[640px] overflow-auto">
            {!drafts.length && !activeBundles.length ? (
              <div className="px-4 py-10 text-center text-xs" style={{ color: secondaryTextColor }}>
                No drafts or bundles yet. Click <strong>+ New</strong> to start one.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {drafts.map((draft) => {
                  const count = (bundleMembersByBundleId[draft.Bundle_ID] || []).length;
                  const active = selectedKey === `draft-${draft.Bundle_ID}`;
                  return (
                    <li key={`d-${draft.Bundle_ID}`}>
                      <button
                        type="button"
                        onClick={() => { handleContinueDraft(draft, { silent: true }); setSelectedKey(`draft-${draft.Bundle_ID}`); }}
                        className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition ${active ? '' : 'hover:bg-slate-50'}`}
                        style={active ? { backgroundColor: withColorAlpha(primaryColor, 0.06), boxShadow: `inset 3px 0 0 ${primaryColor}` } : undefined}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-sm font-semibold" style={{ color: primaryTextColor }}>Draft #{draft.Bundle_ID}</span>
                          <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' }}>Draft</span>
                        </div>
                        <span className="text-xs" style={{ color: tertiaryTextColor }}>{count} hair{count === 1 ? '' : 's'} - {formatDateTime(draft.Created_At)}</span>
                      </button>
                    </li>
                  );
                })}
                {activeBundles.map((bundle) => {
                  const count = (bundleMembersByBundleId[bundle.Bundle_ID] || []).length;
                  const active = selectedKey === `bundle-${bundle.Bundle_ID}`;
                  const statusKey = String(bundle.Status || '').toLowerCase();
                  return (
                    <li key={`b-${bundle.Bundle_ID}`}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(`bundle-${bundle.Bundle_ID}`)}
                        className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition ${active ? '' : 'hover:bg-slate-50'}`}
                        style={active ? { backgroundColor: withColorAlpha(primaryColor, 0.06), boxShadow: `inset 3px 0 0 ${primaryColor}` } : undefined}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-sm font-semibold" style={{ color: primaryTextColor }}>{bundle.Bundle_Waybill_Code || `WB${String(Number(bundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`}</span>
                          <span className="inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold" style={bundleStatusStyle(statusKey, primaryColor, tertiaryColor, secondaryTextColor)}>{bundle.Status}</span>
                        </div>
                        <span className="text-xs" style={{ color: tertiaryTextColor }}>{count} hair{count === 1 ? '' : 's'} - {formatDateTime(bundle.Created_At)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* RIGHT: detail panel */}
        <section className="space-y-4">
          {showCreatePanel ? (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-5 py-3.5" style={{ backgroundColor: withColorAlpha(primaryColor, 0.04) }}>
                <div className="flex items-center gap-2">
                  <ScanLine size={16} style={{ color: primaryColor }} />
                  <h3 className="text-sm font-bold text-slate-800">Create a Bundle</h3>
                </div>
                <p className="mt-1 text-xs" style={{ color: tertiaryTextColor }}>
                  Find the wig style, choose its exact cap size, then open a draft to start scanning.
                </p>
              </div>
              <div className="space-y-4 px-5 py-4">
                <WigSpecificationPicker
                  options={wigSpecOptions}
                  value={scannerSpecId}
                  onChange={setScannerSpecId}
                  primaryColor={primaryColor}
                  primaryTextColor={primaryTextColor}
                  secondaryTextColor={secondaryTextColor}
                />

                <div>
                  <label className="mb-1 block text-xs font-semibold" style={{ color: secondaryTextColor }}>Bundle Notes (optional)</label>
                  <textarea
                    value={scannerNotes}
                    onChange={(event) => setScannerNotes(event.target.value)}
                    rows={2}
                    placeholder="e.g. Event hair batch for medium cap style"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                    style={{ color: primaryTextColor }}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleOpenDraftBundle}
                    disabled={isOpeningScannerBundle || draftCount >= 3 || !scannerSpecId}
                    className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {isOpeningScannerBundle ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
                    Open Draft Bundle
                  </button>
                  <span className="text-xs" style={{ color: tertiaryTextColor }}>Open drafts: {draftCount}/3</span>
                </div>
              </div>
            </div>
          ) : selectedDraftRow ? (
            <>

          {scannerBundleRow ? (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ScanLine size={16} className="text-slate-500" />
                  <h3 className="text-sm font-bold text-slate-800">Active Draft #{scannerBundleRow.Bundle_ID}</h3>
                  <span
                    className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                    style={canCloseActiveDraft
                      ? { borderColor: withColorAlpha(tertiaryColor, 0.45), backgroundColor: withColorAlpha(tertiaryColor, 0.12), color: tertiaryColor }
                      : { borderColor: '#fde68a', backgroundColor: '#fffbeb', color: '#b45309' }}
                  >
                    {activeDraftCounterLabel} / target {BUNDLE_HAIR_COUNT_TARGET_MIN}-{BUNDLE_HAIR_COUNT_TARGET_MAX}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleToggleCamera}
                  disabled={isStartingCamera}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-white transition disabled:opacity-60"
                  style={{ backgroundColor: isCameraOn ? '#dc2626' : tertiaryColor }}
                >
                  {isStartingCamera ? <Loader2 size={12} className="animate-spin" /> : isCameraOn ? <CameraOff size={12} /> : <Camera size={12} />}
                  {isCameraOn ? 'Stop Camera' : 'Start Camera'}
                </button>
              </div>

              {/* Progress toward the closeable range. Green once 8-10 hairs. */}
              <div className="mt-3">
                <div className="h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: '#e2e8f0' }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((scannerBundleMemberCount / BUNDLE_HAIR_COUNT_TARGET_MAX) * 100))}%`,
                      backgroundColor: canCloseActiveDraft ? tertiaryColor : primaryColor,
                    }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {scannerBundleMemberCount} of {BUNDLE_HAIR_COUNT_TARGET_MAX} hairs
                  {canCloseActiveDraft
                    ? ' - ready to close'
                    : scannerBundleMemberCount < BUNDLE_HAIR_COUNT_TARGET_MIN
                      ? ` - need ${BUNDLE_HAIR_COUNT_TARGET_MIN - scannerBundleMemberCount} more to close`
                      : ''}
                </p>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[220px,1fr]">
                {/* Compact square camera preview */}
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-900">
                  <div className="relative aspect-square w-full">
                    <video
                      ref={videoRef}
                      className={`h-full w-full object-cover ${isCameraOn ? '' : 'hidden'}`}
                      autoPlay
                      playsInline
                      muted
                    />
                    {!isCameraOn ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs text-slate-300">
                        <Camera size={20} />
                        <span>Camera preview</span>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Controls */}
                <div className="space-y-2">
                  <div className="flex items-start gap-1.5 rounded-md border px-3 py-2 text-xs" style={cameraNoticeStyle}>
                    <AlertCircle size={12} className="mt-0.5 shrink-0" />
                    <span>{cameraStatus.message}</span>
                  </div>

                  <div className="flex gap-2">
                    <input
                      value={scannerWaybillCode}
                      onChange={(event) => setScannerWaybillCode(normalizeWaybillCodeInput(event.target.value))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void handleScanWaybillIntoBundle(scannerWaybillCode, { fromCamera: false });
                        }
                      }}
                      placeholder="Scan or type waybill (WBXXXXXX)"
                      maxLength={WAYBILL_CODE_LENGTH}
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                      style={{ color: primaryTextColor }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleScanWaybillIntoBundle(scannerWaybillCode, { fromCamera: false })}
                      disabled={isScanningWaybill || !isValidWaybillCode(scannerWaybillCode)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                    >
                      {isScanningWaybill ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}
                      Scan
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span>Manual entry: WB + 6 letters or numbers</span>
                    <span className="font-mono">{scannerWaybillCode.length}/{WAYBILL_CODE_LENGTH}</span>
                  </div>

                  <button
                    type="button"
                    onClick={handleCloseScannerBundle}
                    disabled={isClosingScannerBundle || !canCloseActiveDraft}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-white transition disabled:opacity-60"
                    style={{ backgroundColor: tertiaryColor }}
                  >
                    {isClosingScannerBundle ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    Close Draft &amp; Print Waybill
                  </button>

                  <p className="text-[11px] text-slate-500">
                    Each scan adds a hair and updates the event&apos;s collected count. The close button unlocks at {BUNDLE_HAIR_COUNT_TARGET_MIN}-{BUNDLE_HAIR_COUNT_TARGET_MAX} hairs.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-800">Hairs in Draft #{selectedDraftRow.Bundle_ID}</h3>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleFinalizeDraft(selectedDraftRow)}
                      disabled={isFinalizingDraftId === selectedDraftRow.Bundle_ID}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                      style={{ backgroundColor: tertiaryColor }}
                    >
                      {isFinalizingDraftId === selectedDraftRow.Bundle_ID ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      Finalize
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteDraft(selectedDraftRow)}
                      disabled={isDeletingDraftId === selectedDraftRow.Bundle_ID}
                      className="inline-flex items-center gap-1 rounded-md border bg-white px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60"
                      style={{ borderColor: '#fecaca', color: '#b91c1c' }}
                    >
                      {isDeletingDraftId === selectedDraftRow.Bundle_ID ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      Delete
                    </button>
                  </div>
                </div>
                {renderBundleHairDetails(selectedDraftRow, { allowRemove: true })}
              </div>
            </>
          ) : selectedBundleRow ? (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${primaryColor}, ${primaryColor}99)` }} />
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      {selectedBundleRow.Bundle_Waybill_Code || `WB${String(Number(selectedBundleRow.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`}
                    </p>
                    <span
                      className="mt-1 inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                      style={bundleStatusStyle(String(selectedBundleRow.Status || '').toLowerCase(), primaryColor, tertiaryColor, secondaryTextColor)}
                    >
                      {selectedBundleRow.Status}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenPrint(selectedBundleRow)}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-sm font-semibold"
                    style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
                  >
                    <FileText size={14} />
                    Print Waybill
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Hairs</p>
                    <p className="text-slate-800">{(bundleMembersByBundleId[selectedBundleRow.Bundle_ID] || []).length}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Created</p>
                    <p className="text-slate-800">{formatDateTime(selectedBundleRow.Created_At)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Wig Created</p>
                    <p className="text-slate-800">{selectedBundleRow.Wig_Completed_At ? formatDateTime(selectedBundleRow.Wig_Completed_At) : '-'}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Notes</p>
                    <p className="text-slate-800">{selectedBundleRow.Notes || '-'}</p>
                  </div>
                </div>

                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Hairs in this bundle</h4>
                  {renderBundleHairDetails(selectedBundleRow, { allowRemove: false })}
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {showHelp ? renderPortal(
        <div
          className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-slate-900/60 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-2xl"
            style={{ backgroundColor: '#ffffff' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <HelpCircle size={16} style={{ color: primaryColor }} />
                How bundling works
              </h3>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
                aria-label="Close help"
              >
                <X size={16} />
              </button>
            </div>
            <ol className="space-y-2 overflow-y-auto px-5 py-4">
              {flowSteps.map((step) => {
                const isDone = step.id < currentFlowStep;
                const isActive = step.id === currentFlowStep;
                const accent = isDone ? tertiaryColor : isActive ? primaryColor : '#94a3b8';
                return (
                  <li
                    key={step.id}
                    className="flex items-start gap-3 rounded-xl border p-3"
                    style={{
                      borderColor: isActive ? withColorAlpha(primaryColor, 0.55) : '#e2e8f0',
                      backgroundColor: isActive ? withColorAlpha(primaryColor, 0.1) : isDone ? withColorAlpha(tertiaryColor, 0.1) : '#f8fafc',
                    }}
                  >
                    <span
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: accent }}
                    >
                      {isDone ? <CheckCircle2 size={15} /> : step.id}
                    </span>
                    <div>
                      <p className="text-sm font-semibold" style={{ color: isActive ? primaryColor : primaryTextColor }}>
                        {step.title}
                        {isActive ? <span className="ml-2 text-[10px] font-bold uppercase tracking-wide" style={{ color: primaryColor }}>You are here</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs leading-snug" style={{ color: secondaryTextColor }}>{step.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>,
      ) : null}

      {confirmModal.isOpen ? renderPortal(
        <div className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md rounded-2xl border p-0 shadow-2xl" style={{ borderColor: '#e2e8f0', backgroundColor: '#ffffff' }}>
            <div className="px-5 pb-2 pt-5">
              <p
                className="text-[11px] font-bold uppercase tracking-[0.2em]"
                style={
                  confirmModal.tone === 'danger'
                    ? { color: '#b91c1c' }
                    : confirmModal.tone === 'warning'
                      ? { color: '#b45309' }
                      : { color: primaryColor }
                }
              >
                Confirm Action
              </p>
              <h3 className="mt-1 text-base font-semibold" style={{ color: primaryTextColor }}>
                {confirmModal.title}
              </h3>
              <p className="mt-2 text-sm" style={{ color: secondaryTextColor }}>
                {confirmModal.message}
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 pb-5 pt-3">
              <button
                type="button"
                onClick={closeConfirmModal}
                className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
                style={{ borderColor: '#d1d5db', color: secondaryTextColor, backgroundColor: '#fff' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmModalSubmit()}
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
                style={confirmModal.tone === 'danger' ? { backgroundColor: '#b91c1c' } : { backgroundColor: primaryColor }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>,
      ) : null}

      {activePrintBundle ? renderPortal(
        <div className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-slate-900/70 p-4 print:static print:bg-white print:p-0">
          <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl print:max-h-none print:max-w-none print:rounded-none print:shadow-none" style={{ backgroundColor: '#ffffff' }}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 print:hidden" style={{ borderColor: '#e2e8f0' }}>
              <div>
                <h3 className="text-base font-semibold" style={headingStyle}>Bundle Waybill</h3>
                <p className="text-xs" style={{ color: tertiaryTextColor }}>{activePrintBundle.submissionCode}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSavePdf}
                  disabled={isExportingPdf || !activePrintBundle.qrDataUrl}
                  className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
                  style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
                >
                  {isExportingPdf ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  Save as PDF
                </button>
                <button
                  type="button"
                  onClick={handlePrint}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  <Printer size={14} />
                  Print
                </button>
                <button
                  type="button"
                  onClick={() => setActivePrintBundle(null)}
                  className="rounded-md border p-1.5 text-slate-500 hover:bg-slate-50"
                  style={{ borderColor: '#e2e8f0' }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="Donivra-bundle-print-area flex-1 overflow-y-auto bg-slate-100 p-4 print:overflow-visible print:bg-white print:p-0">
              <article
                className="mx-auto max-w-md rounded-2xl border-2 border-dashed bg-white p-6 text-center shadow-sm print:m-0 print:rounded-none print:border-2 print:border-solid print:shadow-none"
                style={{ borderColor: withColorAlpha(primaryColor, 0.5) }}
              >
                <p className="text-[10px] font-bold uppercase tracking-[0.3em]" style={{ color: primaryColor }}>
                  Donivra Wig Bundle Waybill
                </p>
                <p className="mt-1 text-xs font-semibold" style={{ color: secondaryTextColor }}>
                  Scan on Upload Wig Stocks when wig is completed
                </p>

                {activePrintBundle.qrDataUrl ? (
                  <img src={activePrintBundle.qrDataUrl} alt={`QR for ${activePrintBundle.submissionCode}`} className="mx-auto my-4 h-48 w-48" />
                ) : (
                  <div className="mx-auto my-4 flex h-48 w-48 items-center justify-center text-xs" style={{ color: tertiaryTextColor }}>
                    <ImageIcon size={24} />
                    <span className="ml-1">Generating QR...</span>
                  </div>
                )}

                <p className="text-lg font-bold" style={{ color: primaryTextColor }}>{activePrintBundle.submissionCode}</p>
                <p className="mt-1 text-sm" style={{ color: secondaryTextColor }}>Hairs in bundle: {activePrintBundle.memberCount}</p>
                {activePrintBundle.notes ? (
                  <p className="mt-2 text-xs italic" style={{ color: tertiaryTextColor }}>{activePrintBundle.notes}</p>
                ) : null}

                <p className="mt-4 text-[10px] leading-snug" style={{ color: tertiaryTextColor }}>
                  Keep this waybill with the bundle. After the wig is completed, scan it on Upload Wig Stocks &gt; Complete Wig from Bundle to fan-notify donors.
                </p>
              </article>
            </div>
          </div>

          <style>{`
            @media print {
              body * { visibility: hidden !important; }
              .Donivra-bundle-print-area, .Donivra-bundle-print-area * { visibility: visible !important; }
              .Donivra-bundle-print-area { position: absolute !important; inset: 0 !important; padding: 12mm !important; background: #fff !important; }
            }
          `}</style>
        </div>,
      ) : null}
    </div>
  );
}
