import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_SETTINGS } from "../../vendor/ovis/src/lib/settings";

export const settings = Object.freeze({ ...DEFAULT_SETTINGS });
const value = Object.freeze({
  settings,
  resolvedLanguage: "en",
  update: (_value: unknown): void => {},
  own: () => settings,
  watch: (_changed: () => void) => () => {},
});
const context = createContext(value);

/** Read-only, memory-only settings surface for the vendored Ovis layout components. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useSettings() {
  return useContext(context);
}
