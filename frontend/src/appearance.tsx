import React, { createContext, useContext } from 'react';

const AppearanceContext = createContext(false);
export function UiProvider({ agent, children }: { agent: boolean; children: React.ReactNode }) {
  return <AppearanceContext.Provider value={agent}>{children}</AppearanceContext.Provider>;
}
export function useAgentAppearance() { return useContext(AppearanceContext); }
