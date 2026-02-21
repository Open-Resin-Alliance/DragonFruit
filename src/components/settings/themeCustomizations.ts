import type { ThemePreference } from '@/components/settings/UISettingsTab';

export const THEME_STORAGE_KEY = 'app-theme-preference';
export const THEME_COLORS_STORAGE_KEY = 'app-theme-colors';
export const THEME_PRESET_STORAGE_KEY = 'app-theme-preset';

export type ThemePreset = 'dragonfruit-dark';

const LEGACY_DEFAULT_ACCENT = '#d946ef';
const NEW_DEFAULT_ACCENT = '#ec2a77';

export type ThemeCustomColors = {
  surface0: string;
  accent: string;
  primaryButtonSurface: string;
  accentContrast: string;
  accentSecondary: string;
  secondaryButtonSurface: string;
  accentSecondaryContrast: string;
  sceneGradientRadial: string;
  sceneGradientLinearStart: string;
  sceneGradientLinearMid: string;
  topbarAccent: string;
  surface1: string;
  surface2: string;
  textStrong: string;
  textMuted: string;
  indicator: string;
  borderSubtle: string;
  borderStrong: string;
  danger: string;
};

export const DEFAULT_THEME_CUSTOM_COLORS: ThemeCustomColors = {
  surface0: '#111216',
  accent: NEW_DEFAULT_ACCENT,
  primaryButtonSurface: '#c11f61',
  accentContrast: '#fff6ff',
  accentSecondary: '#baf72e',
  secondaryButtonSurface: '#9bcc26',
  accentSecondaryContrast: '#182106',
  sceneGradientRadial: '#ff37aa',
  sceneGradientLinearStart: '#ff37aa',
  sceneGradientLinearMid: '#6f33ff',
  topbarAccent: NEW_DEFAULT_ACCENT,
  surface1: '#1a1b21',
  surface2: '#23252e',
  textStrong: '#f8f8fb',
  textMuted: '#c3c7cf',
  indicator: '#c3c7cf',
  borderSubtle: '#272a33',
  borderStrong: '#353944',
  danger: '#e45454',
};

function normalizeHex(value: string, fallback: string): string {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : fallback;
}

function darkenHex(hexColor: string, factor: number): string {
  const hex = normalizeHex(hexColor, DEFAULT_THEME_CUSTOM_COLORS.accent).slice(1);
  const channel = (offset: number) => {
    const current = parseInt(hex.slice(offset, offset + 2), 16);
    const next = Math.max(0, Math.min(255, Math.round(current * factor)));
    return next.toString(16).padStart(2, '0');
  };

  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

export function getSavedThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : 'system';
}

export function getSavedThemePreset(): ThemePreset {
  if (typeof window === 'undefined') return 'dragonfruit-dark';
  const raw = window.localStorage.getItem(THEME_PRESET_STORAGE_KEY);
  return raw === 'dragonfruit-dark' ? raw : 'dragonfruit-dark';
}

export function applyThemePreference(preference: ThemePreference) {
  if (typeof document === 'undefined') return;

  if (preference === 'system') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }

  document.documentElement.setAttribute('data-theme', preference);
}

export function getSavedThemeCustomColors(): ThemeCustomColors {
  if (typeof window === 'undefined') return DEFAULT_THEME_CUSTOM_COLORS;

  const raw = window.localStorage.getItem(THEME_COLORS_STORAGE_KEY);
  if (!raw) return DEFAULT_THEME_CUSTOM_COLORS;

  try {
    const parsed = JSON.parse(raw) as Partial<ThemeCustomColors>;
    const d = DEFAULT_THEME_CUSTOM_COLORS;

    let accent = normalizeHex(parsed.accent ?? d.accent, d.accent);
    let topbarAccent = normalizeHex(parsed.topbarAccent ?? d.topbarAccent, d.topbarAccent);

    // Migrate old bundled defaults (#d946ef) to the new brand default (#ec2a77).
    // If users explicitly customized away from legacy values, their choices are preserved.
    if (accent === LEGACY_DEFAULT_ACCENT) accent = NEW_DEFAULT_ACCENT;
    if (topbarAccent === LEGACY_DEFAULT_ACCENT) topbarAccent = NEW_DEFAULT_ACCENT;

    const next: ThemeCustomColors = {
      surface0: normalizeHex(parsed.surface0 ?? d.surface0, d.surface0),
      accent,
      primaryButtonSurface: normalizeHex(parsed.primaryButtonSurface ?? darkenHex(accent, 0.82), d.primaryButtonSurface),
      accentContrast: normalizeHex(parsed.accentContrast ?? d.accentContrast, d.accentContrast),
      accentSecondary: normalizeHex(parsed.accentSecondary ?? d.accentSecondary, d.accentSecondary),
      secondaryButtonSurface: normalizeHex(parsed.secondaryButtonSurface ?? darkenHex(parsed.accentSecondary ?? d.accentSecondary, 0.84), d.secondaryButtonSurface),
      accentSecondaryContrast: normalizeHex(parsed.accentSecondaryContrast ?? d.accentSecondaryContrast, d.accentSecondaryContrast),
      sceneGradientRadial: normalizeHex(parsed.sceneGradientRadial ?? d.sceneGradientRadial, d.sceneGradientRadial),
      sceneGradientLinearStart: normalizeHex(parsed.sceneGradientLinearStart ?? d.sceneGradientLinearStart, d.sceneGradientLinearStart),
      sceneGradientLinearMid: normalizeHex(parsed.sceneGradientLinearMid ?? d.sceneGradientLinearMid, d.sceneGradientLinearMid),
      topbarAccent,
      surface1: normalizeHex(parsed.surface1 ?? d.surface1, d.surface1),
      surface2: normalizeHex(parsed.surface2 ?? d.surface2, d.surface2),
      textStrong: normalizeHex(parsed.textStrong ?? d.textStrong, d.textStrong),
      textMuted: normalizeHex(parsed.textMuted ?? d.textMuted, d.textMuted),
      indicator: normalizeHex(parsed.indicator ?? d.indicator, d.indicator),
      borderSubtle: normalizeHex(parsed.borderSubtle ?? d.borderSubtle, d.borderSubtle),
      borderStrong: normalizeHex(parsed.borderStrong ?? d.borderStrong, d.borderStrong),
      danger: normalizeHex(parsed.danger ?? d.danger, d.danger),
    };

    // Keep storage in sync after migration so future loads are deterministic.
    window.localStorage.setItem(THEME_COLORS_STORAGE_KEY, JSON.stringify(next));

    return next;
  } catch {
    return DEFAULT_THEME_CUSTOM_COLORS;
  }
}

