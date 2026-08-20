import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { logAuditAction } from '../../../lib/auditLogger';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import useRealtimeRefresh from '../../../hooks/useRealtimeRefresh';

const LEGAL_DOCUMENTS_TABLE = 'legal_documents';
const LEGAL_DOCUMENTS_BUCKET = 'legal-documents';
const CONSENT_DOCUMENT_TYPE = 'consent_for_minors';
const CONSENT_DOCUMENT_TITLE = 'Consent for Minors';

const EMPTY_FORM = {
  effectiveAt: '',
};

function normalizeRoleKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateForInput(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function toIsoOrNow(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function toSafeFileName(fileName) {
  return String(fileName || 'consent.pdf')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

function parseVersion(versionValue) {
  const match = String(versionValue || '').trim().match(/^(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function getNextVersion(rows) {
  const parsed = (Array.isArray(rows) ? rows : [])
    .map((row) => parseVersion(row?.version))
    .filter(Boolean);

  if (!parsed.length) {
    return '1.0';
  }

  const latest = parsed.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    return b.minor - a.minor;
  })[0];

  return `${latest.major}.${latest.minor + 1}`;
}

function mapLoadError(rawMessage) {
  const message = String(rawMessage || 'Unable to load legal documents.');
  const lower = message.toLowerCase();
  if (lower.includes('row-level security')) {
    return 'Viewing legal documents is blocked by database policy. Check legal_documents read policies for staff and admin.';
  }
  return message;
}

function mapSaveError(rawMessage) {
  const message = String(rawMessage || 'Unable to save legal document.');
  const lower = message.toLowerCase();
  if (lower.includes('row-level security')) {
    return 'Saving legal documents is blocked by database policy. Make sure legal_documents has INSERT + UPDATE policies for staff/admin and the legal-documents bucket has INSERT policy.';
  }
  if (lower.includes('mime type') || lower.includes('content type')) {
    return 'Only PDF files are allowed for consent documents.';
  }
  return message;
}

function isPdfFile(fileValue) {
  const fileType = String(fileValue?.type || '').toLowerCase();
  const fileName = String(fileValue?.name || '').toLowerCase();
  return fileType === 'application/pdf' || fileName.endsWith('.pdf');
}

export default function LegalDocumentsPage({ userProfile }) {
  const { theme } = useTheme();
  const roleKey = normalizeRoleKey(userProfile?.role);
  const canManage = roleKey === 'superadmin' || roleKey === 'staff';

  const [documents, setDocuments] = useState([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [pdfFile, setPdfFile] = useState(null);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isLoading, setIsLoading] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isActivatingId, setIsActivatingId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [localPreviewUrl, setLocalPreviewUrl] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const primaryColor = theme?.primaryColor || '#0f766e';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const rootStyle = {
    color: primaryTextColor,
    fontFamily: `${bodyFont}, sans-serif`,
  };

  const selectedDocument = useMemo(
    () => documents.find((row) => Number(row.legal_document_id) === Number(selectedDocumentId)) || null,
    [documents, selectedDocumentId],
  );

  const activeDocument = useMemo(
    () => documents.find((row) => Boolean(row.is_active)) || null,
    [documents],
  );

  const nextVersion = useMemo(() => getNextVersion(documents), [documents]);
  const nowLocalDateTimeValue = useMemo(() => formatDateForInput(new Date()), []);

  const selectedPdfPath = useMemo(
    () => String(selectedDocument?.file_path || activeDocument?.file_path || '').trim(),
    [activeDocument?.file_path, selectedDocument?.file_path],
  );

  const loadDocuments = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      setDocuments([]);
      return;
    }

    try {
      setIsLoading(true);
      setNotice({ kind: '', text: '' });

      const { data, error } = await supabase
        .from(LEGAL_DOCUMENTS_TABLE)
        .select('legal_document_id, document_type, version, title, content, is_active, effective_at, created_at, file_path')
        .eq('document_type', CONSENT_DOCUMENT_TYPE)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const rows = data || [];
      setDocuments(rows);

      const currentActive = rows.find((row) => Boolean(row.is_active)) || rows[0] || null;
      setSelectedDocumentId(currentActive?.legal_document_id || null);
      setForm({
        effectiveAt: formatDateForInput(currentActive?.effective_at),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: mapLoadError(error?.message) });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useRealtimeRefresh({
    channelName: 'requirements-legal-documents-live',
    tables: [LEGAL_DOCUMENTS_TABLE],
    onChange: () => void loadDocuments(),
  });

  useEffect(() => {
    let isMounted = true;

    const resolvePreviewUrl = async () => {
      if (!selectedPdfPath || !supabase) {
        if (isMounted) setPreviewUrl('');
        return;
      }

      const signed = await supabase.storage
        .from(LEGAL_DOCUMENTS_BUCKET)
        .createSignedUrl(selectedPdfPath, 60 * 60);

      if (!signed.error && signed.data?.signedUrl) {
        if (isMounted) setPreviewUrl(signed.data.signedUrl);
        return;
      }

      const { data } = supabase.storage.from(LEGAL_DOCUMENTS_BUCKET).getPublicUrl(selectedPdfPath);
      if (isMounted) setPreviewUrl(data?.publicUrl || '');
    };

    void resolvePreviewUrl();
    return () => {
      isMounted = false;
    };
  }, [selectedPdfPath]);

  useEffect(() => {
    if (!pdfFile) {
      setLocalPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(pdfFile);
    setLocalPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [pdfFile]);

  const handlePublish = async () => {
    if (!canManage) {
      setNotice({ kind: 'error', text: 'Only admin and staff can publish consent documents.' });
      return;
    }

    if (!pdfFile) {
      setNotice({ kind: 'error', text: 'Please upload a PDF file before publishing.' });
      return;
    }

    if (form.effectiveAt) {
      const selectedEffectiveAt = new Date(form.effectiveAt);
      if (Number.isNaN(selectedEffectiveAt.getTime()) || selectedEffectiveAt.getTime() < Date.now()) {
        setNotice({ kind: 'error', text: 'Effective At cannot be set to a past date/time.' });
        return;
      }
    }

    if (!isPdfFile(pdfFile)) {
      setNotice({ kind: 'error', text: 'Only PDF files are allowed.' });
      return;
    }

    const newVersion = getNextVersion(documents);
    const safeName = toSafeFileName(pdfFile.name);
    const actorAuthUserId = String(userProfile?.auth_user_id || '').trim();
    if (!actorAuthUserId) {
      setNotice({ kind: 'error', text: 'Missing auth_user_id in profile. Please sign out and sign in again.' });
      return;
    }
    const storagePath = `${actorAuthUserId}/legal-documents/v${newVersion.replace('.', '_')}-${Date.now()}-${safeName}`;

    try {
      setIsPublishing(true);
      setNotice({ kind: '', text: '' });

      const uploadResult = await supabase.storage
        .from(LEGAL_DOCUMENTS_BUCKET)
        .upload(storagePath, pdfFile, {
          cacheControl: '3600',
          upsert: false,
          contentType: 'application/pdf',
        });
      if (uploadResult.error) throw uploadResult.error;

      const deactivateResult = await supabase
        .from(LEGAL_DOCUMENTS_TABLE)
        .update({ is_active: false })
        .eq('document_type', CONSENT_DOCUMENT_TYPE)
        .eq('is_active', true);
      if (deactivateResult.error) throw deactivateResult.error;

      const insertResult = await supabase
        .from(LEGAL_DOCUMENTS_TABLE)
        .insert({
          document_type: CONSENT_DOCUMENT_TYPE,
          version: newVersion,
          title: CONSENT_DOCUMENT_TITLE,
          content: `Uploaded PDF consent file: ${pdfFile.name}`,
          is_active: true,
          effective_at: toIsoOrNow(form.effectiveAt),
          file_path: storagePath,
        })
        .select('legal_document_id')
        .single();
      if (insertResult.error) throw insertResult.error;

      setNotice({ kind: 'success', text: `Consent document version ${newVersion} published and set as active.` });
      setPdfFile(null);
      await logAuditAction({
        action: 'legal_documents.publish',
        description: `Published consent document v${newVersion}`,
        resource: LEGAL_DOCUMENTS_TABLE,
        status: 'success',
        userProfile,
      });
      await loadDocuments();
    } catch (error) {
      setNotice({ kind: 'error', text: mapSaveError(error?.message) });
      await logAuditAction({
        action: 'legal_documents.publish',
        description: 'Failed to publish consent document',
        resource: LEGAL_DOCUMENTS_TABLE,
        status: 'failed',
        userProfile,
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleSelectPdfFile = (fileValue) => {
    if (!fileValue) {
      return;
    }
    if (!isPdfFile(fileValue)) {
      setNotice({ kind: 'error', text: 'Only PDF files are allowed.' });
      return;
    }
    setPdfFile(fileValue);
    setNotice({ kind: '', text: '' });
  };

  const handleSetActive = async (row) => {
    const targetId = Number(row?.legal_document_id || 0);
    if (!targetId || !canManage) return;

    try {
      setIsActivatingId(targetId);
      setNotice({ kind: '', text: '' });

      const deactivateResult = await supabase
        .from(LEGAL_DOCUMENTS_TABLE)
        .update({ is_active: false })
        .eq('document_type', CONSENT_DOCUMENT_TYPE)
        .eq('is_active', true);
      if (deactivateResult.error) throw deactivateResult.error;

      const activateResult = await supabase
        .from(LEGAL_DOCUMENTS_TABLE)
        .update({ is_active: true })
        .eq('legal_document_id', targetId);
      if (activateResult.error) throw activateResult.error;

      setNotice({ kind: 'success', text: `Version ${row.version} is now active.` });
      await loadDocuments();
    } catch (error) {
      setNotice({ kind: 'error', text: mapSaveError(error?.message) });
    } finally {
      setIsActivatingId(null);
    }
  };

  return (
    <div className="space-y-6" style={rootStyle}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="role-page-title text-3xl font-bold text-gray-900">Legal Documents</h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage and publish the latest PDF consent form for minors with version history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadDocuments()}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {notice.text ? (
        <div
          className={`rounded-xl border px-3 py-2 text-sm font-medium ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : notice.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-amber-200 bg-amber-50 text-amber-700'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Publish Latest Consent Form</h2>
            <p className="mt-1 text-xs text-gray-500">
              Document type: <span className="font-semibold">{CONSENT_DOCUMENT_TITLE}</span> | Next version: <span className="font-semibold">{nextVersion}</span>
            </p>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Effective At</label>
          <input
            type="datetime-local"
            value={form.effectiveAt}
            onChange={(event) => setForm((prev) => ({ ...prev, effectiveAt: event.target.value }))}
            min={nowLocalDateTimeValue}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2"
            style={{ '--tw-ring-color': primaryColor }}
            disabled={!canManage || isPublishing}
          />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">Consent PDF File</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={(event) => handleSelectPdfFile(event.target.files?.[0] || null)}
            className="hidden"
            disabled={!canManage || isPublishing}
          />
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!canManage || isPublishing) return;
              setIsDragOver(true);
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!canManage || isPublishing) return;
              setIsDragOver(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragOver(false);
              if (!canManage || isPublishing) return;
              const droppedFile = event.dataTransfer?.files?.[0] || null;
              handleSelectPdfFile(droppedFile);
            }}
            className={`rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
              isDragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300 bg-gray-50'
            } ${!canManage || isPublishing ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            onClick={() => {
              if (!canManage || isPublishing) return;
              fileInputRef.current?.click();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (!canManage || isPublishing) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
          >
            <p className="text-sm font-semibold text-gray-700">Drag and drop PDF here</p>
            <p className="mt-1 text-xs text-gray-500">or click to browse files</p>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Bucket: <code>{LEGAL_DOCUMENTS_BUCKET}</code>. Upload the exact PDF users will sign.
          </p>
          <p className="mt-1 text-xs text-gray-600">{pdfFile?.name || 'No file selected.'}</p>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={handlePublish}
            disabled={!canManage || isPublishing}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: primaryColor }}
          >
            {isPublishing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {isPublishing ? 'Publishing...' : 'Publish New Version'}
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Version History</h2>
            <span className="text-xs text-gray-500">{documents.length} version(s)</span>
          </div>

          {!documents.length ? (
            <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
              No consent document versions yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Version</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Effective</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((row) => {
                    const isActive = Boolean(row.is_active);
                    const isActivating = isActivatingId === row.legal_document_id;
                    return (
                      <tr key={row.legal_document_id} className="border-t border-gray-100">
                        <td className="px-3 py-2 text-gray-800">{row.version || '-'}</td>
                        <td className="px-3 py-2">
                          {isActive ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                              <CheckCircle2 size={11} />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-semibold text-gray-600">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">{formatDateTime(row.effective_at)}</td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setSelectedDocumentId(row.legal_document_id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                            >
                              <Eye size={12} />
                              Preview
                            </button>
                            {!isActive ? (
                              <button
                                type="button"
                                onClick={() => handleSetActive(row)}
                                disabled={!canManage || isActivating}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-white disabled:opacity-60"
                                style={{ backgroundColor: primaryColor }}
                              >
                                {isActivating ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                                Set Active
                              </button>
                            ) : null}
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

        <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
          <h2 className="mb-2 text-lg font-semibold text-gray-900">PDF Preview</h2>
          <p className="mb-3 text-xs text-gray-500">
            Showing {selectedDocument?.version ? `v${selectedDocument.version}` : activeDocument?.version ? `active v${activeDocument.version}` : 'latest'}.
          </p>

          {localPreviewUrl || previewUrl ? (
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              <iframe
                title="Consent PDF preview"
                src={localPreviewUrl || previewUrl}
                className="h-[78vh] w-full"
              />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500">
              No PDF available for preview yet.
            </div>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
        <div className="flex items-start gap-2">
          <FileText size={14} className="mt-0.5 text-gray-500" />
          <p>
            This page manages <code>{CONSENT_DOCUMENT_TITLE}</code> records in <code>{LEGAL_DOCUMENTS_TABLE}</code>.
            Publishing creates a new version and automatically sets only one active document.
          </p>
        </div>
      </section>
    </div>
  );
}
