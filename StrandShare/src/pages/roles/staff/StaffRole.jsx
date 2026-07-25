import React from 'react';
import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  CheckCircle,
  FileText,
  Package,
  SlidersHorizontal,
  Settings,
} from 'lucide-react';
import RoleDashboardShell from '../../shared/RoleDashboardShell';
import DashboardPage from './DashboardPage';
import EventApplicationIntakePage from './EventApplicationIntakePage';
import AssignedEventOperationsPage from './AssignedEventOperationsPage';
import UpdateWigRequestStatusPage from './UpdateWigRequestStatusPage';
import SettingsPage from './SettingsPage';
import ManageRequirementsPage from '../../shared/features/ManageRequirementsPage';
import RoleReportsPage from '../../shared/features/RoleReportsPage';
import SalonSchedulePage from './SalonSchedulePage';

const staffNavItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'salon-schedule', label: 'Salon Schedule', icon: CalendarDays },
  { id: 'event-application-intake', label: 'Manage Event Application', icon: CheckCircle },
  { id: 'assigned-event-operations', label: 'Manage Assigned Events', icon: FileText },
  { id: 'update-wig-request-status', label: 'Manage Wig Request', icon: Package },
  { id: 'manage-requirements', label: 'Manage Requirements', icon: SlidersHorizontal },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const staffPageComponents = {
  dashboard: DashboardPage,
  'event-application-intake': EventApplicationIntakePage,
  'assigned-event-operations': AssignedEventOperationsPage,
  'salon-schedule': SalonSchedulePage,
  'update-wig-request-status': UpdateWigRequestStatusPage,
  'manage-requirements': ManageRequirementsPage,
  reports: RoleReportsPage,
  settings: SettingsPage,
};

export default function StaffRole({ onSignOut, userProfile }) {
  return (
    <RoleDashboardShell
      onSignOut={onSignOut}
      userProfile={userProfile}
      navItems={staffNavItems}
      pageComponents={staffPageComponents}
      defaultPage="dashboard"
    />
  );
}
