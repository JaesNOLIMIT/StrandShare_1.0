import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  ImagePlus,
  Loader2,
  Lock,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react';

import { supabase } from '../../../../lib/supabaseClient';
import { logAuditAction } from '../../../../lib/auditLogger';
import PhotoTryOn, { DEFAULT_TRY_ON_FIT } from './PhotoTryOn';
import {
  CAP_SIZE_OPTIONS,
  COLOR_OPTIONS,
  DENSITY_OPTIONS,
  DUPLICATE_WARNING_THRESHOLD,
  EMPTY_WIG_FORM,
  FILTERS_BUCKET,
  LOW_STOCK_THRESHOLD,
  TEXTURE_OPTIONS,
  checkerboardStyle,
  codePrefix,
  confidencePercent,
  formatWigCodePreview,
  getPublicUrl,
  inventoryForLocalAnalysis,
  requiredDetailsMissing,
  rescoreDuplicateMatches,
  withAlpha,
} from './wigCatalogUtils';

const FILTERS_TABLE = 'Wig_AI_Filters';
const configuredAiServerUrl = String(process.env.REACT_APP_AI_SERVER_URL || '').trim();
const AI_SERVER_BASE_URL = (
  configuredAiServerUrl && !configuredAiServerUrl.startsWith('/')
    ? configuredAiServerUrl
    : 'http://127.0.0.1:8000'
).replace(/\/+$/, '');
const LOCAL_AI_OFFLINE_MESSAGE =
  'Local AI is offline. Start the Donivra Local AI service on this computer and allow Local Network Access if your browser asks. Then choose Check again. Refreshing this page does not start a local program.';
const POLL_MS = 1800;
const OFFLINE_RECHECK_MS = 10000;

