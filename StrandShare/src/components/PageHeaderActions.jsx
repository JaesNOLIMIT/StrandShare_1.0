import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, Loader2, RefreshCw, X } from 'lucide-react';
import { usePageActivity } from '../context/PageActivityContext';

export default function PageHeaderActions({
  onRefresh,
  refreshDisabled = false,
  refreshLoading = false,
  onHelp,
  helpTitle = 'About this page',
  helpContent,
  refreshLabel = 'Refresh',
  autoRefreshOnChanges = true,
}) {
  const isPageActive = usePageActivity();
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  useEffect(() => {
    if (!isPageActive) setIsHelpOpen(false);
  }, [isPageActive]);

  const openHelp = () => {
    if (typeof onHelp === 'function') {
      onHelp();
      return;
    }
    setIsHelpOpen(true);
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={openHelp}
          aria-label={`Help: ${helpTitle}`}
          title={helpTitle}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 shadow-sm transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <HelpCircle size={17} />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshDisabled || refreshLoading}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          {refreshLabel}
        </button>
      </div>

      {isHelpOpen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[10060] flex items-center justify-center bg-slate-950/60 p-4" role="presentation" onMouseDown={() => setIsHelpOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-help-title"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Page guide</p>
                <h2 id="page-help-title" className="mt-1 text-lg font-bold text-slate-950">{helpTitle}</h2>
              </div>
              <button type="button" onClick={() => setIsHelpOpen(false)} aria-label="Close help" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100">
                <X size={17} />
              </button>
            </header>
            <div className="space-y-3 bg-white px-5 py-4 text-sm leading-6 text-slate-700">
              {helpContent}
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">
                {autoRefreshOnChanges
                  ? 'This page keeps its current data when you navigate away. While the page is open, related database changes refresh it automatically. Use Refresh whenever you want to request the newest data immediately.'
                  : 'This page keeps its current data when you navigate away and does not repeatedly reload. Use Refresh whenever you want to request the newest data immediately.'}
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
