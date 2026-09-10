import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useToast } from "../../../context/ToastContext";
import { isSupabaseConfigured, supabase } from "../../../lib/supabaseClient";
import { triggerSmtpNow } from "../../../lib/smtpTriggerClient";

function formatDate(value) {
  if (!value) return "N/A";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "N/A";
  return parsed.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function answer(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not provided";
}

function Row({ label, value, wide = false }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 whitespace-pre-line text-sm leading-6 text-slate-800">
        {value || "N/A"}
      </dd>
    </div>
  );
}

async function invokeDecision(body) {
  const { data, error } = await supabase.functions.invoke(
    "patient-application",
    { body },
  );
  if (error) {
    let message = error.message || "Unable to update the application.";
    try {
      const detail = await error.context?.json?.();
      if (detail?.error) message = detail.error;
    } catch {
      // Keep the function error.
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export default function PatientApplicationsPage({ isActivePage = true }) {
  const { showToast } = useToast();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("submitted");
  const [selected, setSelected] = useState(null);
  const [decision, setDecision] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [assetUrls, setAssetUrls] = useState({ picture: "", document: "" });

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("Patient_Applications")
      .select("*")
      .order("Submitted_At", { ascending: false });
    if (error)
      showToast({
        type: "error",
        title: "Application queue error",
        message: error.message,
      });
    else setApplications(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    if (isActivePage) void load();
  }, [isActivePage, load]);

  useEffect(() => {
    let mounted = true;
    const resolve = async () => {
      setAssetUrls({ picture: "", document: "" });
      if (!selected) return;
      const pictureBucket =
        selected.Status === "accepted"
          ? "patient_assets"
          : "patient-application-assets";
      const [picture, document] = await Promise.all([
        selected.Patient_Picture_Path
          ? supabase.storage
              .from(pictureBucket)
              .createSignedUrl(selected.Patient_Picture_Path, 900)
          : null,
        selected.Medical_Document_Path
          ? supabase.storage
              .from("patient-application-assets")
              .createSignedUrl(selected.Medical_Document_Path, 900)
          : null,
      ]);
      if (mounted)
        setAssetUrls({
          picture: picture?.data?.signedUrl || "",
          document: document?.data?.signedUrl || "",
        });
    };
    void resolve();
    return () => {
      mounted = false;
    };
  }, [selected]);

  const counts = useMemo(
    () => ({
      submitted: applications.filter((row) => row.Status === "submitted")
        .length,
      accepted: applications.filter((row) => row.Status === "accepted").length,
      rejected: applications.filter((row) => row.Status === "rejected").length,
    }),
    [applications],
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return applications.filter((row) => {
      if (status !== "all" && row.Status !== status) return false;
      if (!query) return true;
      return `${row.Application_Code} ${row.First_Name} ${row.Middle_Name} ${row.Last_Name} ${row.Applicant_Email} ${row.Medical_Condition}`
        .toLowerCase()
        .includes(query);
    });
  }, [applications, search, status]);

  const decide = async () => {
    if (!decision?.application || !decision?.type) return;
    if (decision.type === "rejected" && !reason.trim()) {
      showToast({
        type: "error",
        title: "Rejection reason required",
        message: "Explain why the application was not accepted.",
      });
      return;
    }
    try {
      setBusy(true);
      const result = await invokeDecision({
        action: "decide",
        applicationId: decision.application.Patient_Application_ID,
        decision: decision.type,
        reason: reason.trim(),
      });
      showToast({
        type: "success",
        title:
          decision.type === "accepted"
            ? "Application accepted"
            : "Application rejected",
        message:
          decision.type === "accepted"
            ? `Patient ${result.patientCode || ""} was created and the account invitation was sent.`
            : "The applicant was emailed the hospital decision.",
      });
      void triggerSmtpNow(`patient_application_${decision.type}`);
      setDecision(null);
      setReason("");
      setSelected(null);
      await load();
    } catch (error) {
      showToast({
        type: "error",
        title: "Unable to save decision",
        message: error.message || "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="role-page-title text-3xl font-bold text-slate-900">
            Patient Applications
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Review email-verified applications submitted directly to your
            hospital.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />{" "}
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          ["Pending review", counts.submitted, "submitted"],
          ["Accepted", counts.accepted, "accepted"],
          ["Rejected", counts.rejected, "rejected"],
        ].map(([label, count, key]) => (
          <button
            type="button"
            key={key}
            onClick={() => setStatus(key)}
            className={`rounded-xl border bg-white px-4 py-3 text-left ${status === key ? "border-[#7a1020]" : "border-slate-200"}`}
          >
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
              {label}
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{count}</p>
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, email, reference, or condition"
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-[#7a1020]"
            />
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="submitted">Pending review</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="all">All applications</option>
          </select>
        </div>
        {loading ? (
          <div className="flex justify-center py-14 text-sm text-slate-600">
            <Loader2 size={18} className="mr-2 animate-spin" /> Loading
            applications...
          </div>
        ) : visible.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-500">
            No applications match this view.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left">Reference</th>
                  <th className="px-4 py-3 text-left">Applicant</th>
                  <th className="px-4 py-3 text-left">Condition</th>
                  <th className="px-4 py-3 text-left">Submitted</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.Patient_Application_ID}
                    className="border-t border-slate-100"
                  >
                    <td className="px-4 py-3 font-mono text-xs font-bold text-[#7a1020]">
                      {row.Application_Code}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">
                        {[
                          row.First_Name,
                          row.Middle_Name,
                          row.Last_Name,
                          row.Suffix,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      </p>
                      <p className="text-xs text-slate-500">
                        {row.Applicant_Email}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.Medical_Condition}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {formatDate(row.Submitted_At)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-bold ${row.Status === "accepted" ? "bg-emerald-100 text-emerald-800" : row.Status === "rejected" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}
                      >
                        {row.Status === "submitted"
                          ? "Pending review"
                          : row.Status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setSelected(row)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700"
                      >
                        <Eye size={14} /> Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-6">
            <div className="absolute inset-0 bg-slate-950/70" aria-hidden="true" />
            <button
              type="button"
              aria-label="Close"
              className="absolute inset-0"
              onClick={() => setSelected(null)}
            />
            <section
              role="dialog"
              aria-modal="true"
              className="relative z-10 flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 opacity-100 shadow-2xl"
              style={{ backgroundColor: "#ffffff", opacity: 1 }}
            >
              <header className="flex items-start justify-between border-b border-slate-200 bg-white px-5 py-4">
                <div>
                  <p className="font-mono text-xs font-bold text-[#7a1020]">
                    {selected.Application_Code}
                  </p>
                  <h2 className="mt-1 text-xl font-bold">
                    {[
                      selected.First_Name,
                      selected.Middle_Name,
                      selected.Last_Name,
                      selected.Suffix,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Submitted {formatDate(selected.Submitted_At)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                >
                  <X size={18} />
                </button>
              </header>
              <div className="overflow-y-auto bg-white p-5">
                <div className="grid gap-6 lg:grid-cols-[180px,1fr]">
                  {assetUrls.picture ? (
                    <img
                      src={assetUrls.picture}
                      alt="Applicant"
                      className="h-48 w-full rounded-xl object-cover"
                    />
                  ) : (
                    <div className="flex h-48 items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-400">
                      No patient picture
                    </div>
                  )}
                  <div className="space-y-6">
                    <dl className="grid gap-4 sm:grid-cols-2">
                      <Row label="Email" value={selected.Applicant_Email} />
                      <Row label="Contact" value={selected.Contact_Number} />
                      <Row label="Birthdate" value={selected.Birthdate} />
                      <Row label="Gender" value={selected.Gender} />
                      <Row
                        label="Address"
                        wide
                        value={[
                          selected.Street,
                          selected.Barangay,
                          selected.City,
                          selected.Province,
                          selected.Region,
                          selected.Country,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      />
                    </dl>
                    <div className="border-t border-slate-200 pt-5">
                      <h3 className="font-bold">Clinical information</h3>
                      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                        <Row
                          label="Condition"
                          value={`${selected.Medical_Condition}${selected.Condition_Stage_Severity ? ` · ${selected.Condition_Stage_Severity}` : ""}`}
                        />
                        <Row
                          label="Diagnosis date"
                          value={selected.Date_of_Diagnosis}
                        />
                        <Row label="Physician" value={selected.Doctor_Name} />
                        <Row
                          label="Physician contact"
                          value={selected.Attending_Physician_Contact}
                        />
                        <Row
                          label="Treatment hospital / clinic"
                          value={selected.Treatment_Hospital_Clinic}
                        />
                        <Row
                          label="Treatment status"
                          value={selected.Current_Treatment_Status}
                        />
                        <Row
                          label="Treatment plan"
                          wide
                          value={selected.Treatment_Plan}
                        />
                        <Row
                          label="Current medications"
                          wide
                          value={selected.Allergies_Current_Medications}
                        />
                        <Row
                          label="Insurance / PhilHealth"
                          value={selected.Insurance_PhilHealth_Info}
                        />
                        <Row
                          label="Clinical note"
                          value={selected.Clinical_Special_Note}
                        />
                      </dl>
                    </div>
                    <div className="border-t border-slate-200 pt-5">
                      <h3 className="font-bold">
                        Wig-safety review
                      </h3>
                      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                        <Row
                          label="Known allergies"
                          value={answer(selected.Has_Known_Allergies)}
                        />
                        <Row
                          label="Allergy details"
                          value={selected.Allergy_Details}
                        />
                        <Row
                          label="Sensitive scalp"
                          value={answer(selected.Has_Sensitive_Scalp)}
                        />
                        <Row
                          label="Scalp irritation"
                          value={answer(selected.Has_Scalp_Irritation)}
                        />
                        <Row
                          label="Open scalp wounds"
                          value={answer(selected.Has_Open_Scalp_Wounds)}
                        />
                        <Row
                          label="Medical restriction"
                          value={answer(selected.Has_Medical_Restriction)}
                        />
                        <Row
                          label="Restriction details"
                          wide
                          value={selected.Medical_Restriction_Details}
                        />
                      </dl>
                    </div>
                    <div className="border-t border-slate-200 pt-5">
                      <h3 className="font-bold">Contacts and documents</h3>
                      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                        <Row
                          label="Primary guardian"
                          value={`${selected.Guardian} · ${selected.Guardian_Relationship}`}
                        />
                        <Row
                          label="Guardian contact"
                          value={selected.Guardian_Contact_Number}
                        />
                        <Row
                          label="Secondary contact"
                          value={selected.Secondary_Guardian}
                        />
                        <Row
                          label="Secondary contact number"
                          value={selected.Secondary_Guardian_Contact_Number}
                        />
                      </dl>
                      {assetUrls.document && (
                        <a
                          href={assetUrls.document}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700"
                        >
                          <FileText size={16} /> Open medical document
                        </a>
                      )}
                    </div>
                    {selected.Decision_Reason && (
                      <div className="rounded-xl bg-slate-50 p-4">
                        <p className="text-xs font-bold uppercase text-slate-500">
                          Decision reason
                        </p>
                        <p className="mt-2 text-sm text-slate-800">
                          {selected.Decision_Reason}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {selected.Status === "submitted" && (
                <footer className="flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">
                  <button
                    type="button"
                    onClick={() => {
                      setDecision({ type: "rejected", application: selected });
                      setReason("");
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-rose-300 px-4 py-2 text-sm font-bold text-rose-700"
                  >
                    <XCircle size={16} /> Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDecision({ type: "accepted", application: selected });
                      setReason("");
                    }}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#650817] px-4 py-2 text-sm font-bold text-white"
                  >
                    <CheckCircle2 size={16} /> Accept and create patient
                  </button>
                </footer>
              )}
            </section>
          </div>,
          document.body,
        )}

      {decision &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/70" aria-hidden="true" />
            <button
              type="button"
              className="absolute inset-0"
              aria-label="Close decision"
              onClick={() => !busy && setDecision(null)}
            />
            <section
              role="dialog"
              aria-modal="true"
              className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 opacity-100 shadow-2xl"
              style={{ backgroundColor: "#ffffff", opacity: 1 }}
            >
              <h2 className="text-lg font-bold">
                {decision.type === "accepted"
                  ? "Accept patient application?"
                  : "Reject patient application?"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {decision.type === "accepted"
                  ? "This creates the account and patient record, then sends the account invitation."
                  : "No account or patient record will be created. The reason is included in the applicant email."}
              </p>
              {decision.type === "rejected" && (
                <label className="mt-4 block">
                  <span className="text-sm font-bold text-slate-700">
                    Rejection reason *
                  </span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm"
                  />
                </label>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDecision(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={decide}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white ${decision.type === "accepted" ? "bg-[#650817]" : "bg-rose-700"}`}
                >
                  {busy && <Loader2 size={15} className="animate-spin" />}{" "}
                  Confirm{" "}
                  {decision.type === "accepted" ? "acceptance" : "rejection"}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
