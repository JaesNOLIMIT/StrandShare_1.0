import React, { lazy } from 'react';
import {
  LayoutDashboard,
  Users,
  Package,
  FileBarChart,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';

const DashboardPage = lazy(() => import('./DashboardPage'));
const ManagePatientsPage = lazy(() => import('./ManagePatientsPage'));
const WigRequestPage = lazy(() => import('./WigRequestPage'));
const GenerateReportsPage = lazy(() => import('./GenerateReportsPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));

const hRepresentativeNavItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'manage-patients', label: 'Manage Patients', icon: Users },
  { id: 'wig-request', label: 'Wig Requests', icon: Package },
  { id: 'reports', label: 'Reports', icon: FileBarChart },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const hRepresentativePageComponents = {
  dashboard: DashboardPage,
  'manage-patients': ManagePatientsPage,
  'wig-request': WigRequestPage,
  reports: GenerateReportsPage,
  settings: SettingsPage,
};

export default function HRepresentativeRole({ onSignOut, userProfile, onInitialDashboardReady }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={hRepresentativeNavItems}
      pageComponents={hRepresentativePageComponents}
      defaultPage="dashboard"
      onInitialDashboardReady={onInitialDashboardReady}
    />
  );
}
