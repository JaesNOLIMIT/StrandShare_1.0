import React, { useMemo, useState } from 'react';
import { FileText, ListChecks, MapPin } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import PageHeaderActions from '../../../components/PageHeaderActions';
import WigRequirementsPage from './WigRequirementsPage';
import LogisticsDestinationSettingsPage from './LogisticsDestinationSettingsPage';
import LegalDocumentsPage from './LegalDocumentsPage';

const TABS = [
  {
    id: 'wig-requirements',
    label: 'Wig Requirements',
    description: 'Global hair donation requirements.',
    icon: ListChecks,
  },
  {
    id: 'logistics-destination-settings',
    label: 'Logistics Destination',
    description: 'Shared pickup/drop destination and pinned location.',
    icon: MapPin,
  },
  {
    id: 'legal-documents',
    label: 'Legal Documents',
    description: 'Consent PDF versions and activation.',
    icon: FileText,
  },
];

export default function ManageRequirementsPage({ userProfile }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const [activeTab, setActiveTab] = useState('wig-requirements');
  const [visitedTabs, setVisitedTabs] = useState(() => new Set(['wig-requirements']));
  const [refreshKeys, setRefreshKeys] = useState({});

  const openTab = (tabId) => {
    setVisitedTabs((previous) => {
      if (previous.has(tabId)) return previous;
      const next = new Set(previous);
      next.add(tabId);
      return next;
    });
    setActiveTab(tabId);
  };

  const active = useMemo(
    () => TABS.find((tab) => tab.id === activeTab) || TABS[0],
    [activeTab],
  );

  const refreshActiveSection = () => {
    setRefreshKeys((previous) => ({
      ...previous,
      [active.id]: (previous[active.id] || 0) + 1,
    }));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="role-page-title text-2xl font-bold text-slate-900">Manage Requirements</h1>
          <p className="text-sm text-slate-600">Configure donation standards, the logistics destination, and the active legal consent form.</p>
        </div>
        <PageHeaderActions
          onRefresh={refreshActiveSection}
          helpTitle="About Manage Requirements"
          helpContent={(
            <div className="space-y-2">
              <p><strong>{active.label}:</strong> {active.description}</p>
              <p>Select a tab to manage that requirement area. Refresh reloads only the section currently displayed.</p>
            </div>
          )}
          autoRefreshOnChanges={false}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <nav className="flex overflow-x-auto border-b border-slate-200 px-2" role="tablist" aria-label="Requirement sections">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === active.id;
            return (
              <button
                key={tab.id}
                id={`requirements-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`requirements-panel-${tab.id}`}
                onClick={() => openTab(tab.id)}
                className={`relative inline-flex min-w-fit items-center gap-2 px-4 py-3 text-sm font-semibold transition ${
                  isActive ? 'text-slate-950' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                }`}
                style={isActive ? { color: primaryColor } : undefined}
              >
                <Icon size={15} />
                {tab.label}
                {isActive ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full" style={{ backgroundColor: primaryColor }} /> : null}
              </button>
            );
          })}
        </nav>
      </div>

      {visitedTabs.has('wig-requirements') ? (
        <div
          id="requirements-panel-wig-requirements"
          role="tabpanel"
          aria-labelledby="requirements-tab-wig-requirements"
          className={active.id === 'wig-requirements' ? '' : 'hidden'}
        >
          <WigRequirementsPage key={`wig-requirements-${refreshKeys['wig-requirements'] || 0}`} userProfile={userProfile} />
        </div>
      ) : null}
      {visitedTabs.has('logistics-destination-settings') ? (
        <div
          id="requirements-panel-logistics-destination-settings"
          role="tabpanel"
          aria-labelledby="requirements-tab-logistics-destination-settings"
          className={active.id === 'logistics-destination-settings' ? '' : 'hidden'}
        >
          <LogisticsDestinationSettingsPage
            key={`logistics-destination-settings-${refreshKeys['logistics-destination-settings'] || 0}`}
            userProfile={userProfile}
          />
        </div>
      ) : null}
      {visitedTabs.has('legal-documents') ? (
        <div
          id="requirements-panel-legal-documents"
          role="tabpanel"
          aria-labelledby="requirements-tab-legal-documents"
          className={active.id === 'legal-documents' ? '' : 'hidden'}
        >
          <LegalDocumentsPage key={`legal-documents-${refreshKeys['legal-documents'] || 0}`} userProfile={userProfile} />
        </div>
      ) : null}
    </div>
  );
}
