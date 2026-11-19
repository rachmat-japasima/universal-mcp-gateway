'use client';

import { Theme } from '@astryxdesign/core/theme';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { themes, defaultThemeSlug } from '@/astryx-themes';

/**
 * Theme mode is owned here and nowhere else.
 *
 * Astryx's `<Theme mode>` is the only colour-mode authority: it writes
 * `data-theme="light|dark"` and `color-scheme` to `<html>`, which both the
 * Tailwind bridge and `light-dark()` tokens read. Running a second dark-mode
 * provider would let the two disagree, which is the failure the Astryx styling
 * docs specifically warn about.
 *
 * The stored preference is applied after mount. The server cannot read
 * `localStorage`, so rendering "dark" on the server would hydrate against a
 * different DOM. Astryx defaults to `system`, which is the same on both sides —
 * an honest first paint rather than a guessed one.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'umg.theme-mode';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

export function useThemeMode(): ThemeModeContextValue {
  const value = useContext(ThemeModeContext);
  if (value === null) throw new Error('useThemeMode must be used inside <DashboardTheme>.');
  return value;
}

export function DashboardTheme({ children }: { children: React.ReactNode }): React.ReactElement {
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isThemeMode(stored)) setModeState(stored);
    } catch {
      // Storage can be blocked (private mode, disabled cookies). The dashboard
      // still works; the preference just will not persist.
    }
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same as above: a lost preference is not a broken page.
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <ThemeModeContext.Provider value={value}>
      <Theme theme={themes[defaultThemeSlug]} mode={mode}>
        {children}
      </Theme>
    </ThemeModeContext.Provider>
  );
}
