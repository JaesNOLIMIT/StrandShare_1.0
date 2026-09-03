import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Camera,
  CameraOff,
  Calendar,
  CheckCircle2,
  Inbox,
  Loader2,
  MapPin,
  Printer,
  ScanLine,
  Search,
  Users,
  X,
} from 'lucide-react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import { useTheme } from '../../../context/ThemeContext';
import { useToast } from '../../../context/ToastContext';
import ProgramScheduleCalendarModal, {
  formatScheduleDateLabel,
  toScheduleDateKey,
} from '../../../components/events/ProgramScheduleCalendarModal';
import WaybillScanResult from '../../../components/scanning/WaybillScanResult';
import PageHeaderActions from '../../../components/PageHeaderActions';
import {
  WAYBILL_CODE_LENGTH,
  isValidWaybillCode,
  normalizeWaybillCodeInput,
} from '../../../lib/hairSubmissionWorkflow';

const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_ATTENDEES_TABLE = 'Event_Attendees';
const HAIR_SUBMISSIONS_TABLE = 'Hair_Submissions';
const HAIR_SUBMISSION_DETAILS_TABLE = 'Hair_Submission_Details';
const USERS_TABLE = 'users';
const USER_DETAILS_TABLE = 'user_details';
const SCAN_DEBOUNCE_MS = 2500;
const EVENT_FILTERS = [
  { id: 'all_active', label: 'All active events' },
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'Next 7 days' },
  { id: 'upcoming', label: 'Later events' },
  { id: 'ended', label: 'Ended events' },
];
const HAIR_COLOR_OPTIONS = ['Black', 'Dark Brown', 'Brown', 'Light Brown', 'Blonde', 'Gray', 'Red / Auburn', 'Other'];
const HAIR_TEXTURE_OPTIONS = ['Straight', 'Wavy', 'Curly', 'Coily'];
const HAIR_DENSITY_OPTIONS = ['Thin', 'Medium', 'Thick'];
const HAIR_CONDITION_OPTIONS = ['Healthy', 'Slightly Dry', 'Dry', 'Damaged'];
const MANILA_OFFSET_MINUTES = 8 * 60;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const EVENT_SCAN_OUTCOMES = [
  'RSVP donor: attendance becomes Present; next step is Hair Intake & Review.',
  'RSVP voluntary attendee: attendance becomes Present; their event process is complete.',
  'Hair Intake donor: attendee and submitted hair details open for the final staff decision.',
  'Hair Intake voluntary attendee: no hair review is required and no submission is created.',
  'Approved hair: submission becomes Cut and appears in Cut Hair Inventory for bundling.',
  'Rejected or Rejected Cut hair: submission becomes Cancelled and cannot enter bundling.',
  'Cancelled, duplicate, wrong-event, or unknown waybill: no record changes; the reason is shown.',
];

function getManilaSqlTimestamp(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return getManilaSqlTimestamp(new Date());
  }
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  const manilaShiftedDate = new Date(utcMs + (8 * 60 * 60 * 1000));
  return manilaShiftedDate.toISOString().slice(0, 19).replace('T', ' ');
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateShort(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function toManilaShiftedDate(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return toManilaShiftedDate(new Date());
  }
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  return new Date(utcMs + (MANILA_OFFSET_MINUTES * 60 * 1000));
}

function toManilaDayStartMs(dateValue = new Date()) {
  const shifted = toManilaShiftedDate(dateValue);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime();
}

function buildAddress(event) {
  if (!event) return '';
  return [
    event.Street,
    event.Barangay,
    event.City_Municipality,
    event.Province,
    event.Region,
    event.Country,
  ]
    .filter(Boolean)
    .join(', ');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseRsvpScanPayload(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return {
    raw: '',
    payloadType: '',
    waybillCode: '',
    userId: null,
    attendeeId: null,
  };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const payloadType = String(parsed.Payload_Type || parsed.payload_type || '').trim();
      const candidates = [
        parsed.waybill_code,
        parsed.waybillCode,
        parsed.Waybill_Code,
        parsed.code,
        parsed.value,
        parsed.data?.waybill_code,
        parsed.data?.waybillCode,
        parsed.data?.Waybill_Code,
      ];
      const match = candidates.find((value) => String(value || '').trim());
      const userIdRaw = parsed.User_ID ?? parsed.user_id ?? parsed.userId ?? parsed.data?.User_ID ?? parsed.data?.user_id;
      const userId = Number(userIdRaw);
      return {
        raw,
        payloadType,
        waybillCode: match ? String(match).trim() : '',
        userId: Number.isFinite(userId) && userId > 0 ? userId : null,
        attendeeId: Number(parsed.Event_Attendee_ID ?? parsed.event_attendee_id ?? parsed.data?.Event_Attendee_ID) || null,
      };
    }
  } catch {
    // not a JSON payload; continue
  }

  return {
    raw,
    payloadType: '',
    waybillCode: raw,
    userId: null,
    attendeeId: null,
  };
}

function normalizeFlowStatusKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\s-]+/g, '');
}

function isEventEnded(eventRow) {
  if (normalizeFlowStatusKey(eventRow?.Status) === 'ended') return true;
  if (!eventRow?.End_Date) return false;
  const endTime = new Date(eventRow.End_Date).getTime();
  return Number.isFinite(endTime) && endTime <= Date.now();
}

function getEffectiveEventStatus(eventRow) {
  return isEventEnded(eventRow) ? 'Ended' : (eventRow?.Status || 'Approved');
}

function normalizeAttendeeType(value) {
  return normalizeFlowStatusKey(value) === 'voluntary' ? 'Voluntary' : 'Donor';
}

function isFinalHairDetailStatus(status) {
  const key = normalizeFlowStatusKey(status);
  return key === 'approved' || key === 'rejected' || key === 'rejectedcut';
}

function getAttendeeHairIntakeMeta(attendee, submission, details = []) {
  if (normalizeAttendeeType(attendee?.Attendee_Type) === 'Voluntary') {
    return { state: 'not_required', label: 'Not required' };
  }

  const finalDetail = details.find((row) => isFinalHairDetailStatus(row?.Status));
  if (finalDetail) {
    return { state: 'done', label: `Done · ${finalDetail.Status}` };
  }

  const submissionStatus = String(submission?.Status || '').trim();
  if (['cut', 'cancelled', 'wiginproduction', 'wigcreated'].includes(normalizeFlowStatusKey(submissionStatus))) {
    return { state: 'done', label: `Done · ${submissionStatus}` };
  }

  if (submission?.Submission_ID) {
    return { state: 'pending', label: 'Pending review' };
  }

  return { state: 'not_started', label: 'Not started' };
}

function createDetailDraft(detail) {
  return {
    submissionDetailId: Number(detail?.Submission_Detail_ID || 0) || null,
    declaredLength: detail?.Declared_Length == null ? '' : String(detail.Declared_Length),
    declaredColor: String(detail?.Declared_Color || ''),
    declaredTexture: String(detail?.Declared_Texture || ''),
    declaredDensity: String(detail?.Declared_Density || ''),
    declaredCondition: String(detail?.Declared_Condition || ''),
    isChemicallyTreated: Boolean(detail?.Is_Chemically_Treated),
    isColored: Boolean(detail?.Is_Colored),
    isBleached: Boolean(detail?.Is_Bleached),
    isRebonded: Boolean(detail?.Is_Rebonded),
    detailNotes: String(detail?.Detail_Notes || ''),
  };
}

function formatAiConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return `${Math.max(0, Math.min(100, percent)).toFixed(0)}%`;
}

function displayAiValue(value, fallback = 'Not provided') {
  if (value == null || String(value).trim() === '') return fallback;
  return String(value);
}

function findChangedAiHairFields(screening, draft) {
  if (!screening || !draft) return [];
  const comparisons = [
    ['length', screening.Estimated_Length, draft.declaredLength, (aiValue, staffValue) => (
      String(staffValue ?? '').trim() !== '' && Number(aiValue) === Number(staffValue)
    )],
    ['color', screening.Detected_Color, draft.declaredColor],
    ['texture', screening.Detected_Texture, draft.declaredTexture],
    ['density', screening.Detected_Density, draft.declaredDensity],
    ['condition', screening.Detected_Condition, draft.declaredCondition],
  ];

  return comparisons.reduce((changed, [field, aiValue, staffValue, matcher]) => {
    if (aiValue == null || String(aiValue).trim() === '') return changed;
    const matches = typeof matcher === 'function'
      ? matcher(aiValue, staffValue)
      : normalizeFlowStatusKey(aiValue) === normalizeFlowStatusKey(staffValue);
    if (!matches) changed.push(field);
    return changed;
  }, []);
}

function countComparableAiHairFields(screening) {
  return [
    screening?.Estimated_Length,
    screening?.Detected_Color,
    screening?.Detected_Texture,
    screening?.Detected_Density,
    screening?.Detected_Condition,
  ].filter((value) => value != null && String(value).trim() !== '').length;
}

