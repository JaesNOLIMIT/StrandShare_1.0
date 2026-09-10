import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, Loader2, MapPin, Search, ShieldCheck } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';

function hospitalLogoUrl(path) {
  const value = String(path || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return supabase?.storage.from('hospital_logos').getPublicUrl(value).data?.publicUrl || '';
}

export default function PartnerHospitalsPage() {
  const [hospitals, setHospitals] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!isSupabaseConfigured || !supabase) {
        if (mounted) {
          setError('The application service is not configured.');
          setLoading(false);
        }
        return;
      }
      const { data, error: loadError } = await supabase.rpc('list_patient_application_hospitals');
      if (!mounted) return;
      if (loadError) setError(loadError.message || 'Unable to load partner hospitals.');
      else setHospitals(Array.isArray(data) ? data : []);
      setLoading(false);
    };
    void load();
    return () => { mounted = false; };
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return hospitals;
    return hospitals.filter((hospital) => `${hospital.hospital_name} ${hospital.location}`.toLowerCase().includes(query));
  }, [hospitals, search]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <button type="button" onClick={() => window.location.assign('/')} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-900">
            <ArrowLeft size={17} /> Back to Donivra
          </button>
          <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#7a1020]">Partner hospital network</span>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
        <div className="max-w-3xl">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#7a1020]">Patient support network</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Our partner hospitals</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
            Select one hospital, review all of its conditions and required documents, then verify your email before completing the application.
          </p>
        </div>

        <div className="relative mt-8 max-w-xl">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search hospital or location" className="w-full rounded-xl border border-slate-300 bg-white py-3 pl-10 pr-4 text-sm outline-none focus:border-[#7a1020] focus:ring-2 focus:ring-[#7a1020]/10" />
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-16 text-sm text-slate-600"><Loader2 size={18} className="animate-spin" /> Loading partner hospitals...</div>
        ) : error ? (
          <div role="alert" className="mt-8 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <Building2 className="mx-auto text-slate-300" size={32} />
            <p className="mt-3 font-semibold">No matching partner hospitals</p>
            <p className="mt-1 text-sm text-slate-500">Try another hospital name or location.</p>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((hospital) => {
              const logo = hospitalLogoUrl(hospital.hospital_logo);
              const requirements = Array.isArray(hospital.requirements) ? hospital.requirements : [];
              return (
                <article key={hospital.hospital_id} className="flex min-h-[250px] flex-col rounded-2xl border border-slate-200 bg-white p-5">
                  <div className="flex items-start gap-4">
                    {logo ? <img src={logo} alt="" className="h-12 w-12 rounded-xl border border-slate-200 object-contain" /> : <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500"><Building2 size={22} /></div>}
                    <div className="min-w-0">
                      <h2 className="font-bold text-slate-900">{hospital.hospital_name}</h2>
                      <p className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-slate-500"><MapPin size={13} className="mt-0.5 shrink-0" /> {hospital.location || 'Location not provided'}</p>
                    </div>
                  </div>
                  <div className="mt-5 flex-1 space-y-2 text-sm text-slate-600">
                    <p className="flex items-center gap-2"><ShieldCheck size={15} className="text-[#7a1020]" /> {requirements.length} listed requirement{requirements.length === 1 ? '' : 's'}</p>
                    <p className="line-clamp-3 text-xs leading-5">{hospital.conditions || 'Hospital conditions are not published yet.'}</p>
                  </div>
                  <button
                    type="button"
                    disabled={!hospital.applications_open}
                    onClick={() => window.location.assign(`/apply-patient?hospital=${hospital.hospital_id}`)}
                    className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#650817] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    {hospital.applications_open ? <>Review and apply <ArrowRight size={16} /></> : 'Applications currently closed'}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
