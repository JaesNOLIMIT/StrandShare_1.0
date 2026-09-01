import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  History,
  Loader2,
  PackagePlus,
  PlusCircle,
  X,
} from 'lucide-react';

import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { logAuditAction } from '../../../lib/auditLogger';
import PageHeaderActions from '../../../components/PageHeaderActions';
import AddWigTab from './wigCatalog/AddWigTab';
import BundleCompletionScanner from './wigCatalog/BundleCompletionScanner';
import WigInventoryTab from './wigCatalog/WigInventoryTab';
import { normalizeInventory } from './wigCatalog/wigCatalogUtils';

const TAB_INVENTORY = 'inventory';
const TAB_ADD = 'add';

function ModalFrame({ title, icon, children, onClose, width = 'max-w-lg' }) {
  const modal = (
    <div className="fixed inset-0 z-[2147483000] m-0 flex h-screen w-screen items-center justify-center overflow-y-auto bg-slate-950/55 p-4 backdrop-blur-sm">
      <div className={`max-h-[90vh] w-full ${width} overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl`}>
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-center gap-2">
            {icon}
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!onClose}
            className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  if (typeof document === 'undefined') return modal;
  return createPortal(modal, document.body);
}

function createBundleScannerState() {
  return {
    open: false,
    manualCode: '',
    saving: false,
    error: '',
    success: '',
  };
}