export function applyThemeCustomColors(themeColors: ThemeCustomColors) {
  if (typeof document === 'undefined') return;

  const d = DEFAULT_THEME_CUSTOM_COLORS;
  const surface0 = normalizeHex(themeColors.surface0, d.surface0);
  const accent = normalizeHex(themeColors.accent, d.accent);
  const primaryButtonSurface = normalizeHex(themeColors.primaryButtonSurface, darkenHex(accent, 0.82));
  const accentContrast = normalizeHex(themeColors.accentContrast, d.accentContrast);
  const accentSecondary = normalizeHex(themeColors.accentSecondary, d.accentSecondary);
  const secondaryButtonSurface = normalizeHex(themeColors.secondaryButtonSurface, darkenHex(accentSecondary, 0.84));
  const accentSecondaryContrast = normalizeHex(themeColors.accentSecondaryContrast, d.accentSecondaryContrast);
  const sceneGradientRadial = normalizeHex(themeColors.sceneGradientRadial, d.sceneGradientRadial);
  const sceneGradientLinearStart = normalizeHex(themeColors.sceneGradientLinearStart, d.sceneGradientLinearStart);
  const sceneGradientLinearMid = normalizeHex(themeColors.sceneGradientLinearMid, d.sceneGradientLinearMid);
  const topbarAccent = normalizeHex(themeColors.topbarAccent, accent);
  const surface1 = normalizeHex(themeColors.surface1, d.surface1);
  const surface2 = normalizeHex(themeColors.surface2, d.surface2);
  const textStrong = normalizeHex(themeColors.textStrong, d.textStrong);
  const textMuted = normalizeHex(themeColors.textMuted, d.textMuted);
  const indicator = normalizeHex(themeColors.indicator, d.indicator);
  const borderSubtle = normalizeHex(themeColors.borderSubtle, d.borderSubtle);
  const borderStrong = normalizeHex(themeColors.borderStrong, d.borderStrong);
  const danger = normalizeHex(themeColors.danger, d.danger);

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--surface-0', surface0);
  rootStyle.setProperty('--accent', accent);
  rootStyle.setProperty('--primary-button-surface', primaryButtonSurface);
  rootStyle.setProperty('--accent-hover', darkenHex(accent, 0.82));
  rootStyle.setProperty('--accent-contrast', accentContrast);
  rootStyle.setProperty('--accent-secondary', accentSecondary);
  rootStyle.setProperty('--secondary-button-surface', secondaryButtonSurface);
  rootStyle.setProperty('--accent-secondary-hover', darkenHex(accentSecondary, 0.9));
  rootStyle.setProperty('--accent-secondary-contrast', accentSecondaryContrast);
  rootStyle.setProperty('--scene-gradient-radial', sceneGradientRadial);
  rootStyle.setProperty('--scene-gradient-linear-start', sceneGradientLinearStart);
  rootStyle.setProperty('--scene-gradient-linear-mid', sceneGradientLinearMid);
  rootStyle.setProperty('--topbar-accent', topbarAccent);
  rootStyle.setProperty('--surface-1', surface1);
  rootStyle.setProperty('--surface-2', surface2);
  rootStyle.setProperty('--text-strong', textStrong);
  rootStyle.setProperty('--text-muted', textMuted);
  rootStyle.setProperty('--indicator', indicator);
  rootStyle.setProperty('--border-subtle', borderSubtle);
  rootStyle.setProperty('--border-strong', borderStrong);
  rootStyle.setProperty('--danger', danger);
}
