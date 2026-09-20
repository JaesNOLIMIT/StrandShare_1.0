import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin, User, X } from 'lucide-react';
import { scheduleDateKeysForRecord, toScheduleDateKey } from '../events/ProgramScheduleCalendarModal';

const STAFF_COLORS = [
  '#7c3aed', '#0284c7', '#059669', '#d97706', '#dc2626', '#db2777',
  '#0891b2', '#65a30d', '#9333ea', '#ea580c', '#4f46e5', '#0f766e',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function staffId(user) {
  return Number(user?.user_id || user?.id || 0);
}

function staffName(user) {
  const details = Array.isArray(user?.user_details) ? user.user_details[0] : user?.user_details;
  const name = [
    details?.first_name ?? user?.firstName ?? user?.first_name,
    details?.middle_name ?? user?.middleName ?? user?.middle_name,
    details?.last_name ?? user?.lastName ?? user?.last_name,
    details?.suffix ?? user?.suffix,
  ].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return name || user?.email || `Staff #${staffId(user)}`;
}

function dateKeyFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseManilaDateTime(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T${endOfDay ? '23:59:59' : '00:00:00'}+08:00`);
  }
  const normalizedValue = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalizedValue)
    ? normalizedValue
    : `${normalizedValue}+08:00`;
  const parsed = new Date(zoned);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateRangesOverlap(startA, endA, startB, endB) {
  const aStart = parseManilaDateTime(startA);
  const aEnd = parseManilaDateTime(endA || startA, true);
  const bStart = parseManilaDateTime(startB);
  const bEnd = parseManilaDateTime(endB || startB, true);
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

export function getStaffScheduleConflict({
  staffUserId,
  startAt,
  endAt,
  events = [],
  unavailability = [],
  excludeEventRequestId = null,
}) {
  const id = Number(staffUserId || 0);
  if (!id || !startAt) return null;
  const startKey = toScheduleDateKey(startAt);
  const endKey = toScheduleDateKey(endAt || startAt) || startKey;

  const assignedEvent = events.find((event) => (
    Number(event?.Assigned_Staff_User_ID || 0) === id
    && normalized(event?.Status) === 'approved'
    && Number(event?.Event_Request_ID || 0) !== Number(excludeEventRequestId || 0)
    && dateRangesOverlap(startAt, endAt || startAt, event?.Start_Date, event?.End_Date || event?.Start_Date)
  ));
  if (assignedEvent) {
    return {
      type: 'event',
      label: assignedEvent.Event_Name || 'Approved program',
      record: assignedEvent,
    };
  }

  const dayOff = unavailability.find((entry) => {
    if (Number(entry?.Staff_User_ID || 0) !== id || entry?.Is_Active === false) return false;
    if (entry?.Unavailability_Type === 'Specific Date') {
      return entry.Specific_Date >= startKey && entry.Specific_Date <= endKey;
    }
    if (entry?.Unavailability_Type !== 'Recurring Weekday') return false;
    const cursor = new Date(`${startKey}T00:00:00Z`);
    const end = new Date(`${endKey}T00:00:00Z`);
    while (cursor <= end) {
      if (cursor.getUTCDay() === Number(entry.Weekday)) return true;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return false;
  });
  if (dayOff) return { type: 'day-off', label: dayOff.Reason || 'Day off', record: dayOff };
  return null;
}

function formatDateTime(value) {
  const parsed = parseManilaDateTime(value);
  if (!parsed) return 'Not recorded';
  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function ScheduleDetail({ detail, staff, color, onClose }) {
  if (!detail) return null;
  const isEvent = detail.type === 'event';
  const item = detail.record;
  return (
    <div className="fixed inset-0 z-[12000] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[1px]" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="staff-schedule-detail-title" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="h-1.5" style={{ backgroundColor: color }} />
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color }}>{isEvent ? 'Approved program' : 'Staff day off'}</p>
            <h3 id="staff-schedule-detail-title" className="mt-1 text-lg font-bold text-slate-900">{isEvent ? (item.Event_Name || 'Untitled Program') : (item.Reason || 'Day off')}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close schedule details"><X size={17} /></button>
        </header>
        <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
          <p className="flex items-start gap-2"><User size={16} className="mt-0.5 flex-none" style={{ color }} /><span><strong>Assigned Staff:</strong> {staffName(staff)}</span></p>
          {isEvent ? (
            <>
              <p className="flex items-start gap-2"><Clock3 size={16} className="mt-0.5 flex-none" style={{ color }} /><span><strong>Schedule:</strong> {formatDateTime(item.Start_Date)}{item.End_Date ? ` – ${formatDateTime(item.End_Date)}` : ''}</span></p>
              <p className="flex items-start gap-2"><MapPin size={16} className="mt-0.5 flex-none" style={{ color }} /><span><strong>Venue:</strong> {item.Venue_Name || [item.Street, item.Barangay, item.City_Municipality, item.Province].filter(Boolean).join(', ') || 'Not provided'}</span></p>
            </>
          ) : (
            <p className="flex items-start gap-2"><CalendarDays size={16} className="mt-0.5 flex-none" style={{ color }} /><span><strong>Availability:</strong> {item.Unavailability_Type === 'Recurring Weekday' ? `Every ${WEEKDAYS[Number(item.Weekday)]}` : new Date(`${item.Specific_Date}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'long' })}</span></p>
          )}
        </div>
      </section>
    </div>
  );
}

