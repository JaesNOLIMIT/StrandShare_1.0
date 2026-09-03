import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  Droplet,
  FileText,
  Hash,
  Loader2,
  Paintbrush,
  Ruler,
  Save,
  Scissors,
  ShieldCheck,
  Sparkles,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { useToast } from '../../../context/ToastContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const WIG_REQUIREMENTS_TABLE = 'wig_requirements';
const USERS_TABLE = 'users';

const EMPTY_FORM = {
  minimumNumberDonor: '',
  minimumHairLength: '',
  chemicalTreatmentStatus: false,
  coloredHairStatus: false,
  bleachedHairStatus: false,
  rebondedHairStatus: false,
  hairTextureStatus: '',
  notes: '',
};

const TREATMENT_TOGGLES = [
  {
    key: 'chemicalTreatmentStatus',
    label: 'Chemical Treatment',
    description: 'Permed, relaxed, or other chemically processed hair.',
    icon: Beaker,
  },
  {
    key: 'coloredHairStatus',
    label: 'Colored Hair',
    description: 'Dyed or color-treated hair.',
    icon: Paintbrush,
  },
  {
    key: 'bleachedHairStatus',
    label: 'Bleached Hair',
    description: 'Lightened with bleach or peroxide-based products.',
    icon: Droplet,
  },
  {
    key: 'rebondedHairStatus',
    label: 'Rebonded Hair',
    description: 'Hair that has undergone chemical straightening.',
    icon: Sparkles,
  },
];

function normalizeRoleKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function toIntegerOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function toDecimalOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function mapLoadError(rawMessage) {
  const message = String(rawMessage || 'Unable to load wig requirements.');
  const lower = message.toLowerCase();
  if (lower.includes('does not exist') && lower.includes('wig_requirements')) {
    return 'wig_requirements table is missing. Run migration 067_create_wig_requirements.sql.';
  }
  if (lower.includes('row-level security')) {
    return 'Reading wig requirements is blocked by database policy.';
  }
  if (lower.includes('get_or_create_wig_requirements') && lower.includes('schema cache')) {
    return 'Wig Requirements is not initialized yet. Apply the latest Supabase migration, then refresh this page.';
  }
  return message;
}

