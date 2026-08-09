import React from 'react';
import {
  LayoutDashboard,
  Users,
  Package,
  FileBarChart,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';
import DashboardPage from './DashboardPage';
import ManagePatientsPage from './ManagePatientsPage';
import WigRequestPage from './WigRequestPage';
import GenerateReportsPage from './GenerateReportsPage';
import SettingsPage from './SettingsPage';

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

export default function HRepresentativeRole({ onSignOut, userProfile }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={hRepresentativeNavItems}
      pageComponents={hRepresentativePageComponents}
      defaultPage="dashboard"
    />
  );
}
