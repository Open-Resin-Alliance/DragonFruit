export const THEME_STORAGE_KEY = 'app-theme-preference';
export const THEME_COLORS_STORAGE_KEY = 'app-theme-colors';
export const THEME_PRESET_STORAGE_KEY = 'app-theme-preset';
export const THEME_CUSTOM_PROFILES_STORAGE_KEY = 'app-theme-custom-profiles';

export type ThemePreference = 'system' | 'dark' | 'light';
export type BuiltInThemePreset = 'dragonfruit-dark' | 'dragonfruit-light';
export type ThemePreset = BuiltInThemePreset | string;

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

export type SavedCustomThemeProfile = {
  id: string;
  name: string;
  preference: ThemePreference;
  colors: ThemeCustomColors;
};

export type ThemeProfile = {
  id: ThemePreset;
  name: string;
  preference: ThemePreference;
  colors: ThemeCustomColors;
  isBuiltIn: boolean;
};

type ThemeProfileExchangeHeader = {
  kind: 'dragonfruit-theme-profile';
  formatVersion: 1;
  exportedAt: string;
  generator: 'DragonFruit';
  appVersion?: string;
};

type ThemeProfileExchangeDocument = {
  header: ThemeProfileExchangeHeader;
  theme: {
    name: string;
    preference: ThemePreference;
    colors: ThemeCustomColors;
    sourcePresetId?: ThemePreset;
  };
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

const BUILT_IN_THEME_PROFILES: ThemeProfile[] = [
  {
    id: 'dragonfruit-dark',
    name: 'DragonFruit Dark',
    preference: 'dark',
    colors: DEFAULT_THEME_CUSTOM_COLORS,
    isBuiltIn: true,
  },
  {
    id: 'dragonfruit-light',
    name: 'DragonFruit Light',
    preference: 'light',
    colors: DRAGONFRUIT_LIGHT_THEME_COLORS,
    isBuiltIn: true,
  },
];

function cloneThemeColors(themeColors: ThemeCustomColors): ThemeCustomColors {
  return { ...themeColors };
}

function createBuiltInThemeProfiles(): ThemeProfile[] {
  return BUILT_IN_THEME_PROFILES.map((profile) => ({
    ...profile,
    colors: cloneThemeColors(profile.colors),
  }));
}

export function isBuiltInThemePreset(preset: ThemePreset): preset is BuiltInThemePreset {
  return preset === 'dragonfruit-dark' || preset === 'dragonfruit-light';
}

function normalizeThemePreference(value: unknown, fallback: ThemePreference): ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system' ? value : fallback;
}

