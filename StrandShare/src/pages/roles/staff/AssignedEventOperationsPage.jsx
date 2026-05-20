import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import { useTheme } from '../../../context/ThemeContext';

const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_ATTENDEES_TABLE = 'Event_Attendees';
const HAIR_SUBMISSION_DETAILS_TABLE = 'Hair_Submission_Details';
const USERS_TABLE = 'users';
const SCAN_DEBOUNCE_MS = 2500;

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
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [attendees, setAttendees] = useState([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
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

  const loadAttendees = useCallback(async (eventRequestId) => {
    if (!supabase || !eventRequestId) {
      setAttendees([]);
      return;
    }

    setIsLoadingAttendees(true);
    try {
      let result = await supabase
        .from(EVENT_ATTENDEES_TABLE)
        .select('*')
        .eq('Event_Request_ID', eventRequestId)
        .order('Created_At', { ascending: true });

      if (result.error) throw result.error;
      setAttendees(result.data || []);
    } catch (error) {
      setAttendees([]);
      setNotice({ kind: 'error', text: error.message || 'Unable to load attendees.' });
    } finally {
      setIsLoadingAttendees(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const selectedEvent = useMemo(() => (
    events.find((row) => Number(row.Event_Request_ID || 0) === Number(selectedRequestId || 0)) || null
  ), [events, selectedRequestId]);

  // Auto-select first event when nothing is selected yet
  useEffect(() => {
    if (selectedRequestId == null && events.length > 0) {
      setSelectedRequestId(events[0].Event_Request_ID);
    }
  }, [events, selectedRequestId]);

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
              return exists ? prev : [...prev, payload.new];
            });
          } else if (payload.eventType === 'UPDATE') {
            setAttendees((prev) => prev.map((row) => (
              Number(row.Event_Attendee_ID) === Number(payload.new.Event_Attendee_ID)
                ? payload.new
                : row
            )));
          } else if (payload.eventType === 'DELETE') {
            setAttendees((prev) => prev.filter((row) => (
              Number(row.Event_Attendee_ID) !== Number(payload.old?.Event_Attendee_ID)
            )));
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(requestsChannel);
      supabase.removeChannel(attendeesChannel);
    };
  }, [staffUserId, selectedEvent?.Event_Request_ID]);

  const handleAttendanceStatusChange = async (attendee, nextStatus) => {
    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const result = await supabase
        .from(EVENT_ATTENDEES_TABLE)
        .update({ Attendance_Status: nextStatus })
        .eq('Event_Attendee_ID', attendee.Event_Attendee_ID)
        .select('*')
        .single();

      if (result.error) throw result.error;

      setAttendees((current) => current.map((row) => (
        Number(row.Event_Attendee_ID || 0) === Number(result.data.Event_Attendee_ID || 0)
          ? result.data
          : row
      )));
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to update attendee status.' });
    } finally {
      setIsSaving(false);
    }
  };

  const stopCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

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
          if (!exists) return [updated, ...current];
          return current.map((row) => (
            Number(row.Event_Attendee_ID) === Number(updated.Event_Attendee_ID) ? updated : row
          ));
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
          if (!exists) return [updatedAttendee, ...current];
          return current.map((row) => (
            Number(row.Event_Attendee_ID) === Number(updatedAttendee.Event_Attendee_ID) ? updatedAttendee : row
          ));
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
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to submit hair quality decision.' });
      setCameraStatus({ kind: 'error', message: error.message || 'Hair quality review failed.' });
    } finally {
      setIsSubmittingQuality(false);
      setIsSaving(false);
    }
  }, [activeReview, qualityReason, reviewStatusMeta.isFinal, selectedEvent]);

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

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus({ kind: 'error', message: 'Camera API is unavailable on this browser/device.' });
      return;
    }

    setIsStartingCamera(true);
    setCameraStatus({ kind: 'info', message: 'Initializing camera scanner...' });

    try {
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
      const printedAt = new Date().toISOString();

      const updateResult = await supabase
        .from(EVENT_ATTENDEES_TABLE)
        .update({
          Waybill_Printed_At: printedAt,
          Waybill_Printed_By: resolvedStaffId || null,
        })
        .eq('Event_Attendee_ID', attendee.Event_Attendee_ID)
        .select('*')
        .single();

      if (updateResult.error) throw updateResult.error;

      const updatedAttendee = updateResult.data;
      setAttendees((current) => current.map((row) => (
        Number(row.Event_Attendee_ID || 0) === Number(updatedAttendee.Event_Attendee_ID || 0)
          ? updatedAttendee
          : row
      )));

      const waybillCode = updatedAttendee.Waybill_Code || `EVT-WB-${updatedAttendee.Event_Attendee_ID}`;
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
            </style>
          </head>
          <body>
            <h1>Hair Submission Waybill</h1>
            <div class="box">
              <div class="line"><strong>Waybill Code:</strong> <span class="code">${waybillCode}</span></div>
              <div class="line"><strong>Printed At:</strong> ${formatDateTime(printedAt)}</div>
            </div>

            <h2>Event Details</h2>
            <div class="line"><strong>Event:</strong> ${selectedEvent.Event_Name || 'N/A'}</div>
            <div class="line"><strong>Venue:</strong> ${selectedEvent.Venue_Name || buildAddress(selectedEvent) || 'N/A'}</div>
            <div class="line"><strong>Schedule:</strong> ${formatDateTime(selectedEvent.Start_Date)} - ${formatDateTime(selectedEvent.End_Date)}</div>

            <h2>Attendee Details</h2>
            <div class="line"><strong>Name:</strong> ${updatedAttendee.Full_Name || 'N/A'}</div>
            <div class="line"><strong>Email:</strong> ${updatedAttendee.Email || 'N/A'}</div>
            <div class="line"><strong>Contact:</strong> ${updatedAttendee.Contact_Number || 'N/A'}</div>
          </body>
        </html>
      `;

      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();

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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Assigned Event Operations</h1>
        <p className="text-sm text-slate-600">View events admin assigned to you, search attendees, and print waybills.</p>
      </div>

      {notice.text && (
        <div className={`rounded-lg px-4 py-3 text-sm ${notice.kind === 'error' ? 'border border-rose-200 bg-rose-50 text-rose-700' : 'border border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
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
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                {events.length}
              </span>
            </div>
          </div>
          <div className="max-h-[640px] overflow-auto">
            {isLoadingEvents && events.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-5 text-sm text-slate-600">
                <Loader2 size={15} className="animate-spin" />Loading...
              </div>
            ) : events.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <Inbox size={20} />
                </div>
                <p className="mt-2.5 text-sm font-semibold text-slate-700">No assigned events</p>
                <p className="text-xs text-slate-500">Events appear here once admin assigns you to an approved request.</p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {events.map((row) => {
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
                        <p className="font-mono text-slate-700">{activeReview?.submission?.Submission_Code || 'No submission code'}</p>
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
                  <div className="flex items-center gap-2">
                    <Users size={15} className="text-slate-500" />
                    <h3 className="text-sm font-bold text-slate-800">Attendee List</h3>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                      {filteredAttendees.length}{attendeeSearch ? ` / ${attendees.length}` : ''}
                    </span>
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
                              <select
                                value={attendee.Attendance_Status || 'Not Marked'}
                                onChange={(event) => handleAttendanceStatusChange(attendee, event.target.value)}
                                className="rounded border border-slate-300 px-2 py-1 text-xs transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                                disabled={isSaving}
                              >
                                <option value="Not Marked">Not Marked</option>
                                <option value="Present">Present</option>
                                <option value="No Show">No Show</option>
                              </select>
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
    </div>
  );
}
