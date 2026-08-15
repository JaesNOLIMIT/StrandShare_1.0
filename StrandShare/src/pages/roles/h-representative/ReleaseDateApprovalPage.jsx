import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarDays, Check, Info, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { logAuditAction } from '../../../lib/auditLogger';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const HOSPITALS_TABLE = 'Hospitals';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const WIGS_TABLE = 'Wigs';
const WIG_SPECIFICATIONS_TABLE = 'Wig_Specifications';
const WIG_FILTERS_TABLE = 'Wig_AI_Filters';
const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
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
};

const tabs = [
  { id: 'approvals', label: 'Release Date Approvals' },
  { id: 'releasing', label: 'Approved / Releasing' },
  { id: 'released', label: 'Released' },
];

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatusKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
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

  return 'pending';
}

function getStatusLabel(statusValue) {
  const key = getCanonicalStatusKey(statusValue);

  if (key === 'accepted_allocated') return REQUEST_STATUS.acceptedAllocated;
  if (key === 'accepted_no_wig') return REQUEST_STATUS.acceptedNoWig;
  if (key === 'to_be_release') return REQUEST_STATUS.toBeRelease;
  if (key === 'releasing') return REQUEST_STATUS.releasing;
  if (key === 'released') return REQUEST_STATUS.released;
  return REQUEST_STATUS.pending;
}

