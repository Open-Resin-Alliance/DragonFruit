export const THEME_STORAGE_KEY = 'app-theme-preference';
export const THEME_COLORS_STORAGE_KEY = 'app-theme-colors';
export const THEME_PRESET_STORAGE_KEY = 'app-theme-preset';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ThemePreset = 'dragonfruit-dark' | 'dragonfruit-light';

const LEGACY_DEFAULT_ACCENT = '#d946ef';
const NEW_DEFAULT_ACCENT = '#ec2a77';

export type ThemeCustomColors = {
  background: string;
  foreground: string;
  surface0: string;
  surface1: string;
  surface2: string;
  textStrong: string;
  textMuted: string;
  indicator: string;
  borderSubtle: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  primaryButtonSurface: string;
  accentContrast: string;
  accentSecondary: string;
  accentSecondaryHover: string;
  secondaryButtonSurface: string;
  accentSecondaryContrast: string;
  topbarAccent: string;
  sceneGradientRadial: string;
  sceneGradientLinearStart: string;
  sceneGradientLinearMid: string;
  danger: string;
  success: string;
};

export const DEFAULT_THEME_CUSTOM_COLORS: ThemeCustomColors = {
  background: '#0b0f14',
  foreground: '#e6ebf2',
  surface0: '#111216',
  surface1: '#1a1b21',
  surface2: '#23252e',
  textStrong: '#f8f8fb',
  textMuted: '#c3c7cf',
  indicator: '#c3c7cf',
  borderSubtle: '#272a33',
  borderStrong: '#353944',
  accent: NEW_DEFAULT_ACCENT,
  accentHover: '#d81d67',
  primaryButtonSurface: '#c11f61',
  accentContrast: '#fff6ff',
  accentSecondary: '#baf72e',
  accentSecondaryHover: '#a6df29',
  secondaryButtonSurface: '#9bcc26',
  accentSecondaryContrast: '#182106',
  topbarAccent: NEW_DEFAULT_ACCENT,
  sceneGradientRadial: '#ff37aa',
  sceneGradientLinearStart: '#ff37aa',
  sceneGradientLinearMid: '#6f33ff',
  danger: '#e45454',
  success: '#2eb67d',
};

export const DRAGONFRUIT_LIGHT_THEME_COLORS: ThemeCustomColors = {
  background: '#b4b6c2',
  foreground: '#191a20',
  surface0: '#cccfe0',
  surface1: '#c2c5d4',
  surface2: '#b6b9c8',
  textStrong: '#191a20',
  textMuted: '#484c5e',
  indicator: '#585c70',
  borderSubtle: '#a4a8b8',
  borderStrong: '#9195a6',
  accent: NEW_DEFAULT_ACCENT,
  accentHover: '#d81d67',
  primaryButtonSurface: '#c11f61',
  accentContrast: '#fff0f7',
  accentSecondary: '#6ab80a',
  accentSecondaryHover: '#5fa309',
  secondaryButtonSurface: '#4e8900',
  accentSecondaryContrast: '#f0fff4',
  topbarAccent: NEW_DEFAULT_ACCENT,
  sceneGradientRadial: '#ff37aa',
  sceneGradientLinearStart: '#ff37aa',
  sceneGradientLinearMid: '#6f33ff',
  danger: '#c9302c',
  success: '#2eb67d',
};

