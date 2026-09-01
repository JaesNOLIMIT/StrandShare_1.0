import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, CheckCircle2, Info, Loader2, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { logAuditAction } from '../../../lib/auditLogger';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import PageHeaderActions from '../../../components/PageHeaderActions';

const WIG_REQUESTS_TABLE = 'Wig_Requests';
const WIGS_TABLE = 'Wigs';
const WIG_SPECS_TABLE = 'Wig_Specifications';
const WIG_FILTERS_TABLE = 'Wig_AI_Filters';
const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
const HOSPITALS_TABLE = 'Hospitals';
const RELEASE_SCHEDULES_TABLE = 'Release_Schedules';
const SAFETY_ASSESSMENTS_TABLE = 'patient_wig_safety_assessments';
const PATIENT_ASSETS_BUCKET = 'patient_assets';
const PROFILE_PICTURES_BUCKET = 'profile_pictures';
const WIG_REQUEST_PREVIEWS_BUCKET = 'wig_request_previews';
const WIG_AI_FILTERS_BUCKET = 'wig_ai_filters';
const WIG_AI_SOURCES_BUCKET = 'wig_ai_sources';
const PST_TIMEZONE = 'Asia/Manila';
const PST_OFFSET = '+08:00';

const REQUEST_STATUS = {
  pending: 'Pending',
  acceptedAllocated: 'Accepted - Wig Allocated',
  acceptedInProduction: 'Accepted - In Production',
  readyForPickup: 'Ready for Pick-up',
  toBeRelease: 'To Be Release',
  releasing: 'Releasing',
  released: 'Released',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_FILTERS = [
  { id: 'all_active', label: 'All Active Requests' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted_allocated', label: 'Accepted - Wig Allocated' },
  { id: 'accepted_in_production', label: 'Accepted - In Production' },
  { id: 'ready_for_pickup', label: 'Ready for Pick-up' },
  { id: 'to_be_release', label: 'To Be Release' },
  { id: 'releasing', label: 'Releasing' },
  { id: 'released', label: 'Released' },
];

const ACTIVE_REQUEST_STATUS_KEYS = ['pending', 'accepted_allocated', 'accepted_in_production', 'ready_for_pickup', 'to_be_release', 'releasing'];

const ACTION_DEFINITIONS = {
  accept_allocated: {
    label: 'Accept - Wig Allocated',
    requiresWigSelection: true,
  },
  accept_in_production: {
    label: 'Accept - In Production',
  },
  mark_ready_for_pickup: {
    label: 'Mark Ready for Pick-up',
  },
  submit_release_date: {
    label: 'Submit Release Date (Move to To Be Release)',
    requiresReleaseDate: true,
  },
  resubmit_release_date: {
    label: 'Resubmit Release Date',
    requiresReleaseDate: true,
  },
  reject: {
    label: 'Reject Request',
    requiresReason: true,
  },
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatusKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

function toPositiveNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeReleaseWorkflowKey(value) {
  const key = normalizeStatusKey(value);

  if (['pending', 'pendinghospitalapproval', 'pendingapproval'].includes(key)) {
    return 'pending_hospital_approval';
  }

  if (['approved', 'hospitalapproved', 'hospitalapproval'].includes(key)) {
    return 'hospital_approved';
  }

  if (['reschedulerequested', 'hospitalreschedulerequested', 'reschedule'].includes(key)) {
    return 'hospital_reschedule_requested';
  }

  return '';
}

function getReleaseWorkflowLabel(value) {
  const key = normalizeReleaseWorkflowKey(value);

  if (key === 'pending_hospital_approval') return 'Pending H-Representative Approval';
  if (key === 'hospital_approved') return 'H-Representative Approved';
  if (key === 'hospital_reschedule_requested') return 'H-Representative Reschedule Requested';
  return 'N/A';
}

function releaseWorkflowClass(value) {
  const key = normalizeReleaseWorkflowKey(value);

  if (key === 'pending_hospital_approval') return 'bg-amber-100 text-amber-700';
  if (key === 'hospital_approved') return 'bg-emerald-100 text-emerald-700';
  if (key === 'hospital_reschedule_requested') return 'bg-rose-100 text-rose-700';
  return 'bg-slate-100 text-slate-700';
}

function getCanonicalStatusKey(statusValue) {
  const key = normalizeStatusKey(statusValue);

  if (['pendingreview', 'pending', 'pendingvalidation', 'pendingconfirmation'].includes(key)) {
    return 'pending';
  }

  if (['acceptedwithallocatedwig', 'acceptedallocatedwig', 'acceptedwigallocated', 'allocated', 'allocatedwig'].includes(key)) {
    return 'accepted_allocated';
  }

  if (['acceptedbutnowigavailable', 'acceptednowigavailable', 'acceptedinproduction', 'inproduction', 'production', 'inprocess', 'nowigavailable', 'findingmatchingwig', 'formatching', 'matching', 'findingallocatingwig', 'findingandallocatingwig'].includes(key)) {
    return 'accepted_in_production';
  }

  if (['readyforpickup', 'readyforpick-up'].includes(key)) {
    return 'ready_for_pickup';
  }

  if (['readyforevent', 'readyforrelease', 'readyforfitting', 'readyforhandingover', 'toberelease'].includes(key)) {
    return 'to_be_release';
  }

  if (['releasing', 'forrelease', 'releaseongoing'].includes(key)) {
    return 'releasing';
  }

  if (['completed', 'complete', 'released', 'releasecompleted', 'done'].includes(key)) {
    return 'released';
  }

  if (['rejected', 'declined', 'denied'].includes(key)) {
    return 'rejected';
  }

  if (['cancelled', 'canceled', 'cancel'].includes(key)) {
    return 'cancelled';
  }

  if (['approved', 'accepted', 'acceptedforallocation', 'confirmed'].includes(key)) {
    return 'accepted_allocated';
  }

  return 'pending';
}

function getStatusLabel(statusValue) {
  const key = getCanonicalStatusKey(statusValue);

  if (key === 'accepted_allocated') return REQUEST_STATUS.acceptedAllocated;
  if (key === 'accepted_in_production') return REQUEST_STATUS.acceptedInProduction;
  if (key === 'ready_for_pickup') return REQUEST_STATUS.readyForPickup;
  if (key === 'to_be_release') return REQUEST_STATUS.toBeRelease;
  if (key === 'releasing') return REQUEST_STATUS.releasing;
  if (key === 'released') return REQUEST_STATUS.released;
  if (key === 'rejected') return REQUEST_STATUS.rejected;
  if (key === 'cancelled') return REQUEST_STATUS.cancelled;
  return REQUEST_STATUS.pending;
}

function statusClass(statusValue) {
  const key = getCanonicalStatusKey(statusValue);

  if (key === 'accepted_allocated') return 'bg-emerald-100 text-emerald-700';
  if (key === 'accepted_in_production') return 'bg-lime-100 text-lime-700';
  if (key === 'ready_for_pickup') return 'bg-cyan-100 text-cyan-800';
  if (key === 'to_be_release') return 'bg-indigo-100 text-indigo-700';
  if (key === 'releasing') return 'bg-teal-100 text-teal-700';
  if (key === 'released') return 'bg-green-100 text-green-700';
  if (key === 'rejected') return 'bg-red-100 text-red-700';
  if (key === 'cancelled') return 'bg-slate-200 text-slate-700';
  return 'bg-amber-100 text-amber-700';
}

function getPatientUserName(userRow) {
  if (!userRow) {
    return '';
  }

  const details = Array.isArray(userRow.user_details)
    ? userRow.user_details[0]
    : userRow.user_details;

  const fullName = [details?.first_name, details?.middle_name, details?.last_name, details?.suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return fullName || String(userRow.email || '').trim() || '';
}

function getPatientFullName(patientRow, linkedUserRow = null) {
  if (!patientRow) {
    return 'Unknown Patient';
  }

  const linkedUserName = getPatientUserName(linkedUserRow);
  if (linkedUserName) {
    return linkedUserName;
  }

  return patientRow.Patient_Code || (patientRow.User_ID ? `User #${patientRow.User_ID}` : `Patient #${patientRow.Patient_ID}`);
}

function formatRequestCode(requestCodeValue, reqIdValue) {
  const rawCode = String(requestCodeValue || '').trim();
  if (rawCode) {
    const cleanedCode = rawCode.toUpperCase();
    return cleanedCode.startsWith('WR') ? cleanedCode : `WR${cleanedCode}`;
  }
  const reqId = Number(reqIdValue || 0);
  if (!reqId) {
    return 'WR------';
  }
  return `WR${String(reqId).padStart(6, '0')}`;
}

function buildPatientAddress(details) {
  return [
    details?.street,
    details?.barangay,
    details?.city,
    details?.province,
    details?.region,
    details?.country,
  ].map((value) => String(value || '').trim()).filter(Boolean).join(', ') || 'N/A';
}

function parseSpecialNotesPayload(specialNotesValue) {
  const raw = String(specialNotesValue || '').trim();
  if (!raw) {
    return {};
  }

  if (!raw.startsWith('SSMETA:')) {
    return {
      specialNoteTemplate: raw,
    };
  }

  try {
    const parsed = JSON.parse(raw.slice(7));
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch {
    return {
      specialNoteTemplate: raw,
    };
  }
}

function formatDateTime(value) {
  if (!value) {
    return 'N/A';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  return parsed.toLocaleString('en-PH', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toDateTimeLocalValue(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(parsed).map((part) => [part.type, part.value]),
  );

  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

function toIsoFromDateTimeLocal(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2}))?$/);
  if (match) {
    const seconds = match[7] || '00';
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${seconds}${PST_OFFSET}`;
  }
  const fallback = new Date(raw);
  if (Number.isNaN(fallback.getTime())) {
    return '';
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(fallback).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${PST_OFFSET}`;
}

function getMinimumReleaseDateTimeLocal(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const minimumDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 3));
  const year = minimumDate.getUTCFullYear();
  const month = String(minimumDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(minimumDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T00:00`;
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function resolveStoragePublicUrl(bucket, value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  if (isAbsoluteUrl(raw)) {
    return raw;
  }

  if (!supabase) {
    return '';
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(raw);
  return data?.publicUrl || '';
}

async function resolveStorageSignedUrl(bucket, value, expiresInSeconds = 3600) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  if (isAbsoluteUrl(raw)) {
    return raw;
  }

  if (!supabase) {
    return '';
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(raw, expiresInSeconds);

  if (error) {
    return '';
  }

  return String(data?.signedUrl || '').trim();
}

function mapLoadError(rawMessage) {
  const message = String(rawMessage || 'Unable to load wig request records.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('allocated_wig_id') && lowerMessage.includes('column')) {
    return 'Database migration is missing. Run supabase/119_add_allocated_wig_id_for_actual_allocation.sql, then refresh.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Data access is blocked by database policy. Verify your staff role permissions.';
  }

  if (lowerMessage.includes('lock broken') && lowerMessage.includes('steal')) {
    return 'Your account session was interrupted while another tab synchronized it. Refresh this page once; opening normal browser tabs will no longer sign out the account.';
  }

  return message;
}

function mapActionError(rawMessage) {
  const message = String(rawMessage || 'Unable to apply the requested action.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('allocated_wig_id') && lowerMessage.includes('column')) {
    return 'Database migration is missing. Run supabase/119_add_allocated_wig_id_for_actual_allocation.sql, then retry.';
  }

  if (lowerMessage.includes('hospital_id') && lowerMessage.includes('release_schedules')) {
    return 'Release scheduling has a database schema mismatch. Apply the latest release-scheduling migration, then retry.';
  }

  if (
    lowerMessage.includes('release_schedules')
    && (lowerMessage.includes('could not find the table') || lowerMessage.includes('relation "release_schedules" does not exist'))
  ) {
    return 'The Release_Schedules table is not exposed to the application. Verify the table and Data API configuration.';
  }

  if (
    (lowerMessage.includes('staff_schedule_wig_release') || lowerMessage.includes('staff_complete_wig_release'))
    && lowerMessage.includes('schema cache')
  ) {
    return 'The release scheduling service is not available in the API schema cache yet. Refresh the page and retry.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Status update is blocked by database policy. Verify your staff role permissions.';
  }

  if (lowerMessage.includes('lock broken') && lowerMessage.includes('steal')) {
    return 'Your account session was interrupted while another tab synchronized it. Refresh and retry the action once.';
  }

  if (lowerMessage.includes('out of stock') || lowerMessage.includes('stock')) {
    return 'Selected wig is out of stock. Refresh and choose another wig specification.';
  }

  if (lowerMessage.includes('three days') || lowerMessage.includes('3 days') || lowerMessage.includes('earliest release')) {
    return 'Release scheduling must be at least three calendar days from today.';
  }

  return message;
}

function isMissingRelationError(rawMessage) {
  const message = String(rawMessage || '').toLowerCase();
  return message.includes('relation') && message.includes('does not exist');
}

function actionRequiresReleaseDate(actionId) {
  return Boolean(ACTION_DEFINITIONS[actionId]?.requiresReleaseDate);
}

function actionRequiresReason(actionId) {
  return Boolean(ACTION_DEFINITIONS[actionId]?.requiresReason);
}

function actionRequiresWigSelection(actionId) {
  return Boolean(ACTION_DEFINITIONS[actionId]?.requiresWigSelection);
}

function getCanonicalWigStatusLabel(statusValue) {
  const key = normalizeStatusKey(statusValue);
  if (['readyforrelease', 'readyforevent', 'available'].includes(key)) return 'Available';
  if (['notavailable', 'unavailable'].includes(key)) return 'Not Available';
  if (['wigallocated', 'allocatedwig', 'allocated'].includes(key)) return 'Allocated';
  if (['releasing', 'forrelease'].includes(key)) return 'Releasing';
  if (['released', 'completed', 'done'].includes(key)) return 'Released';
  return String(statusValue || '').trim() || 'Not Available';
}

function getAllowedActionsForRow(row) {
  if (!row) {
    return [];
  }

  if (row.statusKey === 'pending') {
    return row.requestedStockAvailable
      ? ['accept_allocated', 'reject']
      : ['accept_in_production', 'reject'];
  }

  if (row.statusKey === 'accepted_in_production') {
    return [];
  }

  if (row.statusKey === 'accepted_allocated') {
    return row.hospitalId ? ['submit_release_date'] : ['mark_ready_for_pickup'];
  }

  if (row.statusKey === 'to_be_release') {
    if (row.releaseWorkflowKey === 'hospital_reschedule_requested') {
      return ['resubmit_release_date'];
    }

    if (!row.releaseDate || !row.releaseScheduleId) {
      return ['submit_release_date'];
    }
  }

  return [];
}

function buildSearchBlob(row) {
  return [
    row.requestId,
    row.hospitalName,
    row.patientName,
    row.patientCode,
    row.medicalCondition,
    row.statusLabel,
    row.releaseWorkflowLabel,
    row.specStyle,
    row.specWigName,
    row.specColor,
    row.specLength,
    row.specDensity,
    row.specTexture,
    row.specCapSize,
    row.requestedWigSpecificationId,
    row.specSpecialNote,
    row.allocatedWigCode,
    row.allocatedWigName,
    row.allocatedWigStatus,
    formatDateTime(row.requestDate),
    formatDateTime(row.releaseDate),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

export default function UpdateWigRequestStatusPage({ userProfile, isActivePage = true }) {
  const [rows, setRows] = useState([]);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [searchTerm, setSearchTerm] = useState('');
  const [activeStatusFilter, setActiveStatusFilter] = useState('all_active');
  const [requestDateFrom, setRequestDateFrom] = useState('');
  const [requestDateTo, setRequestDateTo] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingAction, setIsApplyingAction] = useState(false);
  const [isReleaseWorkflowAvailable, setIsReleaseWorkflowAvailable] = useState(true);

  const [selectedRow, setSelectedRow] = useState(null);
  const [selectedAction, setSelectedAction] = useState('');
  const [selectedWigSpecificationId, setSelectedWigSpecificationId] = useState('');
  const [availableWigs, setAvailableWigs] = useState([]);
  const [isLoadingAvailableWigs, setIsLoadingAvailableWigs] = useState(false);
  const [actionReason, setActionReason] = useState('');
  const [actionReleaseDate, setActionReleaseDate] = useState('');
  const [safetyReviewStatus, setSafetyReviewStatus] = useState('Pending');
  const [safetyReviewNotes, setSafetyReviewNotes] = useState('');
  const [releaseConfirmationStep, setReleaseConfirmationStep] = useState('');

  const loadReviewRows = useCallback(async (keepSelectedReqId = null) => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      setRows([]);
      return;
    }

    try {
      setIsLoading(true);
      setNotice({ kind: '', text: '' });

      const [requestsRes, patientsRes, hospitalsRes, safetyRes] = await Promise.all([
        supabase
          .from(WIG_REQUESTS_TABLE)
          .select('*')
          .order('Request_Date', { ascending: false }),
        supabase.from(PATIENTS_TABLE).select('*'),
        supabase.from(HOSPITALS_TABLE).select('Hospital_ID,Hospital_Name'),
        supabase.from(SAFETY_ASSESSMENTS_TABLE).select('*'),
      ]);

      if (requestsRes.error) throw requestsRes.error;
      if (patientsRes.error) throw patientsRes.error;
      if (hospitalsRes.error) throw hospitalsRes.error;
      if (safetyRes.error) throw safetyRes.error;

      const linkedUserIds = Array.from(
        new Set(
          (patientsRes.data || [])
            .map((row) => Number(row.User_ID || 0))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      let patientUsersById = {};

      if (linkedUserIds.length > 0) {
        const { data: patientUsers, error: patientUsersError } = await supabase
          .from(USERS_TABLE)
          .select(`
            user_id,
            email,
            user_details:user_details (
              first_name,
              middle_name,
              last_name,
              suffix,
              birthdate,
              gender,
              contact_number,
              photo_path,
              street,
              barangay,
              city,
              province,
              region,
              country
            )
          `)
          .in('user_id', linkedUserIds);

        if (patientUsersError) throw patientUsersError;

        patientUsersById = (patientUsers || []).reduce((accumulator, row) => {
          accumulator[Number(row.user_id)] = row;
          return accumulator;
        }, {});
      }

      let currentSchedules = [];
      let releaseWorkflowAvailable = true;

      const scheduleRes = await supabase
        .from(RELEASE_SCHEDULES_TABLE)
        .select('Release_Schedule_ID,Req_ID,Proposed_Release_Date,Hospital_Decision,Hospital_Decision_Reason,Is_Current,Created_At,Updated_At')
        .eq('Is_Current', true);

      if (scheduleRes.error) {
        if (isMissingRelationError(scheduleRes.error.message)) {
          releaseWorkflowAvailable = false;
        } else {
          throw scheduleRes.error;
        }
      } else {
        currentSchedules = scheduleRes.data || [];
      }

      setIsReleaseWorkflowAvailable(releaseWorkflowAvailable);

      const wigIdsForLookup = Array.from(
        new Set(
          (requestsRes.data || [])
            .flatMap((row) => [
              Number(row.Requested_Wig_ID || 0),
              Number(row.Allocated_Wig_ID || 0),
            ])
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      let allocatedWigs = [];
      let allocatedWigSpecs = [];
      let allocatedWigFilters = [];
      if (wigIdsForLookup.length > 0) {
        const [allocatedWigsRes, allocatedSpecsRes, allocatedFiltersRes] = await Promise.all([
          supabase
            .from(WIGS_TABLE)
            .select('Wig_ID, Wig_Code, Wig_Name, Wig_Status, Stock_Count, Catalog_Image_Path')
            .in('Wig_ID', wigIdsForLookup),
          supabase
            .from(WIG_SPECS_TABLE)
            .select('Wig_Specification_ID, Wig_ID, Hair_Length, Hair_Color, Hair_Texture, Hair_Density, Cap_Size, Style')
            .in('Wig_ID', wigIdsForLookup),
          supabase
            .from(WIG_FILTERS_TABLE)
            .select('Wig_ID, Is_Active, Status, Source_Front_Path, Source_Side_Path, Source_Top_Path, Source_Back_Path, Layer_Back_Hair_Path, Updated_At')
            .in('Wig_ID', wigIdsForLookup)
            .order('Updated_At', { ascending: false }),
        ]);

        if (allocatedWigsRes.error) throw allocatedWigsRes.error;
        if (allocatedSpecsRes.error) throw allocatedSpecsRes.error;
        if (allocatedFiltersRes.error) throw allocatedFiltersRes.error;

        allocatedWigs = allocatedWigsRes.data || [];
        allocatedWigSpecs = allocatedSpecsRes.data || [];
        allocatedWigFilters = allocatedFiltersRes.data || [];
      }

      const patientById = new Map((patientsRes.data || []).map((row) => [Number(row.Patient_ID), row]));
      const safetyByReqId = new Map((safetyRes.data || []).map((row) => [Number(row.req_id), row]));
      const hospitalById = new Map((hospitalsRes.data || []).map((row) => [Number(row.Hospital_ID), row]));
      const allocatedWigById = new Map(
        allocatedWigs
          .map((row) => ({
            wigId: Number(row.Wig_ID || 0),
            wigCode: String(row.Wig_Code || '').trim(),
            wigName: String(row.Wig_Name || '').trim(),
            wigStatus: getCanonicalWigStatusLabel(row.Wig_Status),
            stockCount: Number(row.Stock_Count || 0),
            catalogImagePath: String(row.Catalog_Image_Path || '').trim(),
          }))
          .filter((row) => row.wigId > 0)
          .map((row) => [row.wigId, row]),
      );
      const allocatedSpecByWigId = new Map(
        (allocatedWigSpecs || [])
          .map((row) => [Number(row.Wig_ID || 0), row])
          .filter(([wigId]) => wigId > 0),
      );
      const allocatedFilterByWigId = new Map();
      (allocatedWigFilters || []).forEach((row) => {
        const wigId = Number(row.Wig_ID || 0);
        if (!wigId || allocatedFilterByWigId.has(wigId)) return;
        const statusKey = normalizeStatusKey(row.Status);
        if (row.Is_Active || statusKey === 'approved' || statusKey === 'pendingreview') {
          allocatedFilterByWigId.set(wigId, row);
        }
      });

      const sourcePathSet = new Set();
      (allocatedWigFilters || []).forEach((row) => {
        ['Source_Front_Path', 'Source_Side_Path', 'Source_Top_Path', 'Source_Back_Path', 'Layer_Back_Hair_Path'].forEach((col) => {
          const pathValue = String(row?.[col] || '').trim();
          if (pathValue) sourcePathSet.add(pathValue);
        });
      });

      const signedSourceUrlByPath = new Map();
      await Promise.all(
        Array.from(sourcePathSet).map(async (pathValue) => {
          const signedUrl = await resolveStorageSignedUrl(WIG_AI_SOURCES_BUCKET, pathValue, 3600);
          if (signedUrl) {
            signedSourceUrlByPath.set(pathValue, signedUrl);
            return;
          }
          const legacySignedUrl = await resolveStorageSignedUrl(WIG_AI_FILTERS_BUCKET, pathValue, 3600);
          if (legacySignedUrl) {
            signedSourceUrlByPath.set(pathValue, legacySignedUrl);
          }
        }),
      );
      const currentScheduleByReqId = new Map(
        currentSchedules
          .filter((row) => Number(row.Req_ID || 0) > 0)
          .map((row) => [Number(row.Req_ID), row]),
      );

      const mappedRows = (requestsRes.data || []).map((requestRow) => {
        const reqId = Number(requestRow.Req_ID || 0);
        const patientId = Number(requestRow.Patient_ID || 0);
        const hospitalId = Number(requestRow.Hospital_ID || 0);

        const patient = patientById.get(patientId) || null;
        const hospital = hospitalById.get(hospitalId) || null;
        const rawStatusReason = String(requestRow.Status_Reason || '').trim();
        const specialNotesPayload = rawStatusReason.startsWith('SSMETA:')
          ? parseSpecialNotesPayload(rawStatusReason)
          : {};
        const requestedWigId = Number(requestRow.Requested_Wig_ID || 0) || null;
        const allocatedWigId = Number(requestRow.Allocated_Wig_ID || 0) || null;
        const requestedSpec = requestedWigId ? (allocatedSpecByWigId.get(requestedWigId) || null) : null;
        const requestedWig = requestedWigId ? (allocatedWigById.get(requestedWigId) || null) : null;
        const requestedWigFilter = requestedWigId ? (allocatedFilterByWigId.get(requestedWigId) || null) : null;
        const requestedSpecId = toPositiveNumber(requestedSpec?.Wig_Specification_ID || 0);
        const allocatedWig = allocatedWigId ? (allocatedWigById.get(allocatedWigId) || null) : null;
        const allocatedWigSpec = allocatedWigId ? (allocatedSpecByWigId.get(allocatedWigId) || null) : null;
        const allocatedWigFilter = allocatedWigId ? (allocatedFilterByWigId.get(allocatedWigId) || null) : null;
        const schedule = currentScheduleByReqId.get(reqId) || null;
        const linkedPatientUser = patient ? patientUsersById[Number(patient.User_ID || 0)] : null;
        const linkedPatientDetails = Array.isArray(linkedPatientUser?.user_details) ? linkedPatientUser.user_details[0] : linkedPatientUser?.user_details;
        const safetyAssessment = safetyByReqId.get(reqId) || null;

        const statusRaw = requestRow.Status || REQUEST_STATUS.pending;
        const statusKey = getCanonicalStatusKey(statusRaw);

        const releaseWorkflowRaw = schedule?.Hospital_Decision
          ? String(schedule.Hospital_Decision).trim()
          : '';
        const releaseWorkflowLabel = getReleaseWorkflowLabel(releaseWorkflowRaw);

        return {
          reqId,
          requestId: formatRequestCode(requestRow.Request_Code, reqId),
          patientId,
          hospitalId,
          hospitalName: String(hospital?.Hospital_Name || 'N/A'),
          patientName: getPatientFullName(patient, linkedPatientUser),
          patientCode: String(patient?.Patient_Code || ''),
          medicalCondition: String(patient?.Medical_Condition || requestRow.Medical_Condition || '').trim() || 'N/A',
          conditionCategory: String(patient?.Condition_Category || '').trim() || 'N/A',
          conditionStage: String(patient?.Condition_Stage_Severity || '').trim() || 'N/A',
          patientEmail: String(linkedPatientUser?.email || '').trim() || 'N/A',
          patientBirthdate: String(linkedPatientDetails?.birthdate || '').trim() || 'N/A',
          patientGender: String(linkedPatientDetails?.gender || '').trim() || 'N/A',
          patientContact: String(linkedPatientDetails?.contact_number || '').trim() || 'N/A',
          patientAddress: buildPatientAddress(linkedPatientDetails),
          patientPhotoUrl: resolveStoragePublicUrl(PATIENT_ASSETS_BUCKET, patient?.Patient_Picture)
            || resolveStoragePublicUrl(PROFILE_PICTURES_BUCKET, linkedPatientDetails?.photo_path),
          guardianName: String(patient?.Guardian || '').trim() || 'N/A',
          guardianRelationship: String(patient?.Guardian_Relationship || '').trim() || 'N/A',
          guardianContact: String(patient?.Guardian_Contact_Number || '').trim() || 'N/A',
          secondaryGuardianName: String(patient?.Secondary_Guardian || '').trim(),
          secondaryGuardianRelationship: String(patient?.Secondary_Guardian_Relationship || '').trim(),
          secondaryGuardianContact: String(patient?.Secondary_Guardian_Contact_Number || '').trim(),
          attendingPhysician: String(patient?.Doctor_Name || '').trim() || 'N/A',
          attendingPhysicianContact: String(patient?.Attending_Physician_Contact || '').trim() || 'N/A',
          treatmentHospitalClinic: String(patient?.Treatment_Hospital_Clinic || '').trim() || 'N/A',
          treatmentPlan: String(patient?.Treatment_Plan || '').trim() || 'N/A',
          treatmentStatus: String(patient?.Current_Treatment_Status || '').trim() || 'N/A',
          clinicalAllergiesMedications: String(patient?.Allergies_Current_Medications || '').trim() || 'N/A',
          requestDate: requestRow.Request_Date,
          updatedAt: requestRow.Updated_At || requestRow.Request_Date,
          status: statusRaw,
          statusKey,
          statusLabel: getStatusLabel(statusRaw),
          fulfillmentStatus: String(requestRow.Fulfillment_Status || '').trim(),
          statusReason: rawStatusReason.startsWith('SSMETA:') ? '' : rawStatusReason,
          previewPdfUrl: String(requestRow.Pdf_Url || requestRow.Preview_Pdf_Url || '').trim(),
          requestedWigSpecificationId: requestedSpecId || null,
          specWigName: requestedWig?.wigName || 'N/A',
          specStyle: String(requestedSpec?.Style || '').trim() || 'N/A',
          specColor: String(requestedSpec?.Hair_Color || '').trim() || 'N/A',
          specLength: String(requestedSpec?.Hair_Length ?? '').trim() || 'N/A',
          specTexture: String(requestedSpec?.Hair_Texture || '').trim() || 'N/A',
          specDensity: String(requestedSpec?.Hair_Density || '').trim() || 'N/A',
          specCapSize: String(requestedSpec?.Cap_Size || '').trim() || 'N/A',
          specSpecialNote: String(specialNotesPayload?.specialNoteTemplate || '').trim() || 'N/A',
          requestedStockCount: requestedWig?.stockCount ?? 0,
          requestedStockAvailable: Number(requestedWig?.stockCount || 0) > 0
            && normalizeStatusKey(requestedWig?.wigStatus) === 'available',
          safetyAssessment,
          requestedWigFrontImageUrl: signedSourceUrlByPath.get(String(requestedWigFilter?.Source_Front_Path || '').trim())
            || resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(requestedWigFilter?.Source_Front_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(requestedWigFilter?.Source_Front_Path || '').trim(),
            ) || resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, requestedWig?.catalogImagePath),
          requestedWigSideImageUrl: signedSourceUrlByPath.get(String(requestedWigFilter?.Source_Side_Path || '').trim())
            || resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(requestedWigFilter?.Source_Side_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(requestedWigFilter?.Source_Side_Path || '').trim(),
            ),
          requestedWigTopImageUrl: signedSourceUrlByPath.get(String(requestedWigFilter?.Source_Top_Path || '').trim())
            || resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(requestedWigFilter?.Source_Top_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(requestedWigFilter?.Source_Top_Path || '').trim(),
            ),
          requestedWigBackImageUrl: signedSourceUrlByPath.get(String(requestedWigFilter?.Source_Back_Path || '').trim())
            || resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(requestedWigFilter?.Source_Back_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(requestedWigFilter?.Source_Back_Path || '').trim(),
            ) || signedSourceUrlByPath.get(String(requestedWigFilter?.Layer_Back_Hair_Path || '').trim())
            || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(requestedWigFilter?.Layer_Back_Hair_Path || '').trim(),
            ),
          allocatedWigId,
          allocatedWigCode: allocatedWig?.wigCode || '',
          allocatedWigName: allocatedWig?.wigName || '',
          allocatedWigStatus: allocatedWig?.wigStatus || '',
          allocatedWigStockCount: allocatedWig?.stockCount ?? null,
          allocatedWigSpecificationId: Number(allocatedWigSpec?.Wig_Specification_ID || 0) || null,
          allocatedWigStyle: String(allocatedWigSpec?.Style || '').trim() || '',
          allocatedWigColor: String(allocatedWigSpec?.Hair_Color || '').trim() || '',
          allocatedWigTexture: String(allocatedWigSpec?.Hair_Texture || '').trim() || '',
          allocatedWigDensity: String(allocatedWigSpec?.Hair_Density || '').trim() || '',
          allocatedWigLength: allocatedWigSpec?.Hair_Length ?? null,
          allocatedWigCapSize: String(allocatedWigSpec?.Cap_Size || '').trim() || '',
          allocatedWigFrontImageUrl: signedSourceUrlByPath.get(String(allocatedWigFilter?.Source_Front_Path || '').trim()) || resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Front_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Front_Path || '').trim(),
          ),
          allocatedWigSideImageUrl: signedSourceUrlByPath.get(String(allocatedWigFilter?.Source_Side_Path || '').trim()) || resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Side_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Side_Path || '').trim(),
          ),
          allocatedWigTopImageUrl: signedSourceUrlByPath.get(String(allocatedWigFilter?.Source_Top_Path || '').trim()) || resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Top_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Top_Path || '').trim(),
          ),
          allocatedWigBackImageUrl: signedSourceUrlByPath.get(String(allocatedWigFilter?.Source_Back_Path || '').trim()) || resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Back_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Back_Path || '').trim(),
          ) || signedSourceUrlByPath.get(String(allocatedWigFilter?.Layer_Back_Hair_Path || '').trim()) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Back_Path || allocatedWigFilter?.Layer_Back_Hair_Path || '').trim(),
          ),
          releaseDate: schedule?.Proposed_Release_Date || null,
          releaseScheduleId: Number(schedule?.Release_Schedule_ID || 0) || null,
          releaseWorkflowStatus: releaseWorkflowRaw || '',
          releaseWorkflowKey: normalizeReleaseWorkflowKey(releaseWorkflowRaw),
          releaseWorkflowLabel,
          releaseDecisionReason: String(schedule?.Hospital_Decision_Reason || '').trim(),
        };
      });

      setRows(mappedRows);

      setSelectedRow((previous) => {
        const targetReqId = Number(keepSelectedReqId || previous?.reqId || 0);
        if (!targetReqId) {
          return previous ? null : null;
        }

        return mappedRows.find((row) => row.reqId === targetReqId) || null;
      });

      if (!releaseWorkflowAvailable) {
        setNotice((previous) => {
          if (previous.kind === 'error') {
            return previous;
          }

          return {
            kind: 'warning',
            text: 'Release scheduling is partially disabled. Ensure Release_Schedules exists and refresh Supabase schema cache.',
          };
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: mapLoadError(error.message) });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadAvailableWigs = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setAvailableWigs([]);
      return;
    }

    try {
      setIsLoadingAvailableWigs(true);
      const [specRes, wigsRes, filtersRes] = await Promise.all([
        supabase
          .from(WIG_SPECS_TABLE)
          .select('Wig_Specification_ID, Wig_ID, Hair_Length, Hair_Color, Hair_Texture, Hair_Density, Cap_Size, Style'),
        supabase
          .from(WIGS_TABLE)
          .select('Wig_ID, Wig_Code, Wig_Name, Wig_Status, Stock_Count, Completed_At, Catalog_Image_Path'),
        supabase
          .from(WIG_FILTERS_TABLE)
          .select('Wig_ID, Is_Active, Status, Source_Front_Path, Source_Side_Path, Source_Top_Path, Source_Back_Path, Layer_Back_Hair_Path, Updated_At')
          .order('Updated_At', { ascending: false }),
      ]);

      if (specRes.error) throw specRes.error;
      if (wigsRes.error) throw wigsRes.error;
      if (filtersRes.error) throw filtersRes.error;

      const wigById = new Map(
        (wigsRes.data || []).map((row) => [Number(row.Wig_ID || 0), row]).filter(([wigId]) => wigId > 0),
      );
      const filterByWigId = new Map();
      (filtersRes.data || []).forEach((row) => {
        const wigId = Number(row.Wig_ID || 0);
        if (!wigId || filterByWigId.has(wigId)) return;
        const statusKey = normalizeStatusKey(row.Status);
        if (row.Is_Active || statusKey === 'approved' || statusKey === 'pendingreview') {
          filterByWigId.set(wigId, row);
        }
      });

      const nextRows = (specRes.data || [])
        .map((specRow) => {
          const wigId = Number(specRow.Wig_ID || 0);
          const wigRow = wigById.get(wigId);
          if (!wigId || !wigRow) return null;
          const stockCount = Number(wigRow.Stock_Count || 0);
          const wigStatusLabel = getCanonicalWigStatusLabel(wigRow.Wig_Status);
          const wigStatusKey = normalizeStatusKey(wigStatusLabel);
          if (stockCount <= 0 || wigStatusKey !== 'available') return null;
          const wigFilter = filterByWigId.get(wigId) || null;
          return {
            specificationId: Number(specRow.Wig_Specification_ID || 0),
            wigId,
            wigCode: String(wigRow.Wig_Code || '').trim(),
            wigName: String(wigRow.Wig_Name || '').trim(),
            stockCount,
            wigStatus: wigStatusLabel,
            style: String(specRow.Style || '').trim(),
            color: String(specRow.Hair_Color || '').trim(),
            texture: String(specRow.Hair_Texture || '').trim(),
            density: String(specRow.Hair_Density || '').trim(),
            capSize: String(specRow.Cap_Size || '').trim(),
            hairLength: specRow.Hair_Length,
            frontImageUrl: resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(wigFilter?.Source_Front_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(wigFilter?.Source_Front_Path || '').trim(),
            ) || resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, wigRow.Catalog_Image_Path),
            sideImageUrl: resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(wigFilter?.Source_Side_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(wigFilter?.Source_Side_Path || '').trim(),
            ),
            topImageUrl: resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(wigFilter?.Source_Top_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(wigFilter?.Source_Top_Path || '').trim(),
            ),
            backImageUrl: resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(wigFilter?.Source_Back_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(wigFilter?.Source_Back_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(wigFilter?.Source_Back_Path || wigFilter?.Layer_Back_Hair_Path || '').trim(),
            ),
          };
        })
        .filter((row) => row && row.specificationId > 0)
        .sort((a, b) => {
          const byStock = (b.stockCount || 0) - (a.stockCount || 0);
          if (byStock !== 0) return byStock;
          return `${a.wigName} ${a.color} ${a.capSize}`.localeCompare(`${b.wigName} ${b.color} ${b.capSize}`);
        });

      setAvailableWigs(nextRows);
    } catch (error) {
      setNotice({ kind: 'error', text: mapLoadError(error.message) });
      setAvailableWigs([]);
    } finally {
      setIsLoadingAvailableWigs(false);
    }
  }, []);

  useEffect(() => {
    loadReviewRows();
  }, [loadReviewRows]);

  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase) {
      return undefined;
    }

    const refreshRequests = () => void loadReviewRows();
    const channel = supabase
      .channel('staff-wig-requests-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: WIG_REQUESTS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIGS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIG_SPECS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIG_FILTERS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: PATIENTS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: RELEASE_SCHEDULES_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: SAFETY_ASSESSMENTS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: HOSPITALS_TABLE }, refreshRequests)
      .on('postgres_changes', { event: '*', schema: 'public', table: USERS_TABLE }, refreshRequests)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isActivePage, loadReviewRows]);

  const filteredRows = useMemo(() => {
    const activeStatusSet = new Set(ACTIVE_REQUEST_STATUS_KEYS);

    const statusFiltered = rows.filter((row) => {
      if (activeStatusFilter === 'all_active') {
        return activeStatusSet.has(row.statusKey);
      }

      return row.statusKey === activeStatusFilter;
    });

    const query = normalizeText(searchTerm);

    return statusFiltered.filter((row) => {
      const requestDate = new Date(row.requestDate);
      if (requestDateFrom && !Number.isNaN(requestDate.getTime()) && requestDate < new Date(`${requestDateFrom}T00:00:00`)) {
        return false;
      }
      if (requestDateTo && !Number.isNaN(requestDate.getTime()) && requestDate > new Date(`${requestDateTo}T23:59:59`)) {
        return false;
      }
      return !query || buildSearchBlob(row).includes(query);
    });
  }, [rows, activeStatusFilter, searchTerm, requestDateFrom, requestDateTo]);

  const hasActiveRequestFilters = activeStatusFilter !== 'all_active'
    || Boolean(requestDateFrom)
    || Boolean(requestDateTo)
    || Boolean(searchTerm.trim());

  const clearRequestFilters = () => {
    setActiveStatusFilter('all_active');
    setRequestDateFrom('');
    setRequestDateTo('');
    setSearchTerm('');
  };

  const quickStats = useMemo(() => {
    const pendingCount = rows.filter((row) => row.statusKey === 'pending').length;
    const acceptedAllocatedCount = rows.filter((row) => row.statusKey === 'accepted_allocated').length;
    const acceptedInProductionCount = rows.filter((row) => row.statusKey === 'accepted_in_production').length;
    const readyForPickupCount = rows.filter((row) => row.statusKey === 'ready_for_pickup').length;
    const toBeReleaseCount = rows.filter((row) => row.statusKey === 'to_be_release').length;
    const releasingCount = rows.filter((row) => row.statusKey === 'releasing').length;
    const releasedCount = rows.filter((row) => row.statusKey === 'released').length;
    const rescheduleRequestedCount = rows.filter((row) => row.releaseWorkflowKey === 'hospital_reschedule_requested').length;

    return [
      { label: 'Pending Review', value: String(pendingCount) },
      { label: 'Accepted - Wig Allocated', value: String(acceptedAllocatedCount) },
      { label: 'Accepted - In Production', value: String(acceptedInProductionCount) },
      { label: 'Ready for Pick-up', value: String(readyForPickupCount) },
      { label: 'To Be Release', value: String(toBeReleaseCount) },
      { label: 'Releasing', value: String(releasingCount) },
      { label: 'Released', value: String(releasedCount) },
      { label: 'Reschedule Requested', value: String(rescheduleRequestedCount) },
    ];
  }, [rows]);

  const minimumReleaseDateTimeLocal = getMinimumReleaseDateTimeLocal();

  const selectedPreviewUrl = useMemo(() => {
    if (!selectedRow) {
      return '';
    }

    return resolveStoragePublicUrl(WIG_REQUEST_PREVIEWS_BUCKET, selectedRow.previewPdfUrl);
  }, [selectedRow]);

  const requestedSpecIdForSelection = useMemo(
    () => toPositiveNumber(selectedRow?.requestedWigSpecificationId),
    [selectedRow?.requestedWigSpecificationId],
  );

  const assignableWigs = useMemo(() => {
    if (!requestedSpecIdForSelection) {
      return availableWigs;
    }

    return availableWigs.filter((row) => toPositiveNumber(row.specificationId) === requestedSpecIdForSelection);
  }, [availableWigs, requestedSpecIdForSelection]);

  const selectedAllocationChoice = useMemo(() => {
    const targetSpecId = Number(selectedWigSpecificationId || 0);
    if (!targetSpecId) return null;
    return assignableWigs.find((row) => Number(row.specificationId || 0) === targetSpecId) || null;
  }, [assignableWigs, selectedWigSpecificationId]);

  const selectedAllowedActions = useMemo(() => getAllowedActionsForRow(selectedRow), [selectedRow]);

  useEffect(() => {
    setSelectedAction('');
    setSelectedWigSpecificationId('');
    setAvailableWigs([]);
    setActionReason('');
    setActionReleaseDate('');
    setSafetyReviewStatus(selectedRow?.safetyAssessment?.review_status || 'Pending');
    setSafetyReviewNotes(selectedRow?.safetyAssessment?.review_notes || '');
  }, [selectedRow?.reqId, selectedRow?.safetyAssessment?.review_notes, selectedRow?.safetyAssessment?.review_status]);

  useEffect(() => {
    setSelectedWigSpecificationId('');
    if (selectedAction === 'accept_allocated' && selectedRow) {
      void loadAvailableWigs();
    } else {
      setAvailableWigs([]);
    }
  }, [selectedAction, selectedRow, loadAvailableWigs]);

  useEffect(() => {
    if (selectedAction !== 'accept_allocated' || selectedWigSpecificationId || assignableWigs.length === 0) return;
    setSelectedWigSpecificationId(String(assignableWigs[0].specificationId));
  }, [assignableWigs, selectedAction, selectedWigSpecificationId]);

  useEffect(() => {
    if (!selectedAction || !actionRequiresReleaseDate(selectedAction) || actionReleaseDate) {
      return;
    }

    const savedDate = toDateTimeLocalValue(selectedRow?.releaseDate);
    setActionReleaseDate(savedDate && savedDate >= minimumReleaseDateTimeLocal
      ? savedDate
      : `${minimumReleaseDateTimeLocal.slice(0, 10)}T09:00`);
  }, [selectedAction, selectedRow, actionReleaseDate, minimumReleaseDateTimeLocal]);

  const canApplyAction = useMemo(() => {
    if (!selectedRow || !selectedAction || isApplyingAction) {
      return false;
    }

    if (actionRequiresReleaseDate(selectedAction)) {
      if (!isReleaseWorkflowAvailable) {
        return false;
      }

      if (!String(actionReleaseDate || '').trim()) {
        return false;
      }

      if (actionReleaseDate < minimumReleaseDateTimeLocal) {
        return false;
      }
    }

    if (actionRequiresReason(selectedAction) && !String(actionReason || '').trim()) {
      return false;
    }

    if (actionRequiresWigSelection(selectedAction) && !Number(selectedWigSpecificationId || 0)) {
      return false;
    }

    if (
      selectedAction === 'accept_allocated'
      && requestedSpecIdForSelection
      && Number(selectedWigSpecificationId || 0)
      && Number(selectedWigSpecificationId || 0) !== requestedSpecIdForSelection
    ) {
      return false;
    }

    return true;
  }, [
    selectedRow,
    selectedAction,
    isApplyingAction,
    isReleaseWorkflowAvailable,
    actionReleaseDate,
    actionReason,
    selectedWigSpecificationId,
    requestedSpecIdForSelection,
    minimumReleaseDateTimeLocal,
  ]);

  const proposeReleaseSchedule = useCallback(async ({ requestRow, releaseDateIso, note }) => {
    const result = await supabase.rpc('staff_schedule_wig_release', {
      p_req_id: requestRow.reqId,
      p_proposed_release_date: releaseDateIso,
      p_note: note || null,
    });
    if (result.error) throw result.error;
    return result.data;
  }, []);

  const handleApplyAction = async () => {
    if (!selectedRow || !selectedAction) {
      return;
    }

    const actionLabel = ACTION_DEFINITIONS[selectedAction]?.label || 'Update';
    const requestCode = selectedRow.requestId;
    const reasonText = String(actionReason || '').trim();

    if (actionRequiresReleaseDate(selectedAction) && !isReleaseWorkflowAvailable) {
      setNotice({
        kind: 'error',
        text: 'Release scheduling is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.',
      });
      return;
    }

    if (actionRequiresReason(selectedAction) && !reasonText) {
      setNotice({ kind: 'error', text: 'A reason is required for this action.' });
      return;
    }

    if (actionRequiresReleaseDate(selectedAction) && actionReleaseDate < minimumReleaseDateTimeLocal) {
      setNotice({ kind: 'error', text: 'The earliest release schedule is three calendar days from today.' });
      return;
    }

    try {
      setIsApplyingAction(true);
      setNotice({ kind: '', text: '' });

      if (['accept_allocated', 'accept_in_production', 'reject'].includes(selectedAction)) {
        const transactionalResult = await supabase.rpc('review_wig_request_transactional', {
          p_req_id: selectedRow.reqId,
          p_action: selectedAction === 'accept_in_production' ? 'accept_production_required' : selectedAction,
          p_wig_specification_id: selectedAction === 'accept_allocated' ? Number(selectedWigSpecificationId || 0) : null,
          p_reason: reasonText || null,
          p_safety_review_status: safetyReviewStatus || null,
          p_safety_review_notes: String(safetyReviewNotes || '').trim() || null,
        });
        if (transactionalResult.error) throw transactionalResult.error;
      }

      if (selectedAction === 'mark_ready_for_pickup') {
        const readyResult = await supabase.rpc('staff_mark_wig_ready_for_pickup', {
          p_req_id: selectedRow.reqId,
        });
        if (readyResult.error) throw readyResult.error;
      }

      if (selectedAction === 'submit_release_date' || selectedAction === 'resubmit_release_date') {
        const releaseDateIso = toIsoFromDateTimeLocal(actionReleaseDate);
        if (!releaseDateIso) {
          throw new Error('Please enter a valid release date and time.');
        }

        await proposeReleaseSchedule({
          requestRow: selectedRow,
          releaseDateIso,
          note: reasonText,
        });
      }

      await logAuditAction({
        action: 'staff_wig_request_action',
        description: `${requestCode}: ${actionLabel}${reasonText ? ` | reason: ${reasonText}` : ''}`,
        resource: 'Wig_Requests',
        status: 'success',
        userProfile,
      });

      await loadReviewRows(selectedRow.reqId);
      setSelectedAction('');
      setSelectedWigSpecificationId('');
      setActionReason('');
      setActionReleaseDate('');
      setNotice({ kind: 'success', text: `${requestCode} updated successfully using "${actionLabel}".` });
    } catch (error) {
      await logAuditAction({
        action: 'staff_wig_request_action',
        description: `${requestCode}: failed action ${actionLabel}`,
        resource: 'Wig_Requests',
        status: 'failed',
        userProfile,
      });

      setNotice({ kind: 'error', text: mapActionError(error.message) });
    } finally {
      setIsApplyingAction(false);
    }
  };

  const handleOpenReleaseConfirmation = () => {
    if (!selectedRow || !['releasing', 'ready_for_pickup'].includes(selectedRow.statusKey)) return;
    setReleaseConfirmationStep('confirm');
  };

  const handleConfirmRelease = async () => {
    if (!selectedRow || !['releasing', 'ready_for_pickup'].includes(selectedRow.statusKey) || isApplyingAction) return;

    try {
      setIsApplyingAction(true);
      setNotice({ kind: '', text: '' });

      const result = await supabase.rpc('staff_complete_wig_release', {
        p_req_id: selectedRow.reqId,
      });
      if (result.error) throw result.error;

      await loadReviewRows(selectedRow.reqId);
      setReleaseConfirmationStep('success');
    } catch (error) {
      setReleaseConfirmationStep('');
      setNotice({ kind: 'error', text: mapActionError(error.message) });
    } finally {
      setIsApplyingAction(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="role-page-title text-2xl font-bold text-slate-900">Manage Wig Request</h1>
          <p className="text-sm text-slate-600">Review incoming requests, inspect specifications, and process each request through release scheduling.</p>
        </div>
        <PageHeaderActions
          onRefresh={() => loadReviewRows(selectedRow?.reqId || null)}
          refreshLoading={isLoading}
          refreshDisabled={isApplyingAction}
          helpTitle="About Manage Wig Request"
          helpContent={(
            <>
              <p>Use the filters to find a request, then open it to review the patient, requested wig, safety assessment, allocation, and release workflow.</p>
              <p>Status updates from other authorized users are applied automatically while this page is open.</p>
            </>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-8">
        {quickStats.map((item) => (
          <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{item.value}</p>
          </article>
        ))}
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-slate-500" />
            <div>
              <p className="text-sm font-semibold text-slate-800">Filter wig requests</p>
              <p className="text-[11px] text-slate-500">Showing {filteredRows.length} of {rows.length} requests</p>
            </div>
          </div>
          {hasActiveRequestFilters && (
            <button type="button" onClick={clearRequestFilters} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              <X size={13} /> Clear filters
            </button>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[170px_170px_minmax(220px,1fr)_minmax(360px,2.5fr)]">
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">From</span>
            <input
              type="date"
              value={requestDateFrom}
              onChange={(event) => setRequestDateFrom(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">To</span>
            <input
              type="date"
              value={requestDateTo}
              onChange={(event) => setRequestDateTo(event.target.value)}
              min={requestDateFrom || undefined}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Status</span>
            <select
              value={activeStatusFilter}
              onChange={(event) => setActiveStatusFilter(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            >
              {STATUS_FILTERS.map((filterItem) => (
                <option key={filterItem.id} value={filterItem.id}>{filterItem.label}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Search</span>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white py-2 pl-8 pr-3 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
                placeholder="Request, patient, hospital, wig, status, or condition"
              />
            </div>
          </label>
        </div>
        </div>

      {notice.text && (
        <div
          className={`m-4 rounded-lg border px-3 py-2 text-sm font-medium ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : notice.kind === 'warning'
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
        >
          {notice.text}
        </div>
      )}

        {isLoading ? (
          <div className="px-4 py-8 text-sm text-slate-600 inline-flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading wig request records...
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="px-4 py-8 text-sm text-slate-600">No records matched your current filter/search.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Request ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Hospital</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Patient</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Wig Model</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Status</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Date Submitted</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">Release Date</th>
                  <th className="px-4 py-3 text-right font-semibold text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    key={row.reqId}
                    onClick={() => {
                      setReleaseConfirmationStep('');
                      setSelectedRow(row);
                    }}
                    className="cursor-pointer border-t border-slate-200 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-semibold text-slate-800">{row.requestId}</td>
                    <td className="px-4 py-3 text-slate-700">{row.hospitalName}</td>
                    <td className="px-4 py-3 text-slate-700">
                      <p className="font-semibold text-slate-800">{row.patientName}</p>
                      <p className="text-xs text-slate-500">{row.patientCode || 'No patient code'}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">{row.medicalCondition}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <p className="text-xs font-semibold text-slate-800">{row.specWigName}</p>
                      <p className="text-[11px] text-slate-500">{row.specColor} / {row.specCapSize}</p>
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${row.requestedStockAvailable ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                        {row.requestedStockAvailable ? `${row.requestedStockCount} in stock` : 'No matching stock'}
                      </span>
                      {row.allocatedWigCode ? <p className="text-xs font-semibold text-emerald-700">Allocated Wig: {row.allocatedWigCode}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>
                        {row.statusLabel}
                      </span>
                      <span className={`mt-1 block w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold ${releaseWorkflowClass(row.releaseWorkflowStatus)}`}>
                        {row.releaseWorkflowLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{formatDateTime(row.requestDate)}</td>
                    <td className="px-4 py-3 text-slate-700">{formatDateTime(row.releaseDate)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setReleaseConfirmationStep('');
                          setSelectedRow(row);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <Info size={13} /> View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedRow && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-6">
          <button
            type="button"
            aria-label="Close staff request panel"
            className="absolute inset-0 m-0 p-0 border-0 appearance-none bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={() => {
              setReleaseConfirmationStep('');
              setSelectedRow(null);
            }}
          />

          <section className="relative flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="z-10 flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Wig Request Review</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {selectedRow.requestId} | {selectedRow.patientName}
                </p>
              </div>
              <button type="button" onClick={() => { setReleaseConfirmationStep(''); setSelectedRow(null); }} className="text-slate-400 hover:text-red-500">
                <X size={22} />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto bg-slate-100 p-5">
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
                  <div className="flex min-w-0 items-center gap-3">
                    {selectedRow.patientPhotoUrl ? (
                      <img src={selectedRow.patientPhotoUrl} alt={selectedRow.patientName} className="h-16 w-16 shrink-0 rounded-full border border-slate-200 object-cover" />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-slate-900 text-lg font-bold text-white">{String(selectedRow.patientName || 'P').charAt(0).toUpperCase()}</div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-lg font-bold text-slate-900">{selectedRow.patientName}</p>
                      <p className="text-xs text-slate-500">{selectedRow.patientCode || `Patient #${selectedRow.patientId}`}</p>
                      <p className="mt-1 text-xs text-slate-600">{selectedRow.hospitalName}</p>
                    </div>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass(selectedRow.status)}`}>
                    {selectedRow.statusLabel}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <section>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Personal Information</p>
                    <div className="mt-2 space-y-1.5">
                      <p><span className="font-semibold text-slate-900">Birthdate:</span> {selectedRow.patientBirthdate}</p>
                      <p><span className="font-semibold text-slate-900">Gender:</span> {selectedRow.patientGender}</p>
                      <p><span className="font-semibold text-slate-900">Email:</span> {selectedRow.patientEmail}</p>
                      <p><span className="font-semibold text-slate-900">Contact:</span> {selectedRow.patientContact}</p>
                      <p><span className="font-semibold text-slate-900">Address:</span> {selectedRow.patientAddress}</p>
                    </div>
                  </section>
                  <section>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Clinical Information</p>
                    <div className="mt-2 space-y-1.5">
                      <p><span className="font-semibold text-slate-900">Condition:</span> {selectedRow.medicalCondition}</p>
                      <p><span className="font-semibold text-slate-900">Category / Stage:</span> {selectedRow.conditionCategory} / {selectedRow.conditionStage}</p>
                      <p><span className="font-semibold text-slate-900">Physician:</span> {selectedRow.attendingPhysician}</p>
                      <p><span className="font-semibold text-slate-900">Physician Contact:</span> {selectedRow.attendingPhysicianContact}</p>
                      <p><span className="font-semibold text-slate-900">Treatment:</span> {selectedRow.treatmentPlan}</p>
                      <p><span className="font-semibold text-slate-900">Current Status:</span> {selectedRow.treatmentStatus}</p>
                    </div>
                  </section>
                  <section>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Emergency Contacts</p>
                    <div className="mt-2 space-y-1.5">
                      <p className="font-semibold text-slate-900">Primary</p>
                      <p>{selectedRow.guardianName} Â· {selectedRow.guardianRelationship}</p>
                      <p>{selectedRow.guardianContact}</p>
                      {selectedRow.secondaryGuardianName || selectedRow.secondaryGuardianRelationship || selectedRow.secondaryGuardianContact ? (
                        <div className="border-t border-slate-100 pt-2">
                          <p className="font-semibold text-slate-900">Secondary</p>
                          <p>{selectedRow.secondaryGuardianName || 'N/A'} Â· {selectedRow.secondaryGuardianRelationship || 'N/A'}</p>
                          <p>{selectedRow.secondaryGuardianContact || 'N/A'}</p>
                        </div>
                      ) : null}
                    </div>
                  </section>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-200 pt-3 text-xs text-slate-600">
                  <p><span className="font-semibold text-slate-900">Request:</span> {formatDateTime(selectedRow.requestDate)}</p>
                  <p><span className="font-semibold text-slate-900">Updated:</span> {formatDateTime(selectedRow.updatedAt)}</p>
                  <p><span className="font-semibold text-slate-900">Status:</span> {selectedRow.statusLabel}</p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">Wig Preference</p>
                  <button
                    type="button"
                    onClick={() => loadReviewRows(selectedRow?.reqId || null)}
                    disabled={isLoading || isApplyingAction}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {isLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    Refresh
                  </button>
                </div>
                <div className="mt-3 flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row">
                  <div className="w-full shrink-0 sm:w-40">
                  {selectedRow.requestedWigFrontImageUrl || selectedRow.requestedWigSideImageUrl || selectedRow.requestedWigTopImageUrl || selectedRow.requestedWigBackImageUrl ? (
                    <img
                      src={selectedRow.requestedWigFrontImageUrl || selectedRow.requestedWigSideImageUrl || selectedRow.requestedWigTopImageUrl || selectedRow.requestedWigBackImageUrl}
                      alt={`${selectedRow.specWigName} requested wig`}
                      className="h-40 w-full rounded-lg border border-slate-200 bg-white object-contain"
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-3 text-center text-xs text-slate-500">Catalog image unavailable</div>
                  )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-bold text-slate-900">{selectedRow.specWigName}</p>
                    <p className="mt-0.5 text-xs text-slate-500">Specification #{selectedRow.requestedWigSpecificationId || 'N/A'}</p>
                    <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-sm text-slate-700 md:grid-cols-3">
                      <p><span className="font-semibold text-slate-900">Style:</span> {selectedRow.specStyle}</p>
                      <p><span className="font-semibold text-slate-900">Color:</span> {selectedRow.specColor}</p>
                      <p><span className="font-semibold text-slate-900">Length:</span> {selectedRow.specLength}</p>
                      <p><span className="font-semibold text-slate-900">Density:</span> {selectedRow.specDensity}</p>
                      <p><span className="font-semibold text-slate-900">Texture:</span> {selectedRow.specTexture}</p>
                      <p><span className="font-semibold text-slate-900">Cap Size:</span> {selectedRow.specCapSize}</p>
                    </div>
                    <p className="mt-3 text-sm text-slate-700"><span className="font-semibold text-slate-900">Allocated Wig:</span> {selectedRow.allocatedWigCode || 'Not assigned yet'}</p>
                    <p className="mt-2 whitespace-pre-line text-sm text-slate-700"><span className="font-semibold text-slate-900">Special Note:</span> {selectedRow.specSpecialNote}</p>
                  </div>
                </div>
                {selectedRow.allocatedWigId ? (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    <p className="font-semibold text-slate-900">
                      {selectedRow.allocatedWigCode || `Wig #${selectedRow.allocatedWigId}`} | {selectedRow.allocatedWigName || 'Unnamed Wig'}
                    </p>
                    <p className="mt-1">
                      Status: {selectedRow.allocatedWigStatus || 'N/A'} | Stock: {selectedRow.allocatedWigStockCount ?? 'N/A'}
                    </p>
                    <p className="mt-1">
                      Style: {selectedRow.allocatedWigStyle || 'N/A'} | Color: {selectedRow.allocatedWigColor || 'N/A'} | Texture: {selectedRow.allocatedWigTexture || 'N/A'} | Cap: {selectedRow.allocatedWigCapSize || 'N/A'}
                    </p>
                    {selectedRow.allocatedWigFrontImageUrl || selectedRow.allocatedWigSideImageUrl || selectedRow.allocatedWigTopImageUrl || selectedRow.allocatedWigBackImageUrl ? (
                      <img
                        src={selectedRow.allocatedWigFrontImageUrl || selectedRow.allocatedWigSideImageUrl || selectedRow.allocatedWigTopImageUrl || selectedRow.allocatedWigBackImageUrl}
                        alt="Allocated wig"
                        className="mt-2 h-52 w-full rounded-lg bg-white object-contain"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Patient Wig Safety Assessment</p>
                {selectedRow.safetyAssessment ? (
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
                      <p><span className="font-semibold text-slate-900">Known allergies:</span> {selectedRow.safetyAssessment.has_known_allergies == null ? 'Not answered' : selectedRow.safetyAssessment.has_known_allergies ? 'Yes' : 'No'}</p>
                      <p><span className="font-semibold text-slate-900">Sensitive scalp:</span> {selectedRow.safetyAssessment.has_sensitive_scalp == null ? 'Not answered' : selectedRow.safetyAssessment.has_sensitive_scalp ? 'Yes' : 'No'}</p>
                      <p><span className="font-semibold text-slate-900">Scalp irritation:</span> {selectedRow.safetyAssessment.has_scalp_irritation == null ? 'Not answered' : selectedRow.safetyAssessment.has_scalp_irritation ? 'Yes' : 'No'}</p>
                      <p><span className="font-semibold text-slate-900">Open scalp wounds:</span> {selectedRow.safetyAssessment.has_open_scalp_wounds == null ? 'Not answered' : selectedRow.safetyAssessment.has_open_scalp_wounds ? 'Yes' : 'No'}</p>
                      <p><span className="font-semibold text-slate-900">Medical restriction:</span> {selectedRow.safetyAssessment.has_medical_restriction == null ? 'Not answered' : selectedRow.safetyAssessment.has_medical_restriction ? 'Yes' : 'No'}</p>
                      <p><span className="font-semibold text-slate-900">Information confirmed:</span> {selectedRow.safetyAssessment.information_confirmed ? 'Yes' : 'No'}</p>
                    </div>
                    {selectedRow.safetyAssessment.allergy_details ? <p className="text-sm text-slate-700"><span className="font-semibold text-slate-900">Allergy details:</span> {selectedRow.safetyAssessment.allergy_details}</p> : null}
                    {selectedRow.safetyAssessment.medical_restriction_details ? <p className="text-sm text-slate-700"><span className="font-semibold text-slate-900">Restriction details:</span> {selectedRow.safetyAssessment.medical_restriction_details}</p> : null}
                    <p className="text-sm text-slate-700"><span className="font-semibold text-slate-900">Clinical allergies/current medications:</span> {selectedRow.clinicalAllergiesMedications}</p>
                    <div className="grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Safety Review</label>
                        <select value={safetyReviewStatus} onChange={(event) => setSafetyReviewStatus(event.target.value)} disabled={isApplyingAction} className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-800">
                          {['Pending', 'Cleared', 'Needs Clarification', 'Requires Medical Clearance'].map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Review Notes</label>
                        <textarea value={safetyReviewNotes} onChange={(event) => setSafetyReviewNotes(event.target.value)} disabled={isApplyingAction} rows={2} className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-800" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">No safety assessment was saved for this request.</div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Release Workflow</p>
                <div className="mt-3 space-y-1.5 text-sm text-slate-700">
                  <p className="inline-flex items-center gap-1.5">
                    <CalendarDays size={14} className="text-slate-500" />
                    <span><span className="font-semibold text-slate-900">Release Date:</span> {formatDateTime(selectedRow.releaseDate)}</span>
                  </p>
                  <p><span className="font-semibold text-slate-900">Flow Status:</span> {selectedRow.releaseWorkflowLabel}</p>
                  {selectedRow.releaseDecisionReason && (
                    <p className="whitespace-pre-line"><span className="font-semibold text-slate-900">H-Representative Reason:</span> {selectedRow.releaseDecisionReason}</p>
                  )}
                  {selectedRow.statusReason && (
                    <p className="whitespace-pre-line"><span className="font-semibold text-slate-900">Status Reason:</span> {selectedRow.statusReason}</p>
                  )}
                </div>
              </div>

              <div className="order-last rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
                <p className="text-sm font-semibold text-slate-900">Apply Review Action</p>
                <p className="mt-1 text-xs text-slate-500">
                  {selectedRow.statusKey === 'pending'
                    ? selectedRow.requestedStockAvailable
                      ? 'Matching stock is available, so this request can only be allocated or rejected.'
                      : 'No matching stock is available, so this request can only enter production or be rejected.'
                    : ['releasing', 'ready_for_pickup'].includes(selectedRow.statusKey)
                      ? 'Complete the physical handover to move this request to its final Released status.'
                    : selectedRow.statusKey === 'accepted_allocated' && !selectedRow.hospitalId
                      ? 'The wig is allocated. Mark it Ready for Pick-up only when it is prepared for the patient.'
                    : 'Select only the next valid step for this request.'}
                </p>

                {['releasing', 'ready_for_pickup'].includes(selectedRow.statusKey) ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-900">
                      {selectedRow.statusKey === 'ready_for_pickup'
                        ? 'This patient has no hospital. Confirm only after the patient or authorized recipient has picked up the wig.'
                        : 'The hospital approved the release schedule. Confirm only after the wig has been physically handed over to the patient or authorized recipient.'}
                    </div>
                    <button
                      type="button"
                      onClick={handleOpenReleaseConfirmation}
                      disabled={isApplyingAction}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                    >
                      <CheckCircle2 size={16} /> {selectedRow.statusKey === 'ready_for_pickup' ? 'Confirm Pick-up' : 'Release Wig'}
                    </button>
                  </div>
                ) : selectedRow.statusKey === 'released' ? (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-900">
                    <CheckCircle2 size={18} /> This wig request is complete and has reached its final Released status.
                  </div>
                ) : selectedAllowedActions.length === 0 ? (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    No staff action is available for the current status.
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Next Action</label>
                      <select
                        value={selectedAction}
                        onChange={(event) => setSelectedAction(event.target.value)}
                        disabled={isApplyingAction}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
                      >
                        <option value="">Select action</option>
                        {selectedAllowedActions.map((actionId) => (
                          <option key={actionId} value={actionId}>{ACTION_DEFINITIONS[actionId].label}</option>
                        ))}
                      </select>
                    </div>

                    {selectedAction === 'accept_allocated' && (
                      <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Select Wig Specification (required)</label>
                          <button
                            type="button"
                            onClick={() => { void loadAvailableWigs(); }}
                            disabled={isLoadingAvailableWigs || isApplyingAction}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          >
                            {isLoadingAvailableWigs ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                            Refresh Wig List
                          </button>
                        </div>

                        <select
                          value={selectedWigSpecificationId}
                          onChange={(event) => setSelectedWigSpecificationId(event.target.value)}
                          disabled={isApplyingAction || isLoadingAvailableWigs}
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
                        >
                          <option value="">{isLoadingAvailableWigs ? 'Loading wig specifications...' : 'Select available wig specification'}</option>
                          {assignableWigs.map((wigRow) => (
                            <option key={wigRow.specificationId} value={String(wigRow.specificationId)}>
                              {(wigRow.wigCode || `Wig #${wigRow.wigId}`)} | {wigRow.wigName || 'Unnamed Wig'} | {wigRow.color || 'N/A'} | {wigRow.capSize || 'N/A'} | Stock {wigRow.stockCount}
                            </option>
                          ))}
                        </select>
                        {requestedSpecIdForSelection ? (
                          <p className="mt-1 text-xs text-slate-600">
                            Locked to requested specification ID <span className="font-semibold">{requestedSpecIdForSelection}</span>.
                          </p>
                        ) : null}
                        {requestedSpecIdForSelection
                          && Number(selectedWigSpecificationId || 0)
                          && Number(selectedWigSpecificationId || 0) !== requestedSpecIdForSelection ? (
                            <p className="mt-1 text-xs text-red-700">
                              Selected specification must match requested specification #{requestedSpecIdForSelection}.
                            </p>
                          ) : null}

                        {selectedAllocationChoice ? (
                          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-xs font-semibold text-slate-900">
                              Selected: {(selectedAllocationChoice.wigCode || `Wig #${selectedAllocationChoice.wigId}`)} | {selectedAllocationChoice.wigName || 'Unnamed Wig'}
                            </p>
                            <p className="mt-1 text-xs text-slate-700">
                              Style: {selectedAllocationChoice.style || 'N/A'} | Color: {selectedAllocationChoice.color || 'N/A'} | Texture: {selectedAllocationChoice.texture || 'N/A'} | Cap: {selectedAllocationChoice.capSize || 'N/A'} | Stock: {selectedAllocationChoice.stockCount}
                            </p>
                            {selectedAllocationChoice.frontImageUrl || selectedAllocationChoice.sideImageUrl || selectedAllocationChoice.topImageUrl || selectedAllocationChoice.backImageUrl ? (
                              <img src={selectedAllocationChoice.frontImageUrl || selectedAllocationChoice.sideImageUrl || selectedAllocationChoice.topImageUrl || selectedAllocationChoice.backImageUrl} alt="Selected wig" className="mt-2 h-52 w-full rounded-lg bg-white object-contain" />
                            ) : null}
                          </div>
                        ) : null}

                        {!isLoadingAvailableWigs && assignableWigs.length === 0 && (
                          <p className="mt-1 text-xs text-amber-700">
                            No matching stock is available. Use "Accept - In Production" to send this request to the specialist priority queue.
                          </p>
                        )}
                      </div>
                    )}

                    {selectedAction && actionRequiresReleaseDate(selectedAction) && (
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Release Date (required)</label>
                        <input
                          type="datetime-local"
                          value={actionReleaseDate}
                          min={minimumReleaseDateTimeLocal}
                          onChange={(event) => setActionReleaseDate(event.target.value)}
                          disabled={isApplyingAction || !isReleaseWorkflowAvailable}
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
                        />
                        <p className="mt-1 text-xs text-slate-500">Earliest allowed date: {minimumReleaseDateTimeLocal.slice(0, 10)} (three days from today).</p>
                        {!isReleaseWorkflowAvailable && (
                          <p className="mt-1 text-xs text-red-700">
                            Release scheduling data is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.
                          </p>
                        )}
                      </div>
                    )}

                    {selectedAction && (
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Reason {actionRequiresReason(selectedAction) ? '(required)' : '(optional)'}
                        </label>
                        <textarea
                          value={actionReason}
                          onChange={(event) => setActionReason(event.target.value)}
                          disabled={isApplyingAction}
                          rows={3}
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
                          placeholder={
                            actionRequiresReason(selectedAction)
                              ? 'Provide required reason for this action.'
                              : 'Optional note for this action.'
                          }
                        />
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handleApplyAction}
                      disabled={!canApplyAction}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isApplyingAction ? 'Applying...' : 'Apply Action'}
                    </button>
                  </div>
                )}
              </div>

              {selectedPreviewUrl ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <iframe
                    title="Wig request PDF preview"
                    src={selectedPreviewUrl}
                    className="h-[62vh] w-full rounded-lg border border-slate-200"
                  />
                  <a
                    href={selectedPreviewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs font-semibold text-blue-700 hover:underline"
                  >
                    Open PDF in new tab
                  </a>
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  No preview PDF URL is saved for this request yet.
                </div>
              )}
            </div>
          </section>
        </div>,
        document.body,
      )}

      {releaseConfirmationStep && selectedRow && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/65 backdrop-blur-sm" />
          <section className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            {releaseConfirmationStep === 'confirm' ? (
              <>
                <div className="border-b border-slate-200 px-5 py-4">
                  <h3 className="text-lg font-bold text-slate-900">Final Release Confirmation</h3>
                  <p className="mt-1 text-sm text-slate-600">Review the handover details before completing this request.</p>
                </div>
                <div className="space-y-4 p-5">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <p><span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">Request</span>{selectedRow.requestId}</p>
                      <p><span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">Current Status</span>{selectedRow.statusLabel}</p>
                      <p><span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">Patient</span>{selectedRow.patientName}</p>
                      <p><span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">Hospital</span>{selectedRow.hospitalName}</p>
                      <p><span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">Allocated Wig</span>{selectedRow.allocatedWigCode || selectedRow.specWigName}</p>
                      <p><span className="block text-[11px] font-bold uppercase tracking-wide text-slate-500">{selectedRow.statusKey === 'ready_for_pickup' ? 'Pickup Type' : 'Approved Release Date'}</span>{selectedRow.statusKey === 'ready_for_pickup' ? 'Direct patient pickup' : formatDateTime(selectedRow.releaseDate)}</p>
                    </div>
                  </div>
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    Continuing confirms the wig was handed over. The request will move permanently from <strong>{selectedRow.statusLabel}</strong> to <strong>Released</strong>.
                  </div>
                </div>
                <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setReleaseConfirmationStep('')}
                    disabled={isApplyingAction}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmRelease}
                    disabled={isApplyingAction}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                  >
                    {isApplyingAction ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                    {isApplyingAction ? 'Completing...' : selectedRow.statusKey === 'ready_for_pickup' ? 'Confirm Pick-up' : 'Confirm Release'}
                  </button>
                </div>
              </>
            ) : (
              <div className="p-6 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                  <CheckCircle2 size={34} />
                </div>
                <h3 className="mt-4 text-xl font-bold text-slate-900">Wig Released Successfully</h3>
                <p className="mt-2 text-sm text-slate-600">
                  {selectedRow.requestId} for {selectedRow.patientName} is now in its final <strong>Released</strong> status.
                </p>
                <button
                  type="button"
                  onClick={() => setReleaseConfirmationStep('')}
                  className="mt-5 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Done
                </button>
              </div>
            )}
          </section>
        </div>,
        document.body,
      )}

    </div>
  );
}
