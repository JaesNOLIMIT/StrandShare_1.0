import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useTheme } from './ThemeContext';

const ToastContext = createContext(null);
const MAX_VISIBLE_TOASTS = 1;

const TOAST_STYLES = {
  error: {
    title: 'Action not completed',
    container: 'border-rose-300 bg-rose-50 text-rose-950',
    icon: 'bg-rose-100 text-rose-700',
    titleColor: 'text-rose-800',
    Icon: AlertTriangle,
  },
  success: {
    title: 'Success',
    container: 'border-emerald-300 bg-emerald-50 text-emerald-950',
    icon: 'bg-emerald-100 text-emerald-700',
    titleColor: 'text-emerald-800',
    Icon: CheckCircle2,
  },
  warning: {
    title: 'Please review',
    container: 'border-amber-300 bg-amber-50 text-amber-950',
    icon: 'bg-amber-100 text-amber-700',
    titleColor: 'text-amber-800',
    Icon: XCircle,
  },
  info: {
    title: 'Information',
    container: 'border-sky-300 bg-sky-50 text-sky-950',
    icon: 'bg-sky-100 text-sky-700',
    titleColor: 'text-sky-800',
    Icon: Info,
  },
};

function inferToastType(message) {
  const value = String(message || '').toLowerCase();
  if (/failed|failure|unable|invalid|incorrect|expired|error|could not|not configured/.test(value)) return 'error';
  if (/required|must |wait |already|does not match|unavailable|local only/.test(value)) return 'warning';
  if (/success|saved|updated|uploaded|enabled|verified|sent|removed|loaded|created|complete/.test(value)) return 'success';
  return 'info';
}

export function ToastProvider({ children }) {
  const { theme } = useTheme();
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const timerRefs = useRef(new Map());
  const recentToastRef = useRef({ signature: '', at: 0, id: null });

  const dismissToast = useCallback((toastId) => {
    const timer = timerRefs.current.get(toastId);
    if (timer) window.clearTimeout(timer);
    timerRefs.current.delete(toastId);
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const showToast = useCallback((input, typeOrOptions = 'auto') => {
    const options = typeof input === 'object' && input !== null ? input : {};
    const message = String(options.message ?? input ?? '').trim();
    if (!message) return null;

    const requestedType = typeof typeOrOptions === 'object'
      ? typeOrOptions.type
      : typeOrOptions;
    const type = TOAST_STYLES[options.type || requestedType]
      ? (options.type || requestedType)
      : inferToastType(message);
    const signature = `${type}:${message}`;
    const now = Date.now();
    if (recentToastRef.current.signature === signature && now - recentToastRef.current.at < 1000) {
      return recentToastRef.current.id;
    }
    const toastId = ++idRef.current;
    recentToastRef.current = { signature, at: now, id: toastId };
    const duration = Number(options.duration ?? (type === 'error' ? 6500 : 4500));
    const toast = {
      id: toastId,
      type,
      title: String(options.title || TOAST_STYLES[type].title),
      message,
    };

    setToasts((current) => [...current, toast].slice(-MAX_VISIBLE_TOASTS));
    if (duration > 0) {
      const timer = window.setTimeout(() => dismissToast(toastId), duration);
      timerRefs.current.set(toastId, timer);
    }
    return toastId;
  }, [dismissToast]);

  useEffect(() => () => {
    timerRefs.current.forEach((timer) => window.clearTimeout(timer));
    timerRefs.current.clear();
  }, []);

  useEffect(() => {
    const handleGlobalToast = (event) => {
      const detail = event?.detail || {};
      showToast(detail.message, {
        type: detail.type || 'auto',
        title: detail.title,
        duration: detail.duration,
      });
    };
    window.addEventListener('Donivra:toast', handleGlobalToast);
    return () => window.removeEventListener('Donivra:toast', handleGlobalToast);
  }, [showToast]);

  const value = useMemo(() => ({ showToast, dismissToast }), [dismissToast, showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[10050] flex w-[calc(100vw-2rem)] max-w-sm flex-col-reverse gap-2 sm:bottom-5 sm:right-5"
        aria-live="polite"
        aria-relevant="additions removals"
      >
        {toasts.map((toast) => {
          const style = TOAST_STYLES[toast.type];
          const Icon = style.Icon;
          return (
            <div
              key={toast.id}
              role={toast.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3 py-2.5 shadow-2xl backdrop-blur-sm toast-slide-in ${style.container}`}
            >
              <div className={`mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full ${style.icon}`}>
                <Icon size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-bold leading-5 ${style.titleColor}`}>{toast.title}</p>
                <p className="mt-0.5 break-words text-xs leading-5 text-slate-700">{toast.message}</p>
              </div>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="-mr-1 -mt-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-black/5 hover:text-slate-700"
                aria-label="Dismiss notification"
                style={{ '--toast-focus-color': theme?.primaryColor || '#0f766e' }}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes toast-slide-in {
          from { opacity: 0; transform: translate3d(22px, 10px, 0); }
          to { opacity: 1; transform: translate3d(0, 0, 0); }
        }
        .toast-slide-in { animation: toast-slide-in 180ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .toast-slide-in { animation: none; }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}
