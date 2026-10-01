import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CalendarOff,
  Camera,
  CameraOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  MapPin,
  Save,
  ScanLine,
  Search,
  UserCheck,
  UserX,
  XCircle,
} from "lucide-react";
import jsQR from "jsqr";
import { useTheme } from "../../../context/ThemeContext";
import { isSupabaseConfigured, supabase } from "../../../lib/supabaseClient";
import PageHeaderActions from "../../../components/PageHeaderActions";
import { useToast } from "../../../context/ToastContext";
import {
  isValidWaybillCode,
  normalizeWaybillCodeInput,
  parseWaybillQrPayload,
} from "../../../lib/hairSubmissionWorkflow";

const LOGISTICS_TABLE = "Hair_Submission_Logistics";
const SUBMISSIONS_TABLE = "Hair_Submissions";
const APPOINTMENTS_TABLE = "Salon_Donation_Appointments";
const HOURS_TABLE = "Salon_Operating_Hours";
const OVERRIDES_TABLE = "Salon_Schedule_Overrides";
const EMPTY_OVERRIDE = {
  date: "",
  isClosed: true,
  openingTime: "09:00",
  closingTime: "17:00",
  breakStartTime: "",
  breakEndTime: "",
  capacity: "",
  reason: "",
};
const EMPTY_APPOINTMENT_REVIEW = {
  declaredLength: "",
  declaredColor: "",
  declaredTexture: "",
  declaredDensity: "",
  declaredCondition: "",
  isChemicallyTreated: false,
  isColored: false,
  isBleached: false,
  isRebonded: false,
  detailNotes: "",
};
const HAIR_COLORS = [
  "Black",
  "Dark Brown",
  "Brown",
  "Light Brown",
  "Blonde",
  "Red",
  "Gray",
  "White",
  "Mixed",
];
const HAIR_PATTERNS = ["Straight", "Wavy", "Curly", "Coily"];
const HAIR_DENSITIES = ["Low", "Medium", "High"];
const HAIR_CONDITIONS = [
  "No Visible Concerns Detected",
  "Dry",
  "Damaged",
  "Brittle",
  "Split Ends",
  "Other",
];

