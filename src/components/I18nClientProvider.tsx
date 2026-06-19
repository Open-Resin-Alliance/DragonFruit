"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { I18nProvider } from "@lingui/react";
import {
  i18n,
  loadLocale,
  detectInitialLocale,
  persistLocale,
  type Locale,
} from "@/i18n";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within I18nClientProvider");
  return ctx;
}

export function I18nClientProvider({ children }: { children: React.ReactNode }) {
  // Start on the bootstrapped English locale (i18n.ts), then resolve the
  // detected/persisted locale on mount. Re-render via state when it activates.
  const [locale, setLocaleState] = useState<Locale>("en");

  const setLocale = React.useCallback((next: Locale) => {
    void loadLocale(next).then(() => {
      persistLocale(next);
      setLocaleState(next);
    });
  }, []);

  useEffect(() => {
    const initial = detectInitialLocale();
    // State already starts on "en" (the bootstrapped locale) — only act when
    // the detected locale differs and its catalog must be loaded.
    if (initial === "en") return;
    void loadLocale(initial).then(() => setLocaleState(initial));
  }, []);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </LocaleContext.Provider>
  );
}
