import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Info, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { logAuditAction } from '../../../lib/auditLogger';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const WIG_REQUESTS_TABLE = 'Wig_Requests';
const WIGS_TABLE = 'Wigs';
const WIG_SPECS_TABLE = 'Wig_Specifications';
const WIG_FILTERS_TABLE = 'Wig_AI_Filters';
const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
const HOSPITALS_TABLE = 'Hospitals';
const RELEASE_SCHEDULES_TABLE = 'Release_Schedules';
const WIG_REQUEST_PREVIEWS_BUCKET = 'wig_request_previews';
const WIG_AI_FILTERS_BUCKET = 'wig_ai_filters';
const WIG_AI_SOURCES_BUCKET = 'wig_ai_sources';
const PST_TIMEZONE = 'Asia/Manila';
const PST_OFFSET = '+08:00';

const REQUEST_STATUS = {
  pending: 'Pending',
  acceptedAllocated: 'Accepted - Wig Allocated',
  acceptedNoWig: 'Accepted - No Wig Available',
  toBeRelease: 'To Be Release',
  releasing: 'Releasing',
  released: 'Released',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_FILTERS = [
  { id: 'all_review', label: 'All To Be Review' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted_allocated', label: 'Accepted - Wig Allocated' },
  { id: 'accepted_no_wig', label: 'Accepted - No Wig Available' },
  { id: 'to_be_release', label: 'To Be Release' },
  { id: 'releasing', label: 'Releasing' },
];

const REVIEW_QUEUE_STATUS_KEYS = ['pending', 'accepted_allocated', 'accepted_no_wig'];

const ACTION_DEFINITIONS = {
  accept_allocated: {
    label: 'Accept - Wig Allocated',
    requiresWigSelection: true,
  },
  accept_no_wig: {
    label: 'Accept - No Wig Available',
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
  cancel: {
    label: 'Cancel Request',
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

  if (['acceptedbutnowigavailable', 'acceptednowigavailable', 'nowigavailable', 'findingmatchingwig', 'formatching', 'matching', 'findingallocatingwig', 'findingandallocatingwig'].includes(key)) {
    return 'accepted_no_wig';
  }

  if (['inproduction', 'production', 'inprocess'].includes(key)) {
    return 'accepted_no_wig';
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
  if (key === 'accepted_no_wig') return REQUEST_STATUS.acceptedNoWig;
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
  if (key === 'accepted_no_wig') return 'bg-lime-100 text-lime-700';
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

function getPstTimestamp(date = new Date()) {
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
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${PST_OFFSET}`;
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

  return message;
}

function mapActionError(rawMessage) {
  const message = String(rawMessage || 'Unable to apply the requested action.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('allocated_wig_id') && lowerMessage.includes('column')) {
    return 'Database migration is missing. Run supabase/119_add_allocated_wig_id_for_actual_allocation.sql, then retry.';
  }

  if (lowerMessage.includes('release_schedules') && (lowerMessage.includes('relation') || lowerMessage.includes('does not exist'))) {
    return 'Release scheduling data is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Status update is blocked by database policy. Verify your staff role permissions.';
  }

  if (lowerMessage.includes('out of stock') || lowerMessage.includes('stock')) {
    return 'Selected wig is out of stock. Refresh and choose another wig specification.';
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
    return ['accept_allocated', 'accept_no_wig', 'reject', 'cancel'];
  }

  if (row.statusKey === 'accepted_no_wig') {
    return ['accept_allocated', 'cancel'];
  }

  if (row.statusKey === 'accepted_allocated') {
    return ['submit_release_date', 'accept_no_wig', 'cancel'];
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

export default function UpdateWigRequestStatusPage({ userProfile }) {
  const [rows, setRows] = useState([]);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [searchTerm, setSearchTerm] = useState('');
  const [activeStatusFilter, setActiveStatusFilter] = useState('all_review');
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

      const [requestsRes, patientsRes, hospitalsRes] = await Promise.all([
        supabase
          .from(WIG_REQUESTS_TABLE)
          .select('*')
          .order('Request_Date', { ascending: false }),
        supabase.from(PATIENTS_TABLE).select('Patient_ID,Hospital_ID,Patient_Code,Medical_Condition,User_ID'),
        supabase.from(HOSPITALS_TABLE).select('Hospital_ID,Hospital_Name'),
      ]);

      if (requestsRes.error) throw requestsRes.error;
      if (patientsRes.error) throw patientsRes.error;
      if (hospitalsRes.error) throw hospitalsRes.error;

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
              suffix
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
        .select('*')
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
            .select('Wig_ID, Wig_Code, Wig_Name, Wig_Status, Stock_Count')
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
      const hospitalById = new Map((hospitalsRes.data || []).map((row) => [Number(row.Hospital_ID), row]));
      const allocatedWigById = new Map(
        allocatedWigs
          .map((row) => ({
            wigId: Number(row.Wig_ID || 0),
            wigCode: String(row.Wig_Code || '').trim(),
            wigName: String(row.Wig_Name || '').trim(),
            wigStatus: getCanonicalWigStatusLabel(row.Wig_Status),
            stockCount: Number(row.Stock_Count || 0),
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
          hospitalName: String(hospital?.Hospital_Name || `H-Representative #${hospitalId || 'N/A'}`),
          patientName: getPatientFullName(patient, linkedPatientUser),
          patientCode: String(patient?.Patient_Code || ''),
          medicalCondition: String(patient?.Medical_Condition || requestRow.Medical_Condition || '').trim() || 'N/A',
          requestDate: requestRow.Request_Date,
          updatedAt: requestRow.Updated_At || requestRow.Request_Date,
          status: statusRaw,
          statusKey,
          statusLabel: getStatusLabel(statusRaw),
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
          requestedWigFrontImageUrl: signedSourceUrlByPath.get(String(requestedWigFilter?.Source_Front_Path || '').trim())
            || resolveStoragePublicUrl(
              WIG_AI_SOURCES_BUCKET,
              String(requestedWigFilter?.Source_Front_Path || '').trim(),
            ) || resolveStoragePublicUrl(
              WIG_AI_FILTERS_BUCKET,
              String(requestedWigFilter?.Source_Front_Path || '').trim(),
            ),
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
          .select('Wig_ID, Wig_Code, Wig_Name, Wig_Status, Stock_Count, Completed_At'),
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
            ),
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

  const filteredRows = useMemo(() => {
    const reviewStatusSet = new Set(REVIEW_QUEUE_STATUS_KEYS);

    const statusFiltered = rows.filter((row) => {
      if (activeStatusFilter === 'all_review') {
        return reviewStatusSet.has(row.statusKey);
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

  const quickStats = useMemo(() => {
    const reviewStatusSet = new Set(REVIEW_QUEUE_STATUS_KEYS);

    const toBeReviewCount = rows.filter((row) => reviewStatusSet.has(row.statusKey)).length;
    const acceptedNoWigCount = rows.filter((row) => row.statusKey === 'accepted_no_wig').length;
    const toBeReleaseCount = rows.filter((row) => row.statusKey === 'to_be_release').length;
    const rescheduleRequestedCount = rows.filter((row) => row.releaseWorkflowKey === 'hospital_reschedule_requested').length;

    return [
      { label: 'To Be Review', value: String(toBeReviewCount) },
      { label: 'Accepted - No Wig', value: String(acceptedNoWigCount) },
      { label: 'To Be Release', value: String(toBeReleaseCount) },
      { label: 'Reschedule Requested', value: String(rescheduleRequestedCount) },
    ];
  }, [rows]);

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
  }, [selectedRow?.reqId]);

  useEffect(() => {
    setSelectedWigSpecificationId('');
    if (selectedAction === 'accept_allocated' && selectedRow) {
      void loadAvailableWigs();
    } else {
      setAvailableWigs([]);
    }
  }, [selectedAction, selectedRow, loadAvailableWigs]);

  useEffect(() => {
    if (!selectedAction || !actionRequiresReleaseDate(selectedAction) || actionReleaseDate) {
      return;
    }

    const defaultDate = selectedRow?.releaseDate
      || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    setActionReleaseDate(toDateTimeLocalValue(defaultDate));
  }, [selectedAction, selectedRow, actionReleaseDate]);

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
  ]);

  const updateRequestWithStatusReasonFallback = useCallback(async (reqId, payload) => {
    const { error } = await supabase
      .from(WIG_REQUESTS_TABLE)
      .update(payload)
      .eq('Req_ID', reqId);

    if (!error) {
      return;
    }

    const lowerError = String(error.message || '').toLowerCase();
    if (lowerError.includes('status_reason') && lowerError.includes('column')) {
      const { Status_Reason: _ignored, ...fallbackPayload } = payload;
      const { error: fallbackError } = await supabase
        .from(WIG_REQUESTS_TABLE)
        .update(fallbackPayload)
        .eq('Req_ID', reqId);

      if (fallbackError) {
        throw fallbackError;
      }

      return;
    }

    throw error;
  }, []);

  const updateWigStock = useCallback(async ({ wigId, delta, nowIso }) => {
    const numericWigId = Number(wigId || 0);
    const numericDelta = Number(delta || 0);
    if (!numericWigId || !numericDelta) return;

    const { data: currentWig, error: readError } = await supabase
      .from(WIGS_TABLE)
      .select('Wig_ID, Stock_Count, Wig_Status')
      .eq('Wig_ID', numericWigId)
      .single();
    if (readError) throw readError;

    const currentStock = Math.max(0, Number(currentWig?.Stock_Count || 0));
    const nextStock = currentStock + numericDelta;
    if (nextStock < 0) {
      throw new Error('Selected wig is out of stock.');
    }

    const { error: updateError } = await supabase
      .from(WIGS_TABLE)
      .update({
        Stock_Count: nextStock,
        Updated_At: nowIso,
      })
      .eq('Wig_ID', numericWigId)
      .eq('Stock_Count', currentStock);
    if (updateError) throw updateError;
  }, []);

  const proposeReleaseSchedule = useCallback(async ({ requestRow, releaseDateIso, note, actorUserId }) => {
    const nowIso = getPstTimestamp();

    const { error: clearCurrentError } = await supabase
      .from(RELEASE_SCHEDULES_TABLE)
      .update({
        Is_Current: false,
        Updated_At: nowIso,
      })
      .eq('Req_ID', requestRow.reqId)
      .eq('Is_Current', true);

    if (clearCurrentError) {
      throw clearCurrentError;
    }

    const schedulePayload = {
      Req_ID: requestRow.reqId,
      Proposed_Release_Date: releaseDateIso,
      Proposed_By: actorUserId,
      Proposal_Note: note || null,
      Hospital_Decision: 'Pending',
      Is_Current: true,
      Created_At: nowIso,
      Updated_At: nowIso,
    };

    let insertScheduleError = null;

    {
      const { error } = await supabase
        .from(RELEASE_SCHEDULES_TABLE)
        .insert(schedulePayload);

      insertScheduleError = error;
    }

    if (insertScheduleError) {
      const lowerInsertError = String(insertScheduleError.message || '').toLowerCase();
      const requiresHospitalId = lowerInsertError.includes('hospital_id')
        || (lowerInsertError.includes('not-null') && lowerInsertError.includes('null value'));

      if (requiresHospitalId && Number(requestRow.hospitalId || 0) > 0) {
        const { error: retryInsertError } = await supabase
          .from(RELEASE_SCHEDULES_TABLE)
          .insert({
            ...schedulePayload,
            Hospital_ID: requestRow.hospitalId,
          });

        insertScheduleError = retryInsertError;
      }
    }

    if (insertScheduleError) {
      throw insertScheduleError;
    }

    const releasePayload = {
      Status: REQUEST_STATUS.toBeRelease,
      Updated_At: nowIso,
      Status_Reason: null,
    };

    const { error: releaseUpdateError } = await supabase
      .from(WIG_REQUESTS_TABLE)
      .update(releasePayload)
      .eq('Req_ID', requestRow.reqId);

    if (!releaseUpdateError) {
      return;
    }

    const lowerError = String(releaseUpdateError.message || '').toLowerCase();
    if (lowerError.includes('status_reason') && lowerError.includes('column')) {
      const { Status_Reason: _ignored, ...fallbackPayload } = releasePayload;
      const { error: fallbackError } = await supabase
        .from(WIG_REQUESTS_TABLE)
        .update(fallbackPayload)
        .eq('Req_ID', requestRow.reqId);

      if (fallbackError) {
        throw fallbackError;
      }

      return;
    }

    throw releaseUpdateError;
  }, []);

  const handleApplyAction = async () => {
    if (!selectedRow || !selectedAction) {
      return;
    }

    const actionLabel = ACTION_DEFINITIONS[selectedAction]?.label || 'Update';
    const requestCode = selectedRow.requestId;
    const actorUserId = Number(userProfile?.user_id || 0) || null;
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

    try {
      setIsApplyingAction(true);
      setNotice({ kind: '', text: '' });

      const nowIso = getPstTimestamp();
      const hasExistingAllocation = Number(selectedRow.allocatedWigId || 0) > 0;
      const releaseExistingAllocation = async () => {
        const existingWigId = Number(selectedRow.allocatedWigId || 0);
        if (!existingWigId) return;
        await updateWigStock({ wigId: existingWigId, delta: +1, nowIso });
      };

      if (selectedAction === 'accept_allocated') {
        const selectedSpecificationNumericId = Number(selectedWigSpecificationId || 0);
        if (!selectedSpecificationNumericId) {
          throw new Error('Select a wig specification to allocate.');
        }

        if (
          requestedSpecIdForSelection
          && selectedSpecificationNumericId !== requestedSpecIdForSelection
        ) {
          throw new Error(`Selected wig must match requested specification #${requestedSpecIdForSelection}.`);
        }

        const chosenWig = assignableWigs.find((row) => row.specificationId === selectedSpecificationNumericId);
        if (!chosenWig) {
          throw new Error('Selected wig specification is no longer available. Refresh and try again.');
        }
        const targetWigId = Number(chosenWig.wigId || 0);
        if (!targetWigId) {
          throw new Error('Selected specification has no linked wig.');
        }

        const existingWigId = Number(selectedRow.allocatedWigId || 0);
        const changedAllocation = !existingWigId || existingWigId !== targetWigId;
        if (changedAllocation && existingWigId) {
          await updateWigStock({ wigId: existingWigId, delta: +1, nowIso });
        }

        if (changedAllocation) {
          await updateWigStock({ wigId: targetWigId, delta: -1, nowIso });
        }

        await updateRequestWithStatusReasonFallback(selectedRow.reqId, {
          Status: REQUEST_STATUS.acceptedAllocated,
          Allocated_Wig_ID: targetWigId,
          Updated_At: nowIso,
          Status_Reason: null,
        });
      }

      if (selectedAction === 'accept_no_wig') {
        if (hasExistingAllocation) {
          await releaseExistingAllocation();
        }
        await updateRequestWithStatusReasonFallback(selectedRow.reqId, {
          Status: REQUEST_STATUS.acceptedNoWig,
          Allocated_Wig_ID: null,
          Updated_At: nowIso,
          Status_Reason: null,
        });
      }

      if (selectedAction === 'reject') {
        if (hasExistingAllocation) {
          await releaseExistingAllocation();
        }
        await updateRequestWithStatusReasonFallback(selectedRow.reqId, {
          Status: REQUEST_STATUS.rejected,
          Allocated_Wig_ID: null,
          Updated_At: nowIso,
          Status_Reason: reasonText,
        });
      }

      if (selectedAction === 'cancel') {
        if (hasExistingAllocation) {
          await releaseExistingAllocation();
        }
        await updateRequestWithStatusReasonFallback(selectedRow.reqId, {
          Status: REQUEST_STATUS.cancelled,
          Allocated_Wig_ID: null,
          Updated_At: nowIso,
          Status_Reason: reasonText,
        });
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
          actorUserId,
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

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Staff Workflow</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl">Manage Wig Request</h1>
        <p className="mt-1 text-sm text-slate-600">
          Review all incoming wig requests, inspect full specifications, and process status transitions up to release scheduling.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {quickStats.map((item) => (
          <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{item.value}</p>
          </article>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 shadow-sm">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-6">
          <div className="relative xl:col-span-2">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
              placeholder="Search requests, patients, hospitals, wigs..."
            />
          </div>

          <select
            value={activeStatusFilter}
            onChange={(event) => setActiveStatusFilter(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            aria-label="Wig request status filter"
          >
            {STATUS_FILTERS.map((filterItem) => (
              <option key={filterItem.id} value={filterItem.id}>{filterItem.label}</option>
            ))}
          </select>

          <input
            type="date"
            value={requestDateFrom}
            onChange={(event) => setRequestDateFrom(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            aria-label="Request from date"
            title="From date"
          />

          <input
            type="date"
            value={requestDateTo}
            onChange={(event) => setRequestDateTo(event.target.value)}
            min={requestDateFrom || undefined}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            aria-label="Request to date"
            title="To date"
          />

          <button
            type="button"
            onClick={() => loadReviewRows(selectedRow?.reqId || null)}
            disabled={isLoading || isApplyingAction}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>
      </div>

      {notice.text && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm font-medium ${
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

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-lg font-semibold text-slate-900">Wig Request Management</h2>
          <p className="mt-0.5 text-xs text-slate-500">Review request details and continue the role-appropriate status workflow.</p>
        </div>

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
                    onClick={() => setSelectedRow(row)}
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
        <div className="fixed inset-0 z-[90] m-0 p-0">
          <button
            type="button"
            aria-label="Close staff request panel"
            className="absolute inset-0 m-0 p-0 border-0 appearance-none bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={() => setSelectedRow(null)}
          />

          <aside
            className="absolute right-0 top-0 h-full w-full max-w-3xl overflow-y-auto border-l border-slate-200 bg-white shadow-2xl"
            style={{ animation: 'staffRequestSlideIn 0.25s ease-out' }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Wig Request Review</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {selectedRow.requestId} | {selectedRow.patientName}
                </p>
              </div>
              <button type="button" onClick={() => setSelectedRow(null)} className="text-slate-400 hover:text-red-500">
                <X size={22} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p><span className="font-semibold text-slate-900">H-Representative:</span> {selectedRow.hospitalName}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Patient:</span> {selectedRow.patientName}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Medical Condition:</span> {selectedRow.medicalCondition}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Request Date:</span> {formatDateTime(selectedRow.requestDate)}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Last Updated:</span> {formatDateTime(selectedRow.updatedAt)}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Status:</span> {selectedRow.statusLabel}</p>
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
                <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 sm:grid-cols-2">
                  <p><span className="font-semibold text-slate-900">Spec ID:</span> {selectedRow.requestedWigSpecificationId || 'N/A'}</p>
                  <p><span className="font-semibold text-slate-900">Wig Name:</span> {selectedRow.specWigName}</p>
                  <p><span className="font-semibold text-slate-900">Color:</span> {selectedRow.specColor}</p>
                  <p><span className="font-semibold text-slate-900">Length:</span> {selectedRow.specLength}</p>
                  <p><span className="font-semibold text-slate-900">Density:</span> {selectedRow.specDensity}</p>
                  <p><span className="font-semibold text-slate-900">Texture:</span> {selectedRow.specTexture}</p>
                  <p><span className="font-semibold text-slate-900">Cap Size:</span> {selectedRow.specCapSize}</p>
                  <p><span className="font-semibold text-slate-900">Allocated Wig:</span> {selectedRow.allocatedWigCode || 'Not assigned yet'}</p>
                </div>
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <p className="font-semibold text-slate-900">
                    Requested Wig Preview: {selectedRow.specWigName || 'N/A'}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[
                      ['Front', selectedRow.requestedWigFrontImageUrl],
                      ['Side', selectedRow.requestedWigSideImageUrl],
                      ['Top', selectedRow.requestedWigTopImageUrl],
                      ['Back', selectedRow.requestedWigBackImageUrl],
                    ].map(([label, imageUrl]) => (
                      <div key={label} className="rounded-md border border-slate-200 bg-white p-1">
                        <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                        {imageUrl ? (
                          <img src={imageUrl} alt={`${label} requested wig`} className="mt-1 h-24 w-full rounded object-cover" />
                        ) : (
                          <div className="mt-1 flex h-24 items-center justify-center rounded bg-slate-100 text-[11px] text-slate-500">No image</div>
                        )}
                      </div>
                    ))}
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
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {[
                        ['Front', selectedRow.allocatedWigFrontImageUrl],
                        ['Side', selectedRow.allocatedWigSideImageUrl],
                        ['Top', selectedRow.allocatedWigTopImageUrl],
                        ['Back', selectedRow.allocatedWigBackImageUrl],
                      ].map(([label, imageUrl]) => (
                        <div key={label} className="rounded-md border border-slate-200 bg-white p-1">
                          <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                          {imageUrl ? (
                            <img src={imageUrl} alt={`${label} allocated wig`} className="mt-1 h-24 w-full rounded object-cover" />
                          ) : (
                            <div className="mt-1 flex h-24 items-center justify-center rounded bg-slate-100 text-[11px] text-slate-500">No image</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className="mt-3 whitespace-pre-line text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">Special Note:</span> {selectedRow.specSpecialNote}
                </p>
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

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Apply Review Action</p>
                <p className="mt-1 text-xs text-slate-500">Select only the next valid step for this request.</p>

                {selectedAllowedActions.length === 0 ? (
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
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              {[
                                ['Front', selectedAllocationChoice.frontImageUrl],
                                ['Side', selectedAllocationChoice.sideImageUrl],
                                ['Top', selectedAllocationChoice.topImageUrl],
                                ['Back', selectedAllocationChoice.backImageUrl],
                              ].map(([label, imageUrl]) => (
                                <div key={label} className="rounded-md border border-slate-200 bg-white p-1">
                                  <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                                  {imageUrl ? (
                                    <img src={imageUrl} alt={`${label} wig preview`} className="mt-1 h-24 w-full rounded object-cover" />
                                  ) : (
                                    <div className="mt-1 flex h-24 items-center justify-center rounded bg-slate-100 text-[11px] text-slate-500">No image</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {!isLoadingAvailableWigs && assignableWigs.length === 0 && (
                          <p className="mt-1 text-xs text-amber-700">
                            No assignable wig specifications found right now. Use "Accept - No Wig Available" and assign later.
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
                          onChange={(event) => setActionReleaseDate(event.target.value)}
                          disabled={isApplyingAction || !isReleaseWorkflowAvailable}
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
                        />
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
          </aside>
        </div>,
        document.body,
      )}

      <style>{`
        @keyframes staffRequestSlideIn {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
      `}</style>
    </div>
  );
}