function mapSaveError(rawMessage) {
  const message = String(rawMessage || 'Unable to save wig requirements.');
  const lower = message.toLowerCase();
  if (lower.includes('row-level security')) {
    return 'Saving is blocked by database policy. Only admin and staff can update wig requirements.';
  }
  if (lower.includes('does not exist') && lower.includes('wig_requirements')) {
    return 'wig_requirements table is missing. Run migration 067_create_wig_requirements.sql.';
  }
  return message;
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

function parseTextureChips(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function SectionCard({ icon: Icon, title, description, accentColor, children, footer }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <div
          className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-white shadow-sm"
          style={{ backgroundColor: accentColor || '#0f766e' }}
        >
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
      {footer && <div className="border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div>}
    </section>
  );
}

function ToggleCard({ active, disabled, onToggle, icon: Icon, label, description, accentColor }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onToggle()}
      disabled={disabled}
      aria-pressed={active}
      className={`group relative flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? 'border-transparent text-white shadow-md'
          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
      }`}
      style={active ? { backgroundColor: accentColor } : undefined}
    >
      <div
        className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg transition ${
          active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200'
        }`}
      >
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className={`text-sm font-bold ${active ? 'text-white' : 'text-slate-900'}`}>{label}</p>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {active ? <><CheckCircle2 size={10} /> Allowed</> : <><X size={10} /> Not Allowed</>}
          </span>
        </div>
        <p className={`mt-1 text-xs leading-relaxed ${active ? 'text-white/90' : 'text-slate-500'}`}>
          {description}
        </p>
      </div>
    </button>
  );
}

function NumberField({ label, icon: Icon, unit, value, onChange, disabled, min = '0', step = '1', placeholder, helper, accentColor }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
        <Icon size={11} />
        {label}
      </span>
      <div className="relative">
        <input
          type="number"
          min={min}
          step={step}
          value={value}
          onChange={onChange}
          disabled={disabled}
          placeholder={placeholder}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 pr-14 text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
          style={{ '--tw-ring-color': accentColor ? `${accentColor}33` : undefined }}
        />
        {unit && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">
            {unit}
          </span>
        )}
      </div>
      {helper && <span className="text-[11px] text-slate-500">{helper}</span>}
    </label>
  );
}

export default function WigRequirementsPage({ userProfile }) {
  const { theme } = useTheme();
  const { showToast } = useToast();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const roleKey = normalizeRoleKey(userProfile?.role);
  const canEdit = roleKey === 'admin' || roleKey === 'staff' || roleKey === 'superadmin';

  const [form, setForm] = useState(EMPTY_FORM);
  const [originalForm, setOriginalForm] = useState(EMPTY_FORM);
  const [wigRequirementId, setWigRequirementId] = useState(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [updatedBy, setUpdatedBy] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });

  useEffect(() => {
    if (!notice.text || !['error', 'success'].includes(notice.kind)) return;
    showToast({
      type: notice.kind,
      title: notice.kind === 'error' ? 'Wig Requirements unavailable' : 'Wig Requirements updated',
      message: notice.text,
    });
    setNotice({ kind: '', text: '' });
  }, [notice, showToast]);

  const applyRowToForm = useCallback((row) => {
    if (!row) return;

    setWigRequirementId(row.Wig_Requirement_ID || null);
    setUpdatedAt(row.Updated_At || '');
    setUpdatedBy(row.Updated_By || null);
    const nextForm = {
      minimumNumberDonor: row.Minimum_Number_Donor ?? '',
      minimumHairLength: row.Minimum_Hair_Length ?? '',
      chemicalTreatmentStatus: Boolean(row.Chemical_Treatment_Status),
      coloredHairStatus: Boolean(row.Colored_Hair_Status),
      bleachedHairStatus: Boolean(row.Bleached_Hair_Status),
      rebondedHairStatus: Boolean(row.Rebonded_Hair_Status),
      hairTextureStatus: String(row.Hair_Texture_Status || ''),
      notes: String(row.Notes || ''),
    };
    setForm(nextForm);
    setOriginalForm(nextForm);
  }, []);

  const resolveActorUserId = useCallback(async () => {
    if (userProfile?.user_id) {
      return Number(userProfile.user_id) || null;
    }

    if (!supabase) {
      return null;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData?.session?.user?.id) {
      return null;
    }

    const authUserId = sessionData.session.user.id;
    const result = await supabase
      .from(USERS_TABLE)
      .select('user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    return result?.data?.user_id || null;
  }, [userProfile?.user_id]);

  const loadWigRequirements = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });

    try {
      const result = await supabase
        .from(WIG_REQUIREMENTS_TABLE)
        .select('*')
        .order('Wig_Requirement_ID', { ascending: true })
        .limit(1);

      if (result.error) throw result.error;

      let row = Array.isArray(result.data) ? result.data[0] : null;
      if (!row) {
        const repairResult = await supabase.rpc('get_or_create_wig_requirements');
        if (repairResult.error) throw repairResult.error;
        row = Array.isArray(repairResult.data) ? repairResult.data[0] : repairResult.data;
        if (!row) throw new Error('The wig requirements singleton could not be initialized.');
      }

      applyRowToForm(row);
    } catch (error) {
      setNotice({ kind: 'error', text: mapLoadError(error?.message) });
    } finally {
      setIsLoading(false);
    }
  }, [applyRowToForm]);

  useEffect(() => {
    void loadWigRequirements();
  }, [loadWigRequirements]);

  const handleFieldChange = (key) => (event) => {
    const value = event?.target?.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const toggleField = (key) => {
    setForm((previous) => ({
      ...previous,
      [key]: !previous[key],
    }));
  };

  const handleReset = () => {
    setForm(originalForm);
    setNotice({ kind: '', text: '' });
  };

  const handleSave = async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      return;
    }

    if (!canEdit) {
      setNotice({ kind: 'error', text: 'You are not allowed to edit wig requirements.' });
      return;
    }

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      let targetRequirementId = wigRequirementId;
      if (!targetRequirementId) {
        const repairResult = await supabase.rpc('get_or_create_wig_requirements');
        if (repairResult.error) throw repairResult.error;
        const repairedRow = Array.isArray(repairResult.data) ? repairResult.data[0] : repairResult.data;
        targetRequirementId = Number(repairedRow?.Wig_Requirement_ID || 0) || null;
        if (!targetRequirementId) throw new Error('The Wig Requirements record could not be initialized.');
      }

      const actorUserId = await resolveActorUserId();
      const payload = {
        Minimum_Number_Donor: toIntegerOrNull(form.minimumNumberDonor),
        Minimum_Hair_Length: toDecimalOrNull(form.minimumHairLength),
        Chemical_Treatment_Status: Boolean(form.chemicalTreatmentStatus),
        Colored_Hair_Status: Boolean(form.coloredHairStatus),
        Bleached_Hair_Status: Boolean(form.bleachedHairStatus),
        Rebonded_Hair_Status: Boolean(form.rebondedHairStatus),
        Hair_Texture_Status: String(form.hairTextureStatus || '').trim() || null,
        Notes: String(form.notes || '').trim() || null,
        Updated_By: actorUserId,
        Updated_At: new Date().toISOString(),
      };

      const result = await supabase
        .from(WIG_REQUIREMENTS_TABLE)
        .update(payload)
        .eq('Wig_Requirement_ID', targetRequirementId)
        .select('*')
        .single();

      if (result.error) throw result.error;

      applyRowToForm(result.data);
      setNotice({ kind: 'success', text: 'Wig requirements updated successfully.' });
    } catch (error) {
      setNotice({ kind: 'error', text: mapSaveError(error?.message) });
    } finally {
      setIsSaving(false);
    }
  };

  const isDirty = useMemo(() => {
    return Object.keys(EMPTY_FORM).some((key) => {
      const a = form[key];
      const b = originalForm[key];
      if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) !== Boolean(b);
      return String(a ?? '') !== String(b ?? '');
    });
  }, [form, originalForm]);

  const textureChips = useMemo(() => parseTextureChips(form.hairTextureStatus), [form.hairTextureStatus]);
  const allowedCount = TREATMENT_TOGGLES.filter((toggle) => Boolean(form[toggle.key])).length;

  const canSave = canEdit && isDirty && !isSaving && !isLoading;

  return (
    <div className="space-y-5 pb-24">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Wig Requirements</h2>
            <p className="mt-0.5 text-sm text-slate-600">
              Global qualification standards for hair donations. Updates apply to the shared rule set.
            </p>
          </div>
          {isDirty && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">
              <AlertTriangle size={11} />
              Unsaved changes
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-3">
          <div className="bg-white px-5 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Row ID</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-800">{wigRequirementId || 'N/A'}</p>
          </div>
          <div className="bg-white px-5 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Last Updated</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-800">{formatDateTime(updatedAt)}</p>
          </div>
          <div className="bg-white px-5 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Updated By</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-800">
              {updatedBy ? `User #${updatedBy}` : 'N/A'}
            </p>
          </div>
        </div>
      </section>

      {!canEdit && (
        <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          <ShieldCheck size={16} className="mt-0.5 flex-none" />
          <span>You are viewing this page in read-only mode. Only admin and staff accounts can edit wig requirements.</span>
        </div>
      )}

      {isLoading && !wigRequirementId ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-16 text-sm text-slate-600 shadow-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading wig requirements...
        </div>
      ) : (
        <>
          {/* Donation Thresholds */}
          <SectionCard
            icon={Ruler}
            title="Donation Thresholds"
            description="Minimum quantities before a hair donation qualifies for wig production."
            accentColor={primaryColor}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <NumberField
                label="Minimum Number of Donors"
                icon={Users}
                unit="donors"
                value={form.minimumNumberDonor}
                onChange={handleFieldChange('minimumNumberDonor')}
                disabled={!canEdit}
                min="0"
                step="1"
                placeholder="e.g., 5"
                helper="Minimum donors required to bundle into a single wig."
                accentColor={primaryColor}
              />
              <NumberField
                label="Minimum Hair Length"
                icon={Hash}
                unit="inches"
                value={form.minimumHairLength}
                onChange={handleFieldChange('minimumHairLength')}
                disabled={!canEdit}
                min="0"
                step="0.1"
                placeholder="e.g., 8"
                helper="Shortest acceptable hair length per donation."
                accentColor={primaryColor}
              />
            </div>
          </SectionCard>

          {/* Treatments */}
          <SectionCard
            icon={Scissors}
            title="Allowed Hair Treatments"
            description="Toggle which chemically treated hair types are acceptable."
            accentColor={primaryColor}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 size={12} className="text-emerald-600" />
                  {allowedCount} of {TREATMENT_TOGGLES.length} treatments allowed
                </span>
                <span className="text-slate-400">Click a card to toggle</span>
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {TREATMENT_TOGGLES.map((toggle) => (
                <ToggleCard
                  key={toggle.key}
                  icon={toggle.icon}
                  label={toggle.label}
                  description={toggle.description}
                  active={Boolean(form[toggle.key])}
                  disabled={!canEdit}
                  onToggle={() => toggleField(toggle.key)}
                  accentColor={primaryColor}
                />
              ))}
            </div>
          </SectionCard>

          {/* Texture + Notes */}
          <SectionCard
            icon={FileText}
            title="Texture & Internal Notes"
            description="Acceptable hair textures and additional guidance for screeners."
            accentColor={primaryColor}
          >
            <div className="space-y-4">
              <label className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  <Sparkles size={11} />
                  Hair Texture Status
                </span>
                <input
                  type="text"
                  value={form.hairTextureStatus}
                  onChange={handleFieldChange('hairTextureStatus')}
                  disabled={!canEdit}
                  placeholder="Comma-separated, e.g., Straight, Wavy, Curly"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50"
                />
                {textureChips.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1.5">
                    {textureChips.map((chip, index) => (
                      <span
                        key={`${chip}-${index}`}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                )}
                <span className="text-[11px] text-slate-500">Separate textures with commas. Each entry shows as a chip.</span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  <FileText size={11} />
                  Notes
                </span>
                <textarea
                  value={form.notes}
                  onChange={handleFieldChange('notes')}
                  disabled={!canEdit}
                  rows={4}
                  placeholder="Additional guidance for donation qualifiers and screeners."
                  className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50"
                />
                <span className="text-[11px] text-slate-500">
                  Optional. Visible to staff during intake.
                </span>
              </label>
            </div>
          </SectionCard>
        </>
      )}

      {/* Sticky action bar */}
      {canEdit && (
        <div
          className={`fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.15)] backdrop-blur transition-all duration-200 ${
            isDirty ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0 pointer-events-none'
          }`}
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <AlertTriangle size={15} className="text-amber-500" />
              <span className="font-semibold">You have unsaved changes.</span>
              <span className="hidden text-slate-500 sm:inline">Save them before navigating away.</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleReset}
                disabled={isSaving || !isDirty}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
              >
                <Undo2 size={14} />
                Discard
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
                style={{ backgroundColor: primaryColor }}
              >
                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