function buildUserFullName(detailRow) {
  if (!detailRow) return '';
  return [
    detailRow.first_name,
    detailRow.middle_name,
    detailRow.last_name,
    detailRow.suffix,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

function enrichAttendeeRowWithUserData(attendeeRow, userRow, detailRow, fallbackRow = null) {
  const fullName = buildUserFullName(detailRow)
    || String(attendeeRow?.Full_Name || '').trim()
    || String(fallbackRow?.Full_Name || '').trim()
    || 'N/A';
  const email = String(userRow?.email || attendeeRow?.Email || fallbackRow?.Email || '').trim();
  const contactNumber = String(detailRow?.contact_number || attendeeRow?.Contact_Number || fallbackRow?.Contact_Number || '').trim();

  return {
    ...fallbackRow,
    ...attendeeRow,
    Full_Name: fullName,
    Email: email || null,
    Contact_Number: contactNumber || null,
  };
}

export default function AssignedEventOperationsPage({ userProfile, isActivePage = true }) {
  const { theme } = useTheme();
  const { showToast } = useToast();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';

  const [staffUserId, setStaffUserId] = useState(userProfile?.user_id || null);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [isLoadingAttendees, setIsLoadingAttendees] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });

  const [events, setEvents] = useState([]);
  const [eventTimeFilter, setEventTimeFilter] = useState('all_active');
  const [selectedCalendarDate, setSelectedCalendarDate] = useState('');
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [attendees, setAttendees] = useState([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [showHowToModal, setShowHowToModal] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState({
    kind: 'info',
    message: 'Camera is off. Start scanner to mark RSVP attendance.',
  });
  const [manualWaybillCode, setManualWaybillCode] = useState('');
  const [scanMode, setScanMode] = useState('rsvp');
  const [activeReview, setActiveReview] = useState(null);
  const [qualityReason, setQualityReason] = useState('');
  const [detailDraft, setDetailDraft] = useState(() => createDetailDraft(null));
  const [aiReviewTab, setAiReviewTab] = useState('screening');
  const [isSubmittingQuality, setIsSubmittingQuality] = useState(false);
  const [isSavingDetail, setIsSavingDetail] = useState(false);
  const [eventSummary, setEventSummary] = useState(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [scanOutcome, setScanOutcome] = useState(null);

  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const isScanProcessingRef = useRef(false);
  const lastScanRef = useRef({ raw: '', at: 0 });
  const attendeesCacheRef = useRef(new Map());
  const attendeeLoadSeqRef = useRef(0);

  useEffect(() => {
    if (!notice.text) return;
    showToast({
      type: notice.kind || 'info',
      title: notice.kind === 'error' ? 'Error' : undefined,
      message: notice.text,
    });
    setNotice({ kind: '', text: '' });
  }, [notice, showToast]);

  useEffect(() => {
    if (cameraStatus.kind !== 'error' || !cameraStatus.message) return;
    showToast({ type: 'error', title: 'Scanner error', message: cameraStatus.message });
    setCameraStatus({
      kind: 'info',
      message: 'Scanner ready. Try again or enter the waybill manually.',
    });
  }, [cameraStatus, showToast]);

  const resolveStaffUserId = useCallback(async () => {
    if (staffUserId) return staffUserId;
    if (!supabase) return null;

    const { data: sessionData } = await supabase.auth.getSession();
    const authUserId = sessionData?.session?.user?.id || null;
    if (!authUserId) return null;

    const result = await supabase
      .from(USERS_TABLE)
      .select('user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    const resolved = result?.data?.user_id || null;
    setStaffUserId(resolved);
    return resolved;
  }, [staffUserId]);

  const loadEvents = useCallback(async ({ silent = false } = {}) => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }

    const resolvedStaffId = await resolveStaffUserId();
    if (!resolvedStaffId) {
      setNotice({ kind: 'error', text: 'Unable to resolve your staff profile.' });
      return;
    }

    if (!silent) setIsLoadingEvents(true);
    setNotice({ kind: '', text: '' });

    try {
      const result = await supabase
        .from(EVENT_REQUESTS_TABLE)
        .select('*')
        .eq('Assigned_Staff_User_ID', resolvedStaffId)
        .order('Start_Date', { ascending: true })
        .limit(300);

      if (result.error) throw result.error;

      const nextEvents = result.data || [];
      setEvents(nextEvents);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load assigned events.' });
      if (!silent) setEvents([]);
    } finally {
      setIsLoadingEvents(false);
    }
  }, [resolveStaffUserId]);

  const loadAttendees = useCallback(async (eventRequestId, { silent = false, force = false } = {}) => {
    const targetEventRequestId = Number(eventRequestId || 0);
    if (!supabase || !targetEventRequestId) {
      setAttendees([]);
      return;
    }

    const cachedRows = attendeesCacheRef.current.get(targetEventRequestId);
    if (cachedRows && !force) {
      setAttendees(cachedRows);
    }

    const shouldShowLoading = !silent && (!cachedRows || force);
    if (shouldShowLoading) {
      setIsLoadingAttendees(true);
    }
    const loadSeq = attendeeLoadSeqRef.current + 1;
    attendeeLoadSeqRef.current = loadSeq;

    try {
      const result = await supabase
        .from(EVENT_ATTENDEES_TABLE)
        .select('Event_Attendee_ID, User_ID, Registration_Status, Attendance_Status, Waybill_Code, Waybill_Printed_At, Waybill_Printed_By, Notes, Created_At, Updated_At, Event_Request_ID, RSVP_Scanned_At, RSVP_Scanned_By, Attendee_Type')
        .eq('Event_Request_ID', targetEventRequestId)
        .order('Event_Attendee_ID', { ascending: true });

      if (result.error) throw result.error;
      if (attendeeLoadSeqRef.current !== loadSeq) {
        return;
      }

      const baseRows = result.data || [];
      const userIds = [...new Set(
        baseRows
          .map((row) => Number(row?.User_ID || 0))
          .filter((id) => Number.isFinite(id) && id > 0),
      )];

      const usersById = new Map();
      const detailsById = new Map();
      const [accountResults, submissionsResult] = await Promise.all([
        userIds.length ? Promise.all([
          supabase
            .from(USERS_TABLE)
            .select('user_id, email')
            .in('user_id', userIds),
          supabase
            .from(USER_DETAILS_TABLE)
            .select('user_id, first_name, middle_name, last_name, suffix, contact_number')
            .in('user_id', userIds),
        ]) : Promise.resolve([{ data: [], error: null }, { data: [], error: null }]),
        supabase
          .from(HAIR_SUBMISSIONS_TABLE)
          .select('Submission_ID, Event_Attendee_ID, User_ID, Status')
          .eq('Event_Request_ID', targetEventRequestId)
          .order('Submission_ID', { ascending: false })
          .limit(1000),
      ]);

      const [usersResult, detailsResult] = accountResults;
      if (usersResult.error) throw usersResult.error;
      if (detailsResult.error) throw detailsResult.error;
      if (submissionsResult.error) throw submissionsResult.error;

      for (const userRow of usersResult.data || []) {
        usersById.set(Number(userRow.user_id || 0), userRow);
      }
      for (const detailRow of detailsResult.data || []) {
        detailsById.set(Number(detailRow.user_id || 0), detailRow);
      }

      const submissions = submissionsResult.data || [];
      const submissionIds = submissions
        .map((row) => Number(row?.Submission_ID || 0))
        .filter((id) => id > 0);
      let hairDetails = [];
      if (submissionIds.length) {
        const hairDetailsResult = await supabase
          .from(HAIR_SUBMISSION_DETAILS_TABLE)
          .select('Submission_Detail_ID, Submission_ID, Status')
          .in('Submission_ID', submissionIds)
          .order('Submission_Detail_ID', { ascending: false });
        if (hairDetailsResult.error) throw hairDetailsResult.error;
        hairDetails = hairDetailsResult.data || [];
      }

      const submissionsByAttendee = new Map();
      const submissionsByUser = new Map();
      for (const submission of submissions) {
        const attendeeId = Number(submission?.Event_Attendee_ID || 0);
        const userId = Number(submission?.User_ID || 0);
        if (attendeeId > 0 && !submissionsByAttendee.has(attendeeId)) submissionsByAttendee.set(attendeeId, submission);
        if (userId > 0 && !submissionsByUser.has(userId)) submissionsByUser.set(userId, submission);
      }

      const hairDetailsBySubmission = new Map();
      for (const detail of hairDetails) {
        const submissionId = Number(detail?.Submission_ID || 0);
        const current = hairDetailsBySubmission.get(submissionId) || [];
        current.push(detail);
        hairDetailsBySubmission.set(submissionId, current);
      }

      const rows = baseRows.map((row) => {
        const userId = Number(row?.User_ID || 0);
        const attendeeId = Number(row?.Event_Attendee_ID || 0);
        const submission = submissionsByAttendee.get(attendeeId) || submissionsByUser.get(userId) || null;
        const intakeMeta = getAttendeeHairIntakeMeta(
          row,
          submission,
          hairDetailsBySubmission.get(Number(submission?.Submission_ID || 0)) || [],
        );
        return {
          ...enrichAttendeeRowWithUserData(
          row,
          usersById.get(userId) || null,
          detailsById.get(userId) || null,
          ),
          Hair_Intake_State: intakeMeta.state,
          Hair_Intake_Label: intakeMeta.label,
        };
      });
      attendeesCacheRef.current.set(targetEventRequestId, rows);
      setAttendees(rows);
    } catch (error) {
      if (!cachedRows) {
        setAttendees([]);
      }
      setNotice({ kind: 'error', text: error.message || 'Unable to load attendees.' });
    } finally {
      if (attendeeLoadSeqRef.current === loadSeq) {
        setIsLoadingAttendees(false);
      }
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const filteredEvents = useMemo(() => {
    if (selectedCalendarDate) {
      return events.filter((row) => (
        toScheduleDateKey(row.Start_Date) === selectedCalendarDate
      ));
    }

    const todayStart = toManilaDayStartMs(new Date());
    const weekEnd = todayStart + (6 * DAY_IN_MS);

    return events.filter((row) => {
      const ended = isEventEnded(row);
      if (eventTimeFilter === 'ended') return ended;
      if (ended) return false;
      if (eventTimeFilter === 'all_active') return true;
      const eventDay = toManilaDayStartMs(row?.Start_Date || row?.Created_At || new Date());
      if (eventTimeFilter === 'today') {
        return eventDay === todayStart;
      }
      if (eventTimeFilter === 'this_week') {
        return eventDay >= todayStart && eventDay <= weekEnd;
      }
      if (eventTimeFilter === 'upcoming') {
        return eventDay > weekEnd;
      }
      return true;
    });
  }, [events, eventTimeFilter, selectedCalendarDate]);

  const selectedEvent = useMemo(() => (
    events.find((row) => Number(row.Event_Request_ID || 0) === Number(selectedRequestId || 0)) || null
  ), [events, selectedRequestId]);
  const selectedEventEnded = useMemo(() => isEventEnded(selectedEvent), [selectedEvent]);

  // Auto-select first event when nothing is selected yet
  useEffect(() => {
    if (!filteredEvents.length) {
      setSelectedRequestId(null);
      return;
    }

    const hasSelectedInFilter = filteredEvents.some(
      (row) => Number(row.Event_Request_ID || 0) === Number(selectedRequestId || 0),
    );
    if (!hasSelectedInFilter) {
      setSelectedRequestId(filteredEvents[0].Event_Request_ID);
    }
  }, [filteredEvents, selectedRequestId]);

  // Load attendees whenever the selected event changes
  useEffect(() => {
    if (selectedEvent?.Event_Request_ID) {
      loadAttendees(selectedEvent?.Event_Request_ID);
    } else {
      setAttendees([]);
    }
    setAttendeeSearch('');
    setActiveReview(null);
    setQualityReason('');
    setDetailDraft(createDetailDraft(null));
    setEventSummary(null);
    setScanOutcome(null);
  }, [selectedEvent, loadAttendees]);

  useEffect(() => {
    if (!supabase || !selectedEvent?.Event_Request_ID || !selectedEventEnded) {
      setEventSummary(null);
      return;
    }
    let active = true;
    setIsLoadingSummary(true);
    supabase.rpc('get_event_operations_summary', {
      p_event_request_id: Number(selectedEvent.Event_Request_ID),
    }).then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setNotice({ kind: 'error', text: error.message || 'Unable to load ended event summary.' });
        setEventSummary(null);
      } else {
        setEventSummary(data || {});
      }
      setIsLoadingSummary(false);
    });
    return () => { active = false; };
  }, [selectedEvent?.Event_Request_ID, selectedEventEnded]);

  // Realtime: keep assigned events + attendees in sync
  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase) return undefined;

    const requestsChannel = supabase
      .channel('assigned-events-requests-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: EVENT_REQUESTS_TABLE },
        (payload) => {
          if (!staffUserId) return;
          const matchesStaff = (row) => Number(row?.Assigned_Staff_User_ID) === Number(staffUserId);

          if (payload.eventType === 'INSERT') {
            if (!matchesStaff(payload.new)) return;
            setEvents((prev) => {
              const exists = prev.some((row) => Number(row.Event_Request_ID) === Number(payload.new.Event_Request_ID));
              return exists ? prev : [...prev, payload.new];
            });
          } else if (payload.eventType === 'UPDATE') {
            setEvents((prev) => {
              const inList = prev.some((row) => Number(row.Event_Request_ID) === Number(payload.new.Event_Request_ID));
              if (matchesStaff(payload.new)) {
                if (inList) {
                  return prev.map((row) => (
                    Number(row.Event_Request_ID) === Number(payload.new.Event_Request_ID)
                      ? payload.new
                      : row
                  ));
                }
                return [...prev, payload.new];
              }
              return inList
                ? prev.filter((row) => Number(row.Event_Request_ID) !== Number(payload.new.Event_Request_ID))
                : prev;
            });
          } else if (payload.eventType === 'DELETE') {
            setEvents((prev) => prev.filter((row) => (
              Number(row.Event_Request_ID) !== Number(payload.old?.Event_Request_ID)
            )));
          }
        },
      )
      .subscribe();

    const attendeesChannel = supabase
      .channel('assigned-events-attendees-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: EVENT_ATTENDEES_TABLE },
        (payload) => {
          const targetEventRequestId = Number(selectedEvent?.Event_Request_ID || 0);
          if (!targetEventRequestId) return;

          const payloadEventRequestId = Number(payload.new?.Event_Request_ID ?? payload.old?.Event_Request_ID ?? 0);
          const isForSelected = targetEventRequestId > 0 && payloadEventRequestId === targetEventRequestId;
          if (!isForSelected) return;

          if (payload.eventType === 'INSERT') {
            void loadAttendees(targetEventRequestId, { silent: true, force: true });
          } else if (payload.eventType === 'UPDATE') {
            setAttendees((prev) => {
              const nextRows = prev.map((row) => (
                Number(row.Event_Attendee_ID) === Number(payload.new.Event_Attendee_ID)
                  ? { ...row, ...payload.new }
                  : row
              ));
              attendeesCacheRef.current.set(targetEventRequestId, nextRows);
              return nextRows;
            });
          } else if (payload.eventType === 'DELETE') {
            setAttendees((prev) => {
              const nextRows = prev.filter((row) => (
                Number(row.Event_Attendee_ID) !== Number(payload.old?.Event_Attendee_ID)
              ));
              attendeesCacheRef.current.set(targetEventRequestId, nextRows);
              return nextRows;
            });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(requestsChannel);
      supabase.removeChannel(attendeesChannel);
    };
  }, [isActivePage, loadAttendees, staffUserId, selectedEvent?.Event_Request_ID]);

  const stopCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!selectedEvent?.Event_Request_ID) return;

    stopCamera();
    setIsCameraOn(false);
    setManualWaybillCode('');
    setScanMode(selectedEventEnded ? 'hair_review' : 'rsvp');
    setCameraStatus({
      kind: 'info',
      message: selectedEventEnded
        ? 'This event has ended. RSVP is closed, but pending Hair Intake & Review scans remain available.'
        : 'RSVP Check-in selected. Scan or enter an attendee waybill to mark attendance.',
    });
  }, [selectedEvent?.Event_Request_ID, selectedEventEnded, stopCamera]);

  const startCameraScanner = useCallback(async () => {
    if (isCameraOn || isStartingCamera) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus({ kind: 'error', message: 'Camera API is unavailable on this browser/device.' });
      return;
    }

    setIsStartingCamera(true);
    setCameraStatus({ kind: 'info', message: 'Initializing camera scanner...' });

    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }

      setIsCameraOn(true);
      setCameraStatus({
        kind: 'success',
        message: scanMode === 'hair_review'
          ? 'Hair Intake & Review scanner is running. Scan a checked-in donor QR.'
          : 'RSVP Check-in scanner is running. Point the camera at an attendee QR.',
      });
    } catch (error) {
      setCameraStatus({ kind: 'error', message: error?.message || 'Could not access the camera.' });
    } finally {
      setIsStartingCamera(false);
    }
  }, [isCameraOn, isStartingCamera, scanMode, stopCamera]);

  const loadSubmissionDetailsById = useCallback(async (submissionId) => {
    const targetId = Number(submissionId || 0);
    if (!targetId || !supabase) return [];

    const detailsResult = await supabase
      .from(HAIR_SUBMISSION_DETAILS_TABLE)
      .select('*')
      .eq('Submission_ID', targetId)
      .order('Submission_Detail_ID', { ascending: true });

    if (detailsResult.error) throw detailsResult.error;
    return detailsResult.data || [];
  }, []);

  const loadAiScreeningBySubmissionId = useCallback(async (eventRequestId, submissionId) => {
    const targetEventId = Number(eventRequestId || 0);
    const targetSubmissionId = Number(submissionId || 0);
    if (!targetEventId || !targetSubmissionId || !supabase) return null;

    const result = await supabase.rpc('get_event_hair_ai_screening', {
      p_event_request_id: targetEventId,
      p_submission_id: targetSubmissionId,
    });

    if (result.error) throw result.error;
    return result.data || null;
  }, []);

  const reviewStatusMeta = useMemo(() => {
    const submission = activeReview?.submission || null;
    const details = Array.isArray(activeReview?.details) ? activeReview.details : [];

    const detailStatus = details.find((row) => isFinalHairDetailStatus(row?.Status))?.Status || '';
    const submissionStatusKey = normalizeFlowStatusKey(submission?.Status);

    const submissionFinal = ['cut', 'cancelled', 'wiginproduction', 'wigcreated'].includes(submissionStatusKey);
    const detailFinal = Boolean(detailStatus);
    const isFinal = submissionFinal || detailFinal;
    const needsDecision = Boolean(submission?.Submission_ID) && !isFinal;

    return {
      isFinal,
      needsDecision,
      finalStatusLabel: detailFinal ? String(detailStatus) : (submission?.Status ? String(submission.Status) : ''),
    };
  }, [activeReview]);

  const activeAiScreening = activeReview?.aiScreening || null;
  const changedAiHairFields = useMemo(
    () => findChangedAiHairFields(activeAiScreening, detailDraft),
    [activeAiScreening, detailDraft],
  );
  const liveAiAccuracy = useMemo(() => {
    const comparable = countComparableAiHairFields(activeAiScreening);
    const changed = changedAiHairFields.length;
    const humanPercent = comparable > 0 ? (changed / comparable) * 100 : 0;
    return {
      comparable,
      aiPercent: comparable > 0 ? 100 - humanPercent : 0,
      humanPercent,
    };
  }, [activeAiScreening, changedAiHairFields]);

  const markAttendeePresentByWaybill = useCallback(async (rawValue) => {
    if (isScanProcessingRef.current || !selectedEvent || !supabase) return;

    if (scanMode === 'hair_review' && reviewStatusMeta.needsDecision) {
      const message = 'Complete the current hair quality decision before scanning another donor.';
      setNotice({ kind: 'warning', text: message });
      setCameraStatus({ kind: 'warning', message });
      return;
    }

    isScanProcessingRef.current = true;
    setIsSaving(true);

    try {
      const scan = parseRsvpScanPayload(rawValue);
      if (!scan.waybillCode && !scan.userId && !scan.raw) {
        throw new Error('No waybill code or user id detected from scan.');
      }

      const eventRequestId = Number(selectedEvent?.Event_Request_ID || 0);
      if (!eventRequestId) {
        throw new Error('Selected event has no Event_Request_ID.');
      }

      const scannedAttendee = attendees.find((row) => (
        (scan.attendeeId && Number(row.Event_Attendee_ID) === Number(scan.attendeeId))
        || (scan.waybillCode && String(row.Waybill_Code || '').trim().toUpperCase() === String(scan.waybillCode).trim().toUpperCase())
        || (scan.userId && Number(row.User_ID) === Number(scan.userId))
      )) || null;
      if (scanMode === 'hair_review' && normalizeAttendeeType(scannedAttendee?.Attendee_Type) === 'Voluntary') {
        const waybillCode = String(scannedAttendee?.Waybill_Code || scan.waybillCode || '').trim();
        setActiveReview({
          attendee: scannedAttendee,
          submission: null,
          details: [],
          waybillCode,
          attendeeType: 'Voluntary',
          voluntaryOnly: true,
        });
        setQualityReason('');
        setDetailDraft(createDetailDraft(null));
        setCameraStatus({
          kind: 'info',
          message: `${scannedAttendee?.Full_Name || waybillCode || 'This attendee'} is voluntary. RSVP check-in is their only required step.`,
        });
        setScanOutcome({
          tone: 'info',
          title: 'Voluntary attendee identified',
          waybill: waybillCode,
          subject: scannedAttendee?.Full_Name || 'Voluntary attendee',
          action: 'Verified attendee type; no hair intake was opened',
          status: 'RSVP only',
          nextStep: scannedAttendee?.RSVP_Scanned_At ? 'No further event scan required' : 'Complete RSVP Check-in',
          statusChanges: [],
        });
        return true;
      }

      const scanResult = await supabase.rpc('scan_event_attendee_operation', {
        p_event_request_id: eventRequestId,
        p_qr_payload: String(rawValue || ''),
        p_mode: scanMode,
      });
      if (scanResult.error) throw scanResult.error;

      const payload = scanResult.data || {};
      const updated = payload?.attendee || null;
      const existingAttendee = attendees.find((row) => (
        Number(row.Event_Attendee_ID) === Number(updated?.Event_Attendee_ID)
      )) || scannedAttendee;
      const updatedForDisplay = updated ? {
        ...existingAttendee,
        ...updated,
        Full_Name: existingAttendee?.Full_Name || updated?.Full_Name || 'N/A',
        Email: existingAttendee?.Email || updated?.Email || null,
        Contact_Number: existingAttendee?.Contact_Number || updated?.Contact_Number || null,
      } : null;
      const submission = payload?.submission || null;
      const submissionStatus = String(
        payload?.submission_status
        || payload?.submission?.Status
        || '',
      ).trim();
      const attendeeType = normalizeAttendeeType(
        payload?.attendee_type
        || updated?.Attendee_Type,
      );
      const requiresHairReview = scanMode === 'hair_review' && (payload?.requires_hair_review == null
        ? attendeeType === 'Donor'
        : Boolean(payload.requires_hair_review));
      const resolvedWaybillCode = String(
        payload?.waybill_code
        || updated?.Waybill_Code
        || scan.waybillCode
        || '',
      ).trim();

      if (updatedForDisplay?.Event_Attendee_ID) {
        setAttendees((current) => {
          const exists = current.some((row) => Number(row.Event_Attendee_ID) === Number(updatedForDisplay.Event_Attendee_ID));
          const nextRows = !exists
            ? [updatedForDisplay, ...current]
            : current.map((row) => (
            Number(row.Event_Attendee_ID) === Number(updatedForDisplay.Event_Attendee_ID) ? updatedForDisplay : row
            ));
          if (selectedEvent?.Event_Request_ID) {
            attendeesCacheRef.current.set(Number(selectedEvent.Event_Request_ID), nextRows);
          }
          return nextRows;
        });
      } else {
        await loadAttendees(selectedEvent.Event_Request_ID);
      }

      let details = [];
      let aiScreening = null;
      if (requiresHairReview) {
        details = Array.isArray(payload?.details) ? payload.details : [];
        const submissionId = Number(submission?.Submission_ID || 0);
        if (!details.length && submissionId > 0) {
          details = await loadSubmissionDetailsById(submissionId);
        }
        if (submissionId > 0) {
          aiScreening = await loadAiScreeningBySubmissionId(eventRequestId, submissionId);
        }
      }

      setActiveReview(requiresHairReview ? {
        attendee: updatedForDisplay || null,
        submission: submission || null,
        details,
        aiScreening,
        waybillCode: resolvedWaybillCode,
      } : null);
      setAiReviewTab('screening');
      setQualityReason('');
      setDetailDraft(createDetailDraft(details?.[0] || null));

      const attendeeLabel = updatedForDisplay?.Full_Name || resolvedWaybillCode || 'attendee';
      setNotice({
        kind: 'success',
        text: requiresHairReview
          ? `Hair intake loaded for ${attendeeLabel}. Double-check the AI details and record the final decision.`
          : `RSVP check-in complete for ${attendeeLabel}. Donors may now use Hair Intake & Review.`,
      });
      setCameraStatus({
        kind: 'success',
        message: requiresHairReview
          ? `Hair intake opened.${submissionStatus ? ` Submission: ${submissionStatus}.` : ''} Review the details below.`
          : `RSVP success: ${attendeeLabel} marked Present.`,
      });
      setScanOutcome({
        tone: 'success',
        title: requiresHairReview ? 'Hair intake opened' : 'RSVP check-in completed',
        waybill: resolvedWaybillCode,
        subject: attendeeLabel,
        action: requiresHairReview ? 'Loaded donor submission and hair details' : 'Marked attendance as Present',
        status: requiresHairReview ? 'Awaiting decision' : 'Present',
        nextStep: requiresHairReview
          ? 'Review the hair and choose Approve, Reject, or Rejected Cut'
          : attendeeType === 'Voluntary' ? 'Process complete' : 'Use Hair Intake & Review when hair is received',
        statusChanges: requiresHairReview ? [] : [{
          label: 'Attendance',
          before: existingAttendee?.Attendance_Status || 'Not Marked',
          after: updatedForDisplay?.Attendance_Status || 'Present',
        }],
      });
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to process scan.' });
      setCameraStatus({ kind: 'error', message: error.message || 'Scan failed.' });
      const scan = parseRsvpScanPayload(rawValue);
      setScanOutcome({
        tone: 'error',
        title: 'Waybill was not processed',
        waybill: scan.waybillCode,
        action: 'No database change',
        status: 'Blocked',
        nextStep: error.message || 'Check the code and scan again',
        statusChanges: [],
      });
      return false;
    } finally {
      setIsSaving(false);
      isScanProcessingRef.current = false;
    }
  }, [attendees, loadAiScreeningBySubmissionId, loadAttendees, loadSubmissionDetailsById, reviewStatusMeta.needsDecision, scanMode, selectedEvent]);

  const handleSaveDetailEdits = useCallback(async () => {
    if (!supabase || !selectedEvent) return;

    const submissionId = Number(activeReview?.submission?.Submission_ID || 0);
    const eventRequestId = Number(selectedEvent?.Event_Request_ID || 0);
    if (!submissionId || !eventRequestId) {
      setNotice({ kind: 'error', text: 'Scan an RSVP first to load hair details.' });
      return;
    }

    if (reviewStatusMeta.isFinal) {
      setNotice({ kind: 'warning', text: 'Hair details are locked after final decision.' });
      return;
    }

    const lengthRaw = String(detailDraft?.declaredLength || '').trim();
    const parsedLength = lengthRaw === '' ? null : Number(lengthRaw);
    if (parsedLength != null && (!Number.isFinite(parsedLength) || parsedLength < 0)) {
      setNotice({ kind: 'error', text: 'Declared length must be a non-negative number.' });
      return;
    }

    setIsSavingDetail(true);
    setIsSaving(true);
    setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('staff_update_hair_submission_details', {
        p_event_request_id: eventRequestId,
        p_submission_id: submissionId,
        p_declared_length: parsedLength,
        p_declared_color: String(detailDraft?.declaredColor || '').trim() || null,
        p_declared_texture: String(detailDraft?.declaredTexture || '').trim() || null,
        p_declared_density: String(detailDraft?.declaredDensity || '').trim() || null,
        p_declared_condition: String(detailDraft?.declaredCondition || '').trim() || null,
        p_is_chemically_treated: Boolean(detailDraft?.isChemicallyTreated),
        p_is_colored: Boolean(detailDraft?.isColored),
        p_is_bleached: Boolean(detailDraft?.isBleached),
        p_is_rebonded: Boolean(detailDraft?.isRebonded),
        p_detail_notes: String(detailDraft?.detailNotes || '').trim() || null,
      });
      if (result.error) throw result.error;

      const payload = result.data || {};
      const updatedDetails = Array.isArray(payload?.details) ? payload.details : [];
      const updatedSubmission = payload?.submission || null;

      setActiveReview((prev) => ({
        attendee: prev?.attendee || null,
        submission: updatedSubmission || prev?.submission || null,
        details: updatedDetails.length ? updatedDetails : (prev?.details || []),
        aiScreening: prev?.aiScreening || null,
        waybillCode: prev?.waybillCode || '',
      }));
      setDetailDraft(createDetailDraft(updatedDetails?.[0] || null));
      setNotice({ kind: 'success', text: 'Hair details updated.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to update hair details.' });
    } finally {
      setIsSavingDetail(false);
      setIsSaving(false);
    }
  }, [activeReview, detailDraft, reviewStatusMeta.isFinal, selectedEvent]);

  const handleQualityDecision = useCallback(async (decision) => {
    if (!supabase || !selectedEvent) return;

    const submissionId = Number(activeReview?.submission?.Submission_ID || 0);
    const eventRequestId = Number(selectedEvent?.Event_Request_ID || 0);
    if (!submissionId || !eventRequestId) {
      setNotice({ kind: 'error', text: 'Scan an RSVP first to load hair details for review.' });
      return;
    }

    if (reviewStatusMeta.isFinal) {
      setNotice({ kind: 'warning', text: 'Hair quality decision is already final and locked.' });
      return;
    }

    const normalizedDecision = normalizeFlowStatusKey(decision);
    if (!['approved', 'rejected', 'rejectedcut'].includes(normalizedDecision)) {
      setNotice({ kind: 'error', text: 'Invalid quality decision.' });
      return;
    }

    const rejectionReason = String(qualityReason || '').trim();
    if ((normalizedDecision === 'rejected' || normalizedDecision === 'rejectedcut') && !rejectionReason) {
      setNotice({ kind: 'error', text: 'Rejection reason is required for Rejected or Rejected Cut.' });
      return;
    }

    const lengthRaw = String(detailDraft?.declaredLength || '').trim();
    const parsedLength = lengthRaw === '' ? null : Number(lengthRaw);
    if (parsedLength != null && (!Number.isFinite(parsedLength) || parsedLength < 0)) {
      setNotice({ kind: 'error', text: 'Declared length must be a non-negative number.' });
      return;
    }

    setIsSubmittingQuality(true);
    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      // Persist the values currently visible in the editable form before the
      // decision trigger calculates AI-vs-human accuracy. This also covers the
      // common flow where staff edits a field and clicks Approve immediately.
      const detailSaveResult = await supabase.rpc('staff_update_hair_submission_details', {
        p_event_request_id: eventRequestId,
        p_submission_id: submissionId,
        p_declared_length: parsedLength,
        p_declared_color: String(detailDraft?.declaredColor || '').trim() || null,
        p_declared_texture: String(detailDraft?.declaredTexture || '').trim() || null,
        p_declared_density: String(detailDraft?.declaredDensity || '').trim() || null,
        p_declared_condition: String(detailDraft?.declaredCondition || '').trim() || null,
        p_is_chemically_treated: Boolean(detailDraft?.isChemicallyTreated),
        p_is_colored: Boolean(detailDraft?.isColored),
        p_is_bleached: Boolean(detailDraft?.isBleached),
        p_is_rebonded: Boolean(detailDraft?.isRebonded),
        p_detail_notes: String(detailDraft?.detailNotes || '').trim() || null,
      });
      if (detailSaveResult.error) throw detailSaveResult.error;

      const result = await supabase.rpc('staff_review_hair_submission_quality', {
        p_event_request_id: eventRequestId,
        p_submission_id: submissionId,
        p_decision: normalizedDecision === 'approved'
          ? 'Approved'
          : normalizedDecision === 'rejectedcut'
            ? 'Rejected Cut'
            : 'Rejected',
        p_rejection_reason: (normalizedDecision === 'rejected' || normalizedDecision === 'rejectedcut')
          ? rejectionReason
          : null,
      });

      if (result.error) throw result.error;

      const payload = result.data || {};
      const updatedAttendee = payload?.attendee || null;
      const updatedSubmission = payload?.submission || null;
      const updatedDetails = Array.isArray(payload?.details) ? payload.details : [];
      const resolvedDecision = String(
        payload?.decision
        || (normalizedDecision === 'approved'
          ? 'Approved'
          : normalizedDecision === 'rejectedcut'
            ? 'Rejected Cut'
            : 'Rejected'),
      ).trim();

      if (updatedAttendee?.Event_Attendee_ID) {
        setAttendees((current) => {
          const exists = current.some((row) => Number(row.Event_Attendee_ID) === Number(updatedAttendee.Event_Attendee_ID));
          const nextRows = !exists
            ? [updatedAttendee, ...current]
            : current.map((row) => (
            Number(row.Event_Attendee_ID) === Number(updatedAttendee.Event_Attendee_ID) ? updatedAttendee : row
            ));
          if (selectedEvent?.Event_Request_ID) {
            attendeesCacheRef.current.set(Number(selectedEvent.Event_Request_ID), nextRows);
          }
          return nextRows;
        });
      }

      setActiveReview((prev) => ({
        attendee: updatedAttendee || prev?.attendee || null,
        submission: updatedSubmission || prev?.submission || null,
        details: updatedDetails.length ? updatedDetails : (prev?.details || []),
        aiScreening: prev?.aiScreening || null,
        waybillCode: prev?.waybillCode || '',
      }));
      setDetailDraft(createDetailDraft(updatedDetails?.[0] || null));

      setNotice({
        kind: 'success',
        text: resolvedDecision === 'Approved'
          ? 'Hair quality approved. Submission moved to Cut.'
          : resolvedDecision === 'Rejected Cut'
            ? 'Hair quality marked Rejected Cut. Submission moved to Cancelled.'
            : 'Hair quality rejected. Submission moved to Cancelled.',
      });
      setCameraStatus({
        kind: resolvedDecision === 'Approved' ? 'success' : 'warning',
        message: resolvedDecision === 'Approved'
          ? 'Hair quality approved and tagged as Cut. Ready for specialist bundling.'
          : resolvedDecision === 'Rejected Cut'
            ? 'Hair quality marked Rejected Cut and submission marked Cancelled.'
            : 'Hair quality rejected and marked Cancelled.',
      });
      setScanOutcome({
        tone: resolvedDecision === 'Approved' ? 'success' : 'warning',
        title: `Hair review finalized as ${resolvedDecision}`,
        waybill: activeReview?.waybillCode || updatedAttendee?.Waybill_Code || '',
        subject: activeReview?.attendee?.Full_Name || updatedAttendee?.Full_Name || 'Donor',
        action: 'Saved the final staff quality decision',
        status: resolvedDecision === 'Approved' ? 'Cut' : 'Cancelled',
        nextStep: resolvedDecision === 'Approved'
          ? 'Hair is available in Cut Hair Inventory and can be bundled'
          : 'No further processing is allowed for this hair',
        statusChanges: [
          { label: 'Quality detail', before: 'Pending', after: resolvedDecision },
          {
            label: 'Hair submission',
            before: activeReview?.submission?.Status || 'Pending',
            after: resolvedDecision === 'Approved' ? 'Cut' : 'Cancelled',
          },
          ...(resolvedDecision === 'Approved'
            ? [{ label: 'Cut inventory', before: 'Not available', after: 'Cut / Available' }]
            : []),
        ],
      });

      if (resolvedDecision === 'Approved') {
        setQualityReason('');
      }

      // Auto-reset review panel and resume scanner for next attendee.
      setActiveReview(null);
      setDetailDraft(createDetailDraft(null));
      setQualityReason('');
      setManualWaybillCode('');
      setCameraStatus({
        kind: 'info',
        message: 'Decision saved. Hair Intake & Review is restarting for the next donor...',
      });
      await loadAttendees(eventRequestId);
      if (selectedEventEnded) {
        const summaryResult = await supabase.rpc('get_event_operations_summary', {
          p_event_request_id: eventRequestId,
        });
        if (!summaryResult.error) setEventSummary(summaryResult.data || {});
      }
      void startCameraScanner();
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to submit hair quality decision.' });
      setCameraStatus({ kind: 'error', message: error.message || 'Hair quality review failed.' });
    } finally {
      setIsSubmittingQuality(false);
      setIsSaving(false);
    }
  }, [activeReview, detailDraft, qualityReason, reviewStatusMeta.isFinal, selectedEvent, selectedEventEnded, loadAttendees, startCameraScanner]);

  const handleToggleCamera = async () => {
    if (reviewStatusMeta.needsDecision) {
      const message = 'Complete the current hair quality decision before scanning another donor.';
      setNotice({ kind: 'warning', text: message });
      setCameraStatus({ kind: 'warning', message });
      return;
    }

    if (isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraStatus({
        kind: 'info',
        message: scanMode === 'hair_review'
          ? 'Camera is off. Start the scanner to open a pending hair review.'
          : 'Camera is off. Start the scanner to mark RSVP attendance.',
      });
      return;
    }

    await startCameraScanner();
  };

  const handleManualScanLookup = async () => {
    const value = normalizeWaybillCodeInput(manualWaybillCode);
    if (!value) return;
    if (!isValidWaybillCode(value)) {
      const message = 'Enter a complete waybill: WB followed by 6 letters or numbers.';
      setNotice({ kind: 'warning', text: message });
      setCameraStatus({ kind: 'warning', message });
      return;
    }
    if (reviewStatusMeta.needsDecision) {
      const message = 'Complete the current hair quality decision before scanning another donor.';
      setNotice({ kind: 'warning', text: message });
      setCameraStatus({ kind: 'warning', message });
      return;
    }
    const succeeded = await markAttendeePresentByWaybill(value);
    if (succeeded) setManualWaybillCode('');
  };

  const handleScanModeChange = (nextMode) => {
    if (nextMode === scanMode) return;
    if (reviewStatusMeta.needsDecision) {
      setNotice({ kind: 'warning', text: 'Finish the open hair review before changing scanner mode.' });
      return;
    }
    if (nextMode === 'rsvp' && selectedEventEnded) {
      setNotice({ kind: 'warning', text: 'RSVP check-in is closed because this event has ended.' });
      return;
    }
    stopCamera();
    setIsCameraOn(false);
    setScanMode(nextMode);
    setManualWaybillCode('');
    setCameraStatus({
      kind: 'info',
      message: nextMode === 'hair_review'
        ? 'Hair Intake & Review selected. Scan only donors who already completed RSVP check-in.'
        : 'RSVP Check-in selected. This scan only records attendance.',
    });
  };

  useEffect(() => {
    if (!reviewStatusMeta.needsDecision || !isCameraOn) return;
    stopCamera();
    setIsCameraOn(false);
    setCameraStatus({
      kind: 'warning',
      message: 'Scanner paused. Complete the current hair quality decision before scanning the next donor.',
    });
  }, [isCameraOn, reviewStatusMeta.needsDecision, stopCamera]);

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
        void markAttendeePresentByWaybill(decoded);
      } catch {
        // ignore frame-level scan errors
      }
    }, 280);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isCameraOn, markAttendeePresentByWaybill]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const printWaybill = async (attendee) => {
    if (!selectedEvent) return;

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const resolvedStaffId = await resolveStaffUserId();
      const printedAt = getManilaSqlTimestamp();

      const updateResult = await supabase
        .from(EVENT_ATTENDEES_TABLE)
        .update({
          Waybill_Printed_At: printedAt,
          Waybill_Printed_By: resolvedStaffId || null,
          Updated_At: printedAt,
        })
        .eq('Event_Attendee_ID', attendee.Event_Attendee_ID)
        .select('*')
        .single();

      if (updateResult.error) throw updateResult.error;

      const updatedAttendee = {
        ...attendee,
        ...(updateResult.data || {}),
      };
      setAttendees((current) => {
        const nextRows = current.map((row) => (
          Number(row.Event_Attendee_ID || 0) === Number(updatedAttendee.Event_Attendee_ID || 0)
            ? updatedAttendee
            : row
        ));
        const eventRequestId = Number(updatedAttendee?.Event_Request_ID || selectedEvent?.Event_Request_ID || 0);
        if (eventRequestId) {
          attendeesCacheRef.current.set(eventRequestId, nextRows);
        }
        return nextRows;
      });

      const waybillCode =
        updatedAttendee.Waybill_Code
        || `WB${String(Number(updatedAttendee.Event_Attendee_ID || 0)).padStart(6, '0').slice(-6)}`;
      const qrPayload = JSON.stringify({
        Payload_Type: 'Event_RSVP_Waybill',
        Event_Request_ID: Number(selectedEvent.Event_Request_ID || 0) || null,
        Event_Attendee_ID: Number(updatedAttendee.Event_Attendee_ID || 0) || null,
        User_ID: Number(updatedAttendee.User_ID || 0) || null,
        Waybill_Code: waybillCode,
      });
      let qrDataUrl = '';
      try {
        qrDataUrl = await QRCode.toDataURL(qrPayload, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 220,
          color: { dark: '#0f172a', light: '#ffffff' },
        });
      } catch {
        qrDataUrl = '';
      }

      const printWindow = window.open('', '_blank', 'width=760,height=900');
      if (!printWindow) {
        throw new Error('Browser blocked popup window for printing. Please allow popups and try again.');
      }
      const html = `
        <html>
          <head>
            <title>Waybill ${waybillCode}</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
              h1 { margin: 0 0 12px; font-size: 22px; }
              h2 { margin: 20px 0 8px; font-size: 16px; }
              .line { margin: 6px 0; font-size: 14px; }
              .box { border: 2px solid #1e293b; border-radius: 8px; padding: 14px; margin-top: 12px; }
              .code { font-size: 24px; letter-spacing: 2px; font-weight: 700; }
              .qr-wrap { margin-top: 14px; text-align: center; }
              .qr-wrap img { width: 220px; height: 220px; border: 1px solid #cbd5e1; border-radius: 8px; }
              .qr-fallback { width: 220px; height: 220px; margin: 0 auto; border: 1px dashed #64748b; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 700; letter-spacing: 1px; }
              .qr-caption { margin-top: 8px; font-size: 12px; color: #334155; }
            </style>
          </head>
          <body>
            <h1>Hair Submission Waybill</h1>
            <div class="box">
              <div class="line"><strong>Waybill Code:</strong> <span class="code">${waybillCode}</span></div>
              <div class="line"><strong>Printed At:</strong> ${formatDateTime(updatedAttendee.Waybill_Printed_At || printedAt)}</div>
              <div class="qr-wrap">
                ${qrDataUrl
                  ? `<img id="waybill-qr" src="${qrDataUrl}" alt="Waybill QR ${waybillCode}" />`
                  : `<div class="qr-fallback">${waybillCode}</div>`}
                <div class="qr-caption">Scan this QR for RSVP / waybill lookup</div>
              </div>
            </div>

            <h2>Event Details</h2>
            <div class="line"><strong>Event:</strong> ${selectedEvent.Event_Name || 'N/A'}</div>
            <div class="line"><strong>Venue:</strong> ${selectedEvent.Venue_Name || buildAddress(selectedEvent) || 'N/A'}</div>
            <div class="line"><strong>Schedule:</strong> ${formatDateTime(selectedEvent.Start_Date)} - ${formatDateTime(selectedEvent.End_Date)}</div>

            <h2>Attendee Details</h2>
            <div class="line"><strong>Name:</strong> ${updatedAttendee.Full_Name || 'N/A'}</div>
            <div class="line"><strong>Email:</strong> ${updatedAttendee.Email || 'N/A'}</div>
            <div class="line"><strong>Contact:</strong> ${updatedAttendee.Contact_Number || 'N/A'}</div>
            <script>
              (function () {
                function triggerPrint() {
                  setTimeout(function () { window.print(); }, 120);
                }
                var img = document.getElementById('waybill-qr');
                if (!img) {
                  triggerPrint();
                  return;
                }
                if (img.complete) {
                  triggerPrint();
                } else {
                  img.onload = triggerPrint;
                  img.onerror = triggerPrint;
                }
              })();
            </script>
          </body>
        </html>
      `;

      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();

      setNotice({ kind: 'success', text: `Waybill printed for ${updatedAttendee.Full_Name}.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to print waybill.' });
    } finally {
      setIsSaving(false);
    }
  };

  const filteredAttendees = useMemo(() => {
    const term = attendeeSearch.trim().toLowerCase();
    if (!term) return attendees;
    return attendees.filter((row) => {
      const haystack = [
        row.Full_Name,
        row.Email,
        row.Contact_Number,
        row.Waybill_Code,
        row.Attendance_Status,
        row.Hair_Intake_Label,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [attendees, attendeeSearch]);

  const unprintedAttendeeCount = useMemo(
    () => attendees.filter((row) => !row?.Waybill_Printed_At).length,
    [attendees],
  );

  const handleRefreshAll = useCallback(async () => {
    await loadEvents();
    if (selectedEvent?.Event_Request_ID) {
      await loadAttendees(selectedEvent.Event_Request_ID, { force: true });
    }
    setNotice({ kind: 'success', text: 'Data refreshed.' });
  }, [loadAttendees, loadEvents, selectedEvent?.Event_Request_ID]);

  const handlePrintAllWaybills = useCallback(async () => {
    if (!selectedEvent || !supabase) return;

    const targetRows = attendees.filter((row) => Number(row?.Event_Attendee_ID || 0) > 0);
    if (!targetRows.length) {
      setNotice({ kind: 'warning', text: 'No attendees to print in this event.' });
      return;
    }

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const resolvedStaffId = await resolveStaffUserId();
      const printedAt = getManilaSqlTimestamp();
      const targetIds = targetRows.map((row) => Number(row.Event_Attendee_ID)).filter((id) => id > 0);

      const updateResult = await supabase
        .from(EVENT_ATTENDEES_TABLE)
        .update({
          Waybill_Printed_At: printedAt,
          Waybill_Printed_By: resolvedStaffId || null,
          Updated_At: printedAt,
        })
        .eq('Event_Request_ID', Number(selectedEvent.Event_Request_ID || 0))
        .in('Event_Attendee_ID', targetIds)
        .select('*');

      if (updateResult.error) throw updateResult.error;

      const updatedRows = updateResult.data || [];
      const existingById = new Map(
        attendees.map((row) => [Number(row.Event_Attendee_ID || 0), row]),
      );
      const updatedById = new Map(
        updatedRows.map((row) => {
          const id = Number(row.Event_Attendee_ID || 0);
          return [id, { ...(existingById.get(id) || {}), ...row }];
        }),
      );

      const nextRows = attendees.map((row) => (
        updatedById.get(Number(row.Event_Attendee_ID || 0)) || row
      ));
      setAttendees(nextRows);
      attendeesCacheRef.current.set(Number(selectedEvent.Event_Request_ID || 0), nextRows);

      const printRows = nextRows.filter((row) => Number(row?.Event_Attendee_ID || 0) > 0);
      const rowHtmlList = await Promise.all(printRows.map(async (row) => {
        const waybillCode = row.Waybill_Code
          || `WB${String(Number(row.Event_Attendee_ID || 0)).padStart(6, '0').slice(-6)}`;
        const qrPayload = JSON.stringify({
          Payload_Type: 'Event_RSVP_Waybill',
          Event_Request_ID: Number(selectedEvent.Event_Request_ID || 0) || null,
          Event_Attendee_ID: Number(row.Event_Attendee_ID || 0) || null,
          User_ID: Number(row.User_ID || 0) || null,
          Waybill_Code: waybillCode,
        });

        let qrDataUrl = '';
        try {
          qrDataUrl = await QRCode.toDataURL(qrPayload, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 220,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
        } catch {
          qrDataUrl = '';
        }

        return `
          <section class="ticket">
            <h1>Hair Submission Waybill</h1>
            <div class="box">
              <div class="line"><strong>Waybill Code:</strong> <span class="code">${escapeHtml(waybillCode)}</span></div>
              <div class="line"><strong>Printed At:</strong> ${escapeHtml(formatDateTime(row.Waybill_Printed_At || printedAt))}</div>
              <div class="qr-wrap">
                ${qrDataUrl
                  ? `<img src="${qrDataUrl}" alt="Waybill QR ${escapeHtml(waybillCode)}" />`
                  : `<div class="qr-fallback">${escapeHtml(waybillCode)}</div>`}
                <div class="qr-caption">Scan this QR for RSVP / waybill lookup</div>
              </div>
            </div>
            <h2>Event Details</h2>
            <div class="line"><strong>Event:</strong> ${escapeHtml(selectedEvent.Event_Name || 'N/A')}</div>
            <div class="line"><strong>Venue:</strong> ${escapeHtml(selectedEvent.Venue_Name || buildAddress(selectedEvent) || 'N/A')}</div>
            <div class="line"><strong>Schedule:</strong> ${escapeHtml(`${formatDateTime(selectedEvent.Start_Date)} - ${formatDateTime(selectedEvent.End_Date)}`)}</div>
            <h2>Attendee Details</h2>
            <div class="line"><strong>Name:</strong> ${escapeHtml(row.Full_Name || 'N/A')}</div>
            <div class="line"><strong>Email:</strong> ${escapeHtml(row.Email || 'N/A')}</div>
            <div class="line"><strong>Contact:</strong> ${escapeHtml(row.Contact_Number || 'N/A')}</div>
          </section>
        `;
      }));

      const printWindow = window.open('', '_blank', 'width=860,height=980');
      if (!printWindow) {
        throw new Error('Browser blocked popup window for printing. Please allow popups and try again.');
      }

      const html = `
        <html>
          <head>
            <title>Waybills - ER-${Number(selectedEvent.Event_Request_ID || 0)}</title>
            <style>
              @page { size: A4 portrait; margin: 14mm; }
              body { font-family: Arial, sans-serif; color: #0f172a; }
              .ticket { page-break-after: always; }
              .ticket:last-child { page-break-after: auto; }
              h1 { margin: 0 0 12px; font-size: 22px; }
              h2 { margin: 20px 0 8px; font-size: 16px; }
              .line { margin: 6px 0; font-size: 14px; }
              .box { border: 2px solid #1e293b; border-radius: 8px; padding: 14px; margin-top: 12px; }
              .code { font-size: 24px; letter-spacing: 2px; font-weight: 700; }
              .qr-wrap { margin-top: 14px; text-align: center; }
              .qr-wrap img { width: 220px; height: 220px; border: 1px solid #cbd5e1; border-radius: 8px; object-fit: contain; }
              .qr-fallback { width: 220px; height: 220px; margin: 0 auto; border: 1px dashed #64748b; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 700; letter-spacing: 1px; }
              .qr-caption { margin-top: 8px; font-size: 12px; color: #334155; }
            </style>
          </head>
          <body>
            ${rowHtmlList.join('')}
            <script>
              (function () {
                function triggerPrint() {
                  setTimeout(function () { window.print(); }, 140);
                }
                var images = Array.prototype.slice.call(document.images || []);
                if (!images.length) {
                  triggerPrint();
                  return;
                }
                var remaining = images.length;
                function done() {
                  remaining -= 1;
                  if (remaining <= 0) triggerPrint();
                }
                images.forEach(function (img) {
                  if (img.complete) {
                    done();
                  } else {
                    img.onload = done;
                    img.onerror = done;
                  }
                });
              })();
            </script>
          </body>
        </html>
      `;

      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();

      setNotice({ kind: 'success', text: `Printed ${printRows.length} waybill(s) for ER-${selectedEvent.Event_Request_ID}.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to print all waybills.' });
    } finally {
      setIsSaving(false);
    }
  }, [attendees, resolveStaffUserId, selectedEvent]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="role-page-title text-2xl font-bold text-slate-900">Manage Assigned Events</h1>
          <p className="text-sm text-slate-600">View events admin assigned to you, search attendees, and print waybills.</p>
        </div>

        <PageHeaderActions
          onHelp={() => setShowHowToModal(true)}
          helpTitle="Assigned Events workflow guide"
          onRefresh={() => { void handleRefreshAll(); }}
          refreshLoading={isLoadingEvents || isLoadingAttendees || isSaving}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px,1fr]">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <Inbox size={14} />
                Assigned Events
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowCalendarModal(true)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold transition ${
                    selectedCalendarDate
                      ? 'border-sky-200 bg-sky-50 text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Calendar size={12} />
                  {selectedCalendarDate ? formatScheduleDateLabel(selectedCalendarDate, true) : 'Calendar'}
                </button>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                  {filteredEvents.length}{filteredEvents.length !== events.length ? ` / ${events.length}` : ''}
                </span>
              </div>
            </div>
            <div className="mt-3">
              <label htmlFor="assigned-event-time-filter" className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Show events
              </label>
              <select
                id="assigned-event-time-filter"
                value={eventTimeFilter}
                onChange={(event) => {
                  setEventTimeFilter(event.target.value);
                  setSelectedCalendarDate('');
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
              >
                {EVENT_FILTERS.map((filterItem) => (
                  <option key={filterItem.id} value={filterItem.id}>{filterItem.label}</option>
                ))}
              </select>
            </div>
            {selectedCalendarDate && (
              <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-sky-600">Calendar date</p>
                  <p className="truncate text-xs font-semibold text-sky-800">
                    {formatScheduleDateLabel(selectedCalendarDate)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCalendarDate('')}
                  className="rounded-md p-1 text-sky-600 hover:bg-sky-100"
                  aria-label="Clear selected date"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          <div className="max-h-[640px] overflow-auto">
            {isLoadingEvents && filteredEvents.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-5 text-sm text-slate-600">
                <Loader2 size={15} className="animate-spin" />Loading...
              </div>
            ) : filteredEvents.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <Inbox size={20} />
                </div>
                <p className="mt-2.5 text-sm font-semibold text-slate-700">No events in this filter</p>
                <p className="text-xs text-slate-500">
                  {selectedCalendarDate
                    ? 'No assigned events are scheduled on the selected date.'
                    : 'Try another filter (Today, This Week, Upcoming, Ended).'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {filteredEvents.map((row) => {
                  const active = Number(row.Event_Request_ID || 0) === Number(selectedRequestId || 0);
                  return (
                    <li key={row.Event_Request_ID}>
                      <button
                        type="button"
                        onClick={() => setSelectedRequestId(row.Event_Request_ID)}
                        className={`flex w-full flex-col gap-1 px-4 py-3.5 text-left transition ${
                          active ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                        }`}
                        style={active ? { boxShadow: `inset 3px 0 0 ${primaryColor}` } : undefined}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                            ER-{row.Event_Request_ID}
                          </span>
                          <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                            isEventEnded(row)
                              ? 'border-slate-300 bg-slate-100 text-slate-700'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          }`}>
                            {getEffectiveEventStatus(row)}
                          </span>
                        </div>
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {row.Event_Name || 'Untitled Event'}
                        </p>
                        <p className="truncate text-xs text-slate-600">
                          {row.Venue_Name || buildAddress(row) || 'No venue yet'}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {formatDateShort(row.Start_Date)}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="space-y-4">
          {!selectedEvent ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-20 text-center shadow-sm">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <Inbox size={26} />
              </div>
              <h2 className="mt-4 text-base font-bold text-slate-800">Select an assigned event</h2>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                Pick an event from the list to view its attendees and print waybills.
              </p>
            </div>
          ) : (
            <>
              {/* Hero */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${primaryColor}, ${primaryColor}99)` }} />
                <div className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        ER-{selectedEvent.Event_Request_ID}
                      </p>
                      <h2 className="mt-0.5 text-xl font-bold text-slate-900">
                        {selectedEvent.Event_Name || 'Untitled Event'}
                      </h2>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                      selectedEventEnded
                        ? 'border-slate-300 bg-slate-100 text-slate-700'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    }`}>
                      {getEffectiveEventStatus(selectedEvent)}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-slate-100 text-slate-500">
                        <Calendar size={13} />
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Schedule</p>
                        <p className="text-sm text-slate-800">
                          {formatDateTime(selectedEvent.Start_Date)} â€” {formatDateTime(selectedEvent.End_Date)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-slate-100 text-slate-500">
                        <MapPin size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Venue</p>
                        <p className="text-sm text-slate-800">
                          {selectedEvent.Venue_Name || 'N/A'}
                        </p>
                        {buildAddress(selectedEvent) && (
                          <p className="text-xs text-slate-500">{buildAddress(selectedEvent)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {selectedEventEnded && (
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Ended event summary</p>
                      <h3 className="mt-0.5 text-sm font-bold text-slate-900">Final attendance, hair intake, and AI review results</h3>
                    </div>
                    {isLoadingSummary && <Loader2 size={15} className="animate-spin text-slate-500" />}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                    {[
                      ['Registered', eventSummary?.registered],
                      ['Present', eventSummary?.present],
                      ['No-show', eventSummary?.no_show],
                      ['Donors', eventSummary?.donors],
                      ['Voluntary', eventSummary?.voluntary],
                      ['Approved cut', eventSummary?.approved_cut],
                      ['Rejected', eventSummary?.rejected],
                      ['Rejected cut', eventSummary?.rejected_cut],
                      ['Pending review', eventSummary?.pending],
                      ['Inventory added', eventSummary?.inventory_added],
                      ['Corrected AI fields', eventSummary?.ai_corrections],
                      ['AI correct', eventSummary?.ai_accuracy_percent == null ? 'N/A' : `${eventSummary.ai_accuracy_percent}%`],
                      ['Human changes', eventSummary?.ai_accuracy_percent == null ? 'N/A' : `${Math.max(0, 100 - Number(eventSummary.ai_accuracy_percent || 0))}%`],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                        <p className="mt-0.5 text-lg font-bold text-slate-900">{value ?? 0}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    New RSVP check-ins are closed. Pending donor hair reviews can still be completed below.
                  </p>
                </div>
              )}

              {/* Event scanner */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ScanLine size={16} className="text-slate-500" />
                    <h3 className="text-sm font-bold text-slate-800">
                      {scanMode === 'hair_review' ? 'Hair Intake & Review Scanner' : 'RSVP Check-in Scanner'}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void handleToggleCamera(); }}
                    disabled={isStartingCamera || reviewStatusMeta.needsDecision || (scanMode === 'rsvp' && selectedEventEnded)}
                    className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-white transition disabled:opacity-60"
                    style={{ backgroundColor: isCameraOn ? '#dc2626' : tertiaryColor }}
                  >
                    {isStartingCamera ? <Loader2 size={12} className="animate-spin" /> : isCameraOn ? <CameraOff size={12} /> : <Camera size={12} />}
                    {isCameraOn ? 'Stop Camera' : 'Start Camera'}
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => handleScanModeChange('rsvp')}
                    disabled={selectedEventEnded || reviewStatusMeta.needsDecision}
                    className={`rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      scanMode === 'rsvp'
                        ? 'border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <span className="block text-xs font-bold text-slate-900">1. RSVP Check-in</span>
                    <span className="mt-0.5 block text-[11px] text-slate-600">Attendance only. Marks the attendee Present.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleScanModeChange('hair_review')}
                    disabled={reviewStatusMeta.needsDecision}
                    className={`rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      scanMode === 'hair_review'
                        ? 'border-violet-300 bg-violet-50 ring-1 ring-violet-200'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <span className="block text-xs font-bold text-slate-900">2. Hair Intake &amp; Review</span>
                    <span className="mt-0.5 block text-[11px] text-slate-600">Checked-in donors only. Opens AI details for staff review.</span>
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[200px,1fr]">
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-900">
                    <div className="relative aspect-square w-full">
                      <video ref={videoRef} className={`h-full w-full object-cover ${isCameraOn ? '' : 'hidden'}`} autoPlay playsInline muted />
                      {!isCameraOn ? (
                        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-slate-300">
                          Camera preview
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {cameraStatus.kind !== 'error' && <div
                      className={`rounded-md border px-3 py-2 text-xs ${
                        cameraStatus.kind === 'error'
                          ? 'border-rose-200 bg-rose-50 text-rose-700'
                          : cameraStatus.kind === 'warning'
                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                            : cameraStatus.kind === 'success'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-sky-200 bg-sky-50 text-sky-700'
                      }`}
                    >
                      <span className="inline-flex items-start gap-1.5">
                        <AlertCircle size={12} className="mt-0.5" />
                        {cameraStatus.message}
                      </span>
                    </div>}

                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={manualWaybillCode}
                        onChange={(event) => setManualWaybillCode(normalizeWaybillCodeInput(event.target.value))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void handleManualScanLookup();
                          }
                        }}
                        placeholder="WBXXXXXX"
                        maxLength={WAYBILL_CODE_LENGTH}
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                        disabled={reviewStatusMeta.needsDecision}
                      />
                      <button
                        type="button"
                        onClick={handleManualScanLookup}
                        disabled={!String(manualWaybillCode || '').trim() || isSaving || reviewStatusMeta.needsDecision}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                      >
                        {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                        Lookup
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span>Manual entry: WB + 6 letters or numbers</span>
                      <span className="font-mono">{manualWaybillCode.length}/{WAYBILL_CODE_LENGTH}</span>
                    </div>

                    <p className="text-[11px] text-slate-500">
                      {scanMode === 'hair_review'
                        ? 'This scan does not change attendance. It opens a checked-in donor for the final hair decision.'
                        : 'This scan only marks attendance as Present. Donors use the second mode for hair review; voluntary attendees are finished after check-in.'}
                    </p>
                  </div>
                </div>
              </div>

              <WaybillScanResult outcome={scanOutcome} possibleOutcomes={EVENT_SCAN_OUTCOMES} />

              {/* Hair Quality Review */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-800">Hair Quality Review</h3>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                    {activeReview?.submission?.Submission_ID ? `Submission #${activeReview.submission.Submission_ID}` : 'Waiting for scan'}
                  </span>
                </div>

                {activeReview?.voluntaryOnly ? (
                  <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-4 text-sm text-sky-800">
                    <div className="flex items-start gap-2">
                      <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-bold">Voluntary attendee — no hair review required</p>
                        <p className="mt-1 text-xs leading-5">
                          {activeReview?.attendee?.Full_Name || activeReview?.waybillCode || 'This attendee'} only needs RSVP check-in and does not submit hair for quality review.
                        </p>
                        <p className="mt-1 font-mono text-xs">{activeReview?.waybillCode}</p>
                      </div>
                    </div>
                  </div>
                ) : !activeReview?.submission?.Submission_ID ? (
                  <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-xs text-slate-600">
                    Select <strong>Hair Intake &amp; Review</strong>, then scan a donor who already completed RSVP Check-in.
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs md:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Donor</p>
                        <p className="text-sm font-semibold text-slate-900">{activeReview?.attendee?.Full_Name || 'N/A'}</p>
                        <p className="text-slate-600">{activeReview?.attendee?.Email || 'No email'}</p>
                      </div>
                      <div className="md:text-right">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Codes</p>
                        <p className="font-mono text-slate-800">{activeReview?.waybillCode || activeReview?.attendee?.Waybill_Code || 'N/A'}</p>
                        <p className="font-mono text-slate-700">
                          {activeReview?.submission?.Submission_ID
                            ? `Submission #${activeReview.submission.Submission_ID}`
                            : 'No submission linked'}
                        </p>
                        <p className="text-slate-600">Submission status: <strong>{activeReview?.submission?.Status || 'Pending'}</strong></p>
                        <p className="text-slate-600">
                          Decision:
                          {' '}
                          <strong>{reviewStatusMeta.finalStatusLabel || 'Pending'}</strong>
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-800">Editable Hair Details</p>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          reviewStatusMeta.isFinal ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-700'
                        }`}>
                          {reviewStatusMeta.isFinal ? 'Locked' : 'Editable'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <label className="text-xs text-slate-700">
                          Length (inches)
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={detailDraft.declaredLength}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredLength: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
                        </label>
                        <label className="text-xs text-slate-700">
                          Color
                          <select
                            value={detailDraft.declaredColor}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredColor: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          >
                            <option value="">Select color</option>
                            {detailDraft.declaredColor && !HAIR_COLOR_OPTIONS.includes(detailDraft.declaredColor) && (
                              <option value={detailDraft.declaredColor}>{detailDraft.declaredColor} (existing)</option>
                            )}
                            {HAIR_COLOR_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </label>
                        <label className="text-xs text-slate-700">
                          Texture
                          <select
                            value={detailDraft.declaredTexture}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredTexture: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          >
                            <option value="">Select texture</option>
                            {detailDraft.declaredTexture && !HAIR_TEXTURE_OPTIONS.includes(detailDraft.declaredTexture) && (
                              <option value={detailDraft.declaredTexture}>{detailDraft.declaredTexture} (existing)</option>
                            )}
                            {HAIR_TEXTURE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </label>
                        <label className="text-xs text-slate-700">
                          Density
                          <select
                            value={detailDraft.declaredDensity}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredDensity: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          >
                            <option value="">Select density</option>
                            {detailDraft.declaredDensity && !HAIR_DENSITY_OPTIONS.includes(detailDraft.declaredDensity) && (
                              <option value={detailDraft.declaredDensity}>{detailDraft.declaredDensity} (existing)</option>
                            )}
                            {HAIR_DENSITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </label>
                        <label className="text-xs text-slate-700 md:col-span-2">
                          Condition
                          <select
                            value={detailDraft.declaredCondition}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredCondition: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          >
                            <option value="">Select condition</option>
                            {detailDraft.declaredCondition && !HAIR_CONDITION_OPTIONS.includes(detailDraft.declaredCondition) && (
                              <option value={detailDraft.declaredCondition}>{detailDraft.declaredCondition} (existing)</option>
                            )}
                            {HAIR_CONDITION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </label>
                        <label className="text-xs text-slate-700 md:col-span-2">
                          Notes
                          <textarea
                            value={detailDraft.detailNotes}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, detailNotes: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            rows={2}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
                        </label>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                        <label className="inline-flex items-center gap-1 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={detailDraft.isChemicallyTreated}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, isChemicallyTreated: event.target.checked }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                          />
                          Chemically treated
                        </label>
                        <label className="inline-flex items-center gap-1 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={detailDraft.isColored}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, isColored: event.target.checked }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                          />
                          Colored
                        </label>
                        <label className="inline-flex items-center gap-1 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={detailDraft.isBleached}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, isBleached: event.target.checked }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                          />
                          Bleached
                        </label>
                        <label className="inline-flex items-center gap-1 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={detailDraft.isRebonded}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, isRebonded: event.target.checked }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                          />
                          Rebonded
                        </label>
                      </div>

                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => { void handleSaveDetailEdits(); }}
                          disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                          {(isSaving || isSavingDetail) ? <Loader2 size={12} className="animate-spin" /> : null}
                          Save Hair Details
                        </button>
                      </div>
                    </div>

                    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                        <div>
                          <h4 className="text-sm font-bold text-slate-900">Original AI Hair Review</h4>
                          <p className="mt-0.5 text-[11px] text-slate-500">This is the AI baseline used to measure the final staff review accuracy.</p>
                        </div>
                        {activeAiScreening ? (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${changedAiHairFields.length ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-emerald-300 bg-emerald-50 text-emerald-700'}`}>
                              {liveAiAccuracy.comparable > 0
                                ? `AI ${Number(liveAiAccuracy.aiPercent.toFixed(1))}% · Human ${Number(liveAiAccuracy.humanPercent.toFixed(1))}%${changedAiHairFields.length ? ` · Changed: ${changedAiHairFields.join(', ')}` : ''}`
                                : 'No comparable AI fields'}
                            </span>
                            <span className="rounded-full border px-2.5 py-1 text-[11px] font-bold" style={{ borderColor: `${primaryColor}40`, color: primaryColor, backgroundColor: `${primaryColor}0D` }}>
                              AI confidence {formatAiConfidence(activeAiScreening.Confidence_Score)}
                            </span>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex gap-1 border-b border-slate-200 bg-white px-3 pt-3" role="tablist" aria-label="AI review information">
                        {[
                          { id: 'screening', label: 'AI Screening' },
                          { id: 'comments', label: 'AI Comments' },
                        ].map((tab) => {
                          const isSelected = aiReviewTab === tab.id;
                          return (
                            <button
                              key={tab.id}
                              type="button"
                              role="tab"
                              aria-selected={isSelected}
                              onClick={() => setAiReviewTab(tab.id)}
                              className={`rounded-t-lg border border-b-0 px-3 py-2 text-xs font-semibold transition ${isSelected ? 'text-white shadow-sm' : 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
                              style={isSelected ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined}
                            >
                              {tab.label}
                            </button>
                          );
                        })}
                      </div>

                      {!activeAiScreening ? (
                        <div className="m-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center text-xs text-slate-600">
                          No AI screening is linked to this submission. Staff can still complete the manual quality review, but it will not be included in AI accuracy reporting.
                        </div>
                      ) : aiReviewTab === 'screening' ? (
                        <div className="grid grid-cols-2 gap-2 p-4 md:grid-cols-3 xl:grid-cols-5" role="tabpanel">
                          {[
                            ['Estimated length', `${displayAiValue(activeAiScreening.Estimated_Length, '0')} in`],
                            ['Detected color', displayAiValue(activeAiScreening.Detected_Color)],
                            ['Texture', displayAiValue(activeAiScreening.Detected_Texture)],
                            ['Density', displayAiValue(activeAiScreening.Detected_Density)],
                            ['Condition', displayAiValue(activeAiScreening.Detected_Condition)],
                            ['Hair density score', `${displayAiValue(activeAiScreening.Hair_Density_Score, '0')}%`],
                            ['Shine level', `${displayAiValue(activeAiScreening.Shine_Level, '0')}/10`],
                            ['Frizz level', `${displayAiValue(activeAiScreening.Frizz_Level, '0')}/10`],
                            ['Dryness level', `${displayAiValue(activeAiScreening.Dryness_Level, '0')}/10`],
                            ['Damage level', `${displayAiValue(activeAiScreening.Damage_Level, '0')}/10`],
                            ['Bald spots', activeAiScreening.Bald_Spots_Present ? 'Detected' : 'Not detected'],
                            ['Dandruff', activeAiScreening.Dandruff_Detected ? displayAiValue(activeAiScreening.Dandruff_Severity, 'Detected') : 'Not detected'],
                            ['Lice indicators', activeAiScreening.Lice_Detected ? displayAiValue(activeAiScreening.Lice_Confidence, 'Detected') : 'Not detected'],
                            ['Shedding', displayAiValue(activeAiScreening.Shedding_Level)],
                            ['Visible scalp', displayAiValue(activeAiScreening.Visible_Scalp_Area)],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
                              <p className="mt-1 text-xs font-semibold text-slate-900">{value}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2" role="tabpanel">
                          {[
                            ['AI decision', activeAiScreening.Decision],
                            ['Analysis summary', activeAiScreening.Summary],
                            ['Visible damage notes', activeAiScreening.Visible_Damage_Notes],
                            ['Length assessment', activeAiScreening.Length_Assessment],
                            ['Donation readiness', activeAiScreening.Donation_Readiness_Note],
                            ['History assessment', activeAiScreening.History_Assessment],
                            ['Improvement recommendation', activeAiScreening.Improvement_Recommendation],
                            ['Scalp coverage notes', activeAiScreening.Scalp_Coverage_Notes],
                            ['Dandruff notes', activeAiScreening.Dandruff_Notes],
                            ['Lice notes', activeAiScreening.Lice_Notes],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
                              <p className="mt-1 text-xs leading-5 text-slate-700">{displayAiValue(value)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-700" htmlFor="hair-quality-reason">
                        Rejection reason (required for Rejected and Rejected Cut)
                      </label>
                      <textarea
                        id="hair-quality-reason"
                        value={qualityReason}
                        onChange={(event) => setQualityReason(event.target.value)}
                        rows={2}
                        disabled={reviewStatusMeta.isFinal || isSaving || isSubmittingQuality || isSavingDetail}
                        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                        placeholder="Enter reason if hair quality is rejected..."
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => { void handleQualityDecision('Approved'); }}
                        disabled={reviewStatusMeta.isFinal || isSaving || isSubmittingQuality || isSavingDetail}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
                      >
                        {(isSaving || isSubmittingQuality) ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                        Approve Hair (Set Cut)
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleQualityDecision('Rejected'); }}
                        disabled={reviewStatusMeta.isFinal || isSaving || isSubmittingQuality || isSavingDetail}
                        className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
                      >
                        {(isSaving || isSubmittingQuality) ? <Loader2 size={12} className="animate-spin" /> : <AlertCircle size={12} />}
                        Reject Hair (Cancel)
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleQualityDecision('Rejected Cut'); }}
                        disabled={reviewStatusMeta.isFinal || isSaving || isSubmittingQuality || isSavingDetail}
                        className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
                      >
                        {(isSaving || isSubmittingQuality) ? <Loader2 size={12} className="animate-spin" /> : <AlertCircle size={12} />}
                        Rejected Cut (Cancel)
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Attendees */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                      <Users size={15} className="text-slate-500" />
                      <h3 className="text-sm font-bold text-slate-800">Attendee List</h3>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                        {filteredAttendees.length}{attendeeSearch ? ` / ${attendees.length}` : ''}
                      </span>
                    </div>
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      Unprinted: {unprintedAttendeeCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => { void handlePrintAllWaybills(); }}
                      disabled={isSaving || attendees.length === 0}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                    >
                      {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                      Print All Waybills
                    </button>
                  </div>
                  <div className="relative w-full sm:w-72">
                    <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="search"
                      value={attendeeSearch}
                      onChange={(event) => setAttendeeSearch(event.target.value)}
                      placeholder="Search name, email, waybill..."
                      className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-8 text-sm placeholder:text-slate-400 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                    />
                    {attendeeSearch && (
                      <button
                        type="button"
                        onClick={() => setAttendeeSearch('')}
                        className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        aria-label="Clear search"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {isLoadingAttendees && attendees.length === 0 ? (
                  <div className="flex items-center gap-2 px-5 py-6 text-sm text-slate-600">
                    <Loader2 size={15} className="animate-spin" />Loading attendees...
                  </div>
                ) : attendees.length === 0 ? (
                  <div className="flex flex-col items-center px-5 py-10 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                      <Users size={20} />
                    </div>
                    <p className="mt-2.5 text-sm font-semibold text-slate-700">No attendees yet</p>
                    <p className="text-xs text-slate-500">Attendees register through the public event flow.</p>
                  </div>
                ) : filteredAttendees.length === 0 ? (
                  <div className="flex flex-col items-center px-5 py-10 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                      <Search size={18} />
                    </div>
                    <p className="mt-2.5 text-sm font-semibold text-slate-700">No matches</p>
                    <p className="text-xs text-slate-500">Try a different search term.</p>
                    <button
                      type="button"
                      onClick={() => setAttendeeSearch('')}
                      className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                    >
                      Clear search
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-5 py-3 font-semibold text-slate-700">Attendee</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Type</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Waybill</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Attendance</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">RSVP Scanned</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Hair Intake</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Printed At</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAttendees.map((attendee) => (
                          <tr key={attendee.Event_Attendee_ID} className="border-t border-slate-200 transition hover:bg-slate-50/50">
                            <td className="px-5 py-3 align-top">
                              <p className="font-semibold text-slate-900">{attendee.Full_Name || 'N/A'}</p>
                              <p className="text-xs text-slate-600">{attendee.Email || 'No email'}</p>
                              <p className="text-xs text-slate-600">{attendee.Contact_Number || 'No contact'}</p>
                            </td>
                            <td className="px-5 py-3 align-top">
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${
                                normalizeAttendeeType(attendee.Attendee_Type) === 'Voluntary'
                                  ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-violet-200 bg-violet-50 text-violet-700'
                              }`}>
                                {normalizeAttendeeType(attendee.Attendee_Type)}
                              </span>
                            </td>
                            <td className="px-5 py-3 align-top font-mono text-xs text-slate-700">{attendee.Waybill_Code || 'Pending code'}</td>
                            <td className="px-5 py-3 align-top">
                              <span
                                className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${
                                  String(attendee.Attendance_Status || '').toLowerCase() === 'present'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : String(attendee.Attendance_Status || '').toLowerCase().replace(/\s+/g, '') === 'noshow'
                                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                                      : 'border-slate-200 bg-slate-100 text-slate-700'
                                }`}
                              >
                                {attendee.Attendance_Status || 'Not Marked'}
                              </span>
                            </td>
                            <td className="px-5 py-3 align-top text-xs text-slate-600">
                              {attendee.RSVP_Scanned_At ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700">
                                  <CheckCircle2 size={11} />
                                  {formatDateTime(attendee.RSVP_Scanned_At)}
                                </span>
                              ) : (
                                <span className="text-slate-400">Not scanned</span>
                              )}
                            </td>
                            <td className="px-5 py-3 align-top">
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${
                                attendee.Hair_Intake_State === 'done'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : attendee.Hair_Intake_State === 'pending'
                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                    : attendee.Hair_Intake_State === 'not_required'
                                      ? 'border-sky-200 bg-sky-50 text-sky-700'
                                      : 'border-slate-200 bg-slate-100 text-slate-600'
                              }`}>
                                {attendee.Hair_Intake_Label || 'Not started'}
                              </span>
                            </td>
                            <td className="px-5 py-3 align-top text-xs text-slate-600">
                              {attendee.Waybill_Printed_At ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700">
                                  <CheckCircle2 size={11} />
                                  {formatDateTime(attendee.Waybill_Printed_At)}
                                </span>
                              ) : (
                                <span className="text-slate-400">Not printed</span>
                              )}
                            </td>
                            <td className="px-5 py-3 align-top">
                              <button
                                type="button"
                                onClick={() => printWaybill(attendee)}
                                disabled={isSaving}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                              >
                                {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                                Print Waybill
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ProgramScheduleCalendarModal
        open={showCalendarModal}
        onClose={() => setShowCalendarModal(false)}
        records={events}
        selectedDate={selectedCalendarDate}
        onSelectDate={setSelectedCalendarDate}
        primaryColor={primaryColor}
        title="Assigned Event Calendar"
        description="Choose a date to view the events assigned to you."
        recordNoun="event"
        resultCount={filteredEvents.length}
        getStartDate={(row) => row.Start_Date}
        getEndDate={(row) => row.Start_Date}
        getStatus={getEffectiveEventStatus}
        statusItems={[
          { key: 'pendingadminapproval', label: 'Pending', dotClass: 'bg-amber-500', reserved: true },
          { key: 'appealed', label: 'Appealed', dotClass: 'bg-violet-500', reserved: true },
          { key: 'approved', label: 'Assigned / Approved', dotClass: 'bg-emerald-500', reserved: true },
          { key: 'ended', label: 'Ended', dotClass: 'bg-slate-500', reserved: false },
          { key: 'rejected', label: 'Rejected', dotClass: 'bg-rose-500', reserved: false },
          { key: 'cancelled', label: 'Cancelled', dotClass: 'bg-slate-400', reserved: false },
        ]}
        showOpenDates={false}
      />

      {showHowToModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <button type="button" aria-label="Close workflow guide" onClick={() => setShowHowToModal(false)} className="absolute inset-0 border-0 bg-slate-950/60 backdrop-blur-[3px]" />
          <section role="dialog" aria-modal="true" aria-labelledby="assigned-events-guide-title" className="relative z-10 w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-6 py-5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Guide</p>
                <h3 id="assigned-events-guide-title" className="text-xl font-bold text-slate-900">Manage Assigned Events Workflow</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowHowToModal(false)}
                aria-label="Close workflow guide"
                className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"
              >
                <X size={17} />
              </button>
            </div>
            <div className="bg-white p-6 text-sm text-slate-700">
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                Always print all waybills before going to the event.
              </p>
              <div className="mt-3 space-y-2 text-slate-700">
                <p>1. Pick an event using the left panel filters: <strong>Today</strong>, <strong>This Week</strong>, <strong>Upcoming</strong>, or <strong>Ended</strong>.</p>
                <p>2. Click <strong>Print All Waybills</strong> to print every attendee waybill with QR before event deployment.</p>
                <p>3. Use <strong>RSVP Check-in</strong> first. It only records attendance and marks the attendee Present.</p>
                <p>4. For donors, switch to <strong>Hair Intake &amp; Review</strong> and scan the same QR again. Double-check the AI details, make corrections, then choose <strong>Approve</strong>, <strong>Reject</strong>, or <strong>Rejected Cut</strong>.</p>
                <p>5. Use <strong>Refresh</strong> anytime if you want an immediate sync; live updates are already active.</p>
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
