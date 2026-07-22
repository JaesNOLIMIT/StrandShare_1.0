import React, { useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

export default function EventApplicationSuccessPage() {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const submittedEmail = useMemo(() => {
    try {
      return String(window.sessionStorage.getItem('eventApplicationSuccessEmail') || '').trim();
    } catch {
      return '';
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 to-slate-50 px-4 py-8 md:px-8">
      <div className="mx-auto max-w-2xl rounded-3xl border border-slate-200 bg-white p-6 shadow-lg md:p-8">
        <div className="flex items-start gap-3">
          <div className="rounded-xl p-2 text-white" style={{ backgroundColor: primaryColor }}>
            <CheckCircle2 size={22} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Submission Complete</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900 md:text-3xl">Program application submitted successfully</h1>
          </div>
        </div>

        <div className="mt-4 space-y-1 text-sm text-slate-600">
          <p>Staff will use your preferred contact first and your other contact detail as the secondary option.</p>
          <p>
            A confirmation email should be sent to{' '}
            <span className="font-semibold text-slate-800">{submittedEmail || 'your submitted email address'}</span>.
          </p>
          <p className="text-xs text-slate-500">
            If it does not arrive in a few minutes, check Spam/Junk.
          </p>
        </div>

        <div className="mt-6">
          <button
            type="button"
            onClick={() => window.location.assign('/')}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            Back to Landing Page
          </button>
        </div>
      </div>
    </div>
  );
}
