import React from 'react';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';

export default function ConfirmationCompletePage() {
  const { theme } = useTheme();
  const primaryColor = theme.primaryColor || '#0f766e';
  const secondaryColor = theme.secondaryColor || '#64748b';
  const backgroundColor = theme.backgroundColor || '#f8fafc';
  const primaryTextColor = theme.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme.secondaryTextColor || '#334155';
  const brandName = theme.brandName || 'Donivra';

  const goToLogin = () => {
    if (typeof window === 'undefined') return;
    window.location.assign('/login');
  };

  return (
    <main
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        backgroundColor,
        color: primaryTextColor,
        backgroundImage: `radial-gradient(circle at 20% 18%, ${primaryColor}25 0%, transparent 40%), radial-gradient(circle at 80% 12%, ${secondaryColor}20 0%, transparent 32%)`,
      }}
    >
      <section className="w-full max-w-lg rounded-2xl border bg-white/90 p-6 shadow-xl md:p-8" style={{ borderColor: `${secondaryColor}33` }}>
        <div className="inline-flex rounded-lg p-2" style={{ backgroundColor: `${primaryColor}22`, color: primaryColor }}>
          <CheckCircle2 size={20} />
        </div>
        <h1 className="mt-4 text-2xl font-extrabold md:text-3xl">Email confirmation complete</h1>
        <p className="mt-2 text-sm md:text-base" style={{ color: secondaryTextColor }}>
          Your {brandName} email is now verified. If this request needs approval, wait for admin decision before access is activated.
        </p>

        <div className="mt-6">
          <button
            type="button"
            onClick={goToLogin}
            className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            Go To Login <ArrowRight size={15} />
          </button>
        </div>
      </section>
    </main>
  );
}