function Step({ number, label, active, done }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
          done
            ? 'border-emerald-500 bg-emerald-500 text-white'
            : active
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-300 bg-white text-slate-500'
        }`}
      >
        {done ? <Check size={13} /> : number}
      </span>
      <span className={`truncate text-xs font-semibold ${active || done ? 'text-slate-800' : 'text-slate-400'}`}>
        {label}
      </span>
    </div>
  );
}

function SuggestionBadge({ suggestion, onApply }) {
  if (!suggestion || !suggestion.value) return null;
  return (
    <button
      type="button"
      onClick={onApply}
      className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-100"
      title="Apply this local AI suggestion"
    >
      <Sparkles size={9} /> {suggestion.value} · {confidencePercent(suggestion)}%
    </button>
  );
}

function FieldShell({ label, required, suggestion, onApplySuggestion, children, hint }) {
  return (
    <label className="block">
      <span className="flex min-h-[20px] flex-wrap items-center justify-between gap-1">
        <span className="text-xs font-semibold text-slate-700">
          {label} {required ? <span className="text-red-500">*</span> : null}
        </span>
        <SuggestionBadge suggestion={suggestion} onApply={onApplySuggestion} />
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] text-slate-500">{hint}</span> : null}
    </label>
  );
}

const fieldClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-slate-600 focus:ring-2 focus:ring-slate-100';

function WigDetailsForm({
  form,
  setField,
  suggestions = {},
  primaryColor,
  showWigCode = false,
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <FieldShell
        label="Wig name"
        required
        suggestion={suggestions.wigName}
        onApplySuggestion={() => setField('wigName', suggestions.wigName?.value || '')}
      >
        <input
          type="text"
          value={form.wigName}
          onChange={(event) => setField('wigName', event.target.value)}
          placeholder="e.g. Long Layered Curl"
          className={fieldClass}
        />
      </FieldShell>

      {showWigCode ? (
        <FieldShell
          label="Wig code"
          required
          hint="Generated after local AI review"
        >
          <div
            className="mt-1 flex min-h-[42px] items-center rounded-lg border px-3 font-mono text-sm font-semibold"
            style={{
              borderColor: withAlpha(primaryColor, 0.28),
              backgroundColor: withAlpha(primaryColor, 0.045),
              color: form.wigCode ? '#0f172a' : '#64748b',
            }}
          >
            {form.wigCode || formatWigCodePreview(form.hairTexture, form.capSize)}
          </div>
        </FieldShell>
      ) : null}

      <FieldShell
        label="Hair length"
        required
        suggestion={suggestions.hairLength}
        onApplySuggestion={() => setField('hairLength', suggestions.hairLength?.value || '')}
        hint="Approximate inches; verify before submission"
      >
        <div className="relative">
          <input
            type="number"
            min="1"
            max="40"
            step="0.5"
            value={form.hairLength}
            onChange={(event) => setField('hairLength', event.target.value)}
            placeholder="14"
            className={`${fieldClass} pr-12`}
          />
          <span className="pointer-events-none absolute right-3 top-[18px] text-xs text-slate-400">in</span>
        </div>
      </FieldShell>

      <FieldShell
        label="Hair color"
        required
        suggestion={suggestions.hairColor}
        onApplySuggestion={() => setField('hairColor', suggestions.hairColor?.value || '')}
      >
        <select
          value={form.hairColor}
          onChange={(event) => setField('hairColor', event.target.value)}
          className={fieldClass}
        >
          <option value="">Select color</option>
          {COLOR_OPTIONS.map((option) => <option key={option}>{option}</option>)}
        </select>
      </FieldShell>

      <FieldShell
        label="Hair texture"
        required
        suggestion={suggestions.hairTexture}
        onApplySuggestion={() => setField('hairTexture', suggestions.hairTexture?.value || '')}
        hint="Wavy, curly, and coily use C in the code"
      >
        <select
          value={form.hairTexture}
          onChange={(event) => setField('hairTexture', event.target.value)}
          className={fieldClass}
        >
          <option value="">Select texture</option>
          {TEXTURE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
        </select>
      </FieldShell>

      <FieldShell
        label="Hair density"
        required
        suggestion={suggestions.hairDensity}
        onApplySuggestion={() => setField('hairDensity', suggestions.hairDensity?.value || '')}
      >
        <select
          value={form.hairDensity}
          onChange={(event) => setField('hairDensity', event.target.value)}
          className={fieldClass}
        >
          <option value="">Select density</option>
          {DENSITY_OPTIONS.map((option) => <option key={option}>{option}</option>)}
        </select>
      </FieldShell>

      <FieldShell
        label="Cap size"
        required
        hint="Cannot be identified reliably from a photo"
      >
        <select
          value={form.capSize}
          onChange={(event) => setField('capSize', event.target.value)}
          className={fieldClass}
        >
          <option value="">Select cap size</option>
          {CAP_SIZE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
        </select>
      </FieldShell>

      <FieldShell
        label="Style"
        required
        suggestion={suggestions.style}
        onApplySuggestion={() => setField('style', suggestions.style?.value || '')}
      >
        <input
          type="text"
          value={form.style}
          onChange={(event) => setField('style', event.target.value)}
          placeholder="e.g. Layered Bob"
          className={fieldClass}
        />
      </FieldShell>

      <FieldShell label="Starting stock" required>
        <input
          type="number"
          min="0"
          step="1"
          value={form.stockCount}
          onChange={(event) => setField('stockCount', event.target.value)}
          className={fieldClass}
        />
      </FieldShell>

    </div>
  );
}

function AiStatusPill({ health, onRetry }) {
  const online = health.state === 'online';
  return (
    <button
      type="button"
      onClick={() => onRetry()}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold ${
        online
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : health.state === 'checking'
            ? 'border-slate-200 bg-slate-50 text-slate-600'
            : 'border-red-200 bg-red-50 text-red-700'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-500' : health.state === 'checking' ? 'bg-slate-400' : 'bg-red-500'}`} />
      {online ? 'Local AI ready' : health.state === 'checking' ? 'Checking local AI' : 'Local AI is offline'}
      {health.state === 'checking' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
    </button>
  );
}