function statusClass(statusValue) {
  const key = getCanonicalStatusKey(statusValue);

  if (key === 'accepted_allocated') return 'bg-emerald-100 text-emerald-700';
  if (key === 'accepted_no_wig') return 'bg-lime-100 text-lime-700';
  if (key === 'to_be_release') return 'bg-indigo-100 text-indigo-700';
  if (key === 'releasing') return 'bg-teal-100 text-teal-700';
  if (key === 'released') return 'bg-green-100 text-green-700';
  return 'bg-amber-100 text-amber-700';
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

function isMissingRelationError(rawMessage) {
  const message = String(rawMessage || '').toLowerCase();
  return message.includes('relation') && message.includes('does not exist');
}

function mapLoadError(rawMessage) {
  const message = String(rawMessage || 'Unable to load release approval records.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('allocated_wig_id') && lowerMessage.includes('column')) {
    return 'Database migration is missing. Run supabase/119_add_allocated_wig_id_for_actual_allocation.sql, then refresh.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Data access is blocked by database policy. Verify your hospital role permissions.';
  }

  if (lowerMessage.includes('release_schedules') && (lowerMessage.includes('relation') || lowerMessage.includes('does not exist'))) {
    return 'Release scheduling data is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.';
  }

  return message;
}

function mapActionError(rawMessage) {
  const message = String(rawMessage || 'Unable to apply decision.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('allocated_wig_id') && lowerMessage.includes('column')) {
    return 'Database migration is missing. Run supabase/119_add_allocated_wig_id_for_actual_allocation.sql, then retry.';
  }

  if (lowerMessage.includes('release_schedules') && (lowerMessage.includes('relation') || lowerMessage.includes('does not exist'))) {
    return 'Release scheduling data is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Action is blocked by database policy. Verify your hospital role permissions.';
  }

  return message;
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

function matchesSearch(row, query) {
  const blob = [
    row.requestId,
    row.patientName,
    row.patientCode,
    row.medicalCondition,
    row.statusLabel,
    row.releaseWorkflowLabel,
    row.specWigName,
    row.specColor,
    row.specLength,
    row.specDensity,
    row.specSpecialNote,
    row.allocatedWigCode,
    row.allocatedWigName,
    row.allocatedWigStatus,
    row.allocatedWigStyle,
    row.allocatedWigColor,
    row.allocatedWigLength,
    row.allocatedWigTexture,
    row.allocatedWigCapSize,
    formatDateTime(row.releaseDate),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');

  return blob.includes(query);
}

export default function ReleaseDateApprovalPage({ userProfile, embedded = false }) {
  const [activeTab, setActiveTab] = useState('approvals');
  const [hospitalId, setHospitalId] = useState(null);
  const [hospitalName, setHospitalName] = useState('');

  const [rows, setRows] = useState([]);
  const [scheduleHistory, setScheduleHistory] = useState([]);
  const [selectedRow, setSelectedRow] = useState(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [quickApproveTarget, setQuickApproveTarget] = useState(null);
  const [quickRescheduleTarget, setQuickRescheduleTarget] = useState(null);
  const [quickRescheduleReason, setQuickRescheduleReason] = useState('');
  const [quickRescheduleAttempted, setQuickRescheduleAttempted] = useState(false);

  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isReleaseWorkflowAvailable, setIsReleaseWorkflowAvailable] = useState(true);
  const [isResolvingHospital, setIsResolvingHospital] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingDecision, setIsApplyingDecision] = useState(false);

  const resolveAssignedHospital = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      return;
    }

    const activeUserId = Number(userProfile?.user_id || 0);
    if (!activeUserId) {
      setHospitalId(null);
      setHospitalName('');
      setNotice({ kind: 'error', text: 'Unable to resolve your account ID. Please sign in again.' });
      return;
    }

    try {
      setIsResolvingHospital(true);
      const { data: staffRow, error: staffError } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .select('Hospital_ID')
        .eq('User_ID', activeUserId)
        .maybeSingle();

      if (staffError) throw staffError;

      const assignedHospitalId = Number(staffRow?.Hospital_ID || 0) || null;
      setHospitalId(assignedHospitalId);

      if (!assignedHospitalId) {
        setHospitalName('');
        setNotice({
          kind: 'error',
          text: 'No hospital assignment found for your account. Ask Admin to assign you first.',
        });
        return;
      }

      const { data: hospitalRow } = await supabase
        .from(HOSPITALS_TABLE)
        .select('Hospital_Name')
        .eq('Hospital_ID', assignedHospitalId)
        .maybeSingle();

      setHospitalName(String(hospitalRow?.Hospital_Name || '').trim());
    } catch (error) {
      setHospitalId(null);
      setHospitalName('');
      setNotice({ kind: 'error', text: mapLoadError(error.message) });
    } finally {
      setIsResolvingHospital(false);
    }
  }, [userProfile?.user_id]);

  const loadReleaseRows = useCallback(async (keepSelectedReqId = null) => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) {
      setRows([]);
      setScheduleHistory([]);
      return;
    }

    try {
      setIsLoading(true);

      const [requestsRes, patientsRes] = await Promise.all([
        supabase
          .from(WIG_REQUESTS_TABLE)
          .select('*')
          .eq('Hospital_ID', hospitalId)
          .order('Request_Date', { ascending: false }),
        supabase
          .from(PATIENTS_TABLE)
          .select('Patient_ID,Patient_Code,Medical_Condition,User_ID')
          .eq('Hospital_ID', hospitalId),
      ]);

      if (requestsRes.error) throw requestsRes.error;
      if (patientsRes.error) throw patientsRes.error;

      const requestIds = Array.from(
        new Set(
          (requestsRes.data || [])
            .map((row) => Number(row.Req_ID || 0))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      const linkedUserIds = Array.from(
        new Set(
          (patientsRes.data || [])
            .map((row) => Number(row.User_ID || 0))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      let nextPatientUsersById = {};

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

        nextPatientUsersById = (patientUsers || []).reduce((accumulator, row) => {
          accumulator[Number(row.user_id)] = row;
          return accumulator;
        }, {});
      }

      let currentSchedules = [];
      let allSchedules = [];
      let releaseWorkflowAvailable = true;
      let wigsById = new Map();
      let wigSpecsByWigId = new Map();
      let wigFiltersByWigId = new Map();

      if (requestIds.length > 0) {
        const currentScheduleRes = await supabase
          .from(RELEASE_SCHEDULES_TABLE)
          .select('*')
          .in('Req_ID', requestIds)
          .eq('Is_Current', true);

        if (currentScheduleRes.error) {
          if (isMissingRelationError(currentScheduleRes.error.message)) {
            releaseWorkflowAvailable = false;
          } else {
            throw currentScheduleRes.error;
          }
        } else {
          currentSchedules = currentScheduleRes.data || [];
        }
      }

      if (releaseWorkflowAvailable && requestIds.length > 0) {
        const historyRes = await supabase
          .from(RELEASE_SCHEDULES_TABLE)
          .select('*')
          .in('Req_ID', requestIds)
          .order('Created_At', { ascending: false });

        if (historyRes.error) {
          throw historyRes.error;
        }

        allSchedules = historyRes.data || [];
      }

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

      if (wigIdsForLookup.length > 0) {
        const [wigsRes, wigSpecsRes, wigFiltersRes] = await Promise.all([
          supabase
            .from(WIGS_TABLE)
            .select(`
              wig_id:Wig_ID,
              wig_code:Wig_Code,
              wig_name:Wig_Name,
              wig_status:Wig_Status,
              total_donated_hairs:Total_Donated_Hairs,
              total_bundles_used:Total_Bundles_Used,
              created_at:Created_At,
              updated_at:Updated_At
            `)
            .in('Wig_ID', wigIdsForLookup),
          supabase
            .from(WIG_SPECIFICATIONS_TABLE)
            .select(`
              wig_id:Wig_ID,
              hair_length:Hair_Length,
              hair_color:Hair_Color,
              hair_texture:Hair_Texture,
              hair_density:Hair_Density,
              style:Style,
              cap_size:Cap_Size
            `)
            .in('Wig_ID', wigIdsForLookup),
          supabase
            .from(WIG_FILTERS_TABLE)
            .select('Wig_ID, Is_Active, Status, Source_Front_Path, Source_Side_Path, Source_Top_Path, Source_Back_Path, Layer_Back_Hair_Path, Updated_At')
            .in('Wig_ID', wigIdsForLookup)
            .order('Updated_At', { ascending: false }),
        ]);

        if (wigsRes.error) throw wigsRes.error;

        const wigRows = wigsRes.data || [];
        wigsById = new Map(
          wigRows
            .map((row) => [Number(row.wig_id ?? row.Wig_ID ?? 0), row])
            .filter(([wigId]) => wigId > 0),
        );

        if (wigSpecsRes.error) {
          const lowerSpecError = String(wigSpecsRes.error.message || '').toLowerCase();
          const canIgnoreMissingSpecTable = lowerSpecError.includes('relation') && lowerSpecError.includes('does not exist');
          if (!canIgnoreMissingSpecTable) {
            throw wigSpecsRes.error;
          }
        } else {
          wigSpecsByWigId = new Map(
            (wigSpecsRes.data || []).map((row) => [Number(row.wig_id ?? row.Wig_ID ?? 0), row]),
          );
        }

        if (wigFiltersRes.error) {
          throw wigFiltersRes.error;
        }
        (wigFiltersRes.data || []).forEach((row) => {
          const wigId = Number(row.Wig_ID || 0);
          if (!wigId || wigFiltersByWigId.has(wigId)) {
            return;
          }
          const statusKey = normalizeStatusKey(row.Status);
          if (row.Is_Active || statusKey === 'approved' || statusKey === 'pendingreview') {
            wigFiltersByWigId.set(wigId, row);
          }
        });
      }

      setIsReleaseWorkflowAvailable(releaseWorkflowAvailable);

      const patientById = new Map((patientsRes.data || []).map((row) => [Number(row.Patient_ID), row]));
      const currentScheduleByReqId = new Map(
        currentSchedules
          .filter((row) => Number(row.Req_ID || 0) > 0)
          .map((row) => [Number(row.Req_ID), row]),
      );

      const mappedRows = (requestsRes.data || []).map((requestRow) => {
        const reqId = Number(requestRow.Req_ID || 0);
        const patient = patientById.get(Number(requestRow.Patient_ID || 0)) || null;
        const linkedPatientUser = patient ? nextPatientUsersById[Number(patient.User_ID || 0)] : null;
        const currentSchedule = currentScheduleByReqId.get(reqId) || null;
        const requestedWigId = Number(requestRow.Requested_Wig_ID || 0) || null;
        const allocatedWigId = Number(requestRow.Allocated_Wig_ID || 0) || null;
        const requestedWigSpec = requestedWigId
          ? (wigSpecsByWigId.get(Number(requestedWigId || 0)) || {})
          : {};
        const allocatedWig = allocatedWigId ? (wigsById.get(allocatedWigId) || null) : null;
        const allocatedWigSpec = allocatedWig
          ? (wigSpecsByWigId.get(Number(allocatedWig.wig_id ?? allocatedWig.Wig_ID ?? 0)) || {})
          : {};
        const allocatedWigFilter = allocatedWigId ? (wigFiltersByWigId.get(allocatedWigId) || null) : null;

        const statusRaw = requestRow.Status || REQUEST_STATUS.pending;
        const releaseWorkflowRaw = currentSchedule?.Hospital_Decision
          ? String(currentSchedule.Hospital_Decision).trim()
          : '';

        return {
          reqId,
          requestId: formatRequestCode(requestRow.Request_Code, reqId),
          patientId: Number(requestRow.Patient_ID || 0),
          patientName: getPatientFullName(patient, linkedPatientUser),
          patientCode: String(patient?.Patient_Code || '').trim(),
          medicalCondition: String(patient?.Medical_Condition || '').trim() || 'N/A',
          requestDate: requestRow.Request_Date,
          updatedAt: requestRow.Updated_At || requestRow.Request_Date,
          status: statusRaw,
          statusKey: getCanonicalStatusKey(statusRaw),
          statusLabel: getStatusLabel(statusRaw),
          statusReason: String(requestRow.Status_Reason || '').trim(),
          releaseDate: currentSchedule?.Proposed_Release_Date || null,
          releaseWorkflowStatus: releaseWorkflowRaw,
          releaseWorkflowKey: normalizeReleaseWorkflowKey(releaseWorkflowRaw),
          releaseWorkflowLabel: getReleaseWorkflowLabel(releaseWorkflowRaw),
          releaseScheduleId: Number(currentSchedule?.Release_Schedule_ID || 0) || null,
          releaseDecisionReason: String(currentSchedule?.Hospital_Decision_Reason || '').trim(),
          releaseProposalNote: String(currentSchedule?.Proposal_Note || '').trim(),
          specWigName: String(
            wigsById.get(Number(requestedWigId || 0))?.wig_name
            ?? wigsById.get(Number(requestedWigId || 0))?.Wig_Name
            ?? '',
          ).trim() || 'N/A',
          specStyle: String(requestedWigSpec?.style ?? requestedWigSpec?.Style ?? '').trim() || 'N/A',
          specColor: String(requestedWigSpec?.hair_color ?? requestedWigSpec?.Hair_Color ?? '').trim() || 'N/A',
          specLength: (requestedWigSpec?.hair_length ?? requestedWigSpec?.Hair_Length) === null
            || (requestedWigSpec?.hair_length ?? requestedWigSpec?.Hair_Length) === undefined
            ? 'N/A'
            : String(requestedWigSpec?.hair_length ?? requestedWigSpec?.Hair_Length).trim() || 'N/A',
          specTexture: String(requestedWigSpec?.hair_texture ?? requestedWigSpec?.Hair_Texture ?? '').trim() || 'N/A',
          specDensity: String(requestedWigSpec?.hair_density ?? requestedWigSpec?.Hair_Density ?? '').trim() || 'N/A',
          specCapSize: String(requestedWigSpec?.cap_size ?? requestedWigSpec?.Cap_Size ?? '').trim() || 'N/A',
          specSpecialNote: 'N/A',
          allocatedWigId,
          allocatedWigCode: String(allocatedWig?.wig_code ?? allocatedWig?.Wig_Code ?? '').trim() || 'N/A',
          allocatedWigName: String(allocatedWig?.wig_name ?? allocatedWig?.Wig_Name ?? '').trim() || 'N/A',
          allocatedWigStatus: String(allocatedWig?.wig_status ?? allocatedWig?.Wig_Status ?? '').trim() || 'N/A',
          allocatedWigTotalDonatedHairs: Number(allocatedWig?.total_donated_hairs ?? allocatedWig?.Total_Donated_Hairs ?? 0) || 0,
          allocatedWigTotalBundlesUsed: Number(allocatedWig?.total_bundles_used ?? allocatedWig?.Total_Bundles_Used ?? 0) || 0,
          allocatedWigLength: (allocatedWigSpec?.hair_length ?? allocatedWigSpec?.Hair_Length) === null
            || (allocatedWigSpec?.hair_length ?? allocatedWigSpec?.Hair_Length) === undefined
            ? 'N/A'
            : String(allocatedWigSpec?.hair_length ?? allocatedWigSpec?.Hair_Length).trim() || 'N/A',
          allocatedWigColor: String(allocatedWigSpec?.hair_color ?? allocatedWigSpec?.Hair_Color ?? '').trim() || 'N/A',
          allocatedWigTexture: String(allocatedWigSpec?.hair_texture ?? allocatedWigSpec?.Hair_Texture ?? '').trim() || 'N/A',
          allocatedWigDensity: String(allocatedWigSpec?.hair_density ?? allocatedWigSpec?.Hair_Density ?? '').trim() || 'N/A',
          allocatedWigStyle: String(allocatedWigSpec?.style ?? allocatedWigSpec?.Style ?? '').trim() || 'N/A',
          allocatedWigCapSize: String(allocatedWigSpec?.cap_size ?? allocatedWigSpec?.Cap_Size ?? '').trim() || 'N/A',
          allocatedWigFrontImageUrl: resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Front_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Front_Path || '').trim(),
          ),
          allocatedWigSideImageUrl: resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Side_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Side_Path || '').trim(),
          ),
          allocatedWigTopImageUrl: resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Top_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Top_Path || '').trim(),
          ),
          allocatedWigBackImageUrl: resolveStoragePublicUrl(
            WIG_AI_SOURCES_BUCKET,
            String(allocatedWigFilter?.Source_Back_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Back_Path || '').trim(),
          ) || resolveStoragePublicUrl(
            WIG_AI_FILTERS_BUCKET,
            String(allocatedWigFilter?.Source_Back_Path || allocatedWigFilter?.Layer_Back_Hair_Path || '').trim(),
          ),
          previewPdfUrl: String(requestRow.Pdf_Url || requestRow.Preview_Pdf_Url || '').trim(),
        };
      });

      const historyRows = allSchedules.map((row) => {
        const reqId = Number(row.Req_ID || 0);
        const requestRow = mappedRows.find((item) => item.reqId === reqId) || null;

        return {
          scheduleId: Number(row.Release_Schedule_ID || 0),
          reqId,
          requestId: requestRow?.requestId || formatRequestCode('', reqId),
          patientName: requestRow?.patientName || 'Unknown Patient',
          proposedReleaseDate: row.Proposed_Release_Date,
          hospitalDecision: row.Hospital_Decision,
          hospitalDecisionKey: normalizeReleaseWorkflowKey(row.Hospital_Decision),
          hospitalDecisionLabel: getReleaseWorkflowLabel(row.Hospital_Decision),
          hospitalDecisionReason: String(row.Hospital_Decision_Reason || '').trim(),
          proposalNote: String(row.Proposal_Note || '').trim(),
          createdAt: row.Created_At,
          updatedAt: row.Updated_At,
          isCurrent: Boolean(row.Is_Current),
        };
      });

      setRows(mappedRows);
      setScheduleHistory(historyRows);

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
  }, [hospitalId]);

  useEffect(() => {
    resolveAssignedHospital();
  }, [resolveAssignedHospital]);

  useEffect(() => {
    if (!hospitalId) {
      setRows([]);
      setScheduleHistory([]);
      return;
    }

    loadReleaseRows();
  }, [hospitalId, loadReleaseRows]);

  useEffect(() => {
    setRescheduleReason('');
  }, [selectedRow?.reqId]);

  const queueRows = useMemo(() => {
    return rows.filter((row) => (
      row.statusKey === 'accepted_allocated'
      || row.statusKey === 'accepted_no_wig'
      || row.statusKey === 'to_be_release'
    ));
  }, [rows]);

  const releaseRows = useMemo(() => {
    return rows.filter(
      (row) => row.statusKey === 'releasing' || (row.statusKey !== 'released' && row.releaseWorkflowKey === 'hospital_approved'),
    );
  }, [rows]);

  const releasedRows = useMemo(() => {
    return rows.filter((row) => row.statusKey === 'released');
  }, [rows]);

  const rescheduleHistoryRows = useMemo(() => {
    return scheduleHistory.filter((row) => row.hospitalDecisionKey === 'hospital_reschedule_requested');
  }, [scheduleHistory]);

  const filteredQueueRows = useMemo(() => {
    const query = normalizeText(searchTerm);
    if (!query) {
      return queueRows;
    }

    return queueRows.filter((row) => matchesSearch(row, query));
  }, [queueRows, searchTerm]);

  const filteredReleaseRows = useMemo(() => {
    const query = normalizeText(searchTerm);
    if (!query) {
      return releaseRows;
    }

    return releaseRows.filter((row) => matchesSearch(row, query));
  }, [releaseRows, searchTerm]);

  const filteredReleasedRows = useMemo(() => {
    const query = normalizeText(searchTerm);
    if (!query) {
      return releasedRows;
    }

    return releasedRows.filter((row) => matchesSearch(row, query));
  }, [releasedRows, searchTerm]);

  const summaryCards = useMemo(() => {
    const pendingApprovalCount = queueRows.filter((row) => row.releaseWorkflowKey === 'pending_hospital_approval').length;
    const releasingCount = releaseRows.length;
    const releasedCount = releasedRows.length;
    const rescheduleCount = rescheduleHistoryRows.length;

    return [
      { label: 'Pending Approval', value: String(pendingApprovalCount) },
      { label: 'Active Releasing', value: String(releasingCount) },
      { label: 'Released', value: String(releasedCount) },
      { label: 'Reschedule Requests', value: String(rescheduleCount) },
    ];
  }, [queueRows, releaseRows, releasedRows, rescheduleHistoryRows]);

  const selectedPreviewUrl = useMemo(() => {
    if (!selectedRow) {
      return '';
    }

    return resolveStoragePublicUrl(WIG_REQUEST_PREVIEWS_BUCKET, selectedRow.previewPdfUrl);
  }, [selectedRow]);

  const selectedCanApprove = useMemo(() => {
    if (!selectedRow) {
      return false;
    }

    return selectedRow.releaseWorkflowKey === 'pending_hospital_approval' && Boolean(selectedRow.releaseScheduleId);
  }, [selectedRow]);

  const selectedCanComplete = useMemo(() => {
    if (!selectedRow) {
      return false;
    }

    return selectedRow.statusKey === 'releasing';
  }, [selectedRow]);

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

  const updateAllocatedWigStatusByRequest = useCallback(async (reqId, nextWigStatus) => {
    if (!Number(reqId || 0)) {
      return;
    }

    const nowIso = getPstTimestamp();
    const { data: requestRow, error: requestReadError } = await supabase
      .from(WIG_REQUESTS_TABLE)
      .select('Allocated_Wig_ID')
      .eq('Req_ID', reqId)
      .maybeSingle();

    if (requestReadError) {
      throw requestReadError;
    }

    const targetWigId = Number(requestRow?.Allocated_Wig_ID || 0);
    if (!targetWigId) {
      return;
    }

    const { error } = await supabase
      .from(WIGS_TABLE)
      .update({
        Wig_Status: nextWigStatus,
        Updated_At: nowIso,
      })
      .eq('Wig_ID', targetWigId);

    if (error) {
      throw error;
    }
  }, []);

  const rowCanApprove = useCallback((row) => (
    Boolean(row)
    && row.releaseWorkflowKey === 'pending_hospital_approval'
    && Boolean(row.releaseScheduleId)
  ), []);

  const performApproveRelease = useCallback(async (row) => {
    if (!row || !rowCanApprove(row)) {
      return;
    }

    const actorUserId = Number(userProfile?.user_id || 0) || null;
    const nowIso = getPstTimestamp();

    try {
      setIsApplyingDecision(true);
      setNotice({ kind: '', text: '' });

      const { error: updateScheduleError } = await supabase
        .from(RELEASE_SCHEDULES_TABLE)
        .update({
          Hospital_Decision: 'Approved',
          Hospital_Decision_By: actorUserId,
          Hospital_Decision_At: nowIso,
          Hospital_Decision_Reason: null,
          Updated_At: nowIso,
        })
        .eq('Release_Schedule_ID', row.releaseScheduleId);

      if (updateScheduleError) {
        throw updateScheduleError;
      }

      await updateRequestWithStatusReasonFallback(row.reqId, {
        Status: REQUEST_STATUS.releasing,
        Updated_At: nowIso,
        Status_Reason: null,
      });
      await updateAllocatedWigStatusByRequest(row.reqId, REQUEST_STATUS.releasing);

      await logAuditAction({
        action: 'hospital_release_schedule_decision',
        description: `${row.requestId} approved release schedule`,
        resource: 'Release_Schedules',
        status: 'success',
        userProfile,
      });

      await loadReleaseRows(row.reqId);
      setNotice({ kind: 'success', text: `${row.requestId} release schedule approved.` });
    } catch (error) {
      await logAuditAction({
        action: 'hospital_release_schedule_decision',
        description: `${row.requestId} failed release approval`,
        resource: 'Release_Schedules',
        status: 'failed',
        userProfile,
      });

      setNotice({ kind: 'error', text: mapActionError(error.message) });
    } finally {
      setIsApplyingDecision(false);
    }
  }, [rowCanApprove, userProfile, updateRequestWithStatusReasonFallback, updateAllocatedWigStatusByRequest, loadReleaseRows]);

  const performRequestReschedule = useCallback(async (row, reasonInput) => {
    if (!row || !rowCanApprove(row)) {
      return;
    }

    const reason = String(reasonInput || '').trim();
    if (!reason) {
      setNotice({ kind: 'error', text: 'Reschedule reason is required.' });
      return;
    }

    const actorUserId = Number(userProfile?.user_id || 0) || null;
    const nowIso = getPstTimestamp();

    try {
      setIsApplyingDecision(true);
      setNotice({ kind: '', text: '' });

      const { error: updateScheduleError } = await supabase
        .from(RELEASE_SCHEDULES_TABLE)
        .update({
          Hospital_Decision: 'Reschedule Requested',
          Hospital_Decision_By: actorUserId,
          Hospital_Decision_At: nowIso,
          Hospital_Decision_Reason: reason,
          Updated_At: nowIso,
        })
        .eq('Release_Schedule_ID', row.releaseScheduleId);

      if (updateScheduleError) {
        throw updateScheduleError;
      }

      await updateRequestWithStatusReasonFallback(row.reqId, {
        Status: REQUEST_STATUS.toBeRelease,
        Updated_At: nowIso,
        Status_Reason: reason,
      });

      await logAuditAction({
        action: 'hospital_release_schedule_decision',
        description: `${row.requestId} requested reschedule | reason: ${reason}`,
        resource: 'Release_Schedules',
        status: 'success',
        userProfile,
      });

      await loadReleaseRows(row.reqId);
      setNotice({ kind: 'success', text: `${row.requestId} marked for reschedule and returned to staff queue.` });
      return { success: true };
    } catch (error) {
      await logAuditAction({
        action: 'hospital_release_schedule_decision',
        description: `${row.requestId} failed reschedule request`,
        resource: 'Release_Schedules',
        status: 'failed',
        userProfile,
      });

      setNotice({ kind: 'error', text: mapActionError(error.message) });
      return { success: false };
    } finally {
      setIsApplyingDecision(false);
    }
  }, [rowCanApprove, userProfile, updateRequestWithStatusReasonFallback, loadReleaseRows]);

  const handleApproveRelease = async () => {
    if (!selectedRow) return;
    await performApproveRelease(selectedRow);
  };

  const handleRequestReschedule = async () => {
    if (!selectedRow) return;
    const result = await performRequestReschedule(selectedRow, rescheduleReason);
    if (result?.success) {
      setRescheduleReason('');
    }
  };

  const handleMarkReleaseCompleted = async () => {
    if (!selectedRow || !selectedCanComplete) {
      return;
    }

    const nowIso = getPstTimestamp();

    try {
      setIsApplyingDecision(true);
      setNotice({ kind: '', text: '' });

      await updateRequestWithStatusReasonFallback(selectedRow.reqId, {
        Status: REQUEST_STATUS.released,
        Updated_At: nowIso,
        Status_Reason: null,
      });
      await updateAllocatedWigStatusByRequest(selectedRow.reqId, REQUEST_STATUS.released);

      await logAuditAction({
        action: 'hospital_release_completed',
        description: `${selectedRow.requestId} marked release as released`,
        resource: 'Wig_Requests',
        status: 'success',
        userProfile,
      });

      await loadReleaseRows(selectedRow.reqId);
      setNotice({ kind: 'success', text: `${selectedRow.requestId} marked as released.` });
    } catch (error) {
      await logAuditAction({
        action: 'hospital_release_completed',
        description: `${selectedRow.requestId} failed to mark release as released`,
        resource: 'Wig_Requests',
        status: 'failed',
        userProfile,
      });

      setNotice({ kind: 'error', text: mapActionError(error.message) });
    } finally {
      setIsApplyingDecision(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className={`role-page-title ${embedded ? '' : 'mb-2'} text-gray-900`}>Release Date Approval</h1>
        <p className="text-gray-600">
          Review proposed release dates from staff, approve or request reschedule, and finalize releases.
        </p>
        <p className="mt-1 text-xs text-gray-500">
          H-Representative scope: {hospitalName || (hospitalId ? `H-Representative #${hospitalId}` : 'Not assigned')}
        </p>
      </div>

      <div className={`${embedded ? 'hidden' : 'grid'} grid-cols-2 gap-3 md:grid-cols-4`}>
        {summaryCards.map((item) => (
          <article key={item.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">{item.label}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900">{item.value}</p>
          </article>
        ))}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-md">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
              placeholder="Search request, patient, status, or notes"
            />
          </div>

          <button
            type="button"
            onClick={() => loadReleaseRows(selectedRow?.reqId || null)}
            disabled={isResolvingHospital || isLoading || isApplyingDecision}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {(isResolvingHospital || isLoading) ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-6" aria-label="Release approval sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-1 py-3 text-sm font-semibold transition-colors ${
              activeTab === tab.id
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
        </nav>
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

      {activeTab === 'approvals' && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Release Approval Queue</h2>
            <p className="mt-1 text-xs text-gray-500">All approved requests &mdash; both &ldquo;Accepted - Wig Allocated&rdquo; and &ldquo;Accepted - No Wig Available&rdquo; &mdash; plus those ready for release approval.</p>
          </div>

          {isLoading ? (
            <div className="px-4 py-8 text-sm text-gray-600 inline-flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading queue...
            </div>
          ) : filteredQueueRows.length === 0 ? (
            <div className="px-4 py-8 text-sm text-gray-600">No records in release approval queue.</div>
          ) : embedded ? (
            <div className="grid grid-cols-1 gap-3 bg-slate-50 p-4 lg:grid-cols-2 2xl:grid-cols-3">
              {filteredQueueRows.map((row) => {
                const canQuickAct = rowCanApprove(row);
                return (
                  <article key={row.reqId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <button type="button" onClick={() => setSelectedRow(row)} className="block w-full text-left">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{row.requestId}</p>
                          <h3 className="mt-1 text-sm font-bold text-slate-900">{row.patientName}</h3>
                          <p className="text-[11px] text-slate-500">{row.patientCode || 'No patient code'}</p>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${statusClass(row.status)}`}>
                          {row.statusLabel}
                        </span>
                      </div>

                      <dl className="mt-3 space-y-2 border-t border-slate-100 pt-3 text-xs">
                        <div>
                          <dt className="text-slate-500">Medical condition</dt>
                          <dd className="font-semibold text-slate-800">{row.medicalCondition}</dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Proposed release date</dt>
                          <dd className="font-semibold text-slate-800">{formatDateTime(row.releaseDate)}</dd>
                        </div>
                      </dl>
                    </button>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      {canQuickAct ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setQuickApproveTarget(row)}
                            disabled={isApplyingDecision}
                            className="inline-flex items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                          >
                            <Check size={13} /> Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setQuickRescheduleReason('');
                              setQuickRescheduleAttempted(false);
                              setQuickRescheduleTarget(row);
                            }}
                            disabled={isApplyingDecision}
                            className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          >
                            <CalendarDays size={13} /> Reschedule
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSelectedRow(row)}
                          className="col-span-2 inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Info size={13} /> View Details
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Request ID</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Patient</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Medical Condition</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Proposed Release Date</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Release Flow</th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQueueRows.map((row) => {
                    const canQuickAct = rowCanApprove(row);
                    return (
                      <tr
                        key={row.reqId}
                        onClick={() => setSelectedRow(row)}
                        className="cursor-pointer border-t border-gray-200 hover:bg-gray-50"
                      >
                        <td className="px-4 py-3 font-semibold text-gray-800">{row.requestId}</td>
                        <td className="px-4 py-3 text-gray-700">
                          <p className="font-semibold text-gray-800">{row.patientName}</p>
                          <p className="text-xs text-gray-500">{row.patientCode || 'No patient code'}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{row.medicalCondition}</td>
                        <td className="px-4 py-3 text-gray-700">{formatDateTime(row.releaseDate)}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>
                            {row.statusLabel}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${releaseWorkflowClass(row.releaseWorkflowStatus)}`}>
                            {row.releaseWorkflowLabel}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {canQuickAct && (
                              <>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setQuickApproveTarget(row);
                                  }}
                                  disabled={isApplyingDecision}
                                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                                >
                                  <Check size={13} /> Approve
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setQuickRescheduleReason('');
                                    setQuickRescheduleAttempted(false);
                                    setQuickRescheduleTarget(row);
                                  }}
                                  disabled={isApplyingDecision}
                                  className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
                                >
                                  <CalendarDays size={13} /> Reschedule
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedRow(row);
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                            >
                              <Info size={13} /> Info
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === 'releasing' && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Active Releasing</h2>
          </div>

          {isLoading ? (
            <div className="px-4 py-8 text-sm text-gray-600 inline-flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading release records...
            </div>
          ) : filteredReleaseRows.length === 0 ? (
            <div className="px-4 py-8 text-sm text-gray-600">No active releasing records found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Request ID</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Patient</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Release Date</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Release Flow</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReleaseRows.map((row) => (
                    <tr
                      key={row.reqId}
                      onClick={() => setSelectedRow(row)}
                      className="cursor-pointer border-t border-gray-200 hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-semibold text-gray-800">{row.requestId}</td>
                      <td className="px-4 py-3 text-gray-700">{row.patientName}</td>
                      <td className="px-4 py-3 text-gray-700">{formatDateTime(row.releaseDate)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>
                          {row.statusLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${releaseWorkflowClass(row.releaseWorkflowStatus)}`}>
                          {row.releaseWorkflowLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedRow(row);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          <Info size={13} /> Info
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === 'released' && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Released Requests</h2>
          </div>

          {isLoading ? (
            <div className="px-4 py-8 text-sm text-gray-600 inline-flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading released records...
            </div>
          ) : filteredReleasedRows.length === 0 ? (
            <div className="px-4 py-8 text-sm text-gray-600">No released records found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Request ID</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Patient</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Release Date</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Released At</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReleasedRows.map((row) => (
                    <tr
                      key={row.reqId}
                      onClick={() => setSelectedRow(row)}
                      className="cursor-pointer border-t border-gray-200 hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-semibold text-gray-800">{row.requestId}</td>
                      <td className="px-4 py-3 text-gray-700">{row.patientName}</td>
                      <td className="px-4 py-3 text-gray-700">{formatDateTime(row.releaseDate)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>
                          {row.statusLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{formatDateTime(row.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedRow(row);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          <Info size={13} /> Info
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {selectedRow && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[90] m-0 p-0">
          <button
            type="button"
            aria-label="Close release details panel"
            className="absolute inset-0 m-0 p-0 border-0 appearance-none bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={() => setSelectedRow(null)}
          />

          <aside
            className="absolute right-0 top-0 h-full w-full max-w-3xl overflow-y-auto border-l border-slate-200 bg-white shadow-2xl"
            style={{ animation: 'hospitalReleasePanelSlideIn 0.25s ease-out' }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Release Review Details</h3>
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
                <p><span className="font-semibold text-slate-900">H-Representative:</span> {hospitalName || `H-Representative #${hospitalId}`}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Patient:</span> {selectedRow.patientName}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Medical Condition:</span> {selectedRow.medicalCondition}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Current Status:</span> {selectedRow.statusLabel}</p>
                <p className="mt-1 inline-flex items-center gap-1.5"><CalendarDays size={14} className="text-slate-500" />
                  <span><span className="font-semibold text-slate-900">Proposed Release Date:</span> {formatDateTime(selectedRow.releaseDate)}</span>
                </p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Release Workflow:</span> {selectedRow.releaseWorkflowLabel}</p>
                {selectedRow.releaseDecisionReason && (
                  <p className="mt-1 whitespace-pre-line"><span className="font-semibold text-slate-900">Decision Reason:</span> {selectedRow.releaseDecisionReason}</p>
                )}
                {selectedRow.releaseProposalNote && (
                  <p className="mt-1 whitespace-pre-line"><span className="font-semibold text-slate-900">Staff Proposal Note:</span> {selectedRow.releaseProposalNote}</p>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Requested Wig Preference</p>
                <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 sm:grid-cols-2">
                  <p><span className="font-semibold text-slate-900">Wig Name:</span> {selectedRow.specWigName}</p>
                  <p><span className="font-semibold text-slate-900">Color:</span> {selectedRow.specColor}</p>
                  <p><span className="font-semibold text-slate-900">Length:</span> {selectedRow.specLength}</p>
                  <p><span className="font-semibold text-slate-900">Density:</span> {selectedRow.specDensity}</p>
                  <p><span className="font-semibold text-slate-900">Cap Size:</span> {selectedRow.specCapSize}</p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Allocated Wig Details</p>
                {selectedRow.allocatedWigId ? (
                  <>
                    <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 sm:grid-cols-2">
                      <p><span className="font-semibold text-slate-900">Wig Code:</span> {selectedRow.allocatedWigCode}</p>
                      <p><span className="font-semibold text-slate-900">Wig Name:</span> {selectedRow.allocatedWigName}</p>
                      <p><span className="font-semibold text-slate-900">Wig Status:</span> {selectedRow.allocatedWigStatus}</p>
                      <p><span className="font-semibold text-slate-900">Total Donated Hair:</span> {selectedRow.allocatedWigTotalDonatedHairs}</p>
                      <p><span className="font-semibold text-slate-900">Bundles Used:</span> {selectedRow.allocatedWigTotalBundlesUsed}</p>
                      <p><span className="font-semibold text-slate-900">Style:</span> {selectedRow.allocatedWigStyle}</p>
                      <p><span className="font-semibold text-slate-900">Color:</span> {selectedRow.allocatedWigColor}</p>
                      <p><span className="font-semibold text-slate-900">Length:</span> {selectedRow.allocatedWigLength}</p>
                      <p><span className="font-semibold text-slate-900">Texture:</span> {selectedRow.allocatedWigTexture}</p>
                      <p><span className="font-semibold text-slate-900">Density:</span> {selectedRow.allocatedWigDensity}</p>
                      <p><span className="font-semibold text-slate-900">Cap Size:</span> {selectedRow.allocatedWigCapSize}</p>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                      {[
                        { key: 'front', label: 'Front View', url: selectedRow.allocatedWigFrontImageUrl },
                        { key: 'side', label: 'Side View', url: selectedRow.allocatedWigSideImageUrl },
                        { key: 'top', label: 'Top View', url: selectedRow.allocatedWigTopImageUrl },
                        { key: 'back', label: 'Back View', url: selectedRow.allocatedWigBackImageUrl },
                      ].map((image) => (
                        <div key={image.key} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                          <p className="mb-2 text-xs font-semibold text-slate-600">{image.label}</p>
                          {image.url ? (
                            <a href={image.url} target="_blank" rel="noreferrer">
                              <img
                                src={image.url}
                                alt={`${image.label} for ${selectedRow.allocatedWigCode}`}
                                className="h-40 w-full rounded-md border border-slate-200 object-cover"
                              />
                            </a>
                          ) : (
                            <div className="flex h-40 w-full items-center justify-center rounded-md border border-dashed border-slate-300 bg-white text-xs text-slate-500">
                              No image uploaded
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    No wig is allocated to this request yet.
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">H-Representative Decision</p>
                {selectedCanApprove ? (
                  <div className="mt-3 space-y-3">
                    <button
                      type="button"
                      onClick={handleApproveRelease}
                      disabled={isApplyingDecision || !isReleaseWorkflowAvailable}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isApplyingDecision ? 'Applying...' : 'Approve Release Schedule'}
                    </button>

                    <div>
                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Reschedule Reason (required)</label>
                      <textarea
                        value={rescheduleReason}
                        onChange={(event) => setRescheduleReason(event.target.value)}
                        disabled={isApplyingDecision || !isReleaseWorkflowAvailable}
                        rows={3}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200"
                        placeholder="Explain why this release date should be changed."
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleRequestReschedule}
                      disabled={isApplyingDecision || !isReleaseWorkflowAvailable || !String(rescheduleReason || '').trim()}
                      className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isApplyingDecision ? 'Applying...' : 'Request Reschedule'}
                    </button>

                    {!isReleaseWorkflowAvailable && (
                      <p className="text-xs text-red-700">
                        Release workflow data is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.
                      </p>
                    )}
                  </div>
                ) : selectedCanComplete ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      This request is in releasing stage. Mark it released once handover is finished.
                    </div>

                    <button
                      type="button"
                      onClick={handleMarkReleaseCompleted}
                      disabled={isApplyingDecision}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {isApplyingDecision ? 'Applying...' : 'Mark as Released'}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    This record has no pending hospital action right now.
                  </div>
                )}
              </div>

              {selectedPreviewUrl ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <iframe
                    title="Request PDF preview"
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

      {quickApproveTarget && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 px-4">
          <button
            type="button"
            aria-label="Close approve confirmation"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => {
              if (isApplyingDecision) return;
              setQuickApproveTarget(null);
            }}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Approve release schedule"
            className="relative w-full max-w-md rounded-2xl border border-emerald-100 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-emerald-100 p-2 text-emerald-700">
                <Check size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-gray-900">Approve Release Schedule</h3>
                <p className="mt-1 text-sm text-gray-700">
                  Approve the proposed release date for <span className="font-semibold">{quickApproveTarget.requestId}</span>
                  {quickApproveTarget.patientName ? <> &mdash; <span className="font-semibold">{quickApproveTarget.patientName}</span></> : null}?
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Proposed Release Date: <span className="font-semibold text-gray-800">{formatDateTime(quickApproveTarget.releaseDate)}</span>
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setQuickApproveTarget(null)}
                disabled={isApplyingDecision}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const target = quickApproveTarget;
                  await performApproveRelease(target);
                  setQuickApproveTarget(null);
                }}
                disabled={isApplyingDecision}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {isApplyingDecision ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                {isApplyingDecision ? 'Approving...' : 'Confirm Approve'}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}

      {quickRescheduleTarget && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 px-4">
          <button
            type="button"
            aria-label="Close reschedule prompt"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => {
              if (isApplyingDecision) return;
              setQuickRescheduleTarget(null);
              setQuickRescheduleReason('');
              setQuickRescheduleAttempted(false);
            }}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Request reschedule"
            className="relative w-full max-w-md rounded-2xl border border-rose-100 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-rose-100 p-2 text-rose-700">
                <CalendarDays size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-gray-900">Request Reschedule</h3>
                <p className="mt-1 text-sm text-gray-700">
                  Send <span className="font-semibold">{quickRescheduleTarget.requestId}</span> back to staff with a reschedule reason.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-600">
                Reschedule Reason <span className="text-rose-600">(required)</span>
              </label>
              <textarea
                value={quickRescheduleReason}
                onChange={(event) => {
                  setQuickRescheduleReason(event.target.value);
                  if (event.target.value.trim()) {
                    setQuickRescheduleAttempted(false);
                  }
                }}
                rows={4}
                placeholder="Explain why this release date should be changed."
                className={`w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:ring-2 ${
                  quickRescheduleAttempted && !quickRescheduleReason.trim()
                    ? 'border-rose-400 focus:ring-rose-200'
                    : 'border-gray-300 focus:ring-gray-200'
                }`}
              />

              {!quickRescheduleReason.trim() && (
                <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>Please add a reschedule reason before submitting.</span>
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setQuickRescheduleTarget(null);
                  setQuickRescheduleReason('');
                  setQuickRescheduleAttempted(false);
                }}
                disabled={isApplyingDecision}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!quickRescheduleReason.trim()) {
                    setQuickRescheduleAttempted(true);
                    return;
                  }
                  const target = quickRescheduleTarget;
                  const reasonValue = quickRescheduleReason;
                  const result = await performRequestReschedule(target, reasonValue);
                  if (result?.success) {
                    setQuickRescheduleTarget(null);
                    setQuickRescheduleReason('');
                    setQuickRescheduleAttempted(false);
                  }
                }}
                disabled={isApplyingDecision || !quickRescheduleReason.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {isApplyingDecision ? <Loader2 size={16} className="animate-spin" /> : <CalendarDays size={16} />}
                {isApplyingDecision ? 'Submitting...' : 'Submit Reschedule'}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}

      <style>{`
        @keyframes hospitalReleasePanelSlideIn {
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
