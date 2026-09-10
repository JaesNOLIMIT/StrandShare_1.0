import React, { createContext, useContext } from 'react';

const PageActivityContext = createContext(true);

export function PageActivityProvider({ active, children }) {
  return (
    <PageActivityContext.Provider value={active !== false}>
      {children}
    </PageActivityContext.Provider>
  );
}

export function usePageActivity() {
  return useContext(PageActivityContext);
}
