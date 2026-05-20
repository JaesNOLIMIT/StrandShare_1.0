import React from 'react';
import {
  LayoutDashboard,
  ScanLine,
  Package,
  Wand2,
  FileBarChart2,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';
import DashboardPage from './DashboardPage';
import QualityCheckPage from './QualityCheckPage';
import BundlingPage from './BundlingPage';
import WigAiStudioPage from './WigAiStudioPage';
import GenerateReportsPage from './GenerateReportsPage';
import SettingsPage from './SettingsPage';

const specialistNavItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'quality-check', label: 'Quality Check', icon: ScanLine },
  { id: 'bundling', label: 'Bundling', icon: Package },
  { id: 'wig-ai-studio', label: 'Wig AI Studio', icon: Wand2 },
  { id: 'reports', label: 'Reports', icon: FileBarChart2 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const specialistPageComponents = {
  dashboard: DashboardPage,
  'quality-check': QualityCheckPage,
  bundling: BundlingPage,
  'wig-ai-studio': WigAiStudioPage,
  reports: GenerateReportsPage,
  settings: SettingsPage,
};

export default function SpecialistRole({ onSignOut, userProfile, initialPage = 'dashboard' }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={specialistNavItems}
      pageComponents={specialistPageComponents}
      defaultPage={initialPage}
    />
  );
}