function StockAdjustmentModal({ state, setState, onClose, onSubmit }) {
  if (!state.open || !state.row) return null;
  const row = state.row;
  const quantity = Math.max(0, Number.parseInt(state.quantity, 10) || 0);
  const signedChange = state.operation === 'remove' ? -quantity : quantity;
  const nextStock = Number(row.stockCount || 0) + signedChange;
  return (
    <ModalFrame
      title={`Adjust stock Â· ${row.wigCode || row.wigName}`}
      icon={<PackagePlus size={17} className="text-slate-700" />}
      onClose={state.saving ? undefined : onClose}
    >
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Current</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{row.stockCount}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Change</p>
            <p className={`mt-1 text-lg font-semibold ${signedChange < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {signedChange > 0 ? '+' : ''}{signedChange}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">After</p>
            <p className={`mt-1 text-lg font-semibold ${nextStock < 0 ? 'text-red-600' : 'text-slate-900'}`}>
              {nextStock}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="text-xs font-semibold text-slate-700">Operation</span>
            <select
              value={state.operation}
              onChange={(event) => setState((previous) => ({ ...previous, operation: event.target.value, error: '' }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
            >
              <option value="add">Add stock</option>
              <option value="remove">Remove stock</option>
            </select>
          </label>
          <label>
            <span className="text-xs font-semibold text-slate-700">Quantity</span>
            <input
              type="number"
              min="0"
              step="1"
              value={state.quantity}
              onChange={(event) => setState((previous) => ({ ...previous, quantity: event.target.value, error: '' }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Reason</span>
          <input
            type="text"
            value={state.reason}
            onChange={(event) => setState((previous) => ({ ...previous, reason: event.target.value }))}
            placeholder="e.g. New batch completed, damaged item, correction"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
          />
        </label>

        {state.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{state.error}</p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={state.saving}
            className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={state.saving || nextStock < 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-45"
          >
            {state.saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            Save adjustment
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function StockHistoryModal({ state, onClose }) {
  if (!state.open || !state.row) return null;
  return (
    <ModalFrame
      title={`Stock history Â· ${state.row.wigCode || state.row.wigName}`}
      icon={<History size={17} className="text-slate-700" />}
      onClose={onClose}
      width="max-w-2xl"
    >
      <div className="p-5">
        {state.loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-slate-500">
            <Loader2 size={16} className="mr-2 animate-spin" /> Loading stock history...
          </div>
        ) : state.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{state.error}</p>
        ) : !state.rows.length ? (
          <div className="py-12 text-center text-sm text-slate-500">No stock changes recorded yet.</div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full text-left">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Change</th>
                  <th className="px-4 py-3">Stock</th>
                  <th className="px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((item) => (
                  <tr key={item.Stock_History_ID} className="border-t border-slate-200 text-xs">
                    <td className="px-4 py-3 text-slate-600">
                      {new Date(item.Created_At).toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 font-semibold ${Number(item.Quantity_Change) >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {Number(item.Quantity_Change) > 0 ? '+' : ''}{item.Quantity_Change}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {item.Previous_Stock} â†’ {item.New_Stock}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{item.Reason || 'Inventory adjustment'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}

export default function WigCatalogStudioPage({ userProfile, isActivePage = true }) {
  const { primaryColor } = useTheme() || {};
  const accent = primaryColor || '#7f1d1d';
  const [tab, setTab] = useState(TAB_INVENTORY);
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [authUserId, setAuthUserId] = useState('');
  const [userIdInt, setUserIdInt] = useState(null);
  const [notice, setNotice] = useState({ kind: '', message: '' });
  const [stockModal, setStockModal] = useState({
    open: false,
    row: null,
    operation: 'add',
    quantity: '1',
    reason: '',
    saving: false,
    error: '',
  });
  const [historyModal, setHistoryModal] = useState({
    open: false,
    row: null,
    rows: [],
    loading: false,
    error: '',
  });
  const [bundleScanner, setBundleScanner] = useState(createBundleScannerState);

  useEffect(() => {
    let cancelled = false;
    const loadIdentity = async () => {
      if (!supabase) return;
      const sessionResult = await supabase.auth.getSession();
      const uid = sessionResult.data?.session?.user?.id || '';
      if (cancelled) return;
      setAuthUserId(uid);
      if (!uid) return;
      const userResult = await supabase
        .from('users')
        .select('user_id')
        .eq('auth_user_id', uid)
        .maybeSingle();
      if (!cancelled) setUserIdInt(userResult.data?.user_id || null);
    };
    void loadIdentity();
    return () => { cancelled = true; };
  }, []);

  const loadInventory = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const [wigsResult, specsResult, filtersResult] = await Promise.all([
        supabase
          .from('Wigs')
          .select('Wig_ID, Wig_Name, Wig_Code, Catalog_Family_Number, Wig_Status, Stock_Count, Low_Stock_Threshold, Catalog_Image_Path, Created_At, Completed_At')
          .order('Created_At', { ascending: false })
          .limit(500),
        supabase
          .from('Wig_Specifications')
          .select('Wig_ID, Hair_Length, Hair_Color, Hair_Texture, Hair_Density, Cap_Size, Style, Visual_Embedding, AI_Suggestions, AI_Model_Version')
          .limit(500),
        supabase
          .from('Wig_AI_Filters')
          .select('Filter_ID, Wig_ID, Is_Active, Status, Thumbnail_Path, Layer_Full_Wig_Path, AI_Model_Version, Created_At')
          .in('Status', ['approved', 'superseded'])
          .order('Created_At', { ascending: false })
          .limit(500),
      ]);
      if (wigsResult.error) throw wigsResult.error;
      if (specsResult.error) throw specsResult.error;
      if (filtersResult.error) throw filtersResult.error;
      setInventory(normalizeInventory(
        wigsResult.data || [],
        specsResult.data || [],
        filtersResult.data || [],
      ));
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error?.message || 'Could not load the wig inventory.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  useEffect(() => {
    if (!isActivePage || !supabase) {
      return undefined;
    }

    const refreshInventory = () => void loadInventory();
    const channel = supabase
      .channel('specialist-wig-catalog-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Wigs' }, refreshInventory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Wig_Specifications' }, refreshInventory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Wig_AI_Filters' }, refreshInventory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Wig_Stock_History' }, refreshInventory)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isActivePage, loadInventory]);

  const openStockModal = (row) => {
    setStockModal({
      open: true,
      row,
      operation: 'add',
      quantity: '1',
      reason: '',
      saving: false,
      error: '',
    });
  };

  const closeStockModal = () => {
    if (stockModal.saving) return;
    setStockModal((previous) => ({ ...previous, open: false }));
  };

  const submitStockAdjustment = async () => {
    if (!supabase || !stockModal.row) return;
    const quantity = Number.parseInt(stockModal.quantity, 10);
    if (!Number.isFinite(quantity) || quantity < 0) {
      setStockModal((previous) => ({ ...previous, error: 'Enter a non-negative whole number.' }));
      return;
    }
    const change = stockModal.operation === 'remove' ? -quantity : quantity;
    if (Number(stockModal.row.stockCount) + change < 0) {
      setStockModal((previous) => ({ ...previous, error: 'Stock cannot be reduced below zero.' }));
      return;
    }

    setStockModal((previous) => ({ ...previous, saving: true, error: '' }));
    try {
      if (change !== 0) {
        const stockResult = await supabase.rpc('adjust_wig_catalog_stock', {
          p_wig_id: stockModal.row.wigId,
          p_quantity_change: change,
          p_reason: stockModal.reason.trim() || 'Inventory adjustment',
        });
        if (stockResult.error) throw stockResult.error;
      }
      void logAuditAction({
        action: 'wig_catalog_stock_adjusted',
        description: `wig_id=${stockModal.row.wigId} change=${change}`,
        resource: 'wig_catalog_studio',
        userProfile,
      });
      setStockModal((previous) => ({ ...previous, open: false, saving: false }));
      setNotice({ kind: 'success', message: `${stockModal.row.wigCode || stockModal.row.wigName} stock was updated.` });
      await loadInventory();
    } catch (error) {
      setStockModal((previous) => ({
        ...previous,
        saving: false,
        error: error?.message || 'Could not save the stock adjustment.',
      }));
    }
  };

  const openHistory = async (row) => {
    setHistoryModal({ open: true, row, rows: [], loading: true, error: '' });
    const result = await supabase
      .from('Wig_Stock_History')
      .select('*')
      .eq('Wig_ID', row.wigId)
      .order('Created_At', { ascending: false })
      .limit(100);
    setHistoryModal((previous) => ({
      ...previous,
      rows: result.data || [],
      loading: false,
      error: result.error?.message || '',
    }));
  };

  const openBundleScanner = useCallback(() => {
    setBundleScanner({
      open: true,
      manualCode: '',
      saving: false,
      error: '',
      success: '',
    });
  }, []);

  const closeBundleScanner = useCallback(() => {
    setBundleScanner((previous) => (
      previous.saving ? previous : createBundleScannerState()
    ));
  }, []);

  const completeBundleFromScan = useCallback(async (rawPayload) => {
    const payload = String(rawPayload || '').trim();
    if (!payload || !supabase) return false;

    setBundleScanner((previous) => ({
      ...previous,
      saving: true,
      error: '',
      success: '',
    }));

    try {
      let result = await supabase.rpc('complete_wig_request_or_stock_from_bundle_scan', {
        p_waybill_payload: payload,
      });
      const missingWorkflowFunction = result.error
        && String(result.error.message || '').toLowerCase().includes('complete_wig_request_or_stock_from_bundle_scan');
      if (missingWorkflowFunction) {
        result = await supabase.rpc('complete_wig_stock_from_bundle_scan', {
          p_waybill_payload: payload,
        });
      }
      if (result.error) throw result.error;

      const data = result.data || {};
      const bundle = data.bundle || {};
      const wig = data.wig || {};
      const specification = data.wig_specification || {};
      const bundleCode = bundle.Bundle_Waybill_Code
        || `WB${String(Number(bundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;
      const wigLabel = wig.Wig_Code || wig.Wig_Name || `Wig #${wig.Wig_ID}`;
      const capLabel = specification.Cap_Size ? ` (${specification.Cap_Size} cap)` : '';
      const previousStock = Number(data.previous_stock ?? 0);
      const nextStock = Number(data.next_stock ?? previousStock + 1);
      const memberCount = Number(data.member_count || 0);
      const directToRequest = Boolean(data.direct_to_request);
      const request = data.request || {};

      void logAuditAction({
        action: 'wig_catalog_bundle_scan_completed',
        description: `bundle_id=${bundle.Bundle_ID} bundle_code=${bundleCode} wig_id=${wig.Wig_ID} stock:${previousStock}->${nextStock} members=${memberCount} direct_to_request=${directToRequest}`,
        resource: 'wig_catalog_studio',
        userProfile,
      });

      setBundleScanner((previous) => ({
        ...previous,
        manualCode: '',
        saving: false,
        error: '',
        success: directToRequest
          ? `Bundle ${bundleCode} completed and was reserved directly for ${request.Request_Code || `request #${request.Req_ID}`}. It was not added to general stock; the request is now Accepted - Wig Allocated and ready for the next staff action.`
          : `Bundle ${bundleCode} completed. ${wigLabel}${capLabel} stock increased from ${previousStock} to ${nextStock}; ${memberCount} linked submission${memberCount === 1 ? '' : 's'} now show Wig Created.`,
      }));
      await loadInventory();
      return true;
    } catch (error) {
      const rawMessage = String(error?.message || 'Could not complete this bundle.').trim();
      setBundleScanner((previous) => ({
        ...previous,
        saving: false,
        success: '',
        error: rawMessage,
      }));
      return false;
    }
  }, [loadInventory, userProfile]);

  if (!isSupabaseConfigured) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        Supabase is not configured. Add the project URL and anon key to <code>.env.local</code>.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="role-page-title text-2xl font-bold text-slate-900">
              Wig Catalog Studio
            </h1>
            <p className="max-w-3xl text-sm text-slate-600">
              Add catalog-ready wigs with private local AI, review similar styles,
              confirm photo try-on, and monitor inventory from one workspace.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start">
            <PageHeaderActions
              onRefresh={() => loadInventory()}
              refreshLoading={loading}
              autoRefreshOnChanges={false}
              helpTitle="About Wig Catalog Studio"
              helpContent={<p>Review wig inventory or open Add Wig to create catalog-ready wig records and starting stock.</p>}
            />
            <button
              type="button"
              onClick={() => setTab(TAB_ADD)}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-white shadow-sm"
              style={{ backgroundColor: accent }}
            >
              <PlusCircle size={16} /> Add New Wig
            </button>
          </div>
        </div>

        <nav className="flex gap-7 border-b border-slate-300" aria-label="Wig catalog sections">
          {[
            [TAB_INVENTORY, 'Wig Inventory'],
            [TAB_ADD, 'Add Wig'],
          ].map(([tabKey, label]) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition ${
                tab === tabKey
                  ? 'text-slate-950'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              style={tab === tabKey ? { borderBottomColor: accent } : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

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

      <div className={tab === TAB_INVENTORY ? 'block' : 'hidden'}>
        <WigInventoryTab
          rows={inventory}
          loading={loading}
          onAdjustStock={openStockModal}
          onOpenHistory={openHistory}
          onOpenBundleScanner={openBundleScanner}
          primaryColor={accent}
        />
      </div>
      <div className={tab === TAB_ADD ? 'block' : 'hidden'}>
        <AddWigTab
          authUserId={authUserId}
          userIdInt={userIdInt}
          userProfile={userProfile}
          inventory={inventory}
          primaryColor={accent}
          onCancel={() => setTab(TAB_INVENTORY)}
          onCreated={async (created) => {
            await loadInventory();
            setTab(TAB_INVENTORY);
            setNotice({
              kind: 'success',
              message: `${created.wigName} was added in Small, Medium, and Large. Starting stock was applied only to ${created.selectedCapSize} (${created.wigCode}).`,
            });
          }}
        />
      </div>

      <StockAdjustmentModal
        state={stockModal}
        setState={setStockModal}
        onClose={closeStockModal}
        onSubmit={submitStockAdjustment}
      />
      <StockHistoryModal
        state={historyModal}
        onClose={() => setHistoryModal((previous) => ({ ...previous, open: false }))}
      />
      <BundleCompletionScanner
        open={bundleScanner.open}
        manualCode={bundleScanner.manualCode}
        saving={bundleScanner.saving}
        error={bundleScanner.error}
        success={bundleScanner.success}
        onManualCodeChange={(value) => setBundleScanner((previous) => ({
          ...previous,
          manualCode: value,
          error: '',
          success: '',
        }))}
        onSubmit={completeBundleFromScan}
        onClose={closeBundleScanner}
        primaryColor={accent}
      />
    </div>
  );
}
