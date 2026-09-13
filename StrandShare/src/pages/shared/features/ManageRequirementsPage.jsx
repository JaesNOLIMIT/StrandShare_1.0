import React, { useEffect, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, ListChecks, MapPin } from "lucide-react";
import { useTheme } from "../../../context/ThemeContext";
import { toCanonicalRole } from "../../../lib/roleUtils";
import PageHeaderActions from "../../../components/PageHeaderActions";
import WigRequirementsPage from "./WigRequirementsPage";
import LogisticsDestinationSettingsPage from "./LogisticsDestinationSettingsPage";
import LegalDocumentsPage from "./LegalDocumentsPage";
import HairReferenceImagesPage from "./HairReferenceImagesPage";

const TABS = [
  {
    id: "wig-requirements",
    label: "Wig Requirements",
    description: "Global hair donation requirements.",
    icon: ListChecks,
  },
  {
    id: "hair-reference-images",
    label: "Hair Reference Photos",
    description: "Upload visual examples used for hair analysis.",
    icon: ImageIcon,
  },
  {
    id: "logistics-destination-settings",
    label: "Logistics Destination",
    description: "Shared pickup/drop destination and pinned location.",
    icon: MapPin,
  },
  {
    id: "legal-documents",
    label: "Legal Documents",
    description: "Consent PDF versions and activation.",
    icon: FileText,
  },
];

export default function ManageRequirementsPage({ userProfile }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || "#0f766e";
  const role = toCanonicalRole(userProfile?.role);
  const availableTabs = useMemo(
    () =>
      role === "specialist"
        ? TABS.filter((tab) => tab.id === "hair-reference-images")
        : TABS,
    [role],
  );
  const initialTab =
    role === "specialist" ? "hair-reference-images" : "wig-requirements";
  const [activeTab, setActiveTab] = useState(initialTab);
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([initialTab]));
  const [refreshKeys, setRefreshKeys] = useState({});

  useEffect(() => {
    if (availableTabs.some((tab) => tab.id === activeTab)) return;
    const fallback = availableTabs[0]?.id || "hair-reference-images";
    setActiveTab(fallback);
    setVisitedTabs((previous) => new Set(previous).add(fallback));
  }, [activeTab, availableTabs]);

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
    () =>
      availableTabs.find((tab) => tab.id === activeTab) ||
      availableTabs[0] ||
      TABS[0],
    [activeTab, availableTabs],
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
          <h1 className="role-page-title text-2xl font-bold text-slate-900">
            Manage Requirements
          </h1>
          <p className="text-sm text-slate-600">
            Configure donation standards, hair reference photos, logistics, and
            legal documents.
          </p>
        </div>
        <PageHeaderActions
          onRefresh={refreshActiveSection}
          helpTitle="About Manage Requirements"
          helpContent={
            <div className="space-y-2">
              <p>
                <strong>{active.label}:</strong> {active.description}
              </p>
              <p>
                Select a tab to manage that requirement area. Refresh reloads
                only the section currently displayed.
              </p>
            </div>
          }
          autoRefreshOnChanges={false}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <nav
          className="flex overflow-x-auto border-b border-slate-200 px-2"
          role="tablist"
          aria-label="Requirement sections"
        >
          {availableTabs.map((tab) => {
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
                  isActive
                    ? "text-slate-950"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
                style={isActive ? { color: primaryColor } : undefined}
              >
                <Icon size={15} />
                {tab.label}
                {isActive ? (
                  <span
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full"
                    style={{ backgroundColor: primaryColor }}
                  />
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>

      {visitedTabs.has("wig-requirements") ? (
        <div
          id="requirements-panel-wig-requirements"
          role="tabpanel"
          aria-labelledby="requirements-tab-wig-requirements"
          className={active.id === "wig-requirements" ? "" : "hidden"}
        >
          <WigRequirementsPage
            key={`wig-requirements-${refreshKeys["wig-requirements"] || 0}`}
            userProfile={userProfile}
          />
        </div>
      ) : null}
      {visitedTabs.has("hair-reference-images") ? (
        <div
          id="requirements-panel-hair-reference-images"
          role="tabpanel"
          aria-labelledby="requirements-tab-hair-reference-images"
          className={active.id === "hair-reference-images" ? "" : "hidden"}
        >
          <HairReferenceImagesPage
            key={`hair-reference-images-${refreshKeys["hair-reference-images"] || 0}`}
          />
        </div>
      ) : null}
      {visitedTabs.has("logistics-destination-settings") ? (
        <div
          id="requirements-panel-logistics-destination-settings"
          role="tabpanel"
          aria-labelledby="requirements-tab-logistics-destination-settings"
          className={
            active.id === "logistics-destination-settings" ? "" : "hidden"
          }
        >
          <LogisticsDestinationSettingsPage
            key={`logistics-destination-settings-${refreshKeys["logistics-destination-settings"] || 0}`}
            userProfile={userProfile}
          />
        </div>
      ) : null}
      {visitedTabs.has("legal-documents") ? (
        <div
          id="requirements-panel-legal-documents"
          role="tabpanel"
          aria-labelledby="requirements-tab-legal-documents"
          className={active.id === "legal-documents" ? "" : "hidden"}
        >
          <LegalDocumentsPage
            key={`legal-documents-${refreshKeys["legal-documents"] || 0}`}
            userProfile={userProfile}
          />
        </div>
      ) : null}
    </div>
  );
}
