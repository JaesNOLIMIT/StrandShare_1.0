import React, { useState } from 'react';
import { ExternalLink, FileText, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { formatManilaDateTime } from '../lib/manilaTime';

export default function LegalTermsGate({
  title, description, document, previewUrl, isLoading, error, checked,
  onCheckedChange, accentColor = '#0f766e', showHeader = true,
  previewClassName = 'h-[60vh]',
}) {
  const canAccept = Boolean(document?.legal_document_id && previewUrl && !isLoading && !error);
  const [isPreviewMinimized, setIsPreviewMinimized] = useState(false);

  return (
    <div className="space-y-4">
      {showHeader ? (
        <div>
          <h1 className="text-2xl font-bold text-slate-900 md:text-3xl">{title}</h1>
          <p className="mt-2 text-sm text-slate-600">{description}</p>
        </div>
      ) : null}

      {isLoading ? (
        <div className={`flex items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-sm text-slate-600 ${previewClassName}`}>
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading the active PDF...
        </div>
      ) : error ? (
        <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-900">
          <FileText size={28} />
          <p className="mt-3 font-semibold">Application is not available right now.</p>
          <p className="mt-1 text-amber-800">
            Contact Donivra at{' '}
            <a href="mailto:donivraproject@gmail.com" className="font-bold underline">donivraproject@gmail.com</a>.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
              <div className="min-w-0 text-left">
                <p className="truncate text-xs font-bold text-slate-800">{document.title}</p>
                <p className="text-[11px] text-slate-500">Version {document.version}</p>
              </div>
              <div className="flex items-center gap-2">
                <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                  <ExternalLink size={13} /> Open PDF
                </a>
                <button type="button" onClick={() => setIsPreviewMinimized((value) => !value)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50" aria-expanded={!isPreviewMinimized}>
                  {isPreviewMinimized ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
                  {isPreviewMinimized ? 'Show preview' : 'Minimize'}
                </button>
              </div>
            </div>
            {!isPreviewMinimized && <iframe title={`${document.title} PDF preview`} src={previewUrl} className={`w-full bg-white ${previewClassName}`} />}
          </div>
          <p className="text-xs text-slate-500">
            {document.title} · Version {document.version}
            {' · '}Effective {formatManilaDateTime(document.effective_at)} (UTC+8)
            {document.created_at ? ` · Uploaded ${formatManilaDateTime(document.created_at)} (UTC+8)` : ''}. If the preview does not load,{' '}
            <a href={previewUrl} target="_blank" rel="noreferrer" className="font-semibold underline">open the PDF in a new tab</a>.
          </p>
        </>
      )}

      <label className={`flex items-start gap-2 rounded-xl border px-3 py-3 text-sm ${canAccept ? 'border-slate-200 bg-white text-slate-700' : 'border-slate-200 bg-slate-100 text-slate-400'}`}>
        <input
          type="checkbox"
          checked={Boolean(checked)}
          onChange={(event) => onCheckedChange(event.target.checked)}
          disabled={!canAccept}
          className="mt-0.5 h-4 w-4 rounded border-slate-300"
          style={{ accentColor }}
        />
        <span>I have reviewed this entire PDF and agree to its terms and conditions.</span>
      </label>
    </div>
  );
}
