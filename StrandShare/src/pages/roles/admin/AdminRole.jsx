import React, { lazy } from 'react';
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

const DashboardPage = lazy(() => import('./DashboardPage'));
const ManageUserAccountsPage = lazy(() => import('./ManageUserAccountsPage'));
const ManageHospitalAccountsPage = lazy(() => import('./ManageHospitalAccountsPage'));
const ManageEventApplicationsPage = lazy(() => import('./ManageEventApplicationsPage'));
const AuditTrailsPage = lazy(() => import('./AuditTrailsPage'));
const BackupPage = lazy(() => import('./BackupPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));
const ManageRequirementsPage = lazy(() => import('../../shared/features/ManageRequirementsPage'));
const RoleReportsPage = lazy(() => import('../../shared/features/RoleReportsPage'));

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

export default function AdminRole({ onSignOut, userProfile, onInitialDashboardReady }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={adminNavItems}
      pageComponents={adminPageComponents}
      defaultPage="dashboard"
      onInitialDashboardReady={onInitialDashboardReady}
    />
  );
}
