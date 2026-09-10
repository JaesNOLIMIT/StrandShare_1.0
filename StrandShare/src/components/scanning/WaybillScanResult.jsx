import React from 'react';
import { AlertTriangle, CheckCircle2, Info, ListChecks, XCircle } from 'lucide-react';

const TONES = {
  success: {
    box: 'border-emerald-200 bg-emerald-50',
    icon: 'text-emerald-700',
    badge: 'border-emerald-200 bg-white text-emerald-700',
    Icon: CheckCircle2,
  },
  warning: {
    box: 'border-amber-200 bg-amber-50',
    icon: 'text-amber-700',
    badge: 'border-amber-200 bg-white text-amber-700',
    Icon: AlertTriangle,
  },
  error: {
    box: 'border-rose-200 bg-rose-50',
    icon: 'text-rose-700',
    badge: 'border-rose-200 bg-white text-rose-700',
    Icon: XCircle,
  },
  info: {
    box: 'border-sky-200 bg-sky-50',
    icon: 'text-sky-700',
    badge: 'border-sky-200 bg-white text-sky-700',
    Icon: Info,
  },
};

export default function WaybillScanResult({ outcome = null, possibleOutcomes = [] }) {
  const tone = TONES[outcome?.tone] || TONES.info;
  const Icon = tone.Icon;

  return (
    <div className="space-y-2">
      {outcome ? (
        <section className={`rounded-xl border p-3 ${tone.box}`} aria-live="polite">
          <div className="flex items-start gap-2.5">
            <Icon size={18} className={`mt-0.5 shrink-0 ${tone.icon}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Latest scan result</p>
                {outcome.status ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.badge}`}>
                    {outcome.status}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm font-bold text-slate-900">{outcome.title || 'Waybill processed'}</p>
              <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-slate-700 sm:grid-cols-2">
                {outcome.waybill ? <p><strong>Waybill:</strong> <span className="font-mono">{outcome.waybill}</span></p> : null}
                {outcome.subject ? <p><strong>Person/item:</strong> {outcome.subject}</p> : null}
                {outcome.action ? <p><strong>Completed:</strong> {outcome.action}</p> : null}
                {outcome.nextStep ? <p><strong>Next:</strong> {outcome.nextStep}</p> : null}
              </div>
              <div className="mt-2 rounded-lg border border-black/5 bg-white/70 px-2.5 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Status changes</p>
                {outcome.statusChanges?.length ? (
                  <ul className="mt-1 space-y-1 text-xs text-slate-700">
                    {outcome.statusChanges.map((change) => (
                      <li key={`${change.label}-${change.before}-${change.after}`} className="flex flex-wrap items-center gap-1">
                        <strong>{change.label}:</strong>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{change.before || 'None'}</span>
                        <span aria-hidden="true">→</span>
                        <span className="rounded bg-white px-1.5 py-0.5 font-semibold">{change.after || 'None'}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs font-medium text-slate-600">No status changed.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {possibleOutcomes.length ? (
        <details className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-slate-700">
            <ListChecks size={14} />
            Show all possible scan results
          </summary>
          <ul className="mt-2 space-y-1.5 border-t border-slate-100 pt-2 text-[11px] leading-5 text-slate-600">
            {possibleOutcomes.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
