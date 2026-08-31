import React, { lazy } from 'react';
import {
  BarChart3,
  Boxes,
  CalendarDays,
  LayoutDashboard,
  CheckCircle,
  FileText,
  Package,
  SlidersHorizontal,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';

const DashboardPage = lazy(() => import('./DashboardPage'));
const EventApplicationIntakePage = lazy(() => import('./EventApplicationIntakePage'));
const AssignedEventOperationsPage = lazy(() => import('./AssignedEventOperationsPage'));
const UpdateWigRequestStatusPage = lazy(() => import('./UpdateWigRequestStatusPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));
const ManageRequirementsPage = lazy(() => import('../../shared/features/ManageRequirementsPage'));
const RoleReportsPage = lazy(() => import('../../shared/features/RoleReportsPage'));
const SalonSchedulePage = lazy(() => import('./SalonSchedulePage'));
const CutHairInventoryPage = lazy(() => import('../../shared/features/CutHairInventoryPage'));

const staffNavItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'salon-schedule', label: 'Salon Schedule', icon: CalendarDays },
  { id: 'event-application-intake', label: 'Manage Event Application', icon: CheckCircle },
  { id: 'assigned-event-operations', label: 'Manage Assigned Events', icon: FileText },
  { id: 'cut-hair-inventory', label: 'Cut Hair Inventory', icon: Boxes },
  { id: 'update-wig-request-status', label: 'Manage Wig Request', icon: Package },
  { id: 'manage-requirements', label: 'Manage Requirements', icon: SlidersHorizontal },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const staffPageComponents = {
  dashboard: DashboardPage,
  'event-application-intake': EventApplicationIntakePage,
  'assigned-event-operations': AssignedEventOperationsPage,
  'cut-hair-inventory': CutHairInventoryPage,
  'salon-schedule': SalonSchedulePage,
  'update-wig-request-status': UpdateWigRequestStatusPage,
  'manage-requirements': ManageRequirementsPage,
  reports: RoleReportsPage,
  settings: SettingsPage,
};

export default function StaffRole({ onSignOut, userProfile, onInitialDashboardReady }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={staffNavItems}
      pageComponents={staffPageComponents}
      defaultPage="dashboard"
      onInitialDashboardReady={onInitialDashboardReady}
    />
  );
}
