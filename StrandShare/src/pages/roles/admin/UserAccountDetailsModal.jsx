import React from 'react';
import { createPortal } from 'react-dom';
import { Edit2, Loader2, Power, Save, Shield, X } from 'lucide-react';
import { toRoleLabel } from '../../../lib/roleUtils';

const EDITABLE_ROLES = ['staff', 'specialist'];
const fieldClass = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900';

function Detail({ label, children }) {
  return <div><dt className="font-semibold text-slate-500">{label}</dt><dd className="mt-0.5 text-slate-900">{children || 'N/A'}</dd></div>;
}

function Input({ label, name, value, onChange, type = 'text' }) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      {label}
      <input name={name} type={type} value={value || ''} onChange={onChange} className={fieldClass} />
    </label>
  );
}

export default function UserAccountDetailsModal({
  user,
  theme,
  open,
  editing,
  form,
  notice,
  saving,
  toggling,
  onClose,
  onBeginEdit,
  onCancelEdit,
  onChange,
  onSave,
  onToggleStatus,
}) {
  if (!open || !user || typeof document === 'undefined') return null;

  const profile = user.details || {};
  const canChangeRole = EDITABLE_ROLES.includes(user.role);
  const fullName = [profile.first_name, profile.middle_name, profile.last_name, profile.suffix].filter(Boolean).join(' ') || 'N/A';
  const address = [profile.street, profile.barangay, profile.city, profile.province, profile.region, profile.country].filter(Boolean).join(', ') || 'N/A';
  const joined = user.joinedDate
    ? new Date(user.joinedDate).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'long' })
    : 'N/A';

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 sm:p-6">
      <button type="button" aria-label="Close user details" className="absolute inset-0 border-0 bg-slate-950/60 backdrop-blur-[3px]" onClick={onClose} />
      <section role="dialog" aria-modal="true" aria-labelledby="user-account-details-title" className="relative z-10 flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
          <div>
            <h2 id="user-account-details-title" className="text-xl font-bold text-slate-900">User Account Details</h2>
            <p className="mt-1 text-sm text-slate-500">Complete non-confidential profile and account access information.</p>
          </div>
          <div className="flex items-center gap-2">
            {!editing && <button type="button" onClick={onBeginEdit} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Edit2 size={15} /> Edit</button>}
            <button type="button" onClick={onClose} aria-label="Close user details" className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"><X size={17} /></button>
          </div>
        </header>

        <div className="overflow-y-auto bg-white p-6">
          {notice?.text && <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>{notice.text}</div>}

          <section className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-14 w-14 place-items-center rounded-full border border-slate-200 bg-white text-lg font-bold" style={{ color: theme?.primaryColor }}>
                {`${String(user.firstName || '').charAt(0)}${String(user.lastName || '').charAt(0)}`.trim() || 'U'}
              </div>
              <div>
                <p className="text-lg font-bold text-slate-900">{fullName}</p>
                <p className="text-sm text-slate-600">{user.email || 'N/A'}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: `${theme?.primaryColor}12`, color: theme?.primaryColor, borderColor: `${theme?.primaryColor}33` }}><Shield size={12} /> {toRoleLabel(user.role)}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${user.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>{user.status}</span>
                </div>
              </div>
            </div>
            <button type="button" onClick={onToggleStatus} disabled={toggling} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-60 ${user.status === 'Active' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
              {toggling ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}{user.status === 'Active' ? 'Deactivate Account' : 'Activate Account'}
            </button>
          </section>

          {editing ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input label="First Name" name="firstName" value={form.firstName} onChange={onChange} />
              <Input label="Middle Name" name="middleName" value={form.middleName} onChange={onChange} />
              <Input label="Last Name" name="lastName" value={form.lastName} onChange={onChange} />
              <Input label="Suffix" name="suffix" value={form.suffix} onChange={onChange} />
              <Input label="Birthdate" name="birthdate" value={form.birthdate} onChange={onChange} type="date" />
              <Input label="Gender" name="gender" value={form.gender} onChange={onChange} />
              <Input label="Contact Number" name="contactNumber" value={form.contactNumber} onChange={onChange} />
              <Input label="Street" name="street" value={form.street} onChange={onChange} />
              <Input label="Barangay" name="barangay" value={form.barangay} onChange={onChange} />
              <Input label="City / Municipality" name="city" value={form.city} onChange={onChange} />
              <Input label="Province" name="province" value={form.province} onChange={onChange} />
              <Input label="Region" name="region" value={form.region} onChange={onChange} />
              <Input label="Country" name="country" value={form.country} onChange={onChange} />
              <label className="block text-sm font-semibold text-slate-700">Email Address<input value={form.email || ''} readOnly className={`${fieldClass} cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500`} /></label>
              <label className="block text-sm font-semibold text-slate-700">Role<select name="role" value={form.role || ''} onChange={onChange} disabled={!canChangeRole} className={`${fieldClass} disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500`}>{canChangeRole ? <><option value="staff">Staff</option><option value="specialist">Specialist</option></> : <option value={user.role}>{toRoleLabel(user.role)}</option>}</select>{!canChangeRole && <span className="mt-1 block text-xs font-normal text-slate-500">Only Staff and Specialist roles can be changed.</span>}</label>
              <Input label="Access Start" name="accessStart" value={form.accessStart} onChange={onChange} type="datetime-local" />
              <Input label="Access End" name="accessEnd" value={form.accessEnd} onChange={onChange} type="datetime-local" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <section className="rounded-xl border border-slate-200 bg-white p-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Account</h3><dl className="mt-3 space-y-3 text-sm"><Detail label="Email">{user.email}</Detail><Detail label="Role">{toRoleLabel(user.role)}</Detail><Detail label="Joined Date">{joined}</Detail><Detail label="Status">{user.status}</Detail></dl></section>
              <section className="rounded-xl border border-slate-200 bg-white p-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Personal Information</h3><dl className="mt-3 space-y-3 text-sm"><Detail label="Full Name">{fullName}</Detail><Detail label="Birthdate">{profile.birthdate}</Detail><Detail label="Gender">{profile.gender}</Detail><Detail label="Contact">{profile.contact_number}</Detail></dl></section>
              <section className="rounded-xl border border-slate-200 bg-white p-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Address & Access</h3><dl className="mt-3 space-y-3 text-sm"><Detail label="Address">{address}</Detail><Detail label="Access Start">{user.accessStart}</Detail><Detail label="Access End">{user.accessEnd}</Detail><Detail label="Last Updated">{user.updatedAt ? new Date(user.updatedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'N/A'}</Detail></dl></section>
            </div>
          )}
        </div>

        {editing && <footer className="flex justify-end gap-2 border-t border-slate-200 bg-white px-6 py-4"><button type="button" onClick={onCancelEdit} disabled={saving} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button><button type="button" onClick={onSave} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: theme?.primaryColor }}>{saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save Changes</button></footer>}
      </section>
    </div>,
    document.body,
  );
}
