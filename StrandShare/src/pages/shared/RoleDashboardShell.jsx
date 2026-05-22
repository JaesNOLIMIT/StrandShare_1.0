import React, { useEffect, useMemo, useState } from 'react';
import Sidebar from '../../components/Sidebar';
import Header from '../../components/Header';
import { logAuditAction } from '../../lib/auditLogger';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'Donivra.sidebar.collapsed';

function getInitialSidebarCollapsed() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export default function RoleDashboardShell({
  onSignOut,
  userProfile,
  navItems,
  defaultPage = 'dashboard',
  pageComponents = {},
}) {
  const [currentPage, setCurrentPage] = useState(defaultPage);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(getInitialSidebarCollapsed);

  useEffect(() => {
    setCurrentPage(defaultPage || 'dashboard');
  }, [defaultPage]);

  const pageTitle = useMemo(() => {
    const activeNavItem = navItems.find((item) => item.id === currentPage);
    return activeNavItem?.label || 'Overview';
  }, [currentPage, navItems]);

  const hasSettingsPage = Boolean(pageComponents.settings) || navItems.some((item) => item.id === 'settings');
  const pageWrapperClass = 'flex-1 overflow-auto bg-slate-50 p-6 md:p-8';

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
    } catch {
      // Ignore localStorage write failures.
    }
  }, [isSidebarCollapsed]);

  useEffect(() => {
    if (!currentPage) {
      return;
    }

    void logAuditAction({
      action: 'navigation.view_page',
      description: `Viewed page: ${pageTitle}`,
      resource: `page/${currentPage}`,
      status: 'success',
      userProfile,
    });
  }, [currentPage, pageTitle, userProfile]);

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        items={navItems}
        isCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed((previous) => !previous)}
      />
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden">
        <Header
          onSignOut={onSignOut}
          onOpenSettings={hasSettingsPage ? () => setCurrentPage('settings') : undefined}
          userProfile={userProfile}
          pageTitle={pageTitle}
        />
        <div className={pageWrapperClass}>
          {Object.keys(pageComponents).length === 0 ? (
            <div className="p-8 text-slate-600">Page not available.</div>
          ) : (
            Object.entries(pageComponents).map(([pageId, PageComponent]) => {
              if (!PageComponent) {
                return null;
              }
              const isActive = pageId === currentPage;
              return (
                <div
                  key={pageId}
                  className={isActive ? 'block' : 'hidden'}
                >
                  <PageComponent
                    userProfile={userProfile}
                    onNavigate={setCurrentPage}
                    navItems={navItems}
                    currentPage={currentPage}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

