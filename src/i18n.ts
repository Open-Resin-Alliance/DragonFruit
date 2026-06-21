import { i18n } from "@lingui/core";

export const SUPPORTED_LOCALES = ["en", "es", "de", "fr"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// Native-language labels for the language switcher.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
};

const STORAGE_KEY = "dragonfruit.locale";
const DEFAULT_LOCALE: Locale = "en";

function isSupported(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// Bootstrap: activate English immediately so components render without waiting.
// For the source locale an empty catalog is correct — strings pass through as-is.
i18n.load(DEFAULT_LOCALE, {});
i18n.activate(DEFAULT_LOCALE);

// Resolve the initial locale, client-side only:
//   1. an explicit user choice persisted in localStorage, else
//   2. a build-time override via NEXT_PUBLIC_DF_LOCALE (forcing a language
//      for demos/CI), else
//   3. the browser/OS preferred language (navigator.language prefix), else
//   4. the default locale.
export function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isSupported(stored)) return stored;
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall through.
  }

  const forced = process.env.NEXT_PUBLIC_DF_LOCALE;
  if (forced && isSupported(forced)) return forced;

  const prefix = navigator.language?.split("-")[0]?.toLowerCase();
  if (prefix && isSupported(prefix)) return prefix;

  return DEFAULT_LOCALE;
}

export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Best-effort; persistence is non-critical.
  }
}

// Dynamically load and activate a compiled locale catalog.
export async function loadLocale(locale: Locale): Promise<void> {
  const { messages } = await import(`./locales/${locale}.js`);
  i18n.load(locale, messages);
  i18n.activate(locale);
}

export { i18n };
