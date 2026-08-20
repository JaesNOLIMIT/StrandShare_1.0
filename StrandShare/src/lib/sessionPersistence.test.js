import {
  clearLoginSessionPersistence,
  configureLoginSessionPersistence,
  getLoginSessionPersistenceStatus,
} from './sessionPersistence';

describe('login session persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = 'Donivra_active_browser_session=; Path=/; Max-Age=0';
  });

  afterEach(() => {
    clearLoginSessionPersistence();
  });

  test('shares a non-remembered login across normal browser tabs', () => {
    configureLoginSessionPersistence(false);

    // A newly opened tab has a fresh sessionStorage but shares cookies.
    window.sessionStorage.clear();

    expect(getLoginSessionPersistenceStatus()).toEqual({
      isValid: true,
      isRemembered: false,
      rememberUntil: null,
    });
  });

  test('keeps remembered logins valid until their deadline', () => {
    configureLoginSessionPersistence(true);

    const status = getLoginSessionPersistenceStatus();
    expect(status.isValid).toBe(true);
    expect(status.isRemembered).toBe(true);
    expect(status.rememberUntil).toBeGreaterThan(Date.now());
  });

  test('clears both browser-session and remembered persistence', () => {
    configureLoginSessionPersistence(false);
    clearLoginSessionPersistence();

    expect(getLoginSessionPersistenceStatus().isValid).toBe(false);
  });
});