export default function AddWigTab({
  authUserId,
  userIdInt,
  userProfile,
  inventory,
  primaryColor,
  onCreated,
}) {
  const fileInputRef = useRef(null);
  const appliedSuggestionsRef = useRef(null);
  const codeRequestRef = useRef(0);
  const [form, setForm] = useState({ ...EMPTY_WIG_FORM });
  const [wigPhoto, setWigPhoto] = useState(null);
  const [currentFilter, setCurrentFilter] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [notice, setNotice] = useState({ kind: '', message: '' });
  const [health, setHealth] = useState({ state: 'checking', details: null });
  const [fit, setFit] = useState(() => ({
    full_wig: { ...DEFAULT_TRY_ON_FIT.full_wig },
  }));
  const [portraitReady, setPortraitReady] = useState(false);
  const [detailsConfirmed, setDetailsConfirmed] = useState(false);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);
  const [reviewComplete, setReviewComplete] = useState(false);
  const [reservedFor, setReservedFor] = useState('');

  const wigPhotoUrl = useMemo(
    () => (wigPhoto ? URL.createObjectURL(wigPhoto) : ''),
    [wigPhoto],
  );
  useEffect(() => () => {
    if (wigPhotoUrl) URL.revokeObjectURL(wigPhotoUrl);
  }, [wigPhotoUrl]);

  const suggestions = currentFilter?.AI_Suggestions || {};
  const processedImageUrl = getPublicUrl(
    FILTERS_BUCKET,
    currentFilter?.Layer_Full_Wig_Path,
  );
  const status = currentFilter?.Status || '';
  const isReview = status === 'pending_review';
  const isProcessing = status === 'processing';
  const isFailed = status === 'failed';

  const checkHealth = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setHealth({ state: 'checking', details: null });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(`${AI_SERVER_BASE_URL}/health`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.status !== 'ok' || data?.mode !== 'local-only') {
        throw new Error('Unexpected health response');
      }
      setHealth({ state: 'online', details: data });
      return true;
    } catch {
      setHealth({ state: 'offline', details: null });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    if (health.state !== 'offline' || currentFilter) return undefined;
    const timer = setInterval(() => {
      void checkHealth({ silent: true });
    }, OFFLINE_RECHECK_MS);
    return () => clearInterval(timer);
  }, [checkHealth, currentFilter, health.state]);

  const setField = useCallback((field, value) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setDetailsConfirmed(false);
    if (field !== 'wigCode') setDuplicateConfirmed(false);
  }, []);

  useEffect(() => {
    if (!isProcessing || !currentFilter?.Filter_ID || !supabase) return undefined;
    let cancelled = false;
    const poll = async () => {
      const result = await supabase
        .from(FILTERS_TABLE)
        .select('*')
        .eq('Filter_ID', currentFilter.Filter_ID)
        .maybeSingle();
      if (!cancelled && result.data) setCurrentFilter(result.data);
      if (!cancelled && result.error) {
        setNotice({ kind: 'error', message: result.error.message });
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentFilter?.Filter_ID, isProcessing]);

  useEffect(() => {
    if (!isReview || !currentFilter?.Filter_ID) return;
    if (appliedSuggestionsRef.current === currentFilter.Filter_ID) return;
    appliedSuggestionsRef.current = currentFilter.Filter_ID;
    setForm((previous) => {
      const next = { ...previous };
      [
        'wigName',
        'hairLength',
        'hairColor',
        'hairTexture',
        'hairDensity',
        'style',
      ].forEach((field) => {
        if (String(next[field] || '').trim()) return;
        const suggestion = currentFilter.AI_Suggestions?.[field];
        if (suggestion?.value !== undefined && suggestion?.value !== null) {
          next[field] = String(suggestion.value);
        }
      });
      return next;
    });
  }, [currentFilter, isReview]);

  const codeKey = codePrefix(form.hairTexture, form.capSize);
  useEffect(() => {
    if (!isReview || !codeKey || reservedFor === codeKey || !supabase) return;
    const requestId = codeRequestRef.current + 1;
    codeRequestRef.current = requestId;
    const reserve = async () => {
      const result = await supabase.rpc('reserve_wig_catalog_code', {
        p_hair_texture: form.hairTexture,
        p_cap_size: form.capSize,
      });
      if (codeRequestRef.current !== requestId) return;
      if (result.error) {
        setNotice({
          kind: 'error',
          message: `Could not generate the wig code: ${result.error.message}`,
        });
        return;
      }
      setReservedFor(codeKey);
      setForm((previous) => ({ ...previous, wigCode: String(result.data || '') }));
    };
    void reserve();
  }, [codeKey, form.capSize, form.hairTexture, isReview, reservedFor]);

  const duplicateMatches = useMemo(
    () => rescoreDuplicateMatches(currentFilter?.Duplicate_Matches || [], form),
    [currentFilter?.Duplicate_Matches, form],
  );
  const warningMatches = duplicateMatches.filter(
    (match) => match.score >= DUPLICATE_WARNING_THRESHOLD,
  );
  const needsDuplicateConfirmation =
    warningMatches.length > 0
    || (currentFilter?.Duplicate_Matches || []).some((match) => Number(match.score) >= DUPLICATE_WARNING_THRESHOLD);

  const handleAnalyze = async () => {
    if (!wigPhoto || !supabase || submitting) return;
    if (!authUserId || !userIdInt) {
      setNotice({ kind: 'error', message: 'Your specialist session is still loading. Please try again.' });
      return;
    }
    if (wigPhoto.size > 15 * 1024 * 1024) {
      setNotice({ kind: 'error', message: 'Use a wig photo smaller than 15 MB.' });
      return;
    }

    setSubmitting(true);
    setNotice({ kind: '', message: '' });
    let insertedFilter = null;
    try {
      const aiReady = await checkHealth();
      if (!aiReady) {
        setNotice({ kind: 'error', message: LOCAL_AI_OFFLINE_MESSAGE });
        return;
      }

      const length = String(form.hairLength).trim() ? Number(form.hairLength) : null;
      const insert = await supabase
        .from(FILTERS_TABLE)
        .insert({
          Wig_ID: null,
          Version: 1,
          Status: 'processing',
          Is_Active: false,
          Source_Front_Path: null,
          Source_Side_Path: null,
          Source_Top_Path: null,
          Source_Back_Path: null,
          Fit_Settings: fit,
          Created_By_User_ID: userIdInt,
          Pending_Wig_Name: form.wigName.trim() || null,
          Pending_Wig_Code: null,
          Pending_Hair_Length: Number.isFinite(length) ? length : null,
          Pending_Hair_Color: form.hairColor || null,
          Pending_Hair_Texture: form.hairTexture || null,
          Pending_Hair_Density: form.hairDensity || null,
          Pending_Cap_Size: form.capSize || null,
          Pending_Style: form.style.trim() || null,
          AI_Suggestions: {},
          Duplicate_Matches: [],
          Duplicate_Confirmed: false,
        })
        .select()
        .single();
      if (insert.error) throw insert.error;

      insertedFilter = insert.data;
      const payload = new FormData();
      payload.append('wig_photo', wigPhoto);
      payload.append('filter_id', String(insert.data.Filter_ID));
      payload.append('auth_user_id', authUserId);
      payload.append('version', String(insert.data.Version || 1));
      payload.append('inventory_json', JSON.stringify(inventoryForLocalAnalysis(inventory)));
      payload.append('attributes_json', JSON.stringify({
        wigName: form.wigName,
        hairLength: form.hairLength,
        hairColor: form.hairColor,
        hairTexture: form.hairTexture,
        hairDensity: form.hairDensity,
        capSize: form.capSize,
        style: form.style,
      }));

      const response = await fetch(`${AI_SERVER_BASE_URL}/analyze-wig`, {
        method: 'POST',
        body: payload,
      });
      if (!response.ok) {
        const text = await response.text();
        let responseMessage = text;
        try {
          const parsed = JSON.parse(text);
          responseMessage = parsed?.detail || parsed?.message || text;
        } catch {
          // Keep a plain-text server response.
        }
        throw new Error(responseMessage || `Local AI returned HTTP ${response.status}`);
      }
      setCurrentFilter({ ...insert.data, Status: 'processing' });
      setHealth({ state: 'online', details: health.details });
      void logAuditAction({
        action: 'wig_catalog_local_analysis_started',
        description: `filter_id=${insert.data.Filter_ID} raw_photo_uploaded=false`,
        resource: 'wig_catalog_studio',
        userProfile,
      });
    } catch (error) {
      if (insertedFilter?.Filter_ID) {
        await supabase
          .from(FILTERS_TABLE)
          .update({
            Status: 'failed',
            Error_Message: error?.message || 'Could not reach the local AI server.',
          })
          .eq('Filter_ID', insertedFilter.Filter_ID);
      }
      const isConnectionError =
        error?.name === 'AbortError'
        || error instanceof TypeError
        || /failed to fetch|networkerror|load failed|router_external_target_connection_error/i.test(
          String(error?.message || ''),
        );
      setNotice({
        kind: 'error',
        message: isConnectionError
          ? LOCAL_AI_OFFLINE_MESSAGE
          : error?.message || 'Could not start local wig analysis.',
      });
      if (isConnectionError) {
        setHealth((previous) => ({ ...previous, state: 'offline' }));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reset = useCallback(() => {
    setForm({ ...EMPTY_WIG_FORM });
    setWigPhoto(null);
    setCurrentFilter(null);
    setSubmitting(false);
    setFinalizing(false);
    setFit({ full_wig: { ...DEFAULT_TRY_ON_FIT.full_wig } });
    setPortraitReady(false);
    setDetailsConfirmed(false);
    setDuplicateConfirmed(false);
    setReviewComplete(false);
    setReservedFor('');
    setNotice({ kind: '', message: '' });
    appliedSuggestionsRef.current = null;
    codeRequestRef.current += 1;
  }, []);

  const handleRedo = async () => {
    if (currentFilter?.Filter_ID && supabase) {
      const stagedPaths = [
        currentFilter.Layer_Full_Wig_Path,
        currentFilter.Layer_Back_Hair_Path,
        currentFilter.Layer_Front_Bangs_Path,
        currentFilter.Layer_Hair_Mask_Path,
        currentFilter.Layer_Face_Mask_Path,
        currentFilter.Thumbnail_Path,
      ].filter((path, index, all) => path && all.indexOf(path) === index);
      if (stagedPaths.length) {
        await supabase.storage.from(FILTERS_BUCKET).remove(stagedPaths);
      }
      await supabase
        .from(FILTERS_TABLE)
        .update({
          Status: 'rejected',
          Is_Active: false,
          Layer_Full_Wig_Path: null,
          Layer_Back_Hair_Path: null,
          Layer_Front_Bangs_Path: null,
          Layer_Hair_Mask_Path: null,
          Layer_Face_Mask_Path: null,
          Thumbnail_Path: null,
        })
        .eq('Filter_ID', currentFilter.Filter_ID);
    }
    reset();
  };

  const missing = requiredDetailsMissing(form);
  const stockCount = Number.parseInt(form.stockCount, 10);
  const stockValid = Number.isFinite(stockCount) && stockCount >= 0;
  const codeMatchesDetails = Boolean(
    codeKey
    && form.wigCode
    && form.wigCode.startsWith(codeKey),
  );
  const canCompleteReview =
    isReview
    && missing.length === 0
    && stockValid
    && codeMatchesDetails
    && (!needsDuplicateConfirmation || duplicateConfirmed);
  const canFinalize =
    canCompleteReview
    && reviewComplete
    && stockValid
    && portraitReady
    && detailsConfirmed
    && !finalizing;

  const handleFinalize = async () => {
    if (!canFinalize || !supabase) return;
    setFinalizing(true);
    setNotice({ kind: '', message: '' });
    try {
      const result = await supabase.rpc('finalize_wig_catalog_item', {
        p_filter_id: currentFilter.Filter_ID,
        p_wig_name: form.wigName.trim(),
        p_wig_code: form.wigCode,
        p_hair_length: Number(form.hairLength),
        p_hair_color: form.hairColor,
        p_hair_texture: form.hairTexture,
        p_hair_density: form.hairDensity,
        p_cap_size: form.capSize,
        p_style: form.style.trim(),
        p_stock_count: stockCount,
        p_low_stock_threshold: LOW_STOCK_THRESHOLD,
        p_fit_settings: fit,
        p_duplicate_confirmed: needsDuplicateConfirmation ? duplicateConfirmed : false,
      });
      if (result.error) throw result.error;
      const createdRows = Array.isArray(result.data) ? result.data : [result.data].filter(Boolean);
      const created = createdRows.find((row) => row?.Wig_Code === form.wigCode) || createdRows[0];
      void logAuditAction({
        action: 'wig_catalog_item_created',
        description: `wig_id=${created?.Wig_ID || ''} code=${created?.Wig_Code || form.wigCode} variants=${createdRows.length} local_ai=true`,
        resource: 'wig_catalog_studio',
        userProfile,
      });
      onCreated?.({
        wigId: created?.Wig_ID,
        wigCode: created?.Wig_Code || form.wigCode,
        wigName: form.wigName,
        selectedCapSize: form.capSize,
        variantCount: createdRows.length,
      });
      reset();
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error?.message || 'Could not add the wig to inventory.',
      });
    } finally {
      setFinalizing(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3 sm:gap-5">
            <Step number="1" label="Details & photo" active={!currentFilter} done={Boolean(currentFilter)} />
            <ChevronRight size={15} className="shrink-0 text-slate-300" />
            <Step
              number="2"
              label="Local AI review"
              active={isProcessing || isFailed || (isReview && !reviewComplete)}
              done={isReview && reviewComplete}
            />
            <ChevronRight size={15} className="shrink-0 text-slate-300" />
            <Step number="3" label="Try-on & confirm" active={isReview && reviewComplete} done={false} />
          </div>
          <AiStatusPill health={health} onRetry={checkHealth} />
        </div>
      </section>

      {health.state === 'offline' && !currentFilter ? (
        <section className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 sm:flex-row sm:items-center">
          <AlertCircle size={19} className="shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold">Start Local AI before continuing</p>
            <p className="mt-0.5 text-xs leading-relaxed">{LOCAL_AI_OFFLINE_MESSAGE}</p>
          </div>
          <button
            type="button"
            onClick={() => checkHealth()}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            <RefreshCw size={13} /> Check again
          </button>
        </section>
      ) : null}

      {notice.message ? (
        <div
          className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {notice.kind === 'error' ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <span className="flex-1">{notice.message}</span>
          <button type="button" onClick={() => setNotice({ kind: '', message: '' })}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {!currentFilter ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Wig details</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Enter what you know. Local AI fills only high-confidence visual attributes;
                  every field remains editable.
                </p>
              </div>
              <span className="hidden rounded-full bg-slate-100 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:inline-flex">
                All details required before final confirmation
              </span>
            </div>
            <div className="mt-5">
              <WigDetailsForm
                form={form}
                setField={setField}
                primaryColor={primaryColor}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <span
                className="rounded-xl p-2.5"
                style={{ backgroundColor: withAlpha(primaryColor, 0.08), color: primaryColor || '#7f1d1d' }}
              >
                <ImagePlus size={20} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-slate-900">Wig photo</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Use one sharp, well-lit front photo with the whole wig visible.
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_1.2fr]">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="group relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 transition hover:border-slate-500"
                style={wigPhoto ? checkerboardStyle() : undefined}
              >
                {wigPhotoUrl ? (
                  <>
                    <img src={wigPhotoUrl} alt="Wig to analyze" className="max-h-[360px] w-full object-contain" />
                    <span className="absolute bottom-3 right-3 rounded-full bg-black/65 px-3 py-1 text-[11px] font-semibold text-white">
                      Replace photo
                    </span>
                  </>
                ) : (
                  <span className="flex flex-col items-center px-6 text-center">
                    <span className="rounded-full bg-slate-100 p-4 text-slate-500 group-hover:bg-slate-200">
                      <Upload size={25} />
                    </span>
                    <span className="mt-3 text-sm font-semibold text-slate-700">Choose wig photo</span>
                    <span className="mt-1 text-xs text-slate-500">PNG, JPG, or WebP · maximum 15 MB</span>
                  </span>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => setWigPhoto(event.target.files?.[0] || null)}
              />

              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-600" />
                    <div>
                      <p className="text-xs font-semibold text-slate-800">Local and private processing</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                        The raw photo goes directly to the AI service on this PC. It is not sent
                        to an external AI provider or saved in cloud storage.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <Wand2 size={18} className="mt-0.5 shrink-0 text-violet-600" />
                    <div>
                      <p className="text-xs font-semibold text-slate-800">Quality background removal</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                        BiRefNet preserves fine hair edges and outputs a transparent PNG without
                        recoloring or restyling the wig.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <SearchCheck size={18} className="mt-0.5 shrink-0 text-blue-600" />
                    <div>
                      <p className="text-xs font-semibold text-slate-800">Redundancy check</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                        The local visual fingerprint is combined with the entered color, texture,
                        density, cap size, length, and style.
                      </p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!wigPhoto || submitting || health.state !== 'online'}
                  onClick={handleAnalyze}
                  className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
                  style={{ backgroundColor: primaryColor || '#7f1d1d' }}
                >
                  {submitting || health.state === 'checking'
                    ? <Loader2 size={16} className="animate-spin" />
                    : <BrainCircuit size={16} />}
                  {health.state === 'offline'
                    ? 'Start Local AI to continue'
                    : health.state === 'checking'
                      ? 'Checking Local AI...'
                      : 'Remove background & check inventory'}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {isProcessing ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <span
            className="mx-auto flex h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: withAlpha(primaryColor, 0.08), color: primaryColor || '#7f1d1d' }}
          >
            <Loader2 size={30} className="animate-spin" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-slate-900">Processing locally on this computer</h2>
          <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-slate-500">
            Removing the background, identifying only confident attributes, and comparing the
            wig against inventory images and entered details. The first run is slower while model
            files are cached.
          </p>
          <div className="mx-auto mt-5 grid max-w-xl grid-cols-3 gap-2 text-[10px] font-semibold text-slate-500">
            <span className="rounded-lg bg-emerald-50 px-2 py-2 text-emerald-700">Raw photo stays local</span>
            <span className="rounded-lg bg-violet-50 px-2 py-2 text-violet-700">BiRefNet + CLIP</span>
            <span className="rounded-lg bg-blue-50 px-2 py-2 text-blue-700">No API fee or quota</span>
          </div>
        </section>
      ) : null}

      {isFailed ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
          <AlertCircle size={28} className="mx-auto text-red-600" />
          <h2 className="mt-3 text-sm font-semibold text-red-800">Local processing did not finish</h2>
          <p className="mx-auto mt-1 max-w-2xl break-words text-xs text-red-700">
            {String(currentFilter.Error_Message || 'Check the local AI server and model setup.').slice(0, 500)}
          </p>
          <button
            type="button"
            onClick={handleRedo}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white"
          >
            <RefreshCw size={13} /> Start again
          </button>
        </section>
      ) : null}

      {isReview ? (
        <>
          {!reviewComplete ? (
            <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={19} className="text-emerald-600" />
                  <h2 className="text-base font-semibold text-slate-900">Background removed</h2>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Review the transparent result and verify every editable detail.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[10px] font-semibold text-violet-700">
                  {Object.keys(suggestions).filter((key) => key !== '_meta').length} confident AI suggestion(s)
                </span>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-semibold text-emerald-700">
                  {suggestions?._meta?.processingSeconds
                    ? `${suggestions._meta.processingSeconds}s local processing`
                    : 'Processed locally'}
                </span>
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div>
                <div
                  className="flex min-h-[310px] items-center justify-center overflow-hidden rounded-xl border border-slate-200 p-3"
                  style={checkerboardStyle()}
                >
                  <img
                    src={processedImageUrl}
                    alt="Wig with transparent background"
                    className="max-h-[340px] w-full object-contain"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                  <span>Approved image preview</span>
                  <span>Transparent PNG</span>
                </div>
              </div>
              <WigDetailsForm
                form={form}
                setField={setField}
                suggestions={suggestions}
                primaryColor={primaryColor}
                showWigCode
              />
            </div>
          </section>

          <section
            className={`rounded-2xl border p-5 shadow-sm ${
              needsDuplicateConfirmation
                ? 'border-amber-300 bg-amber-50'
                : 'border-emerald-200 bg-emerald-50'
            }`}
          >
            <div className="flex items-start gap-3">
              <span className={`rounded-full p-2 ${needsDuplicateConfirmation ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                {needsDuplicateConfirmation ? <AlertCircle size={19} /> : <SearchCheck size={19} />}
              </span>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-slate-900">
                  {needsDuplicateConfirmation
                    ? 'Similar inventory items need your review'
                    : 'No likely duplicate found'}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  The score combines the local image comparison with the currently entered attributes.
                  It is a warning, not an automatic rejection.
                </p>
              </div>
            </div>

            {duplicateMatches.length ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {duplicateMatches.slice(0, 6).map((match) => (
                  <div key={`${match.wigId}-${match.wigCode}`} className="flex gap-3 rounded-xl border border-white/80 bg-white p-3">
                    <div
                      className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200"
                      style={checkerboardStyle()}
                    >
                      {match.imageUrl ? (
                        <img src={match.imageUrl} alt="" className="h-full w-full object-contain" />
                      ) : (
                        <ImagePlus size={15} className="text-slate-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-slate-900">{match.wigName}</p>
                          <p className="font-mono text-[10px] text-slate-500">{match.wigCode || '-'}</p>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          match.requiresConfirmation
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}>
                          {Math.round(match.score * 100)}%
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-500">
                        {match.reason || 'Visually and descriptively similar'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {needsDuplicateConfirmation ? (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300 bg-white p-3">
                <input
                  type="checkbox"
                  checked={duplicateConfirmed}
                  onChange={(event) => setDuplicateConfirmed(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-amber-700"
                />
                <span className="text-xs font-medium leading-relaxed text-slate-700">
                  I reviewed the similar wigs and confirm this is a distinct style or inventory item.
                </span>
              </label>
            ) : null}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Finish the Local AI review</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Verify every detail and the generated wig code before continuing to try-on.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReviewComplete(true)}
                disabled={!canCompleteReview}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
                style={{ backgroundColor: primaryColor || '#7f1d1d' }}
              >
                Continue to try-on <ChevronRight size={13} />
              </button>
            </div>
            {!canCompleteReview ? (
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                {missing.length ? (
                  <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">
                    Complete: {missing.join(', ')}
                  </span>
                ) : null}
                {!stockValid ? (
                  <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">
                    Enter a valid starting stock
                  </span>
                ) : null}
                {!codeMatchesDetails ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">Generating matching wig code</span>
                ) : null}
                {needsDuplicateConfirmation && !duplicateConfirmed ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">
                    Confirm similar-wig review
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>
            </>
          ) : (
            <>
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => setReviewComplete(false)}
              disabled={finalizing}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Back to Local AI review
            </button>
          </div>

          <PhotoTryOn
            wigImageUrl={processedImageUrl}
            fit={fit}
            setFit={setFit}
            onPortraitReady={setPortraitReady}
          />

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={detailsConfirmed}
                  onChange={(event) => setDetailsConfirmed(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-slate-900"
                />
                <span>
                  <span className="block text-xs font-semibold text-slate-800">
                    Final confirmation
                  </span>
                  <span className="mt-0.5 block max-w-2xl text-[11px] leading-relaxed text-slate-500">
                    I checked the transparent image, wig details, generated code, stock, duplicate
                    review, and portrait try-on. Low stock is automatic below 3. This creates Small,
                    Medium, and Large variants with the same four-digit family number; starting
                    stock goes only to the selected {form.capSize || 'cap size'} variant.
                  </span>
                </span>
              </label>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleRedo}
                  disabled={finalizing}
                  className="rounded-lg border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Start over
                </button>
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={!canFinalize}
                  className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-xs font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
                  style={{ backgroundColor: primaryColor || '#7f1d1d' }}
                >
                  {finalizing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Confirm &amp; add to inventory
                </button>
              </div>
            </div>

            {!canFinalize ? (
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                {missing.length ? (
                  <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">
                    Complete: {missing.join(', ')}
                  </span>
                ) : null}
                {!stockValid ? (
                  <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">Enter valid stock values</span>
                ) : null}
                {!codeMatchesDetails ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">Generating matching wig code</span>
                ) : null}
                {!portraitReady ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">Upload try-on portrait</span>
                ) : null}
                {needsDuplicateConfirmation && !duplicateConfirmed ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">Confirm similar-wig review</span>
                ) : null}
                {!detailsConfirmed ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">Check final confirmation</span>
                ) : null}
              </div>
            ) : null}
          </section>
            </>
          )}

          <div className="flex items-center justify-center gap-2 text-[10px] text-slate-500">
            <Lock size={11} />
            Portrait and raw wig photo remain local. Only the transparent wig asset is staged for review and inventory.
          </div>
        </>
      ) : null}
    </div>
  );
}