export function getThemePresetColors(preset: ThemePreset): ThemeCustomColors {
  return preset === 'dragonfruit-light'
    ? DRAGONFRUIT_LIGHT_THEME_COLORS
    : DEFAULT_THEME_CUSTOM_COLORS;
}

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
  return raw === 'dragonfruit-dark' || raw === 'dragonfruit-light' ? raw : 'dragonfruit-dark';
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

  const defaults = getThemePresetColors(getSavedThemePreset());

  const raw = window.localStorage.getItem(THEME_COLORS_STORAGE_KEY);
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Partial<ThemeCustomColors>;
    const d = defaults;

    let accent = normalizeHex(parsed.accent ?? d.accent, d.accent);
    let topbarAccent = normalizeHex(parsed.topbarAccent ?? d.topbarAccent, d.topbarAccent);

    // Migrate old bundled defaults (#d946ef) to the new brand default (#ec2a77).
    // If users explicitly customized away from legacy values, their choices are preserved.
    if (accent === LEGACY_DEFAULT_ACCENT) accent = NEW_DEFAULT_ACCENT;
    if (topbarAccent === LEGACY_DEFAULT_ACCENT) topbarAccent = NEW_DEFAULT_ACCENT;

    const next: ThemeCustomColors = {
      background: normalizeHex(parsed.background ?? d.background, d.background),
      foreground: normalizeHex(parsed.foreground ?? d.foreground, d.foreground),
      surface0: normalizeHex(parsed.surface0 ?? d.surface0, d.surface0),
      surface1: normalizeHex(parsed.surface1 ?? d.surface1, d.surface1),
      surface2: normalizeHex(parsed.surface2 ?? d.surface2, d.surface2),
      textStrong: normalizeHex(parsed.textStrong ?? d.textStrong, d.textStrong),
      textMuted: normalizeHex(parsed.textMuted ?? d.textMuted, d.textMuted),
      indicator: normalizeHex(parsed.indicator ?? d.indicator, d.indicator),
      borderSubtle: normalizeHex(parsed.borderSubtle ?? d.borderSubtle, d.borderSubtle),
      borderStrong: normalizeHex(parsed.borderStrong ?? d.borderStrong, d.borderStrong),
      accent,
      accentHover: normalizeHex(parsed.accentHover ?? darkenHex(accent, 0.82), d.accentHover),
      primaryButtonSurface: normalizeHex(parsed.primaryButtonSurface ?? darkenHex(accent, 0.82), d.primaryButtonSurface),
      accentContrast: normalizeHex(parsed.accentContrast ?? d.accentContrast, d.accentContrast),
      accentSecondary: normalizeHex(parsed.accentSecondary ?? d.accentSecondary, d.accentSecondary),
      accentSecondaryHover: normalizeHex(parsed.accentSecondaryHover ?? darkenHex(parsed.accentSecondary ?? d.accentSecondary, 0.9), d.accentSecondaryHover),
      secondaryButtonSurface: normalizeHex(parsed.secondaryButtonSurface ?? darkenHex(parsed.accentSecondary ?? d.accentSecondary, 0.84), d.secondaryButtonSurface),
      accentSecondaryContrast: normalizeHex(parsed.accentSecondaryContrast ?? d.accentSecondaryContrast, d.accentSecondaryContrast),
      topbarAccent,
      sceneGradientRadial: normalizeHex(parsed.sceneGradientRadial ?? d.sceneGradientRadial, d.sceneGradientRadial),
      sceneGradientLinearStart: normalizeHex(parsed.sceneGradientLinearStart ?? d.sceneGradientLinearStart, d.sceneGradientLinearStart),
      sceneGradientLinearMid: normalizeHex(parsed.sceneGradientLinearMid ?? d.sceneGradientLinearMid, d.sceneGradientLinearMid),
      danger: normalizeHex(parsed.danger ?? d.danger, d.danger),
      success: normalizeHex(parsed.success ?? d.success, d.success),
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
  const background = normalizeHex(themeColors.background, d.background);
  const foreground = normalizeHex(themeColors.foreground, d.foreground);
  const surface0 = normalizeHex(themeColors.surface0, d.surface0);
  const surface1 = normalizeHex(themeColors.surface1, d.surface1);
  const surface2 = normalizeHex(themeColors.surface2, d.surface2);
  const textStrong = normalizeHex(themeColors.textStrong, d.textStrong);
  const textMuted = normalizeHex(themeColors.textMuted, d.textMuted);
  const indicator = normalizeHex(themeColors.indicator, d.indicator);
  const borderSubtle = normalizeHex(themeColors.borderSubtle, d.borderSubtle);
  const borderStrong = normalizeHex(themeColors.borderStrong, d.borderStrong);
  const accent = normalizeHex(themeColors.accent, d.accent);
  const accentHover = normalizeHex(themeColors.accentHover, darkenHex(accent, 0.82));
  const primaryButtonSurface = normalizeHex(themeColors.primaryButtonSurface, darkenHex(accent, 0.82));
  const accentContrast = normalizeHex(themeColors.accentContrast, d.accentContrast);
  const accentSecondary = normalizeHex(themeColors.accentSecondary, d.accentSecondary);
  const accentSecondaryHover = normalizeHex(themeColors.accentSecondaryHover, darkenHex(accentSecondary, 0.9));
  const secondaryButtonSurface = normalizeHex(themeColors.secondaryButtonSurface, darkenHex(accentSecondary, 0.84));
  const accentSecondaryContrast = normalizeHex(themeColors.accentSecondaryContrast, d.accentSecondaryContrast);
  const topbarAccent = normalizeHex(themeColors.topbarAccent, accent);
  const sceneGradientRadial = normalizeHex(themeColors.sceneGradientRadial, d.sceneGradientRadial);
  const sceneGradientLinearStart = normalizeHex(themeColors.sceneGradientLinearStart, d.sceneGradientLinearStart);
  const sceneGradientLinearMid = normalizeHex(themeColors.sceneGradientLinearMid, d.sceneGradientLinearMid);
  const danger = normalizeHex(themeColors.danger, d.danger);
  const success = normalizeHex(themeColors.success, d.success);

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--background', background);
  rootStyle.setProperty('--foreground', foreground);
  rootStyle.setProperty('--surface-0', surface0);
  rootStyle.setProperty('--surface-1', surface1);
  rootStyle.setProperty('--surface-2', surface2);
  rootStyle.setProperty('--text-strong', textStrong);
  rootStyle.setProperty('--text-muted', textMuted);
  rootStyle.setProperty('--indicator', indicator);
  rootStyle.setProperty('--border-subtle', borderSubtle);
  rootStyle.setProperty('--border-strong', borderStrong);
  rootStyle.setProperty('--accent', accent);
  rootStyle.setProperty('--accent-hover', accentHover);
  rootStyle.setProperty('--primary-button-surface', primaryButtonSurface);
  rootStyle.setProperty('--accent-contrast', accentContrast);
  rootStyle.setProperty('--accent-secondary', accentSecondary);
  rootStyle.setProperty('--accent-secondary-hover', accentSecondaryHover);
  rootStyle.setProperty('--secondary-button-surface', secondaryButtonSurface);
  rootStyle.setProperty('--accent-secondary-contrast', accentSecondaryContrast);
  rootStyle.setProperty('--topbar-accent', topbarAccent);
  rootStyle.setProperty('--scene-gradient-radial', sceneGradientRadial);
  rootStyle.setProperty('--scene-gradient-linear-start', sceneGradientLinearStart);
  rootStyle.setProperty('--scene-gradient-linear-mid', sceneGradientLinearMid);
  rootStyle.setProperty('--danger', danger);
  rootStyle.setProperty('--success', success);
}
