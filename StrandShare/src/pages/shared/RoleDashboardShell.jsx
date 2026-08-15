import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  const initialPage = defaultPage || 'dashboard';
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(getInitialSidebarCollapsed);

  const navigateToPage = useCallback((pageId) => {
    setCurrentPage(pageId || 'dashboard');
  }, []);

  useEffect(() => {
    navigateToPage(defaultPage || 'dashboard');
  }, [defaultPage, navigateToPage]);

  const pageTitle = useMemo(() => {
    const activeNavItem = navItems.find((item) => item.id === currentPage);
    return activeNavItem?.label || 'Overview';
  }, [currentPage, navItems]);
  const hasActivePage = Boolean(pageComponents[currentPage]);

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
        onNavigate={navigateToPage}
        items={navItems}
        isCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed((previous) => !previous)}
      />
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden">
        <Header
          onSignOut={onSignOut}
          onOpenSettings={hasSettingsPage ? () => navigateToPage('settings') : undefined}
          userProfile={userProfile}
          pageTitle={pageTitle}
        />
        <div className={pageWrapperClass}>
          {!hasActivePage ? (
            <div className="p-8 text-slate-600">Page not available.</div>
          ) : (
            Object.entries(pageComponents).map(([pageId, PageComponent]) => {
              const isActive = pageId === currentPage;
              return (
                <div
                  key={pageId}
                  className={isActive ? 'min-h-full' : 'hidden'}
                  aria-hidden={!isActive}
                >
                  <PageComponent
                    userProfile={userProfile}
                    onNavigate={navigateToPage}
                    navItems={navItems}
                    currentPage={pageId}
                    isActivePage={isActive}
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
