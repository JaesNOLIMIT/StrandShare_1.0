import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';

export function normalizeScheduleStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function toScheduleDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const sqlDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (sqlDateMatch && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return `${sqlDateMatch[1]}-${sqlDateMatch[2]}-${sqlDateMatch[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateKeyFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayDateKey() {
  return toScheduleDateKey(new Date().toISOString());
}

export function formatScheduleDateLabel(dateKey, short = false) {
  if (!dateKey) return 'No date selected';
  const parsed = new Date(`${dateKey}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  return parsed.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: short ? 'short' : 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function scheduleDateKeysForRecord(record, getStartDate, getEndDate) {
  const startKey = toScheduleDateKey(getStartDate(record));
  const endKey = toScheduleDateKey(getEndDate(record)) || startKey;
  if (!startKey) return [];
  if (!endKey || endKey < startKey) return [startKey];

  const keys = [];
  const cursor = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  while (cursor <= end && keys.length < 370) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

export default function ProgramScheduleCalendarModal({
  open,
  onClose,
  records = [],
  selectedDate,
  onSelectDate,
  primaryColor = '#0f766e',
  title = 'Program Schedule Calendar',
  description = 'Choose a date to filter the list.',
  recordNoun = 'application',
  resultCount = 0,
  getStartDate = (record) => record?.Start_Date,
  getEndDate = (record) => record?.End_Date,
  getStatus = (record) => record?.Status,
  statusItems = [],
  showOpenDates = true,
}) {
  const todayKey = todayDateKey();
  const [month, setMonth] = useState(() => {
    const [year, monthNumber] = todayKey.split('-').map(Number);
    return new Date(year, monthNumber - 1, 1);
  });

  useEffect(() => {
    if (!open || !selectedDate) return;
    const [year, monthNumber] = selectedDate.split('-').map(Number);
    if (year && monthNumber) setMonth(new Date(year, monthNumber - 1, 1));
  }, [open, selectedDate]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  const statusByKey = useMemo(() => new Map(
    statusItems.map((item) => [normalizeScheduleStatus(item.key), item]),
  ), [statusItems]);

  const recordsByDate = useMemo(() => {
    const map = new Map();
    records.forEach((record) => {
      scheduleDateKeysForRecord(record, getStartDate, getEndDate).forEach((dateKey) => {
        const dateRecords = map.get(dateKey) || [];
        dateRecords.push(record);
        map.set(dateKey, dateRecords);
      });
    });
    return map;
  }, [getEndDate, getStartDate, records]);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, monthIndex, 1);
    const gridStart = new Date(year, monthIndex, 1 - firstDay.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [monthIndex, year]);

  const selectedRecords = selectedDate ? (recordsByDate.get(selectedDate) || []) : [];
  const selectedHasReservation = selectedRecords.some((record) => {
    const status = statusByKey.get(normalizeScheduleStatus(getStatus(record)));
    return status?.reserved !== false;
  });
  const selectedIsOpen = Boolean(
    showOpenDates
    && selectedDate
    && selectedDate >= todayKey
    && !selectedHasReservation,
  );

  if (!open || typeof document === 'undefined') return null;

  const moveMonth = (amount) => setMonth(new Date(year, monthIndex + amount, 1));
  const goToToday = () => {
    const [todayYear, todayMonth] = todayKey.split('-').map(Number);
    setMonth(new Date(todayYear, todayMonth - 1, 1));
    onSelectDate(todayKey);
  };
  const pluralNoun = `${recordNoun}${resultCount === 1 ? '' : 's'}`;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close calendar"
        className="absolute inset-0 h-full w-full bg-slate-950/65 backdrop-blur-[2px]"
      />
      <div className="relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex flex-none items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-white" style={{ backgroundColor: primaryColor }}>
              <Calendar size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">{title}</h2>
              <p className="mt-0.5 text-sm text-slate-600">{description}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close calendar">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {showOpenDates && (
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              <strong className="text-slate-800">Open dates</strong> have a neutral dashed border.
              <strong className="ml-1 text-emerald-700">Approved programs</strong> use a solid green dot.
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Calendar size={14} className="text-slate-500" />
                <p className="text-xs font-bold text-slate-800">
                  {month.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => moveMonth(-1)} className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-100" aria-label="Previous month">
                  <ChevronLeft size={14} />
                </button>
                <button type="button" onClick={goToToday} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100">
                  Today
                </button>
                <button type="button" onClick={() => moveMonth(1)} className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-100" aria-label="Next month">
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-7 text-center text-[9px] font-bold uppercase tracking-wide text-slate-400">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
            </div>

            <div className="mt-1 grid grid-cols-7 gap-1">
              {calendarDays.map((date) => {
                const dateKey = dateKeyFromDate(date);
                const dateRecords = recordsByDate.get(dateKey) || [];
                const isCurrentMonth = date.getMonth() === monthIndex;
                const isSelected = selectedDate === dateKey;
                const isToday = todayKey === dateKey;
                const hasReservation = dateRecords.some((record) => {
                  const status = statusByKey.get(normalizeScheduleStatus(getStatus(record)));
                  return status?.reserved !== false;
                });
                const isOpenDate = showOpenDates && dateKey >= todayKey && !hasReservation;
                const statusKeys = [...new Set(
                  dateRecords.map((record) => normalizeScheduleStatus(getStatus(record))),
                )].slice(0, 3);
                const dateSummary = dateRecords.length > 0
                  ? `${dateRecords.length} ${recordNoun}${dateRecords.length === 1 ? '' : 's'}`
                  : (isOpenDate ? 'Open date' : `No ${recordNoun}s`);

                return (
                  <button
                    key={dateKey}
                    type="button"
                    onClick={() => {
                      onSelectDate(dateKey);
                      if (!isCurrentMonth) setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                    }}
                    className={`relative flex h-10 flex-col items-center justify-center rounded-lg border text-[11px] font-semibold transition ${
                      isSelected
                        ? 'border-transparent text-white shadow-sm'
                        : isOpenDate
                          ? 'border-dashed border-slate-300 bg-white text-slate-700 hover:border-slate-500'
                          : 'border-transparent bg-white text-slate-700 hover:border-slate-300'
                    } ${isCurrentMonth ? '' : 'opacity-40'} ${isToday && !isSelected ? 'ring-1 ring-slate-400' : ''}`}
                    style={isSelected ? { backgroundColor: primaryColor } : undefined}
                    title={`${formatScheduleDateLabel(dateKey, true)}: ${dateSummary}`}
                    aria-label={`${formatScheduleDateLabel(dateKey)}. ${dateSummary}`}
                  >
                    <span>{date.getDate()}</span>
                    {dateRecords.length > 0 ? (
                      <span className="mt-0.5 flex items-center gap-0.5">
                        {statusKeys.map((statusKey) => (
                          <span
                            key={statusKey}
                            className={`h-1.5 w-1.5 rounded-full ${statusByKey.get(statusKey)?.dotClass || 'bg-slate-400'} ${isSelected ? 'ring-1 ring-white/70' : ''}`}
                          />
                        ))}
                      </span>
                    ) : isOpenDate ? (
                      <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-white' : 'border border-slate-400 bg-white'}`} />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-semibold text-slate-500">
              {showOpenDates && (
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full border border-slate-400 bg-white" />
                  Open date
                </span>
              )}
              {statusItems.map((item) => (
                <span key={item.key} className="inline-flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${item.dotClass}`} />
                  {item.label}
                </span>
              ))}
            </div>

            {selectedDate && (
              <div className="mt-3 flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div>
                  <p className="text-[11px] font-bold text-slate-800">{formatScheduleDateLabel(selectedDate)}</p>
                  <p className="text-[10px] text-slate-500">
                    {selectedRecords.length > 0
                      ? `${selectedRecords.length} ${recordNoun}${selectedRecords.length === 1 ? '' : 's'} on this date${selectedIsOpen ? ' — open for a new application' : ''}`
                      : (selectedIsOpen ? 'Open date — no active program scheduled' : `No ${recordNoun}s scheduled`)}
                  </p>
                </div>
                <button type="button" onClick={() => onSelectDate('')} className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50">
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={() => onSelectDate('')}
            disabled={!selectedDate}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear Date Filter
          </button>
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-white hover:brightness-110" style={{ backgroundColor: primaryColor }}>
            {selectedDate ? `Show ${resultCount} ${pluralNoun}` : 'Close Calendar'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
