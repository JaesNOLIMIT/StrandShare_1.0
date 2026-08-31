import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from '../../components/Sidebar';
import Header from '../../components/Header';
import { PageActivityProvider } from '../../context/PageActivityContext';

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
  onInitialDashboardReady,
}) {
  const initialPage = defaultPage || 'dashboard';
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [visitedPages, setVisitedPages] = useState(() => new Set([initialPage]));
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(getInitialSidebarCollapsed);

  const navigateToPage = useCallback((pageId) => {
    const nextPage = pageId || 'dashboard';
    setVisitedPages((previous) => {
      if (previous.has(nextPage)) return previous;
      const next = new Set(previous);
      next.add(nextPage);
      return next;
    });
    setCurrentPage(nextPage);
  }, []);

  useEffect(() => {
    navigateToPage(defaultPage || 'dashboard');
  }, [defaultPage, navigateToPage]);

  const pageTitle = useMemo(() => {
    const activeNavItem = navItems.find((item) => item.id === currentPage);
    return activeNavItem?.label || 'Overview';
  }, [currentPage, navItems]);
  const hasActivePage = Boolean(pageComponents[currentPage]);
  const cachedPageIds = useMemo(
    () => Array.from(visitedPages).filter((pageId) => Boolean(pageComponents[pageId])),
    [pageComponents, visitedPages],
  );

  const hasSettingsPage = Boolean(pageComponents.settings) || navItems.some((item) => item.id === 'settings');
  const pageWrapperClass = 'relative flex-1 overflow-auto bg-slate-50 p-6 md:p-8';

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
    } catch {
      // Ignore localStorage write failures.
    }
  }, [isSidebarCollapsed]);

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
            cachedPageIds.map((pageId) => {
              const CachedPageComponent = pageComponents[pageId];
              const isActive = pageId === currentPage;
              return (
                <div
                  key={pageId}
                  className={isActive
                    ? 'min-h-full min-w-0'
                    : 'pointer-events-none absolute inset-x-0 top-0 min-h-full min-w-0 select-none opacity-0'}
                  aria-hidden={!isActive}
                  inert={isActive ? undefined : ''}
                >
                  <PageActivityProvider active={isActive}>
                    <Suspense fallback={null}>
                      <CachedPageComponent
                        userProfile={userProfile}
                        onNavigate={navigateToPage}
                        navItems={navItems}
                        currentPage={pageId}
                        isActivePage={isActive}
                        onInitialDataReady={pageId === 'dashboard' ? onInitialDashboardReady : undefined}
                      />
                    </Suspense>
                  </PageActivityProvider>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