export default function StaffScheduleCalendar({
  staffUsers = [],
  events = [],
  unavailability = [],
  initialDate = '',
  title = 'Staff Schedule',
  description = 'Approved programs and Staff days off.',
  compact = false,
}) {
  const initialKey = toScheduleDateKey(initialDate) || toScheduleDateKey(new Date().toISOString());
  const [month, setMonth] = useState(() => {
    const [year, monthNumber] = initialKey.split('-').map(Number);
    return new Date(year, monthNumber - 1, 1);
  });
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    const key = toScheduleDateKey(initialDate);
    if (!key) return;
    const [year, monthNumber] = key.split('-').map(Number);
    setMonth(new Date(year, monthNumber - 1, 1));
  }, [initialDate]);

  const usersById = useMemo(() => new Map(staffUsers.map((user) => [staffId(user), user])), [staffUsers]);
  const colorById = useMemo(() => {
    const ids = [...usersById.keys()].sort((a, b) => a - b);
    return new Map(ids.map((id, index) => [id, STAFF_COLORS[index % STAFF_COLORS.length]]));
  }, [usersById]);
  const approvedEvents = useMemo(() => events.filter((event) => (
    normalized(event?.Status) === 'approved' && Number(event?.Assigned_Staff_User_ID || 0) > 0
  )), [events]);

  const eventsByDate = useMemo(() => {
    const map = new Map();
    approvedEvents.forEach((event) => {
      scheduleDateKeysForRecord(event, (row) => row.Start_Date, (row) => row.End_Date || row.Start_Date).forEach((key) => {
        const items = map.get(key) || [];
        items.push({ type: 'event', record: event, staffUserId: Number(event.Assigned_Staff_User_ID) });
        map.set(key, items);
      });
    });
    return map;
  }, [approvedEvents]);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const calendarDays = useMemo(() => {
    const first = new Date(year, monthIndex, 1);
    const gridStart = new Date(year, monthIndex, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [monthIndex, year]);

  const itemsForDate = (date, key) => {
    const items = [...(eventsByDate.get(key) || [])];
    unavailability.forEach((entry) => {
      if (entry.Is_Active === false) return;
      const matches = entry.Unavailability_Type === 'Specific Date'
        ? entry.Specific_Date === key
        : entry.Unavailability_Type === 'Recurring Weekday' && Number(entry.Weekday) === date.getDay();
      if (matches) items.push({ type: 'day-off', record: entry, staffUserId: Number(entry.Staff_User_ID) });
    });
    return items.sort((a, b) => a.staffUserId - b.staffUserId || a.type.localeCompare(b.type));
  };

  const detailStaff = detail ? usersById.get(detail.staffUserId) : null;
  const detailColor = detail ? (colorById.get(detail.staffUserId) || '#64748b') : '#64748b';

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className={`flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 ${compact ? 'px-4 py-3' : 'px-4 py-3 sm:px-5 sm:py-4'}`}>
        <div>
          <h3 className="flex items-center gap-2 font-bold text-slate-900"><CalendarDays size={18} />{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Previous month"><ChevronLeft size={15} /></button>
          <button type="button" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Today</button>
          <button type="button" onClick={() => setMonth(new Date(year, monthIndex + 1, 1))} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Next month"><ChevronRight size={15} /></button>
        </div>
      </header>

      <div className={compact ? 'p-3' : 'p-3 sm:p-4'}>
        <p className={`text-center font-bold text-slate-800 ${compact ? 'mb-2 text-[15px]' : 'mb-3 text-sm'}`}>{month.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</p>
        <div className={`grid grid-cols-7 border-b border-r border-slate-200 bg-slate-50 text-center font-bold uppercase tracking-wide text-slate-500 ${compact ? 'text-[11px]' : 'text-[10px]'}`}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <div key={day} className="border-l border-t border-slate-200 px-1 py-2">{day}</div>)}
        </div>
        <div className="grid grid-cols-7 border-r border-slate-200">
          {calendarDays.map((date) => {
            const key = dateKeyFromDate(date);
            const items = itemsForDate(date, key);
            const isCurrentMonth = date.getMonth() === monthIndex;
            const isToday = key === toScheduleDateKey(new Date().toISOString());
            return (
              <div key={key} className={`${compact ? 'min-h-[64px]' : 'min-h-[92px]'} border-b border-l border-slate-200 p-1 ${isCurrentMonth ? 'bg-white' : 'bg-slate-50/70'}`}>
                <span className={`mb-1 grid h-5 w-5 place-items-center rounded-full font-bold ${compact ? 'text-[11px]' : 'text-[10px]'} ${isToday ? 'bg-slate-900 text-white' : isCurrentMonth ? 'text-slate-700' : 'text-slate-400'}`}>{date.getDate()}</span>
                <div className="space-y-1">
                  {items.slice(0, 3).map((item) => {
                    const color = colorById.get(item.staffUserId) || '#64748b';
                    const staff = usersById.get(item.staffUserId);
                    const label = item.type === 'event'
                      ? `${staffName(staff)} · ${item.record.Event_Name || 'Program'}`
                      : `${staffName(staff)} · Day off`;
                    return (
                      <button key={`${item.type}-${item.record.Event_Request_ID || item.record.Staff_Unavailability_ID}-${key}`} type="button" onClick={() => setDetail(item)} title={label} className={`block w-full truncate rounded px-1.5 text-left font-bold leading-tight transition hover:brightness-95 ${compact ? 'py-0.5 text-[10px]' : 'py-1 text-[9px]'}`} style={{ color, backgroundColor: `${color}14`, borderLeft: `3px ${item.type === 'day-off' ? 'dashed' : 'solid'} ${color}` }}>
                        {label}
                      </button>
                    );
                  })}
                  {items.length > 3 && <p className={`px-1 font-bold text-slate-500 ${compact ? 'text-[10px]' : 'text-[9px]'}`}>+{items.length - 3} more</p>}
                </div>
              </div>
            );
          })}
        </div>

        <div className={`${compact ? 'mt-3' : 'mt-4'} flex flex-wrap gap-2`}>
          {[...usersById.entries()].map(([id, user]) => {
            const color = colorById.get(id);
            return <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />{staffName(user)}</span>;
          })}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600"><span className="h-3 w-1 border-l-2 border-dashed border-slate-500" />Dashed = day off</span>
        </div>
      </div>

      <ScheduleDetail detail={detail} staff={detailStaff} color={detailColor} onClose={() => setDetail(null)} />
    </section>
  );
}
