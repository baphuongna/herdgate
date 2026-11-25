import { createContext, useContext, type ReactNode } from "react";

const settings = Object.freeze({
  autoTabNames: false,
  phoneTabs: false,
  statusIndicators: "classic",
  terminalMirrorWrap: false,
});
const value = {
  settings,
  resolvedLanguage: "en",
  update: (_value: unknown): void => {},
  own: () => settings,
  watch: (_changed: () => void) => () => {},
};
const context = createContext(value);

/** Read-only, memory-only settings surface for the vendored Ovis layout components. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useSettings() {
  return useContext(context);
}
