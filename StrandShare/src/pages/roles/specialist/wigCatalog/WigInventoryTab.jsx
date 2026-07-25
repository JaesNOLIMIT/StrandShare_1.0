import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Clock3,
  History,
  ImageOff,
  PackagePlus,
  RefreshCw,
  ScanLine,
  Search,
  SlidersHorizontal,
} from 'lucide-react';

import {
  checkerboardStyle,
  LOW_STOCK_ALERT_BELOW,
  stockState,
  withAlpha,
} from './wigCatalogUtils';

const PAGE_SIZE = 8;

function SummaryCard({ label, value, accent = '#0f172a' }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-serif leading-none" style={{ color: accent }}>{value}</p>
    </div>
  );
}

function StatusBadge({ row }) {
  const status = stockState(row);
  const styles = {
    in: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    low: 'border-red-200 bg-red-50 text-red-700',
    out: 'border-slate-200 bg-slate-100 text-slate-600',
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold ${styles[status.key]}`}>
      {status.label}
    </span>
  );
}

export default function WigInventoryTab({
  rows,
  loading,
  onRefresh,
  onAdjustStock,
  onOpenHistory,
  onOpenBundleScanner,
  primaryColor,
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);

  const stats = useMemo(() => {
    const totalStock = rows.reduce((sum, row) => sum + Number(row.stockCount || 0), 0);
    const lowStock = rows.filter(
      (row) => stockState(row).key === 'low',
    ).length;
    const styles = new Set(rows.map((row) => String(row.style || '').trim().toLowerCase()).filter(Boolean));
    return { totalStock, lowStock, totalStyles: styles.size };
  }, [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const next = rows.filter((row) => {
      const currentStatus = stockState(row).key;
      if (statusFilter !== 'all' && statusFilter !== currentStatus) return false;
      if (!query) return true;
      return [
        row.wigName,
        row.wigCode,
        row.style,
        row.hairColor,
        row.hairTexture,
        row.capSize,
      ].some((value) => String(value || '').toLowerCase().includes(query));
    });

    return [...next].sort((a, b) => {
      if (sort === 'name') return a.wigName.localeCompare(b.wigName);
      if (sort === 'stock-low') return a.stockCount - b.stockCount;
      if (sort === 'stock-high') return b.stockCount - a.stockCount;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }, [rows, search, sort, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  useEffect(() => setPage(1), [search, statusFilter, sort]);

  const visibleRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const firstItem = filtered.length ? ((page - 1) * PAGE_SIZE) + 1 : 0;
  const lastItem = Math.min(page * PAGE_SIZE, filtered.length);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Total wigs in stock" value={stats.totalStock.toLocaleString()} />
        <SummaryCard label="Low stock alerts" value={stats.lowStock.toLocaleString()} accent="#c2412d" />
        <SummaryCard label="Total styles" value={stats.totalStyles.toLocaleString()} accent={primaryColor || '#7f1d1d'} />
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Boxes size={19} style={{ color: primaryColor || '#7f1d1d' }} />
                <h2 className="text-lg font-semibold text-slate-900">All Wigs Inventory</h2>
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-semibold"
                  style={{
                    color: primaryColor || '#7f1d1d',
                    backgroundColor: withAlpha(primaryColor, 0.1),
                  }}
                >
                  {rows.length}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Approved wigs, availability, specifications, and stock activity in one view.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onOpenBundleScanner}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-sm"
                style={{ backgroundColor: primaryColor || '#7f1d1d' }}
              >
                <ScanLine size={13} /> Scan completed wig
              </button>
              <label className="relative min-w-[210px] flex-1 sm:flex-none">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, code, style..."
                  className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-xs outline-none focus:border-slate-500"
                />
              </label>
              <label className="relative">
                <SlidersHorizontal size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="appearance-none rounded-lg border border-slate-300 bg-white py-2 pl-8 pr-7 text-xs font-semibold text-slate-700"
                >
                  <option value="all">All stock</option>
                  <option value="in">In stock</option>
                  <option value="low">Low stock</option>
                  <option value="out">Out of stock</option>
                </select>
              </label>
              <label className="relative">
                <ArrowDownUp size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                  className="appearance-none rounded-lg border border-slate-300 bg-white py-2 pl-8 pr-7 text-xs font-semibold text-slate-700"
                >
                  <option value="newest">Newest</option>
                  <option value="name">Name A-Z</option>
                  <option value="stock-low">Stock low-high</option>
                  <option value="stock-high">Stock high-low</option>
                </select>
              </label>
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>
        </div>

        {loading && !rows.length ? (
          <div className="flex min-h-[320px] items-center justify-center text-sm text-slate-500">
            <RefreshCw size={16} className="mr-2 animate-spin" /> Loading inventory...
          </div>
        ) : !visibleRows.length ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
            <span className="rounded-full bg-slate-100 p-4 text-slate-400">
              <Boxes size={26} />
            </span>
            <p className="mt-3 text-sm font-semibold text-slate-700">No wigs match this view</p>
            <p className="mt-1 text-xs text-slate-500">
              Clear the filters or add a new wig from the Add New Wig tab.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                <tr>
                  <th className="px-5 py-3">Product</th>
                  <th className="px-4 py-3">Wig code</th>
                  <th className="px-4 py-3">Style</th>
                  <th className="px-4 py-3">Hair details</th>
                  <th className="px-4 py-3">Cap size</th>
                  <th className="px-4 py-3">Stock</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.wigId} className="border-t border-slate-200 hover:bg-slate-50/70">
                    <td className="px-5 py-3">
                      <div className="flex min-w-[190px] items-center gap-3">
                        <div
                          className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200"
                          style={checkerboardStyle()}
                        >
                          {row.imageUrl ? (
                            <img
                              src={row.imageUrl}
                              alt={row.wigName}
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <ImageOff size={16} className="text-slate-400" />
                          )}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{row.wigName}</p>
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                            <Clock3 size={10} />
                            {row.createdAt
                              ? new Date(row.createdAt).toLocaleDateString()
                              : 'Date unavailable'}
                            {row.familyNumber !== null && row.familyNumber !== undefined
                              ? ` · Family ${String(row.familyNumber).padStart(4, '0')}`
                              : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-700">
                      {row.wigCode || '-'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">{row.style || '-'}</td>
                    <td className="px-4 py-3">
                      <p className="text-xs font-medium text-slate-700">
                        {[row.hairColor, row.hairTexture].filter(Boolean).join(' · ') || '-'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {row.hairLength ? `${row.hairLength} in` : 'Length —'}
                        {' · '}
                        {row.hairDensity || 'Density —'}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-slate-300 px-2 text-[11px] font-semibold text-slate-700">
                        {row.capSize ? row.capSize.charAt(0) : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-semibold text-slate-900">{row.stockCount}</p>
                      <p className="text-[10px] text-slate-500">Low below {LOW_STOCK_ALERT_BELOW}</p>
                    </td>
                    <td className="px-4 py-3"><StatusBadge row={row} /></td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onAdjustStock(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-white"
                        >
                          <PackagePlus size={12} /> Adjust
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenHistory(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-white"
                        >
                          <History size={12} /> History
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-slate-200 px-5 py-3 text-[11px] text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>
            Showing {firstItem}-{lastItem} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <span>Page {page} of {totalPages}</span>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="rounded-md border border-slate-300 p-1.5 text-slate-600 disabled:opacity-35"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              className="rounded-md border border-slate-300 p-1.5 text-slate-600 disabled:opacity-35"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
