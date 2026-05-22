import React, { useState } from 'react';

const tabs = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'patient-journey', label: 'Patient Journey' },
  { id: 'release-map', label: 'Released Map' },
];

const trackingCards = [
  { label: 'For Matching', value: '13' },
  { label: 'In Production', value: '9' },
  { label: 'Ready For Fitting', value: '7' },
  { label: 'Completed', value: '45' },
];

const pipelineRows = [
  { requestId: 'WR-2096', patient: 'Leah Morales', stage: 'In Production', eta: 'Apr 04', updated: '09:20 AM' },
  { requestId: 'WR-2097', patient: 'Rina Cabrera', stage: 'For Matching', eta: 'Apr 06', updated: '08:45 AM' },
  { requestId: 'WR-2098', patient: 'Mika Santos', stage: 'Ready For Fitting', eta: 'Apr 01', updated: '05:10 PM' },
  { requestId: 'WR-2099', patient: 'Ana Prieto', stage: 'Completed', eta: 'Done', updated: '03:26 PM' },
];

const patientJourney = [
  {
    requestId: 'WR-2098',
    patient: 'Mika Santos',
    progress: 'Submitted -> Verified -> Matched -> Production -> Fitting',
    nextAction: 'Confirm fitting attendance',
  },
  {
    requestId: 'WR-2104',
    patient: 'Anne Delos Reyes',
    progress: 'Submitted -> Verified -> Matched',
    nextAction: 'Wait for production completion',
  },
  {
    requestId: 'WR-2110',
    patient: 'Rica Mendoza',
    progress: 'Submitted -> Verified -> Matched -> Production -> Released',
    nextAction: 'Post-release check-in',
  },
];

const releasedWigLocations = [
  {
    requestId: 'WR-2090',
    patient: 'Leah Morales',
    deliveryMode: 'Courier',
    currentLocation: 'Makati Distribution Hub',
    lastPing: 'Mar 31, 2026 11:12 AM',
    status: 'In Transit',
  },
  {
    requestId: 'WR-2099',
    patient: 'Ana Prieto',
    deliveryMode: 'H-Representative Pickup',
    currentLocation: 'Released at Donivra Main Center',
    lastPing: 'Mar 30, 2026 03:26 PM',
    status: 'Delivered',
  },
];

function tabClass(isActive) {
  return isActive
    ? 'rounded-lg border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white'
    : 'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50';
}

function stageClass(stage) {
  if (stage === 'Completed') return 'bg-emerald-100 text-emerald-700';
  if (stage === 'Ready For Fitting') return 'bg-sky-100 text-sky-700';
  if (stage === 'In Production') return 'bg-indigo-100 text-indigo-700';
  return 'bg-amber-100 text-amber-700';
}

function locationStatusClass(status) {
  if (status === 'Delivered') return 'bg-emerald-100 text-emerald-700';
  if (status === 'In Transit') return 'bg-sky-100 text-sky-700';
  return 'bg-slate-100 text-slate-700';
}

export default function TrackRequestedWigPage() {
  const [activeTab, setActiveTab] = useState('pipeline');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold text-gray-900">Track Status</h1>
        <p className="text-gray-600">Monitor each requested wig from intake to release, with map visibility for delivered or in-transit cases.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {trackingCards.map((card) => (
          <article key={card.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">{card.label}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900">{card.value}</p>
          </article>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={tabClass(activeTab === tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'pipeline' && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Request Pipeline</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Request ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Patient</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Stage</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ETA</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Updated</th>
                </tr>
              </thead>
              <tbody>
                {pipelineRows.map((row) => (
                  <tr key={row.requestId} className="border-t border-gray-200">
                    <td className="px-4 py-3 font-semibold text-gray-800">{row.requestId}</td>
                    <td className="px-4 py-3 text-gray-700">{row.patient}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${stageClass(row.stage)}`}>
                        {row.stage}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{row.eta}</td>
                    <td className="px-4 py-3 text-gray-600">{row.updated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === 'patient-journey' && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-gray-900">Per-Patient Journey</h2>
          <div className="mt-3 space-y-3">
            {patientJourney.map((item) => (
              <article key={item.requestId} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="text-sm font-semibold text-gray-900">{item.requestId} - {item.patient}</p>
                <p className="mt-1 text-sm text-gray-700">{item.progress}</p>
                <p className="mt-1 text-xs text-gray-500">Next action: {item.nextAction}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {activeTab === 'release-map' && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Released Wig Map</h2>
            <span className="text-xs text-gray-500">Delivery visibility</span>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="overflow-hidden rounded-lg border border-gray-200 xl:col-span-2">
              <iframe
                title="Released wig location map"
                src="https://www.openstreetmap.org/export/embed.html?bbox=120.9600%2C14.5200%2C121.1000%2C14.6500&layer=mapnik&marker=14.5790%2C121.0350"
                className="h-[320px] w-full"
                loading="lazy"
              />
            </div>

            <div className="space-y-3">
              {releasedWigLocations.map((item) => (
                <article key={item.requestId} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900">{item.requestId}</p>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${locationStatusClass(item.status)}`}>
                      {item.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600">Patient: {item.patient}</p>
                  <p className="text-xs text-gray-600">Mode: {item.deliveryMode}</p>
                  <p className="mt-2 text-xs text-gray-700">Current location: {item.currentLocation}</p>
                  <p className="mt-1 text-[11px] text-gray-500">Last update: {item.lastPing}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