function normalizeThemeCustomColors(parsed: Partial<ThemeCustomColors> | undefined, defaults: ThemeCustomColors): ThemeCustomColors {
  const d = defaults;

  let accent = normalizeHex(parsed?.accent ?? d.accent, d.accent);
  let topbarAccent = normalizeHex(parsed?.topbarAccent ?? d.topbarAccent, d.topbarAccent);

  if (accent === LEGACY_DEFAULT_ACCENT) accent = NEW_DEFAULT_ACCENT;
  if (topbarAccent === LEGACY_DEFAULT_ACCENT) topbarAccent = NEW_DEFAULT_ACCENT;

  return {
    background: normalizeHex(parsed?.background ?? d.background, d.background),
    foreground: normalizeHex(parsed?.foreground ?? d.foreground, d.foreground),
    surface0: normalizeHex(parsed?.surface0 ?? d.surface0, d.surface0),
    surface1: normalizeHex(parsed?.surface1 ?? d.surface1, d.surface1),
    surface2: normalizeHex(parsed?.surface2 ?? d.surface2, d.surface2),
    textStrong: normalizeHex(parsed?.textStrong ?? d.textStrong, d.textStrong),
    textMuted: normalizeHex(parsed?.textMuted ?? d.textMuted, d.textMuted),
    indicator: normalizeHex(parsed?.indicator ?? d.indicator, d.indicator),
    borderSubtle: normalizeHex(parsed?.borderSubtle ?? d.borderSubtle, d.borderSubtle),
    borderStrong: normalizeHex(parsed?.borderStrong ?? d.borderStrong, d.borderStrong),
    accent,
    accentHover: normalizeHex(parsed?.accentHover ?? darkenHex(accent, 0.82), d.accentHover),
    primaryButtonSurface: normalizeHex(parsed?.primaryButtonSurface ?? darkenHex(accent, 0.82), d.primaryButtonSurface),
    accentContrast: normalizeHex(parsed?.accentContrast ?? d.accentContrast, d.accentContrast),
    accentSecondary: normalizeHex(parsed?.accentSecondary ?? d.accentSecondary, d.accentSecondary),
    accentSecondaryHover: normalizeHex(parsed?.accentSecondaryHover ?? darkenHex(parsed?.accentSecondary ?? d.accentSecondary, 0.9), d.accentSecondaryHover),
    secondaryButtonSurface: normalizeHex(parsed?.secondaryButtonSurface ?? darkenHex(parsed?.accentSecondary ?? d.accentSecondary, 0.84), d.secondaryButtonSurface),
    accentSecondaryContrast: normalizeHex(parsed?.accentSecondaryContrast ?? d.accentSecondaryContrast, d.accentSecondaryContrast),
    topbarAccent,
    sceneGradientRadial: normalizeHex(parsed?.sceneGradientRadial ?? d.sceneGradientRadial, d.sceneGradientRadial),
    sceneGradientLinearStart: normalizeHex(parsed?.sceneGradientLinearStart ?? d.sceneGradientLinearStart, d.sceneGradientLinearStart),
    sceneGradientLinearMid: normalizeHex(parsed?.sceneGradientLinearMid ?? d.sceneGradientLinearMid, d.sceneGradientLinearMid),
    danger: normalizeHex(parsed?.danger ?? d.danger, d.danger),
    success: normalizeHex(parsed?.success ?? d.success, d.success),
  };
}

function persistSavedCustomThemeProfiles(profiles: SavedCustomThemeProfile[]): SavedCustomThemeProfile[] {
  if (typeof window === 'undefined') return profiles;
  window.localStorage.setItem(THEME_CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
  return profiles;
}

function sanitizeCustomThemeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : 'Custom Theme';
}

