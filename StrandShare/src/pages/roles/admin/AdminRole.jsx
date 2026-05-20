import React from 'react';
import {
  BarChart3,
  LayoutDashboard,
  Users,
  Building2,
  ShieldCheck,
  SlidersHorizontal,
  ClipboardList,
  HardDrive,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';
import DashboardPage from './DashboardPage';
import ManageUserAccountsPage from './ManageUserAccountsPage';
import ManageHospitalAccountsPage from './ManageHospitalAccountsPage';
import ManageEventApplicationsPage from './ManageEventApplicationsPage';
import AuditTrailsPage from './AuditTrailsPage';
import BackupPage from './BackupPage';
import SettingsPage from './SettingsPage';
import ManageRequirementsPage from '../../shared/features/ManageRequirementsPage';
import RoleReportsPage from '../../shared/features/RoleReportsPage';

const adminNavItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'manage-user-accounts', label: 'Manage User Accounts', icon: Users },
  { id: 'manage-hospital-accounts', label: 'Manage H-Representative', icon: Building2 },
  { id: 'manage-event-applications', label: 'Manage Event Requests', icon: ShieldCheck },
  { id: 'manage-requirements', label: 'Manage Requirements', icon: SlidersHorizontal },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'audit-trails', label: 'Audit Trails', icon: ClipboardList },
  { id: 'backup', label: 'Backup', icon: HardDrive },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const adminPageComponents = {
  dashboard: DashboardPage,
  'manage-user-accounts': ManageUserAccountsPage,
  'manage-hospital-accounts': ManageHospitalAccountsPage,
  'manage-event-applications': ManageEventApplicationsPage,
  'manage-requirements': ManageRequirementsPage,
  reports: RoleReportsPage,
  'audit-trails': AuditTrailsPage,
  backup: BackupPage,
  settings: SettingsPage,
};

export default function AdminRole({ onSignOut, userProfile }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={adminNavItems}
      pageComponents={adminPageComponents}
      defaultPage="dashboard"
    />
  );
}
