import React, { lazy } from 'react';
import {
  LayoutDashboard,
  Boxes,
  ScanLine,
  Package,
  Wand2,
  FileBarChart2,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';

const DashboardPage = lazy(() => import('./DashboardPage'));
const QualityCheckPage = lazy(() => import('./QualityCheckPage'));
const BundlingPage = lazy(() => import('./BundlingPage'));
const WigCatalogStudioPage = lazy(() => import('./WigCatalogStudioPage'));
const GenerateReportsPage = lazy(() => import('./GenerateReportsPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));
const CutHairInventoryPage = lazy(() => import('../../shared/features/CutHairInventoryPage'));

const specialistNavItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'quality-check', label: 'Quality Check', icon: ScanLine },
  { id: 'cut-hair-inventory', label: 'Cut Hair Inventory', icon: Boxes },
  { id: 'bundling', label: 'Bundling', icon: Package },
  { id: 'wig-ai-studio', label: 'Wig Catalog Studio', icon: Wand2 },
  { id: 'reports', label: 'Reports', icon: FileBarChart2 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const specialistPageComponents = {
  dashboard: DashboardPage,
  'quality-check': QualityCheckPage,
  'cut-hair-inventory': CutHairInventoryPage,
  bundling: BundlingPage,
  'wig-ai-studio': WigCatalogStudioPage,
  reports: GenerateReportsPage,
  settings: SettingsPage,
};

export default function SpecialistRole({ onSignOut, userProfile, initialPage = 'dashboard', onInitialDashboardReady }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={specialistNavItems}
      pageComponents={specialistPageComponents}
      defaultPage={initialPage}
      onInitialDashboardReady={onInitialDashboardReady}
    />
  );
}
