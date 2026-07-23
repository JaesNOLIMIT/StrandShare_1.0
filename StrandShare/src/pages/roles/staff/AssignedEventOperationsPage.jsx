import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CameraOff,
  Calendar,
  CheckCircle2,
  HelpCircle,
  Inbox,
  Loader2,
  MapPin,
  Printer,
  RefreshCw,
  ScanLine,
  Search,
  Users,
  X,
} from 'lucide-react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import { useTheme } from '../../../context/ThemeContext';
import ProgramScheduleCalendarModal, {
  formatScheduleDateLabel,
  toScheduleDateKey,
} from '../../../components/events/ProgramScheduleCalendarModal';

const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_ATTENDEES_TABLE = 'Event_Attendees';
const HAIR_SUBMISSION_DETAILS_TABLE = 'Hair_Submission_Details';
const USERS_TABLE = 'users';
const USER_DETAILS_TABLE = 'user_details';
const SCAN_DEBOUNCE_MS = 2500;
const EVENT_FILTERS = [
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This Week' },
  { id: 'upcoming', label: 'Upcoming' },
];
const MANILA_OFFSET_MINUTES = 8 * 60;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

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
  };
}

function normalizeFlowStatusKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\s-]+/g, '');
}

function isFinalHairDetailStatus(status) {
  const key = normalizeFlowStatusKey(status);
  return key === 'approved' || key === 'rejected' || key === 'rejectedcut';
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

export default function AssignedEventOperationsPage({ userProfile }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';

  const [staffUserId, setStaffUserId] = useState(userProfile?.user_id || null);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [isLoadingAttendees, setIsLoadingAttendees] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });

  const [events, setEvents] = useState([]);
  const [eventTimeFilter, setEventTimeFilter] = useState('this_week');
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
  const [activeReview, setActiveReview] = useState(null);
  const [qualityReason, setQualityReason] = useState('');
  const [detailDraft, setDetailDraft] = useState(() => createDetailDraft(null));
  const [isSubmittingQuality, setIsSubmittingQuality] = useState(false);
  const [isSavingDetail, setIsSavingDetail] = useState(false);

  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const isScanProcessingRef = useRef(false);
  const lastScanRef = useRef({ raw: '', at: 0 });
  const attendeesCacheRef = useRef(new Map());
  const attendeeLoadSeqRef = useRef(0);

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
        .select('Event_Attendee_ID, User_ID, Registration_Status, Attendance_Status, Waybill_Code, Waybill_Printed_At, Waybill_Printed_By, Notes, Created_At, Updated_At, Event_Request_ID, RSVP_Scanned_At, RSVP_Scanned_By')
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
      if (userIds.length) {
        const [usersResult, detailsResult] = await Promise.all([
          supabase
            .from(USERS_TABLE)
            .select('user_id, email')
            .in('user_id', userIds),
          supabase
            .from(USER_DETAILS_TABLE)
            .select('user_id, first_name, middle_name, last_name, suffix, contact_number')
            .in('user_id', userIds),
        ]);

        if (usersResult.error) throw usersResult.error;
        if (detailsResult.error) throw detailsResult.error;

        for (const userRow of usersResult.data || []) {
          usersById.set(Number(userRow.user_id || 0), userRow);
        }
        for (const detailRow of detailsResult.data || []) {
          detailsById.set(Number(detailRow.user_id || 0), detailRow);
        }
      }

      const rows = baseRows.map((row) => {
        const userId = Number(row?.User_ID || 0);
        return enrichAttendeeRowWithUserData(
          row,
          usersById.get(userId) || null,
          detailsById.get(userId) || null,
        );
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
  }, [selectedEvent, loadAttendees]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;
    const intervalId = window.setInterval(() => {
      void loadEvents({ silent: true });
      if (selectedEvent?.Event_Request_ID) {
        void loadAttendees(selectedEvent.Event_Request_ID, { silent: true });
      }
    }, 30000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadEvents, loadAttendees, selectedEvent?.Event_Request_ID]);

  // Realtime: keep assigned events + attendees in sync
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

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
            setAttendees((prev) => {
              const exists = prev.some((row) => Number(row.Event_Attendee_ID) === Number(payload.new.Event_Attendee_ID));
              const nextRows = exists ? prev : [...prev, payload.new];
              attendeesCacheRef.current.set(targetEventRequestId, nextRows);
              return nextRows;
            });
          } else if (payload.eventType === 'UPDATE') {
            setAttendees((prev) => {
              const nextRows = prev.map((row) => (
                Number(row.Event_Attendee_ID) === Number(payload.new.Event_Attendee_ID)
                  ? payload.new
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
  }, [staffUserId, selectedEvent?.Event_Request_ID]);

  const stopCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

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
      setCameraStatus({ kind: 'success', message: 'Scanner is running. Point camera at attendee RSVP QR/waybill.' });
    } catch (error) {
      setCameraStatus({ kind: 'error', message: error?.message || 'Could not access the camera.' });
    } finally {
      setIsStartingCamera(false);
    }
  }, [isCameraOn, isStartingCamera, stopCamera]);

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

  const markAttendeePresentByWaybill = useCallback(async (rawValue) => {
    if (isScanProcessingRef.current || !selectedEvent || !supabase) return;

    if (reviewStatusMeta.needsDecision) {
      const message = 'Complete the current hair quality decision first before scanning another RSVP.';
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

      const scanResult = await supabase.rpc('scan_event_attendee_rsvp', {
        p_event_request_id: eventRequestId,
        p_qr_payload: String(rawValue || ''),
      });
      if (scanResult.error) throw scanResult.error;

      const payload = scanResult.data || {};
      const updated = payload?.attendee || null;
      const submission = payload?.submission || null;
      const submissionStatus = String(
        payload?.submission_status
        || payload?.submission?.Status
        || '',
      ).trim();
      const resolvedWaybillCode = String(
        payload?.waybill_code
        || updated?.Waybill_Code
        || scan.waybillCode
        || '',
      ).trim();

      if (updated?.Event_Attendee_ID) {
        setAttendees((current) => {
          const exists = current.some((row) => Number(row.Event_Attendee_ID) === Number(updated.Event_Attendee_ID));
          const nextRows = !exists
            ? [updated, ...current]
            : current.map((row) => (
            Number(row.Event_Attendee_ID) === Number(updated.Event_Attendee_ID) ? updated : row
            ));
          if (selectedEvent?.Event_Request_ID) {
            attendeesCacheRef.current.set(Number(selectedEvent.Event_Request_ID), nextRows);
          }
          return nextRows;
        });
      } else {
        await loadAttendees(selectedEvent.Event_Request_ID);
      }

      let details = Array.isArray(payload?.details) ? payload.details : [];
      const submissionId = Number(submission?.Submission_ID || 0);
      if (!details.length && submissionId > 0) {
        details = await loadSubmissionDetailsById(submissionId);
      }

      setActiveReview({
        attendee: updated || null,
        submission: submission || null,
        details,
        waybillCode: resolvedWaybillCode,
      });
      setQualityReason('');
      setDetailDraft(createDetailDraft(details?.[0] || null));

      setNotice({ kind: 'success', text: `RSVP marked present for ${updated?.Full_Name || resolvedWaybillCode || 'attendee'}.` });
      setCameraStatus({
        kind: 'success',
        message: `RSVP success: ${updated?.Full_Name || 'Attendee'} marked Present.${submissionStatus ? ` Hair submission: ${submissionStatus}.` : ''} Review hair quality below.`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to process RSVP scan.' });
      setCameraStatus({ kind: 'error', message: error.message || 'RSVP scan failed.' });
    } finally {
      setIsSaving(false);
      isScanProcessingRef.current = false;
    }
  }, [loadAttendees, loadSubmissionDetailsById, reviewStatusMeta.needsDecision, selectedEvent]);

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

    setIsSubmittingQuality(true);
    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
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
        message: 'Decision saved. Scanner is restarting for the next RSVP...',
      });
      await loadAttendees(eventRequestId);
      void startCameraScanner();
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to submit hair quality decision.' });
      setCameraStatus({ kind: 'error', message: error.message || 'Hair quality review failed.' });
    } finally {
      setIsSubmittingQuality(false);
      setIsSaving(false);
    }
  }, [activeReview, qualityReason, reviewStatusMeta.isFinal, selectedEvent, loadAttendees, startCameraScanner]);

  const handleToggleCamera = async () => {
    if (reviewStatusMeta.needsDecision) {
      const message = 'Complete the current hair quality decision first before scanning another RSVP.';
      setNotice({ kind: 'warning', text: message });
      setCameraStatus({ kind: 'warning', message });
      return;
    }

    if (isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraStatus({ kind: 'info', message: 'Camera is off. Start scanner to mark RSVP attendance.' });
      return;
    }

    await startCameraScanner();
  };

  const handleManualScanLookup = () => {
    const value = String(manualWaybillCode || '').trim();
    if (!value) return;
    if (reviewStatusMeta.needsDecision) {
      const message = 'Complete the current hair quality decision first before scanning another RSVP.';
      setNotice({ kind: 'warning', text: message });
      setCameraStatus({ kind: 'warning', message });
      return;
    }
    setManualWaybillCode('');
    void markAttendeePresentByWaybill(value);
  };

  useEffect(() => {
    if (!reviewStatusMeta.needsDecision || !isCameraOn) return;
    stopCamera();
    setIsCameraOn(false);
    setCameraStatus({
      kind: 'warning',
      message: 'Scanner paused. Complete the current hair quality decision before scanning the next RSVP.',
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
          <h1 className="text-2xl font-bold text-slate-900">Manage Assigned Events</h1>
          <p className="text-sm text-slate-600">View events admin assigned to you, search attendees, and print waybills.</p>
          <p className="mt-1 text-xs text-emerald-700">
            Live updates are active. Data also refreshes every 30 seconds automatically.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleRefreshAll(); }}
            disabled={isLoadingEvents || isLoadingAttendees || isSaving}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
          >
            {(isLoadingEvents || isLoadingAttendees || isSaving) ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowHowToModal(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            <HelpCircle size={12} />
            How to use
          </button>
        </div>
      </div>

      {notice.text && (
        <div className={`rounded-lg px-4 py-3 text-sm ${
          notice.kind === 'error'
            ? 'border border-rose-200 bg-rose-50 text-rose-700'
            : notice.kind === 'warning'
              ? 'border border-amber-200 bg-amber-50 text-amber-700'
              : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}>
          {notice.text}
        </div>
      )}

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
            <div className="mt-3 grid grid-cols-3 gap-1">
              {EVENT_FILTERS.map((filterItem) => {
                const active = eventTimeFilter === filterItem.id;
                return (
                  <button
                    key={filterItem.id}
                    type="button"
                    onClick={() => setEventTimeFilter(filterItem.id)}
                    className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                      active
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {filterItem.label}
                  </button>
                );
              })}
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
                    : 'Try another filter (Today, This Week, Upcoming).'}
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
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            {row.Status || 'Approved'}
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
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      {selectedEvent.Status || 'Approved'}
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
                          {formatDateTime(selectedEvent.Start_Date)} — {formatDateTime(selectedEvent.End_Date)}
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

              {/* RSVP Scanner */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ScanLine size={16} className="text-slate-500" />
                    <h3 className="text-sm font-bold text-slate-800">RSVP Scanner</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void handleToggleCamera(); }}
                    disabled={isStartingCamera || reviewStatusMeta.needsDecision}
                    className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-white transition disabled:opacity-60"
                    style={{ backgroundColor: isCameraOn ? '#dc2626' : tertiaryColor }}
                  >
                    {isStartingCamera ? <Loader2 size={12} className="animate-spin" /> : isCameraOn ? <CameraOff size={12} /> : <Camera size={12} />}
                    {isCameraOn ? 'Stop Camera' : 'Start Camera'}
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
                    <div
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
                    </div>

                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={manualWaybillCode}
                        onChange={(event) => setManualWaybillCode(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            handleManualScanLookup();
                          }
                        }}
                        placeholder="Enter waybill code"
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

                    <p className="text-[11px] text-slate-500">
                      Scanning marks attendee as <strong>Present</strong> and loads hair details below. Final decision options are <strong>Approved</strong>, <strong>Rejected</strong>, or <strong>Rejected Cut</strong>. You cannot scan the next RSVP until a final decision is submitted.
                    </p>
                  </div>
                </div>
              </div>

              {/* Hair Quality Review */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-800">Hair Quality Review</h3>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                    {activeReview?.submission?.Submission_ID ? `Submission #${activeReview.submission.Submission_ID}` : 'Waiting for scan'}
                  </span>
                </div>

                {!activeReview?.submission?.Submission_ID ? (
                  <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-xs text-slate-600">
                    Scan an RSVP QR first to load donor hair details for approval or rejection.
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
                          <input
                            type="text"
                            value={detailDraft.declaredColor}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredColor: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
                        </label>
                        <label className="text-xs text-slate-700">
                          Texture
                          <input
                            type="text"
                            value={detailDraft.declaredTexture}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredTexture: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
                        </label>
                        <label className="text-xs text-slate-700">
                          Density
                          <input
                            type="text"
                            value={detailDraft.declaredDensity}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredDensity: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
                        </label>
                        <label className="text-xs text-slate-700 md:col-span-2">
                          Condition
                          <input
                            type="text"
                            value={detailDraft.declaredCondition}
                            onChange={(event) => setDetailDraft((prev) => ({ ...prev, declaredCondition: event.target.value }))}
                            disabled={reviewStatusMeta.isFinal || isSaving || isSavingDetail}
                            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
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
                          <th className="px-5 py-3 font-semibold text-slate-700">Waybill</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">Attendance</th>
                          <th className="px-5 py-3 font-semibold text-slate-700">RSVP Scanned</th>
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
        getStatus={(row) => row.Status}
        statusItems={[
          { key: 'pendingadminapproval', label: 'Pending', dotClass: 'bg-amber-500', reserved: true },
          { key: 'appealed', label: 'Appealed', dotClass: 'bg-violet-500', reserved: true },
          { key: 'approved', label: 'Assigned / Approved', dotClass: 'bg-emerald-500', reserved: true },
          { key: 'rejected', label: 'Rejected', dotClass: 'bg-rose-500', reserved: false },
          { key: 'cancelled', label: 'Cancelled', dotClass: 'bg-slate-400', reserved: false },
        ]}
        showOpenDates={false}
      />

      {showHowToModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Guide</p>
                <h3 className="text-lg font-bold text-slate-900">How to Use Manage Assigned Events</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowHowToModal(false)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <div className="px-5 pb-5 text-sm text-slate-700">
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                Always print all waybills before going to the event.
              </p>
              <div className="mt-3 space-y-2 text-slate-700">
                <p>1. Pick an event using the left panel filters: <strong>Today</strong>, <strong>This Week</strong>, or <strong>Upcoming</strong>.</p>
                <p>2. Click <strong>Print All Waybills</strong> to print every attendee waybill with QR before event deployment.</p>
                <p>3. At the event, use <strong>Start Camera</strong> to scan RSVP QR or waybill and load donor hair details.</p>
                <p>4. Save hair detail edits if needed, then submit one final decision: <strong>Approve</strong>, <strong>Reject</strong>, or <strong>Rejected Cut</strong>.</p>
                <p>5. Use <strong>Refresh</strong> anytime if you want an immediate sync; live updates are already active.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