function ensureUniqueCustomThemeName(name: string, profiles: SavedCustomThemeProfile[], excludeId?: string): string {
  const base = sanitizeCustomThemeName(name);
  const taken = new Set(
    profiles
      .filter((profile) => profile.id !== excludeId)
      .map((profile) => profile.name.toLowerCase()),
  );

  if (!taken.has(base.toLowerCase())) return base;

  let index = 2;
  while (taken.has(`${base} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${base} ${index}`;
}

function createCustomThemeProfileId(name: string): string {
  const slug = sanitizeCustomThemeName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom-theme';
  return `custom:${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function getThemePresetColors(preset: ThemePreset): ThemeCustomColors {
  return isBuiltInThemePreset(preset) && preset === 'dragonfruit-light'
    ? cloneThemeColors(DRAGONFRUIT_LIGHT_THEME_COLORS)
    : cloneThemeColors(DEFAULT_THEME_CUSTOM_COLORS);
}

export function getSavedCustomThemeProfiles(): SavedCustomThemeProfile[] {
  if (typeof window === 'undefined') return [];

  const raw = window.localStorage.getItem(THEME_CUSTOM_PROFILES_STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const next: SavedCustomThemeProfile[] = [];
    const seenIds = new Set<string>();

    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<SavedCustomThemeProfile>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      if (!id || seenIds.has(id) || isBuiltInThemePreset(id)) continue;
      seenIds.add(id);
      next.push({
        id,
        name: sanitizeCustomThemeName(typeof candidate.name === 'string' ? candidate.name : 'Custom Theme'),
        preference: normalizeThemePreference(candidate.preference, 'system'),
        colors: normalizeThemeCustomColors(candidate.colors, DEFAULT_THEME_CUSTOM_COLORS),
      });
    }

    window.localStorage.setItem(THEME_CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

export function getThemeProfiles(customProfiles: SavedCustomThemeProfile[] = getSavedCustomThemeProfiles()): ThemeProfile[] {
  return [
    ...createBuiltInThemeProfiles(),
    ...customProfiles.map((profile) => ({
      ...profile,
      colors: cloneThemeColors(profile.colors),
      isBuiltIn: false,
    })),
  ];
}

export function getThemeProfile(preset: ThemePreset, customProfiles: SavedCustomThemeProfile[] = getSavedCustomThemeProfiles()): ThemeProfile {
  const builtIn = createBuiltInThemeProfiles().find((profile) => profile.id === preset);
  if (builtIn) return builtIn;

  const custom = customProfiles.find((profile) => profile.id === preset);
  if (custom) {
    return {
      ...custom,
      colors: cloneThemeColors(custom.colors),
      isBuiltIn: false,
    };
  }

  return createBuiltInThemeProfiles()[0];
}

export function exportThemeProfileToJson(params: {
  name: string;
  preference: ThemePreference;
  colors: ThemeCustomColors;
  sourcePresetId?: ThemePreset;
  appVersion?: string;
}): string {
  const fallbackDefaults = isBuiltInThemePreset(params.sourcePresetId ?? '')
    ? getThemePresetColors(params.sourcePresetId as ThemePreset)
    : DEFAULT_THEME_CUSTOM_COLORS;

  const doc: ThemeProfileExchangeDocument = {
    header: {
      kind: 'dragonfruit-theme-profile',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      generator: 'DragonFruit',
      appVersion: params.appVersion?.trim() || undefined,
    },
    theme: {
      name: sanitizeCustomThemeName(params.name),
      preference: normalizeThemePreference(params.preference, 'system'),
      colors: normalizeThemeCustomColors(params.colors, fallbackDefaults),
      sourcePresetId: params.sourcePresetId,
    },
  };

  return JSON.stringify(doc, null, 2);
}

export function importThemeProfileFromJson(jsonText: string): {
  name: string;
  preference: ThemePreference;
  colors: ThemeCustomColors;
  sourcePresetId?: ThemePreset;
} {
  const parsed = JSON.parse(jsonText) as unknown;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid theme file: expected a JSON object.');
  }

  const doc = parsed as Partial<ThemeProfileExchangeDocument>;
  const header = doc.header;
  if (!header || typeof header !== 'object') {
    throw new Error('Invalid theme file: missing header.');
  }

  if (header.kind !== 'dragonfruit-theme-profile') {
    throw new Error('Invalid theme file: unsupported kind.');
  }

  if (header.formatVersion !== 1) {
    throw new Error(`Invalid theme file: unsupported format version ${String(header.formatVersion)}.`);
  }

  const theme = doc.theme;
  if (!theme || typeof theme !== 'object') {
    throw new Error('Invalid theme file: missing theme payload.');
  }

  const sourcePresetId = typeof theme.sourcePresetId === 'string' ? theme.sourcePresetId : undefined;
  const defaults = sourcePresetId && isBuiltInThemePreset(sourcePresetId)
    ? getThemePresetColors(sourcePresetId)
    : DEFAULT_THEME_CUSTOM_COLORS;

  return {
    name: sanitizeCustomThemeName(typeof theme.name === 'string' ? theme.name : 'Imported Theme'),
    preference: normalizeThemePreference(theme.preference, 'system'),
    colors: normalizeThemeCustomColors(
      (theme.colors && typeof theme.colors === 'object' ? theme.colors : undefined) as Partial<ThemeCustomColors> | undefined,
      defaults,
    ),
    sourcePresetId,
  };
}

export function createCustomThemeProfile(name: string, preference: ThemePreference, colors: ThemeCustomColors): SavedCustomThemeProfile {
  const profiles = getSavedCustomThemeProfiles();
  const profile: SavedCustomThemeProfile = {
    id: createCustomThemeProfileId(name),
    name: ensureUniqueCustomThemeName(name, profiles),
    preference,
    colors: normalizeThemeCustomColors(colors, DEFAULT_THEME_CUSTOM_COLORS),
  };

  persistSavedCustomThemeProfiles([...profiles, profile]);
  return profile;
}

export function saveCustomThemeProfile(id: string, updates: { name?: string; preference: ThemePreference; colors: ThemeCustomColors }): SavedCustomThemeProfile | null {
  const profiles = getSavedCustomThemeProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return null;

  const existing = profiles[index];
  const nextProfile: SavedCustomThemeProfile = {
    ...existing,
    name: ensureUniqueCustomThemeName(updates.name ?? existing.name, profiles, id),
    preference: updates.preference,
    colors: normalizeThemeCustomColors(updates.colors, DEFAULT_THEME_CUSTOM_COLORS),
  };

  const nextProfiles = [...profiles];
  nextProfiles[index] = nextProfile;
  persistSavedCustomThemeProfiles(nextProfiles);
  return nextProfile;
}

export function deleteCustomThemeProfile(id: string): SavedCustomThemeProfile[] {
  const nextProfiles = getSavedCustomThemeProfiles().filter((profile) => profile.id !== id);
  persistSavedCustomThemeProfiles(nextProfiles);
  return nextProfiles;
}

export function deriveThemeCustomColorsFromBranding(params: {
  primaryBrandColor: string;
  secondaryBrandColor: string;
  preference: ThemePreference;
}): ThemeCustomColors {
  const resolvedPreference = params.preference === 'light' ? 'light' : 'dark';
  const base = resolvedPreference === 'light'
    ? cloneThemeColors(DRAGONFRUIT_LIGHT_THEME_COLORS)
    : cloneThemeColors(DEFAULT_THEME_CUSTOM_COLORS);

  const primary = normalizeHex(params.primaryBrandColor, base.accent);
  const secondary = normalizeHex(params.secondaryBrandColor, base.accentSecondary);

  return {
    ...base,
    accent: primary,
    accentHover: darkenHex(primary, resolvedPreference === 'light' ? 0.9 : 0.82),
    primaryButtonSurface: darkenHex(primary, resolvedPreference === 'light' ? 0.82 : 0.78),
    accentContrast: getContrastForeground(primary),
    topbarAccent: primary,
    accentSecondary: secondary,
    accentSecondaryHover: darkenHex(secondary, resolvedPreference === 'light' ? 0.9 : 0.86),
    secondaryButtonSurface: darkenHex(secondary, resolvedPreference === 'light' ? 0.84 : 0.8),
    accentSecondaryContrast: getContrastForeground(secondary),
    sceneGradientRadial: primary,
    sceneGradientLinearStart: primary,
    sceneGradientLinearMid: blendHex(primary, secondary, resolvedPreference === 'light' ? 0.52 : 0.46),
  };
}

function normalizeHex(value: string, fallback: string): string {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : fallback;
}

function parseHexRgb(hexColor: string): { r: number; g: number; b: number } {
  const normalized = normalizeHex(hexColor, DEFAULT_THEME_CUSTOM_COLORS.accent).slice(1);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function blendHex(aHex: string, bHex: string, bWeight: number): string {
  const weight = Math.max(0, Math.min(1, Number.isFinite(bWeight) ? bWeight : 0.5));
  const a = parseHexRgb(aHex);
  const b = parseHexRgb(bHex);
  const mix = (aChannel: number, bChannel: number) => Math.round(aChannel * (1 - weight) + bChannel * weight);
  const r = mix(a.r, b.r);
  const g = mix(a.g, b.g);
  const bOut = mix(a.b, b.b);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bOut.toString(16).padStart(2, '0')}`;
}

function getContrastForeground(backgroundHex: string): string {
  const { r, g, b } = parseHexRgb(backgroundHex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#111216' : '#f8f8fb';
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
  if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  return getThemeProfile(getSavedThemePreset()).preference;
}

export function getSavedThemePreset(): ThemePreset {
  if (typeof window === 'undefined') return 'dragonfruit-dark';
  const raw = window.localStorage.getItem(THEME_PRESET_STORAGE_KEY);
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'dragonfruit-dark';

  const preset = raw.trim();
  if (isBuiltInThemePreset(preset)) return preset;
  return getSavedCustomThemeProfiles().some((profile) => profile.id === preset)
    ? preset
    : 'dragonfruit-dark';
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

  const defaults = getThemeProfile(getSavedThemePreset()).colors;

  const raw = window.localStorage.getItem(THEME_COLORS_STORAGE_KEY);
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Partial<ThemeCustomColors>;
    const next = normalizeThemeCustomColors(parsed, defaults);

    // Keep storage in sync after migration so future loads are deterministic.
    window.localStorage.setItem(THEME_COLORS_STORAGE_KEY, JSON.stringify(next));

    return next;
  } catch {
    return defaults;
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
