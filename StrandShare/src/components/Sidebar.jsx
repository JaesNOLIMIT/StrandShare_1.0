import React from 'react';
import { useTheme } from '../context/ThemeContext';
import {
  LayoutDashboard,
  Users,
  Database,
  Shield,
  Settings,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'user-management', label: 'User Management', icon: Users },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function Sidebar({
  currentPage,
  onNavigate,
  items = navItems,
  isCollapsed = false,
  onToggleSidebar,
}) {
  const { theme } = useTheme();

  return (
    <div
      className={`h-full bg-white border-r border-gray-200 flex flex-col transition-all duration-200 ${
        isCollapsed ? 'w-20' : 'w-[216px]'
      }`}
    >
      {/* Logo Section */}
      <div className={`group relative h-20 border-b border-gray-200 px-4 flex items-center ${isCollapsed ? 'justify-center' : ''}`}>
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className={`pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-gray-300 bg-white p-1.5 text-gray-700 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 ${
              isCollapsed ? '-right-3 opacity-0' : 'right-3 opacity-0'
            }`}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        )}

        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'gap-3'}`}>
          {theme.logoImage ? (
            <img
              src={theme.logoImage}
              alt="Brand logo"
              className="h-10 w-10 rounded-lg object-cover border border-gray-200"
            />
          ) : (
            <div
              className="h-10 w-10 rounded-lg flex items-center justify-center text-white font-bold text-lg"
              style={{ backgroundColor: theme.primaryColor }}
            >
              A
            </div>
          )}

          {!isCollapsed && (
            <div className="min-w-0">
              <h2 className="break-words text-left text-sm font-bold leading-tight text-gray-900">{theme.brandName}</h2>
              <p className="mt-0.5 break-words text-left text-xs leading-snug text-gray-500">{theme.brandTagline}</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className={`flex-1 overflow-y-auto space-y-1.5 ${isCollapsed ? 'p-2' : 'p-3'}`}>
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = currentPage === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center rounded-lg transition-colors ${
                isCollapsed ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2.5 text-left'
              } ${
                isActive
                  ? 'bg-blue-50'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
              title={item.label}
            >
              <Icon
                size={19}
                className="shrink-0"
                style={isActive ? { color: theme.primaryColor } : {}}
              />

              {!isCollapsed && (
                <span
                  className="min-w-0 flex-1 whitespace-normal break-words text-left text-sm font-medium leading-snug"
                  style={isActive ? { color: theme.primaryColor } : {}}
                >
                  {item.label}
                </span>
              )}
            </button>
          );
        })}
      </nav>

    </div>
  );
}