function dateKey(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
function parseDateKey(value) {
  const [year, month, day] = String(value || "")
    .split("-")
    .map(Number);
  return new Date(year, Math.max(0, month - 1), day || 1);
}
function startOfMonth(value) {
  const date = value instanceof Date ? value : parseDateKey(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function addMonths(value, amount) {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1);
}
function buildMonthCells(value) {
  const first = startOfMonth(value);
  const cells = Array.from({ length: first.getDay() }, () => null);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let day = 1; day <= days; day += 1)
    cells.push(new Date(first.getFullYear(), first.getMonth(), day));
  while (cells.length % 7) cells.push(null);
  return cells;
}
function formatDate(value) {
  if (!value) return "Not set";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00+08:00`)
    : new Date(value);
  return date.toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function formatDateTime(value) {
  if (!value) return "Not recorded";
  const raw = String(value);
  const date = new Date(
    raw.includes("T") ? raw : `${raw.replace(" ", "T")}+08:00`,
  );
  return date.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function formatTime(value) {
  if (!value) return "Not set";
  const raw = String(value);
  if (raw.includes("T") || raw.includes(" ")) {
    const match = raw.match(/[T ](\d{2}):(\d{2})/);
    if (match) {
      const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
      return date.toLocaleTimeString("en-PH", {
        hour: "numeric",
        minute: "2-digit",
      });
    }
  }
  const [hour, minute] = raw.slice(0, 5).split(":").map(Number);
  return new Date(2000, 0, 1, hour || 0, minute || 0).toLocaleTimeString(
    "en-PH",
    { hour: "numeric", minute: "2-digit" },
  );
}
function timestampMinute(value) {
  return String(value || "")
    .trim()
    .replace(" ", "T")
    .slice(0, 16);
}
function fullName(row) {
  return (
    [row?.first_name, row?.middle_name, row?.last_name, row?.suffix]
      .filter(Boolean)
      .join(" ") || "Unknown donor"
  );
}
function appointmentName(row) {
  return fullName(row?.profile) !== "Unknown donor"
    ? fullName(row.profile)
    : row?.Contact_Name || "Unknown donor";
}
function appointmentStatus(row) {
  const quality = String(row?.detail?.Status || "").trim();
  if (quality && quality.toLowerCase() !== "pending") return quality;
  return ["Confirmed", "Rescheduled"].includes(row?.Status)
    ? "Going"
    : row?.Status || "Unknown";
}
function appointmentReviewDraft(row) {
  const detail = row?.detail || {};
  const hair = row?.Hair_Details || {};
  return {
    declaredLength: detail.Declared_Length ?? hair.declaredLength ?? "",
    declaredColor: detail.Declared_Color || hair.declaredColor || "",
    declaredTexture: detail.Declared_Texture || hair.declaredTexture || "",
    declaredDensity: detail.Declared_Density || hair.declaredDensity || "",
    declaredCondition:
      detail.Declared_Condition || hair.declaredCondition || "",
    isChemicallyTreated: Boolean(
      detail.Is_Chemically_Treated ?? hair.isChemicallyTreated,
    ),
    isColored: Boolean(detail.Is_Colored ?? hair.isColored),
    isBleached: Boolean(detail.Is_Bleached ?? hair.isBleached),
    isRebonded: Boolean(detail.Is_Rebonded ?? hair.isRebonded),
    detailNotes: detail.Detail_Notes || hair.detailNotes || "",
  };
}
function routeKind(row) {
  const key = String(row?.Logistics_Type || "")
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (["courier", "shipbycourier"].includes(key)) return "Courier";
  if (["dropoff", "salondropoff", "walkindropoff"].includes(key))
    return "Drop-off";
  return "";
}
function receivingStatus(row) {
  if (routeKind(row) === "Courier") {
    const key = String(row?.Shipment_Status || "")
      .toLowerCase()
      .replace(/[_\s-]+/g, "");
    if (
      row?.Received_At ||
      ["received", "completed", "delivered"].includes(key)
    )
      return "Received";
    if (key === "noshow") return "No Show";
    if (["cancelled", "canceled"].includes(key)) return "Cancelled";
    return "Expected";
  }
  const status = String(row?.Dropoff_Status || "Expected").trim();
  if (status === "Completed") return "Received";
  return status;
}
function receivingStatusLabel(status) {
  return status === "No Show" ? "Not Received" : status;
}
function colorWithAlpha(color, alpha = 0.12) {
  const value = String(color || "").trim();
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) return value;
  const raw = match[1];
  return `rgba(${parseInt(raw.slice(0, 2), 16)}, ${parseInt(raw.slice(2, 4), 16)}, ${parseInt(raw.slice(4, 6), 16)}, ${alpha})`;
}
function address(row) {
  return row
    ? [
        row.Destination_Name,
        row.Street,
        row.Barangay,
        row.City,
        row.Province,
        row.Region,
        row.Country,
      ]
        .filter(Boolean)
        .join(", ")
    : "Salon address has not been configured.";
}
function compactAddress(row) {
  if (!row) return "Location not configured";
  const place = row.Destination_Name || "Main Office";
  const locality = [row.City, row.Province].filter(Boolean).join(", ");
  return [place, locality].filter(Boolean).join(" · ");
}
function expectedArrivalLabel(row) {
  if (!row?.Expected_Dropoff_Date && !row?.Expected_Arrival_Time)
    return "Not set";
  return [
    row?.Expected_Dropoff_Date ? formatDate(row.Expected_Dropoff_Date) : null,
    row?.Expected_Arrival_Time ? formatTime(row.Expected_Arrival_Time) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
function receivingTimeline(row) {
  if (!row) return [];
  const status = receivingStatus(row);
  const receivedAt = row.Completed_At || row.Received_At;
  const submissionStatus = String(row.submission?.Status || "").trim();
  const submissionKey = submissionStatus
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const qualityDone = [
    "approved",
    "accepted",
    "hairaccepted",
    "qualityapproved",
    "forbundling",
    "bundled",
    "inproduction",
    "wigcreated",
    "wigcompleted",
  ].some((key) => submissionKey.includes(key));
  const completed = [
    "bundled",
    "inproduction",
    "wigcreated",
    "wigcompleted",
  ].some((key) => submissionKey.includes(key));
  const stages = [
    {
      label: "Expected Arrival",
      detail: expectedArrivalLabel(row),
      done: ["Checked In", "Received"].includes(status),
    },
    {
      label: "Checked In",
      detail: row.Checked_In_At ? formatDateTime(row.Checked_In_At) : "—",
      done: Boolean(row.Checked_In_At),
    },
    {
      label: "Hair Received",
      detail: receivedAt ? formatDateTime(receivedAt) : "—",
      done: Boolean(receivedAt),
    },
    {
      label: "Quality Check",
      detail: qualityDone
        ? submissionStatus
        : receivedAt
          ? "Waiting for Specialist"
          : "—",
      done: qualityDone,
    },
    {
      label: "Completed",
      detail: completed ? submissionStatus : "—",
      done: completed,
    },
  ];
  let currentAssigned = false;
  return stages.map((stage) => {
    const current =
      !["Cancelled", "No Show"].includes(status) &&
      !stage.done &&
      !currentAssigned;
    if (current) currentAssigned = true;
    return { ...stage, current };
  });
}

export default function SalonSchedulePage({ isActivePage = true }) {
  const { theme } = useTheme();
  const { showToast } = useToast();
  const primaryColor = theme?.primaryColor || "#7c2d12";
  const primaryColorDark = theme?.primaryColorDark || primaryColor;
  const secondaryColor = theme?.secondaryColor || primaryColor;
  const secondaryColorDark = theme?.secondaryColorDark || secondaryColor;
  const tertiaryColor = theme?.tertiaryColor || primaryColor;
  const tertiaryColorDark = theme?.tertiaryColorDark || tertiaryColor;
  const primaryTextColor = theme?.primaryTextColor || "#0f172a";
  const secondaryTextColor = theme?.secondaryTextColor || "#64748b";
  const headingFont =
    theme?.secondaryFontFamily || theme?.fontFamily || "Poppins";
  const statusTone = (status) => {
    let accent = secondaryColor;
    if (["Expected", "Going"].includes(status)) accent = primaryColor;
    if (status === "Checked In") accent = secondaryColorDark;
    if (["Completed", "Received", "Approved"].includes(status))
      accent = tertiaryColorDark;
    if (["Cancelled", "No Show", "Rejected", "Rejected Cut"].includes(status))
      accent = primaryColorDark;
    return {
      borderColor: colorWithAlpha(accent, 0.34),
      backgroundColor: colorWithAlpha(accent, 0.1),
      color: accent,
    };
  };
  const [tab, setTab] = useState("calendar");
  const [rows, setRows] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(startOfMonth(new Date()));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(
    dateKey(new Date()),
  );
  const [hours, setHours] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [office, setOffice] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("Expected");
  const [queuePage, setQueuePage] = useState(1);
  const [dateFilter, setDateFilter] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [notes, setNotes] = useState("");
  const [overrideDraft, setOverrideDraft] = useState(EMPTY_OVERRIDE);
  const [notice, setNotice] = useState({ kind: "", text: "" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scannerCode, setScannerCode] = useState("");
  const [selectedAppointmentId, setSelectedAppointmentId] = useState(null);
  const [appointmentReview, setAppointmentReview] = useState(
    EMPTY_APPOINTMENT_REVIEW,
  );
  const [appointmentRejectionReason, setAppointmentRejectionReason] =
    useState("");
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const scanBusyRef = useRef(false);
  const lastScanRef = useRef({ value: "", at: 0 });
  const calendarMonthStart = dateKey(startOfMonth(calendarMonth));
  const calendarMonthEnd = dateKey(addMonths(startOfMonth(calendarMonth), 1));

  useEffect(() => {
    if (!notice.text) return;
    showToast({
      type: notice.kind === "error" ? "error" : "success",
      title:
        notice.kind === "error" ? "Action not completed" : "Receiving updated",
      message: notice.text,
    });
    setNotice({ kind: "", text: "" });
  }, [notice, showToast]);

  const loadPage = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setLoading(true);
    try {
      const [lr, appointmentsResult, hr, or, officeResult] = await Promise.all([
        supabase
          .from(LOGISTICS_TABLE)
          .select("*")
          .order("Created_At", { ascending: false }),
        supabase
          .from(APPOINTMENTS_TABLE)
          .select("*")
          .gte("Appointment_Start_At", `${calendarMonthStart}T00:00:00`)
          .lt("Appointment_Start_At", `${calendarMonthEnd}T00:00:00`)
          .order("Appointment_Start_At", { ascending: true }),
        supabase.from(HOURS_TABLE).select("*").order("Day_Group"),
        supabase
          .from(OVERRIDES_TABLE)
          .select("*")
          .gte("Override_Date", dateKey(new Date(Date.now() - 31 * 86400000)))
          .order("Override_Date"),
        supabase.from("Logistics_Settings").select("*").limit(1).maybeSingle(),
      ]);
      if (lr.error) throw lr.error;
      if (appointmentsResult.error) throw appointmentsResult.error;
      if (hr.error) throw hr.error;
      if (or.error) throw or.error;
      if (officeResult.error) throw officeResult.error;
      const logisticsRows = (lr.data || []).filter((row) =>
        Boolean(routeKind(row)),
      );
      const logisticsSubmissionIds = [...new Set(
        logisticsRows.map((row) => row.Submission_ID).filter(Boolean),
      )];
      const appointmentLinkResults = await Promise.all(
        Array.from({ length: Math.ceil(logisticsSubmissionIds.length / 200) }, (_, index) =>
          supabase
            .from(APPOINTMENTS_TABLE)
            .select("Hair_Submission_ID")
            .in("Hair_Submission_ID", logisticsSubmissionIds.slice(index * 200, (index + 1) * 200)),
        ),
      );
      for (const result of appointmentLinkResults) {
        if (result.error) throw result.error;
      }
      const appointmentRows = appointmentsResult.data || [];
      const appointmentSubmissionIds = appointmentRows
        .map((row) => row.Hair_Submission_ID)
        .filter(Boolean);
      const appointmentSubmissionSet = new Set(
        appointmentLinkResults.flatMap((result) => result.data || [])
          .map((row) => Number(row.Hair_Submission_ID))
          .filter(Boolean),
      );
      const ids = [
        ...new Set(
          [
            ...logisticsRows.map((row) => row.Submission_ID),
            ...appointmentSubmissionIds,
          ].filter(Boolean),
        ),
      ];
      let submissions = [];
      if (ids.length) {
        const result = await supabase
          .from(SUBMISSIONS_TABLE)
          .select(
            "Submission_ID,User_ID,Status,Waybill_Code,Created_At,Donor_Notes,From_Event",
          )
          .in("Submission_ID", ids)
          .eq("From_Event", false);
        if (result.error) throw result.error;
        submissions = result.data || [];
      }
      const submissionById = Object.fromEntries(
        submissions.map((row) => [row.Submission_ID, row]),
      );
      let appointmentDetailsBySubmissionId = {};
      if (appointmentSubmissionIds.length) {
        const detailResult = await supabase
          .from("Hair_Submission_Details")
          .select("*")
          .in("Submission_ID", appointmentSubmissionIds);
        if (detailResult.error) throw detailResult.error;
        appointmentDetailsBySubmissionId = Object.fromEntries(
          (detailResult.data || []).map((row) => [row.Submission_ID, row]),
        );
      }
      const userIds = [
        ...new Set(
          [
            ...submissions.map((row) => row.User_ID),
            ...appointmentRows.map((row) => row.User_ID),
          ].filter(Boolean),
        ),
      ];
      let usersById = {};
      let detailsById = {};
      if (userIds.length) {
        const [ur, dr] = await Promise.all([
          supabase.from("users").select("user_id,email").in("user_id", userIds),
          supabase
            .from("user_details")
            .select(
              "user_id,first_name,middle_name,last_name,suffix,contact_number",
            )
            .in("user_id", userIds),
        ]);
        if (ur.error) throw ur.error;
        if (dr.error) throw dr.error;
        usersById = Object.fromEntries(
          (ur.data || []).map((row) => [row.user_id, row]),
        );
        detailsById = Object.fromEntries(
          (dr.data || []).map((row) => [row.user_id, row]),
        );
      }
      const enriched = logisticsRows
        .map((logistics) => {
          const submission = submissionById[logistics.Submission_ID] || {};
          return {
            ...logistics,
            submission,
            account: usersById[submission.User_ID],
            profile: detailsById[submission.User_ID],
          };
        })
        .filter(
          (row) =>
            row.submission?.Submission_ID &&
            !appointmentSubmissionSet.has(Number(row.Submission_ID)),
        );
      setRows(enriched);
      setAppointments(
        appointmentRows.map((appointment) => ({
          ...appointment,
          account: usersById[appointment.User_ID] || null,
          profile: detailsById[appointment.User_ID] || null,
          submission: submissionById[appointment.Hair_Submission_ID] || null,
          detail:
            appointmentDetailsBySubmissionId[appointment.Hair_Submission_ID] ||
            null,
        })),
      );
      setHours(
        (hr.data || []).map((row) => ({
          ...row,
          Opening_Time: String(row.Opening_Time || "").slice(0, 5),
          Closing_Time: String(row.Closing_Time || "").slice(0, 5),
          Break_Start_Time: String(row.Break_Start_Time || "").slice(0, 5),
          Break_End_Time: String(row.Break_End_Time || "").slice(0, 5),
        })),
      );
      setOverrides(or.data || []);
      setOffice(officeResult.data || null);
      setSelectedId((previous) =>
        enriched.some((row) => row.Submission_ID === previous)
          ? previous
          : enriched[0]?.Submission_ID || null,
      );
      setSelectedAppointmentId((previous) =>
        appointmentRows.some((row) => row.Appointment_ID === previous)
          ? previous
          : null,
      );
    } catch (error) {
      setNotice({
        kind: "error",
        text: error?.message || "Unable to load expected walk-ins.",
      });
    } finally {
      setLoading(false);
    }
  }, [calendarMonthEnd, calendarMonthStart]);

  const loadSlots = useCallback(async (targetDate) => {
    if (!supabase || !targetDate) {
      setSlots([]);
      return;
    }
    setSlotsLoading(true);
    try {
      const { data, error } = await supabase.rpc("get_salon_available_slots", {
        p_from_date: targetDate,
        p_to_date: targetDate,
      });
      if (error) throw error;
      setSlots(data || []);
    } catch (error) {
      setSlots([]);
      setNotice({
        kind: "error",
        text: error?.message || "Unable to load appointment times.",
      });
    } finally {
      setSlotsLoading(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraOn(false);
  }, []);

  useEffect(() => {
    void loadPage();
    return () => stopCamera();
  }, [loadPage, stopCamera]);
  useEffect(() => {
    if (tab === "calendar") void loadSlots(selectedCalendarDate);
  }, [loadSlots, selectedCalendarDate, tab]);
  useEffect(() => {
    if (!isActivePage || !supabase) return undefined;
    const channel = supabase
      .channel("salon-expected-arrivals-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: LOGISTICS_TABLE },
        () => void loadPage(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: APPOINTMENTS_TABLE },
        () => void loadPage(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: SUBMISSIONS_TABLE },
        () => void loadPage(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isActivePage, loadPage]);

  const counts = useMemo(
    () =>
      rows.reduce((map, row) => {
        const status = receivingStatus(row);
        return { ...map, [status]: (map[status] || 0) + 1 };
      }, {}),
    [rows],
  );
  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        const status = receivingStatus(row);
        if (
          statusFilter === "Active" &&
          !["Expected", "Checked In"].includes(status)
        )
          return false;
        if (
          !["All", "Active"].includes(statusFilter) &&
          status !== statusFilter
        )
          return false;
        if (dateFilter && row.Expected_Dropoff_Date !== dateFilter)
          return false;
        return `${fullName(row.profile)} ${row.account?.email || ""} ${row.submission.Waybill_Code || ""} ${row.Submission_ID} ${routeKind(row)}`
          .toLowerCase()
          .includes(query.toLowerCase().trim());
      }),
    [rows, statusFilter, dateFilter, query],
  );
  const queuePageSize = 5;
  const queuePageCount = Math.max(1, Math.ceil(filtered.length / queuePageSize));
  const visibleQueue = useMemo(
    () => filtered.slice(
      (Math.min(queuePage, queuePageCount) - 1) * queuePageSize,
      Math.min(queuePage, queuePageCount) * queuePageSize,
    ),
    [filtered, queuePage, queuePageCount],
  );
  useEffect(() => {
    setQueuePage(1);
  }, [statusFilter, dateFilter, query]);
  useEffect(() => {
    setQueuePage((previous) => Math.min(previous, queuePageCount));
  }, [queuePageCount]);
  useEffect(() => {
    setSelectedId((previous) =>
      visibleQueue.some((row) => row.Submission_ID === previous)
        ? previous
        : visibleQueue[0]?.Submission_ID || null,
    );
  }, [visibleQueue]);
  const selected =
    visibleQueue.find((row) => row.Submission_ID === selectedId) || null;
  const selectedReceivingStatus = selected ? receivingStatus(selected) : "";
  const selectedRoute = selected ? routeKind(selected) : "";
  const selectedReceivingFinal = ["Received", "Cancelled", "No Show"].includes(
    selectedReceivingStatus,
  );
  const appointmentsByDate = useMemo(
    () =>
      appointments.reduce((map, row) => {
        const key = dateKey(row.Appointment_Start_At);
        if (!map[key]) map[key] = [];
        map[key].push(row);
        return map;
      }, {}),
    [appointments],
  );
  const selectedDayAppointments =
    appointmentsByDate[selectedCalendarDate] || [];
  const selectedDayOverride = overrides.find(
    (row) => row.Override_Date === selectedCalendarDate,
  );
  const appointmentsOutsideCurrentSlots = selectedDayAppointments.filter(
    (appointment) =>
      !slots.some(
        (slot) =>
          timestampMinute(slot.Slot_Start_At) ===
          timestampMinute(appointment.Appointment_Start_At),
      ),
  );
  const selectedAppointment =
    appointments.find((row) => row.Appointment_ID === selectedAppointmentId) ||
    null;
  const selectedAppointmentFinal = [
    "approved",
    "rejected",
    "rejectedcut",
  ].includes(
    String(selectedAppointment?.detail?.Status || "")
      .toLowerCase()
      .replace(/[^a-z]/g, ""),
  );
  const calendarCells = useMemo(
    () => buildMonthCells(calendarMonth),
    [calendarMonth],
  );
  const moveCalendarMonth = (amount) => {
    const nextMonth = addMonths(calendarMonth, amount);
    setCalendarMonth(nextMonth);
    setSelectedCalendarDate(dateKey(nextMonth));
  };

  useEffect(() => {
    setAppointmentReview(
      selectedAppointment
        ? appointmentReviewDraft(selectedAppointment)
        : EMPTY_APPOINTMENT_REVIEW,
    );
    setAppointmentRejectionReason(
      selectedAppointment?.detail?.Rejection_Reason || "",
    );
  }, [selectedAppointment]);

  const receiveScannedWaybill = useCallback(
    async (rawValue) => {
      if (!supabase || scanBusyRef.current) return;
      const parsed = parseWaybillQrPayload(String(rawValue || ""));
      const waybill = normalizeWaybillCodeInput(
        parsed?.waybillCode || rawValue,
      );
      if (!isValidWaybillCode(waybill)) {
        setNotice({
          kind: "error",
          text: "Scan a complete Hair Submissions waybill: WB followed by 6 letters or numbers.",
        });
        return;
      }
      scanBusyRef.current = true;
      setSaving(true);
      try {
        const { data, error } = await supabase.rpc(
          "staff_receive_non_event_hair_by_waybill",
          {
            p_waybill_code: waybill,
            p_note: notes.trim() || null,
          },
        );
        if (error) throw error;
        const submissionId = Number(data?.submission?.Submission_ID || 0);
        setScannerCode("");
        stopCamera();
        setNotice({
          kind: "success",
          text: `${data?.route || "Donation"} ${waybill} received. It is now waiting for Specialist Quality Check.`,
        });
        await loadPage();
        if (submissionId) setSelectedId(submissionId);
      } catch (error) {
        setNotice({
          kind: "error",
          text: error?.message || "Unable to receive this waybill.",
        });
      } finally {
        setSaving(false);
        scanBusyRef.current = false;
      }
    },
    [loadPage, notes, stopCamera],
  );

  const openAppointmentByWaybill = useCallback(
    async (rawValue) => {
      if (!supabase || scanBusyRef.current) return;
      const parsed = parseWaybillQrPayload(String(rawValue || ""));
      const waybill = normalizeWaybillCodeInput(
        parsed?.waybillCode || rawValue,
      );
      if (!isValidWaybillCode(waybill)) {
        setNotice({
          kind: "error",
          text: "Enter the complete WB + 6-character appointment waybill.",
        });
        return;
      }
      scanBusyRef.current = true;
      setSaving(true);
      try {
        const submissionResult = await supabase
          .from(SUBMISSIONS_TABLE)
          .select("Submission_ID")
          .eq("Waybill_Code", waybill)
          .maybeSingle();
        if (submissionResult.error) throw submissionResult.error;
        if (!submissionResult.data?.Submission_ID)
          throw new Error(`No hair submission uses waybill ${waybill}.`);
        const appointmentResult = await supabase
          .from(APPOINTMENTS_TABLE)
          .select("Appointment_ID,Appointment_Start_At,Status")
          .eq("Hair_Submission_ID", submissionResult.data.Submission_ID)
          .maybeSingle();
        if (appointmentResult.error) throw appointmentResult.error;
        if (!appointmentResult.data?.Appointment_ID)
          throw new Error(
            `${waybill} is a courier/drop-off donation, not a booked salon appointment.`,
          );
        const appointmentDate = parseDateKey(
          dateKey(appointmentResult.data.Appointment_Start_At),
        );
        setCalendarMonth(startOfMonth(appointmentDate));
        setSelectedCalendarDate(
          dateKey(appointmentResult.data.Appointment_Start_At),
        );
        setSelectedAppointmentId(appointmentResult.data.Appointment_ID);
        setScannerCode("");
        stopCamera();
        setNotice({
          kind: "success",
          text: `Appointment ${waybill} is ready for review.`,
        });
      } catch (error) {
        setNotice({
          kind: "error",
          text: error?.message || "Unable to find this appointment waybill.",
        });
      } finally {
        setSaving(false);
        scanBusyRef.current = false;
      }
    },
    [stopCamera],
  );

  const processScannedWaybill = useCallback(
    (rawValue) =>
      tab === "calendar"
        ? openAppointmentByWaybill(rawValue)
        : receiveScannedWaybill(rawValue),
    [openAppointmentByWaybill, receiveScannedWaybill, tab],
  );

  const toggleCamera = async () => {
    if (isCameraOn) {
      stopCamera();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice({
        kind: "error",
        text: "Camera scanning is unavailable in this browser. Enter the waybill manually.",
      });
      return;
    }
    setIsStartingCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }
      setIsCameraOn(true);
    } catch (error) {
      setNotice({
        kind: "error",
        text: error?.message || "Camera access failed.",
      });
      stopCamera();
    } finally {
      setIsStartingCamera(false);
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!isCameraOn || !video || !stream) return;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => {
      setNotice({
        kind: "error",
        text: "The camera opened but its preview could not start. Please close it and try again.",
      });
    });
  }, [isCameraOn]);

  useEffect(() => {
    if (!isCameraOn) return undefined;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || scanBusyRef.current) return;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      const canvas = canvasRef.current || document.createElement("canvas");
      canvasRef.current = canvas;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      const decoded = String(
        jsQR(image.data, width, height, { inversionAttempts: "attemptBoth" })
          ?.data || "",
      ).trim();
      if (!decoded) return;
      const now = Date.now();
      if (
        lastScanRef.current.value === decoded &&
        now - lastScanRef.current.at < 2500
      )
        return;
      lastScanRef.current = { value: decoded, at: now };
      void processScannedWaybill(decoded);
    }, 250);
    return () => window.clearInterval(timer);
  }, [isCameraOn, processScannedWaybill]);

  const reviewAppointmentHair = async (decision) => {
    if (!selectedAppointment || !supabase || selectedAppointmentFinal) return;
    if (
      ["Rejected", "Rejected Cut"].includes(decision) &&
      !appointmentRejectionReason.trim()
    ) {
      setNotice({
        kind: "error",
        text: "Enter a reason before rejecting the hair.",
      });
      return;
    }
    const length = String(appointmentReview.declaredLength ?? "").trim();
    if (
      length &&
      (!Number.isFinite(Number(length)) ||
        Number(length) <= 0 ||
        Number(length) > 999.99)
    ) {
      setNotice({
        kind: "error",
        text: "Hair length must be greater than 0 and no more than 999.99 inches.",
      });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc(
        "staff_review_salon_appointment_hair",
        {
          p_appointment_id: selectedAppointment.Appointment_ID,
          p_decision: decision,
          p_rejection_reason: appointmentRejectionReason.trim() || null,
          p_detail_updates: {
            ...appointmentReview,
            declaredLength: length ? Number(length) : null,
          },
        },
      );
      if (error) throw error;
      setNotice({
        kind: "success",
        text:
          decision === "Approved"
            ? "Appointment hair approved and added to cut-hair inventory."
            : `Appointment hair marked ${decision}.`,
      });
      await loadPage();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error?.message || "Unable to save this appointment review.",
      });
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action) => {
    if (!selected || !supabase) return;
    if (["cancel", "no_show"].includes(action) && !notes.trim()) {
      setNotice({
        kind: "error",
        text: "Enter a reason before cancelling or marking Not Received.",
      });
      return;
    }
    if (
      action === "cancel" &&
      !window.confirm(
        "Cancel this expected drop-off? This is final and cannot be reopened.",
      )
    )
      return;
    if (
      action === "no_show" &&
      !window.confirm(
        `Mark ${fullName(selected.profile)}'s donation (${selected.submission.Waybill_Code || `#${selected.Submission_ID}`}) as Not Received? This is final and cannot be reopened.`,
      )
    )
      return;
    setSaving(true);
    try {
      const { error } = action === "no_show" && selectedRoute === "Courier"
        ? await supabase.rpc("staff_mark_courier_hair_not_received", {
            p_submission_id: selected.Submission_ID,
            p_reason: notes.trim(),
          })
        : await supabase.rpc("staff_update_walk_in_donation", {
            p_submission_id: selected.Submission_ID,
            p_action: action,
            p_notes: notes.trim() || null,
          });
      if (error) throw error;
      setNotice({
        kind: "success",
        text:
          action === "complete"
            ? "Receiving completed. The hair can now move to its separate quality review."
            : "Walk-in status updated.",
      });
      setNotes("");
      await loadPage();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error?.message || "Unable to update this walk-in.",
      });
    } finally {
      setSaving(false);
    }
  };
  const updateHour = (id, field, value) =>
    setHours((old) =>
      old.map((row) =>
        row.Operating_Hours_ID === id ? { ...row, [field]: value } : row,
      ),
    );
  const saveHours = async () => {
    for (const row of hours) {
      const breakStart = row.Break_Start_Time || null;
      const breakEnd = row.Break_End_Time || null;
      if (Boolean(breakStart) !== Boolean(breakEnd)) {
        setNotice({ kind: "error", text: `${row.Day_Group}: set both break times, or clear both.` });
        return;
      }
      if (breakStart && (breakStart < row.Opening_Time || breakEnd > row.Closing_Time || breakStart >= breakEnd)) {
        setNotice({ kind: "error", text: `${row.Day_Group}: the break must be within opening hours, with its end after its start.` });
        return;
      }
    }
    setSaving(true);
    try {
      for (const row of hours) {
        const { data, error } = await supabase
          .from(HOURS_TABLE)
          .update({
            Is_Open: Boolean(row.Is_Open),
            Opening_Time: row.Opening_Time,
            Closing_Time: row.Closing_Time,
            Break_Start_Time: row.Break_Start_Time || null,
            Break_End_Time: row.Break_End_Time || null,
            Appointment_Duration_Minutes: Number(
              row.Appointment_Duration_Minutes || 60,
            ),
            Buffer_Minutes: Number(row.Buffer_Minutes || 0),
            Late_Grace_Minutes: Number(row.Late_Grace_Minutes || 0),
            Capacity_Per_Slot: Number(row.Capacity_Per_Slot || 1),
            Minimum_Booking_Notice_Days: Number(
              row.Minimum_Booking_Notice_Days || 0,
            ),
            Maximum_Booking_Days: Number(row.Maximum_Booking_Days || 30),
          })
          .eq("Operating_Hours_ID", row.Operating_Hours_ID)
          .select("Operating_Hours_ID");
        if (error) throw error;
        if (!data?.length) throw new Error(`Could not save ${row.Day_Group} hours. Check staff access and try again.`);
      }
      setNotice({
        kind: "success",
        text: "Receiving hours and allowed date range saved.",
      });
      await loadPage();
      await loadSlots(selectedCalendarDate);
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };
  const saveOverride = async () => {
    if (!overrideDraft.date) {
      setNotice({ kind: "error", text: "Select an override date." });
      return;
    }
    if (!overrideDraft.isClosed) {
      const { openingTime, closingTime, breakStartTime, breakEndTime } = overrideDraft;
      if (!openingTime || !closingTime || openingTime >= closingTime) {
        setNotice({ kind: "error", text: "Set valid opening and closing times for special hours." });
        return;
      }
      if (Boolean(breakStartTime) !== Boolean(breakEndTime)) {
        setNotice({ kind: "error", text: "Set both special-hours break times, or clear both." });
        return;
      }
      if (breakStartTime && (breakStartTime < openingTime || breakEndTime > closingTime || breakStartTime >= breakEndTime)) {
        setNotice({ kind: "error", text: "The special-hours break must be within opening hours, with its end after its start." });
        return;
      }
    }
    setSaving(true);
    try {
      const { data, error } = await supabase.from(OVERRIDES_TABLE).upsert(
        {
          Override_Date: overrideDraft.date,
          Is_Closed: overrideDraft.isClosed,
          Opening_Time: overrideDraft.isClosed
            ? null
            : overrideDraft.openingTime,
          Closing_Time: overrideDraft.isClosed
            ? null
            : overrideDraft.closingTime,
          Break_Start_Time: overrideDraft.isClosed
            ? null
            : overrideDraft.breakStartTime || null,
          Break_End_Time: overrideDraft.isClosed
            ? null
            : overrideDraft.breakEndTime || null,
          Capacity_Per_Slot:
            overrideDraft.isClosed || !overrideDraft.capacity
              ? null
              : Number(overrideDraft.capacity),
          Reason: overrideDraft.reason.trim() || null,
        },
        { onConflict: "Override_Date" },
      ).select("Schedule_Override_ID");
      if (error) throw error;
      if (!data?.length) throw new Error("Could not save these special hours. Check staff access and try again.");
      setOverrideDraft(EMPTY_OVERRIDE);
      setNotice({ kind: "success", text: "Date override saved." });
      await loadPage();
      await loadSlots(selectedCalendarDate);
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const deleteOverride = async (overrideId) => {
    if (!supabase || !overrideId) return;
    if (
      !window.confirm(
        "Remove this date override and restore the regular schedule?",
      )
    )
      return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from(OVERRIDES_TABLE)
        .delete()
        .eq("Schedule_Override_ID", overrideId);
      if (error) throw error;
      setNotice({ kind: "success", text: "Date override removed." });
      await loadPage();
      await loadSlots(selectedCalendarDate);
    } catch (error) {
      setNotice({
        kind: "error",
        text: error?.message || "Unable to remove this date override.",
      });
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500";
  const appointmentReviewPanel = selectedAppointment ? (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Appointment review
          </p>
          <h2 className="mt-1 text-lg font-bold text-slate-900">
            {appointmentName(selectedAppointment)}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {formatDateTime(selectedAppointment.Appointment_Start_At)} ·{" "}
            <span className="font-mono">
              {selectedAppointment.submission?.Waybill_Code || "No waybill"}
            </span>
          </p>
        </div>
        <span
          className="rounded-full border px-3 py-1 text-xs font-semibold"
          style={statusTone(appointmentStatus(selectedAppointment))}
        >
          {appointmentStatus(selectedAppointment)}
        </span>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-3 rounded-xl bg-slate-50 p-4 text-sm">
          <div>
            <p className="text-xs font-semibold text-slate-400">Contact</p>
            <p className="mt-1 font-medium text-slate-800">
              {selectedAppointment.Contact_Number ||
                selectedAppointment.profile?.contact_number ||
                "Not provided"}
            </p>
            <p className="text-slate-500">
              {selectedAppointment.Contact_Email ||
                selectedAppointment.account?.email ||
                "No email"}
            </p>
          </div>
          {selectedAppointment.Donor_Notes ? (
            <div>
              <p className="text-xs font-semibold text-slate-400">Donor note</p>
              <p className="mt-1 text-slate-700">
                {selectedAppointment.Donor_Notes}
              </p>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-semibold text-slate-400">Workflow</p>
            <p className="mt-1 text-slate-700">
              Review the cut hair received during this appointment.
            </p>
          </div>
        </div>
        <div>
          <h3 className="font-semibold text-slate-900">Hair details</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Confirm or correct the donor's values before making a decision.
          </p>
          <fieldset
            disabled={saving || selectedAppointmentFinal}
            className="mt-4 grid gap-3 md:grid-cols-2"
          >
            <label className="text-xs font-semibold text-slate-600">
              Length (in)
              <input
                type="number"
                min="0.01"
                max="999.99"
                step="0.01"
                value={appointmentReview.declaredLength}
                onChange={(event) =>
                  setAppointmentReview((old) => ({
                    ...old,
                    declaredLength: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1`}
              />
            </label>
            <label className="text-xs font-semibold text-slate-600">
              Color
              <select
                value={appointmentReview.declaredColor}
                onChange={(event) =>
                  setAppointmentReview((old) => ({
                    ...old,
                    declaredColor: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1`}
              >
                <option value="">Select color</option>
                {appointmentReview.declaredColor &&
                !HAIR_COLORS.includes(appointmentReview.declaredColor) ? (
                  <option>{appointmentReview.declaredColor}</option>
                ) : null}
                {HAIR_COLORS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-600">
              Pattern
              <select
                value={appointmentReview.declaredTexture}
                onChange={(event) =>
                  setAppointmentReview((old) => ({
                    ...old,
                    declaredTexture: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1`}
              >
                <option value="">Select pattern</option>
                {appointmentReview.declaredTexture &&
                !HAIR_PATTERNS.includes(appointmentReview.declaredTexture) ? (
                  <option>{appointmentReview.declaredTexture}</option>
                ) : null}
                {HAIR_PATTERNS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-600">
              Density
              <select
                value={appointmentReview.declaredDensity}
                onChange={(event) =>
                  setAppointmentReview((old) => ({
                    ...old,
                    declaredDensity: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1`}
              >
                <option value="">Select density</option>
                {appointmentReview.declaredDensity &&
                !HAIR_DENSITIES.includes(appointmentReview.declaredDensity) ? (
                  <option>{appointmentReview.declaredDensity}</option>
                ) : null}
                {HAIR_DENSITIES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-600 md:col-span-2">
              Condition
              <select
                value={appointmentReview.declaredCondition}
                onChange={(event) =>
                  setAppointmentReview((old) => ({
                    ...old,
                    declaredCondition: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1`}
              >
                <option value="">Select condition</option>
                {appointmentReview.declaredCondition &&
                !HAIR_CONDITIONS.includes(
                  appointmentReview.declaredCondition,
                ) ? (
                  <option>{appointmentReview.declaredCondition}</option>
                ) : null}
                {HAIR_CONDITIONS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <div className="md:col-span-2">
              <p className="text-xs font-semibold text-slate-600">Treatment</p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["isChemicallyTreated", "Chemically treated"],
                  ["isColored", "Colored"],
                  ["isBleached", "Bleached"],
                  ["isRebonded", "Rebonded"],
                ].map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700"
                  >
                    <input
                      type="checkbox"
                      checked={appointmentReview[key]}
                      onChange={(event) =>
                        setAppointmentReview((old) => ({
                          ...old,
                          [key]: event.target.checked,
                        }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <label className="text-xs font-semibold text-slate-600 md:col-span-2">
              Notes
              <textarea
                rows={2}
                value={appointmentReview.detailNotes}
                onChange={(event) =>
                  setAppointmentReview((old) => ({
                    ...old,
                    detailNotes: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1`}
              />
            </label>
            {!selectedAppointmentFinal ? (
              <label className="text-xs font-semibold text-slate-600 md:col-span-2">
                Rejection reason{" "}
                <span className="font-normal text-slate-400">
                  (required only for rejected decisions)
                </span>
                <textarea
                  rows={2}
                  value={appointmentRejectionReason}
                  onChange={(event) =>
                    setAppointmentRejectionReason(event.target.value)
                  }
                  className={`${inputClass} mt-1`}
                />
              </label>
            ) : null}
          </fieldset>
          {!selectedAppointmentFinal ? (
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
              <button
                disabled={saving}
                onClick={() => void reviewAppointmentHair("Rejected")}
                className="rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={statusTone("Rejected")}
              >
                Reject
              </button>
              <button
                disabled={saving}
                onClick={() => void reviewAppointmentHair("Rejected Cut")}
                className="rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={statusTone("Checked In")}
              >
                Rejected Cut
              </button>
              <button
                disabled={saving}
                onClick={() => void reviewAppointmentHair("Approved")}
                className="rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: tertiaryColor }}
              >
                Approve & add to inventory
              </button>
            </div>
          ) : (
            <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
              This review is final. Approved hair is already in cut-hair
              inventory.
            </p>
          )}
        </div>
      </div>
    </section>
  ) : (
    <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
      Select an appointment or scan its waybill to review the hair.
    </p>
  );

  return (
    <div
      className={`min-w-0 space-y-3 ${["settings", "arrivals"].includes(tab) ? "lg:flex lg:h-full lg:flex-col lg:gap-3 lg:space-y-0 lg:overflow-hidden" : ""}`}
      style={{ color: primaryTextColor }}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <h1
            className="role-page-title text-xl font-bold sm:text-2xl"
            style={{ fontFamily: `${headingFont}, sans-serif` }}
          >
            Receiving Schedule
          </h1>
          <p
            title={address(office)}
            className="flex items-center gap-1 text-xs"
            style={{ color: secondaryTextColor }}
          >
            <MapPin size={12} className="shrink-0" />
            {compactAddress(office)}
          </p>
        </div>
        <PageHeaderActions
          onRefresh={() => {
            void loadPage();
            if (tab === "calendar") void loadSlots(selectedCalendarDate);
          }}
          refreshLoading={loading}
          helpTitle="Receiving schedule"
          helpContent={
            <p>
              View booked donors, receive expected drop-offs, and manage opening
              hours.
            </p>
          }
        />
      </header>
      <div className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-0.5">
        {[
          ["calendar", "Appointments"],
          ["settings", "Hours & closures"],
          ["arrivals", "Expected drop-offs"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`h-9 shrink-0 rounded-lg px-3 text-xs font-semibold sm:text-sm ${tab === key ? "text-white" : "text-slate-600"}`}
            style={tab === key ? { backgroundColor: primaryColor } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "calendar" ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ScanLine size={18} style={{ color: primaryColor }} />
                  <h2 className="font-semibold">Open appointment</h2>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Scan the donor's appointment waybill to load the booking and
                  hair details.
                </p>
              </div>
              <div className="flex w-full max-w-2xl gap-2">
                <input
                  value={scannerCode}
                  onChange={(event) =>
                    setScannerCode(
                      normalizeWaybillCodeInput(event.target.value),
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter")
                      void openAppointmentByWaybill(scannerCode);
                  }}
                  placeholder="WBXXXXXX"
                  maxLength={8}
                  className={`${inputClass} min-w-0 flex-1 font-mono uppercase`}
                />
                <button
                  type="button"
                  disabled={saving || !isValidWaybillCode(scannerCode)}
                  onClick={() => void openAppointmentByWaybill(scannerCode)}
                  className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: primaryColor }}
                >
                  Find
                </button>
                <button
                  type="button"
                  disabled={isStartingCamera}
                  onClick={() => void toggleCamera()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Camera size={16} />
                  Scan QR
                </button>
              </div>
            </div>
          </section>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 border-b border-slate-200 lg:border-b-0 lg:border-r">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => moveCalendarMonth(-1)}
                    className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                    aria-label="Previous month"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <div className="text-center">
                    <h2 className="text-sm font-semibold text-slate-900">
                      {calendarMonth.toLocaleDateString("en-PH", {
                        month: "long",
                        year: "numeric",
                      })}
                    </h2>
                    <p className="text-xs text-slate-500">
                      Select a date to view booked donors
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => moveCalendarMonth(1)}
                    className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                    aria-label="Next month"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                    (day) => (
                      <div key={day} className="py-2">
                        {day}
                      </div>
                    ),
                  )}
                </div>
                <div className="grid grid-cols-7 gap-px bg-slate-200">
                  {calendarCells.map((day, index) => {
                    if (!day)
                      return (
                        <div
                          key={`empty-${index}`}
                          className="min-h-[82px] bg-slate-50"
                        />
                      );
                    const key = dateKey(day);
                    const booked = appointmentsByDate[key] || [];
                    const going = booked.filter((row) =>
                      ["Confirmed", "Rescheduled", "Checked In"].includes(
                        row.Status,
                      ),
                    ).length;
                    const selectedDay = key === selectedCalendarDate;
                    const today = key === dateKey(new Date());
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedCalendarDate(key)}
                        className="min-h-[82px] bg-white p-2 text-left hover:bg-slate-50"
                        style={
                          selectedDay
                            ? { boxShadow: `inset 0 0 0 2px ${primaryColor}` }
                            : undefined
                        }
                      >
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${today ? "bg-slate-900 text-white" : "text-slate-700"}`}
                        >
                          {day.getDate()}
                        </span>
                        {going ? (
                          <p
                            className="mt-1 text-[10px] font-semibold"
                            style={{ color: primaryColor }}
                          >
                            {going} going
                          </p>
                        ) : null}
                        {booked.some((row) => row.Status === "Completed") ? (
                          <p
                            className="text-[10px]"
                            style={{ color: tertiaryColorDark }}
                          >
                            Completed
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
              <aside className="min-w-0">
                <div className="border-b border-slate-200 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">
                        {formatDate(selectedCalendarDate)}
                      </h2>
                      <p className="text-xs text-slate-500">
                        {selectedDayAppointments.length} booked donor
                        {selectedDayAppointments.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    {slotsLoading ? (
                      <Loader2
                        size={16}
                        className="animate-spin text-slate-400"
                      />
                    ) : null}
                  </div>
                  {selectedDayOverride?.Is_Closed ? (
                    <p
                      className="mt-2 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                      style={statusTone("Cancelled")}
                    >
                      Closed
                      {selectedDayOverride.Reason
                        ? ` · ${selectedDayOverride.Reason}`
                        : ""}
                    </p>
                  ) : null}
                </div>
                <div className="max-h-[590px] space-y-2 overflow-y-auto p-3">
                  {loading || slotsLoading ? (
                    <p className="flex items-center gap-2 p-4 text-sm text-slate-500">
                      <Loader2 size={15} className="animate-spin" />
                      Loading appointment times...
                    </p>
                  ) : null}
                  {!loading && !slotsLoading && !slots.length ? (
                    <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center">
                      <CalendarOff
                        className="mx-auto text-slate-300"
                        size={23}
                      />
                      <p className="mt-2 text-sm font-medium text-slate-600">
                        No appointment times
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        This date is closed or has no regular hours.
                      </p>
                    </div>
                  ) : null}
                  {slots.map((slot) => {
                    const slotAppointments = selectedDayAppointments.filter(
                      (appointment) =>
                        timestampMinute(appointment.Appointment_Start_At) ===
                        timestampMinute(slot.Slot_Start_At),
                    );
                    return (
                      <div
                        key={slot.Slot_Start_At}
                        className="overflow-hidden rounded-xl border border-slate-200"
                      >
                        <div className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-2">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                              <Clock3 size={13} />
                              {formatTime(slot.Slot_Start_At)}–
                              {formatTime(slot.Slot_End_At)}
                            </p>
                            <p className="mt-0.5 text-[10px] text-slate-500">
                              {slot.Late_Grace_Minutes}-minute grace
                            </p>
                          </div>
                          <span
                            className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                            style={statusTone(
                              Number(slot.Remaining_Capacity) > 0
                                ? "Received"
                                : "Cancelled",
                            )}
                          >
                            {slot.Booked_Count}/{slot.Capacity} booked
                          </span>
                        </div>
                        <div className="space-y-1 p-2">
                          {slotAppointments.map((appointment) => {
                            const status = appointmentStatus(appointment);
                            return (
                              <button
                                type="button"
                                key={appointment.Appointment_ID}
                                onClick={() =>
                                  setSelectedAppointmentId(
                                    appointment.Appointment_ID,
                                  )
                                }
                                className="flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-slate-50"
                                style={
                                  selectedAppointmentId ===
                                  appointment.Appointment_ID
                                    ? {
                                        backgroundColor: colorWithAlpha(
                                          primaryColor,
                                          0.1,
                                        ),
                                      }
                                    : undefined
                                }
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-semibold text-slate-900">
                                    {appointmentName(appointment)}
                                  </p>
                                  <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                                    {appointment.submission?.Waybill_Code ||
                                      "No waybill"}
                                  </p>
                                </div>
                                <span
                                  className="shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold"
                                  style={statusTone(status)}
                                >
                                  {status}
                                </span>
                              </button>
                            );
                          })}
                          {!slotAppointments.length ? (
                            <p className="px-2.5 py-2 text-xs text-slate-400">
                              Open · {slot.Remaining_Capacity} place
                              {Number(slot.Remaining_Capacity) === 1 ? "" : "s"}{" "}
                              available
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {appointmentsOutsideCurrentSlots.length ? (
                    <div
                      className="rounded-xl border p-2"
                      style={statusTone("Checked In")}
                    >
                      <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide">
                        Existing bookings outside current hours
                      </p>
                      {appointmentsOutsideCurrentSlots.map((appointment) => (
                        <button
                          type="button"
                          key={appointment.Appointment_ID}
                          onClick={() =>
                            setSelectedAppointmentId(
                              appointment.Appointment_ID,
                            )
                          }
                          className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white"
                        >
                          <span className="min-w-0 truncate text-xs font-semibold text-slate-800">
                            {formatTime(appointment.Appointment_Start_At)} ·{" "}
                            {appointmentName(appointment)}
                          </span>
                          <span className="shrink-0 text-[10px]">
                            {appointmentStatus(appointment)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </aside>
            </div>
          </section>
          {appointmentReviewPanel}
        </>
      ) : tab === "arrivals" ? (
        <>
          <section className="rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm">
            <div className="grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)] lg:items-end">
              <div>
                <div className="flex items-center gap-2">
                  <ScanLine size={17} style={{ color: primaryColor }} />
                  <h2 className="text-sm font-semibold text-slate-900">
                    Receive donation
                  </h2>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  Scan or enter the waybill
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <input
                  value={scannerCode}
                  onChange={(event) =>
                    setScannerCode(
                      normalizeWaybillCodeInput(event.target.value),
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter")
                      void receiveScannedWaybill(scannerCode);
                  }}
                  placeholder="Enter waybill or scan QR"
                  maxLength={8}
                  className={`${inputClass} min-w-0 flex-1 font-mono uppercase`}
                />
                <button
                  type="button"
                  disabled={saving || !isValidWaybillCode(scannerCode)}
                  onClick={() => void receiveScannedWaybill(scannerCode)}
                  className="rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ backgroundColor: primaryColor }}
                >
                  {saving ? "Receiving…" : "Receive"}
                </button>
                <button
                  type="button"
                  disabled={isStartingCamera}
                  onClick={() => void toggleCamera()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ borderColor: primaryColor, color: primaryColor }}
                >
                  <Camera size={16} />
                  QR
                </button>
              </div>
            </div>
          </section>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              [
                "Waiting",
                counts.Expected || 0,
                "Expected",
                primaryColor,
              ],
              [
                "Checked In",
                counts["Checked In"] || 0,
                "Checked In",
                secondaryColorDark,
              ],
              [
                "Received",
                counts.Received || 0,
                "Received",
                tertiaryColorDark,
              ],
              [
                "Cancelled",
                counts.Cancelled || 0,
                "Cancelled",
                primaryColorDark,
              ],
            ].map(([label, count, filter, accent]) => (
              <button
                type="button"
                key={label}
                onClick={() => setStatusFilter(filter)}
                aria-pressed={statusFilter === filter}
                className="flex items-center justify-between rounded-xl border px-3 py-2 text-left transition hover:brightness-95"
                style={{
                  borderColor: statusFilter === filter ? accent : colorWithAlpha(accent, 0.34),
                  borderWidth: statusFilter === filter ? 2 : 1,
                  backgroundColor: colorWithAlpha(accent, 0.1),
                  color: accent,
                }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide">
                  {label}
                </p>
                <p className="text-lg font-bold">{count}</p>
              </button>
            ))}
          </div>
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
            <div className="grid gap-2 border-b border-slate-200 bg-slate-50/80 p-2 md:grid-cols-[1fr_150px_150px]">
              <label className="relative">
                <Search
                  size={16}
                  className="absolute left-3 top-2.5 text-slate-400"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search donor, waybill, route, or ID"
                  className={`${inputClass} pl-9`}
                />
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className={inputClass}
              >
                {[
                  ["Active", "Active"],
                  ["Expected", "Expected"],
                  ["Checked In", "Checked In"],
                  ["Received", "Received"],
                  ["Cancelled", "Cancelled"],
                  ["No Show", "Not Received"],
                  ["All", "All"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="date"
                aria-label="Filter by expected date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="grid lg:min-h-0 lg:flex-1 lg:grid-cols-[360px_minmax(0,1fr)]">
              <div className="border-b border-slate-100 bg-slate-50/40 lg:flex lg:min-h-0 lg:flex-col lg:border-b-0 lg:border-r">
                <div className="border-b border-slate-100 bg-white px-3 py-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Donor queue
                  </h2>
                  <p className="text-xs text-slate-500">
                    {filtered.length} matching donations
                  </p>
                </div>
                {loading ? (
                  <p className="flex items-center gap-2 p-5 text-sm text-slate-500">
                    <Loader2 size={16} className="animate-spin" />
                    Loading donations...
                  </p>
                ) : null}
                {!loading && !filtered.length ? (
                  <p className="p-8 text-center text-sm text-slate-500">
                    No courier or drop-off records match these filters.
                  </p>
                ) : null}
                {visibleQueue.map((row) => {
                  const isSelected = selectedId === row.Submission_ID;
                  return (
                    <button
                      key={row.Submission_ID}
                      onClick={() => setSelectedId(row.Submission_ID)}
                      className={`w-full border-b border-l-[3px] border-b-slate-100 px-3 py-2.5 text-left transition-colors ${isSelected ? "bg-white" : "border-l-transparent hover:bg-white"}`}
                      style={
                        isSelected
                          ? { borderLeftColor: primaryColor }
                          : undefined
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900">
                            {fullName(row.profile)}
                          </p>
                          <p className="mt-0.5 font-mono text-xs text-slate-500">
                            {row.submission.Waybill_Code ||
                              `Submission #${row.Submission_ID}`}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {routeKind(row)} · {expectedArrivalLabel(row)}
                          </p>
                        </div>
                        <span
                          className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                          style={statusTone(receivingStatus(row))}
                        >
                          {receivingStatusLabel(receivingStatus(row))}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {filtered.length > queuePageSize ? (
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-100 bg-white px-3 py-2 text-xs">
                    <button
                      type="button"
                      disabled={queuePage <= 1}
                      onClick={() => setQueuePage((page) => page - 1)}
                      className="rounded-md px-2 py-1 font-semibold disabled:opacity-40"
                      style={{ color: primaryColor }}
                    >
                      Previous
                    </button>
                    <span className="text-slate-500">{queuePage} / {queuePageCount}</span>
                    <button
                      type="button"
                      disabled={queuePage >= queuePageCount}
                      onClick={() => setQueuePage((page) => page + 1)}
                      className="rounded-md px-2 py-1 font-semibold disabled:opacity-40"
                      style={{ color: primaryColor }}
                    >
                      Next
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="min-w-0 p-3 lg:min-h-0 lg:overflow-y-auto">
                {!selected ? (
                  <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">
                    Select a donor to view the receiving record.
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-2.5">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Selected donation
                        </p>
                        <h2 className="mt-0.5 text-base font-bold text-slate-900">
                          {fullName(selected.profile)}
                        </h2>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {selected.account?.email || "No email"} ·{" "}
                          {selected.profile?.contact_number || "No phone"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p
                          className="font-mono text-base font-bold"
                          style={{ color: primaryColor }}
                        >
                          {selected.submission.Waybill_Code || "No waybill"}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Submission #{selected.Submission_ID} ·{" "}
                          {routeKind(selected)}
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(210px,0.68fr)]">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">
                          Receiving progress
                        </h3>
                        <div className="mt-2 space-y-0">
                          {receivingTimeline(selected).map(
                            (stage, index, stages) => (
                              <div
                                key={stage.label}
                                className="relative flex gap-3 pb-1.5 last:pb-0"
                              >
                                {index < stages.length - 1 ? (
                                  <span
                                    className={`absolute left-[9px] top-5 h-full w-px ${stage.done ? "" : "bg-slate-200"}`}
                                    style={
                                      stage.done
                                        ? { backgroundColor: tertiaryColor }
                                        : undefined
                                    }
                                  />
                                ) : null}
                                <span
                                  className={`relative z-[1] mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${stage.done ? "text-white" : stage.current ? "ring-2 ring-offset-2 text-white" : "bg-slate-200 text-slate-400"}`}
                                  style={
                                    stage.done
                                      ? { backgroundColor: tertiaryColor }
                                      : stage.current
                                      ? {
                                          backgroundColor: primaryColor,
                                          "--tw-ring-color": primaryColor,
                                        }
                                      : undefined
                                  }
                                >
                                  {stage.done ? (
                                    <CheckCircle2 size={13} />
                                  ) : (
                                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                                  )}
                                </span>
                                <div>
                                  <p
                                    className={`text-sm font-semibold ${stage.current ? "text-slate-900" : stage.done ? "text-slate-800" : "text-slate-400"}`}
                                  >
                                    {stage.label}
                                  </p>
                                  <p className="mt-0.5 text-xs text-slate-500">
                                    {stage.detail}
                                  </p>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="rounded-xl bg-slate-50 p-2.5">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                            Expected arrival
                          </p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">
                            {expectedArrivalLabel(selected)}
                          </p>
                        </div>
                        {selected.Cancellation_Reason ? (
                          <div
                            className="rounded-xl border p-4 text-sm"
                            style={statusTone("Cancelled")}
                          >
                            <p className="text-xs font-bold uppercase tracking-wide">
                              Exception · {receivingStatusLabel(selectedReceivingStatus)}
                            </p>
                            <p className="mt-1">
                              {selected.Cancellation_Reason}
                            </p>
                            <p className="mt-1 text-xs opacity-80">
                              Recorded by{" "}
                              {selected.Cancellation_Source || "Staff"}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {!selectedReceivingFinal ? (
                      <div className="border-t border-slate-100 pt-2">
                        <label className="block text-sm font-medium text-slate-700">
                          Staff note{" "}
                          <span className="font-normal text-slate-400">
                              (required for cancellation or Not Received)
                          </span>
                          <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={2}
                            placeholder="Add a receiving note or exception reason"
                            className={`${inputClass} mt-2`}
                          />
                        </label>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {selectedRoute === "Drop-off" &&
                          selectedReceivingStatus === "Expected" ? (
                            <button
                              disabled={saving}
                              onClick={() => void runAction("check_in")}
                              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                              style={{ backgroundColor: primaryColor }}
                            >
                              <UserCheck size={16} />
                              Check In
                            </button>
                          ) : null}
                          {selectedRoute === "Drop-off" &&
                          selectedReceivingStatus === "Checked In" ? (
                            <button
                              disabled={saving}
                              onClick={() => void runAction("complete")}
                              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                              style={{ backgroundColor: tertiaryColor }}
                            >
                              <CheckCircle2 size={16} />
                              Mark Received
                            </button>
                          ) : null}
                          {selectedRoute === "Courier" &&
                          selectedReceivingStatus === "Expected" ? (
                            <button
                              disabled={saving}
                              onClick={() =>
                                void receiveScannedWaybill(
                                  selected.submission.Waybill_Code,
                                )
                              }
                              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                              style={{ backgroundColor: tertiaryColor }}
                            >
                              <CheckCircle2 size={16} />
                              Mark Received
                            </button>
                          ) : null}
                          {selectedReceivingStatus === "Expected" ? (
                            <button
                              disabled={saving}
                              onClick={() => void runAction("no_show")}
                              className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold"
                              style={statusTone("No Show")}
                            >
                              <UserX size={16} />
                              Not Received
                            </button>
                          ) : null}
                          {selectedRoute === "Drop-off" ? (
                            <button
                              disabled={saving}
                              onClick={() => void runAction("cancel")}
                              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
                            >
                              <XCircle size={16} />
                              Cancel
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                        This receiving record is final. Received hair continues
                        to Specialist Quality Check; cancelled and not-received
                        records remain in history.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      ) : (
        <div className="grid items-start gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.85fr)_minmax(320px,1fr)] lg:items-stretch">
          <section className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm lg:min-h-0 lg:overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Regular receiving hours</h2>
              <button
                type="button"
                disabled={saving || !hours.length}
                onClick={() => void saveHours()}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: primaryColor }}
              >
                <Save size={14} /> Save hours
              </button>
            </div>
            <div className="mt-2 divide-y divide-slate-200 lg:flex lg:flex-1 lg:flex-col">
              {hours.map((row) => (
                <div key={row.Operating_Hours_ID} className="py-2.5 first:pt-0 last:pb-0 lg:flex lg:flex-1 lg:flex-col lg:justify-center">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-sm">{row.Day_Group}</strong>
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={row.Is_Open}
                        onChange={(e) => updateHour(row.Operating_Hours_ID, "Is_Open", e.target.checked)}
                      />
                      Open
                    </label>
                  </div>
                  <div className="mt-2 space-y-2">
                  <div className="grid grid-cols-[56px_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 sm:grid-cols-[64px_minmax(0,1fr)_auto_minmax(0,1fr)]">
                    <span className="text-xs font-semibold text-slate-600">Hours</span>
                    <input aria-label={`${row.Day_Group} opens`} type="time" value={row.Opening_Time} onChange={(e) => updateHour(row.Operating_Hours_ID, "Opening_Time", e.target.value)} className={`${inputClass} h-9 min-w-0 py-1`} />
                    <span className="text-slate-400" aria-hidden="true">→</span>
                    <input aria-label={`${row.Day_Group} closes`} type="time" value={row.Closing_Time} onChange={(e) => updateHour(row.Operating_Hours_ID, "Closing_Time", e.target.value)} className={`${inputClass} h-9 min-w-0 py-1`} />
                    <span className="text-xs font-semibold text-slate-600">Break <span title="Set both times, or leave both blank for no break. Appointments cannot overlap a break." className="cursor-help text-slate-400">ⓘ</span></span>
                    <input aria-label={`${row.Day_Group} break starts`} type="time" value={row.Break_Start_Time} onChange={(e) => updateHour(row.Operating_Hours_ID, "Break_Start_Time", e.target.value)} className={`${inputClass} h-9 min-w-0 py-1`} />
                    <span className="text-slate-400" aria-hidden="true">→</span>
                    <input aria-label={`${row.Day_Group} break ends`} type="time" value={row.Break_End_Time} onChange={(e) => updateHour(row.Operating_Hours_ID, "Break_End_Time", e.target.value)} className={`${inputClass} h-9 min-w-0 py-1`} />
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 sm:grid-cols-3">
                    {[
                      ["Appointment_Duration_Minutes", "Duration", 15, 480],
                      ["Buffer_Minutes", "Buffer", 0, 240],
                      ["Late_Grace_Minutes", "Grace", 0, 120],
                      ["Capacity_Per_Slot", "Capacity", 1, 20],
                      ["Minimum_Booking_Notice_Days", "Min notice", 0, 30],
                      ["Maximum_Booking_Days", "Book ahead", 1, 365],
                    ].map(([field, label, min, max]) => (
                      <label key={field} className="min-w-0 text-[11px] font-semibold text-slate-600">
                        {label}
                        <input type="number" min={min} max={max} value={row[field]} onChange={(e) => updateHour(row.Operating_Hours_ID, field, e.target.value)} className={`${inputClass} mt-1 h-9 min-w-0 py-1`} />
                      </label>
                    ))}
                  </div>
                  </div>
                </div>
              ))}
              {!hours.length && <p className="py-3 text-xs text-slate-500">No receiving hours configured.</p>}
            </div>
          </section>
          <section className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm lg:min-h-0 lg:overflow-y-auto">
            <h2 className="text-sm font-semibold">Closures & special hours</h2>
            <div className="mt-2 space-y-2.5">
              <label className="block text-xs font-semibold text-slate-600">
                Date
                <input type="date" value={overrideDraft.date} onChange={(e) => setOverrideDraft((old) => ({ ...old, date: e.target.value }))} className={`${inputClass} mt-1 h-9 py-1`} />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={overrideDraft.isClosed} onChange={(e) => setOverrideDraft((old) => ({ ...old, isClosed: e.target.checked }))} />
                Closed all day
              </label>
              {!overrideDraft.isClosed && (
                <>
                  <div className="grid grid-cols-[48px_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                    <span className="text-xs font-semibold text-slate-600">Hours</span>
                    <input aria-label="Special hours open" type="time" value={overrideDraft.openingTime} onChange={(e) => setOverrideDraft((old) => ({ ...old, openingTime: e.target.value }))} className={`${inputClass} h-9 min-w-0 py-1`} />
                    <span className="text-slate-400" aria-hidden="true">→</span>
                    <input aria-label="Special hours close" type="time" value={overrideDraft.closingTime} onChange={(e) => setOverrideDraft((old) => ({ ...old, closingTime: e.target.value }))} className={`${inputClass} h-9 min-w-0 py-1`} />
                    <span className="text-xs font-semibold text-slate-600">Break <span title="Set both times or leave both blank for no break on this date." className="cursor-help text-slate-400">ⓘ</span></span>
                    <input aria-label="Special hours break starts" type="time" value={overrideDraft.breakStartTime} onChange={(e) => setOverrideDraft((old) => ({ ...old, breakStartTime: e.target.value }))} className={`${inputClass} h-9 min-w-0 py-1`} />
                    <span className="text-slate-400" aria-hidden="true">→</span>
                    <input aria-label="Special hours break ends" type="time" value={overrideDraft.breakEndTime} onChange={(e) => setOverrideDraft((old) => ({ ...old, breakEndTime: e.target.value }))} className={`${inputClass} h-9 min-w-0 py-1`} />
                  </div>
                  <label className="block text-xs font-semibold text-slate-600">
                    Capacity <span className="font-normal text-slate-400">(optional)</span>
                    <input type="number" min="1" max="20" value={overrideDraft.capacity} onChange={(e) => setOverrideDraft((old) => ({ ...old, capacity: e.target.value }))} placeholder="Use regular capacity" className={`${inputClass} mt-1 h-9 py-1`} />
                  </label>
                </>
              )}
              <label className="block text-xs font-semibold text-slate-600">
                Reason
                <input value={overrideDraft.reason} onChange={(e) => setOverrideDraft((old) => ({ ...old, reason: e.target.value }))} className={`${inputClass} mt-1 h-9 py-1`} />
              </label>
              <button type="button" disabled={saving} onClick={() => void saveOverride()} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white disabled:opacity-50" style={{ backgroundColor: primaryColor }}>
                <Save size={14} /> Save date
              </button>
            </div>
            <div className="mt-3 border-t border-slate-200 pt-2.5 lg:flex lg:flex-1 lg:flex-col">
              <h3 className="text-xs font-semibold">Upcoming dates <span className="font-normal text-slate-500">({overrides.filter((row) => row.Override_Date >= dateKey(new Date())).length})</span></h3>
              <div className="mt-2 max-h-44 space-y-1 overflow-y-auto lg:max-h-none lg:flex-1">
                {overrides.filter((row) => row.Override_Date >= dateKey(new Date())).map((row) => (
                  <div key={row.Schedule_Override_ID} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">{formatDate(row.Override_Date)} <span className="font-normal text-slate-500">· {row.Is_Closed ? "Closed" : `${formatTime(row.Opening_Time)}–${formatTime(row.Closing_Time)}`}</span></p>
                      {row.Reason && <p className="truncate text-[11px] text-slate-500" title={row.Reason}>{row.Reason}</p>}
                    </div>
                    <button type="button" disabled={saving} onClick={() => void deleteOverride(row.Schedule_Override_ID)} className="shrink-0 rounded-md p-1 disabled:opacity-50" style={{ color: primaryColorDark }} aria-label={`Remove override for ${formatDate(row.Override_Date)}`} title="Remove override"><XCircle size={15} /></button>
                  </div>
                ))}
                {!overrides.some((row) => row.Override_Date >= dateKey(new Date())) && <p className="text-xs text-slate-500 lg:flex lg:h-full lg:items-center lg:justify-center lg:text-center">No upcoming closures or special hours.</p>}
              </div>
            </div>
          </section>
        </div>
      )}

      {isCameraOn && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-[2147483000] flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close QR scanner"
                onClick={stopCamera}
                className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
              />
              <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="receiving-scanner-title"
                className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
              >
                <header className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                      {tab === "calendar"
                        ? "Appointment scanner"
                        : "Receiving scanner"}
                    </p>
                    <h2
                      id="receiving-scanner-title"
                      className="mt-0.5 font-semibold text-slate-900"
                    >
                      {tab === "calendar"
                        ? "Scan appointment waybill"
                        : "Scan donation waybill"}
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Hold the complete QR code inside the guide.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <XCircle size={18} />
                  </button>
                </header>
                <div className="relative aspect-[4/3] bg-slate-950">
                  <video
                    ref={videoRef}
                    className="h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="h-44 w-44 rounded-2xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,0.28)]" />
                  </div>
                </div>
                <footer className="flex items-center justify-between gap-3 px-4 py-3">
                  <p className="text-xs text-slate-500">
                    Scanning automatically…
                  </p>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
                  >
                    <CameraOff size={14} />
                    Close scanner
                  </button>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
