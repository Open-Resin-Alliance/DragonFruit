export const THEME_STORAGE_KEY = 'app-theme-preference';
export const THEME_COLORS_STORAGE_KEY = 'app-theme-colors';
export const THEME_PRESET_STORAGE_KEY = 'app-theme-preset';
export const THEME_CUSTOM_PROFILES_STORAGE_KEY = 'app-theme-custom-profiles';

export type ThemePreference = 'dark' | 'light';

// Every built-in preset, as a runtime list as well as a type: the profile table
// below and the "is this built in" check both read it, so adding one is a single
// entry here and a single profile further down.
const BUILT_IN_THEME_PRESET_IDS = [
  'dragonfruit-dark',
  'dragonfruit-light',
  'concepts-3d',
  'atlas-3dss',
] as const;

export type BuiltInThemePreset = (typeof BUILT_IN_THEME_PRESET_IDS)[number];
export type ThemePreset = BuiltInThemePreset | string;

const DEFAULT_ACCENT = '#ec2a77';

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
  /** Tint applied to a selected model in the 3D view. */
  meshSelectionColor: string;
  /** Tint applied to a hovered model in the 3D view. */
  meshHoverColor: string;
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
  accent: DEFAULT_ACCENT,
  accentHover: '#d81d67',
  primaryButtonSurface: '#c11f61',
  accentContrast: '#fff6ff',
  accentSecondary: '#baf72e',
  accentSecondaryHover: '#a6df29',
  secondaryButtonSurface: '#9bcc26',
  accentSecondaryContrast: '#182106',
  topbarAccent: DEFAULT_ACCENT,
  sceneGradientRadial: '#ff37aa',
  sceneGradientLinearStart: '#ff37aa',
  sceneGradientLinearMid: '#6f33ff',
  meshSelectionColor: DEFAULT_ACCENT,
  meshHoverColor: DEFAULT_ACCENT,
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
  accent: DEFAULT_ACCENT,
  accentHover: '#d81d67',
  primaryButtonSurface: '#c11f61',
  accentContrast: '#fff0f7',
  accentSecondary: '#6ab80a',
  accentSecondaryHover: '#5fa309',
  secondaryButtonSurface: '#4e8900',
  accentSecondaryContrast: '#f0fff4',
  topbarAccent: DEFAULT_ACCENT,
  sceneGradientRadial: '#ff37aa',
  sceneGradientLinearStart: '#ff37aa',
  sceneGradientLinearMid: '#6f33ff',
  meshSelectionColor: DEFAULT_ACCENT,
  meshHoverColor: DEFAULT_ACCENT,
  danger: '#c9302c',
  // Darkened for light surfaces the same way danger is: the dark palettes'
  // #2eb67d only reaches 1.3:1 on these ones, which is unreadable as an icon or
  // status label.
  success: '#146b46',
};

// Two sponsor themes; the preset id is ours, as are the tones noted here.
// Concepts 3D keeps the sponsor's two brand colours for the UI (gold #f0ad4e,
// blue #8ab4f8); its neutrals are a darker, warmer brown ladder tinted to the
// gold's hue (15-20° at ~13-16% saturation — its own export was near-grey and
// read washed out) that still holds off-white text at 13.9:1 or better, with the
// panel steps carried by the borders. The backdrop runs brown into the accent's
// orange, and the model highlight is a deeper cut of the secondary blue
// (#487dd5) so a selected model separates from the gold chrome.
const CONCEPTS_3D_THEME_COLORS: ThemeCustomColors = {
  background: '#100d0c',
  foreground: '#f8f6f1',
  surface0: '#191412',
  surface1: '#211c1a',
  surface2: '#2c2522',
  textStrong: '#f8f6f1',
  textMuted: '#cbc5ba',
  indicator: '#cbc5ba',
  borderSubtle: '#403530',
  borderStrong: '#51443d',
  accent: '#f0ad4e',
  accentHover: '#e59c36',
  primaryButtonSurface: '#f0ad4e',
  accentContrast: '#1d1307',
  accentSecondary: '#8ab4f8',
  accentSecondaryHover: '#95c2ff',
  secondaryButtonSurface: '#8ab4f8',
  accentSecondaryContrast: '#161515',
  topbarAccent: '#f0ad4e',
  // Backdrop runs warm: brown at the top, its accent's orange through the middle.
  sceneGradientRadial: '#b18f67',
  sceneGradientLinearStart: '#9a7854',
  sceneGradientLinearMid: '#d4862c',
  // Model highlight is a deeper cut of the secondary blue, not the gold that
  // colours the UI: a selected model reads as its own family against the chrome.
  meshSelectionColor: '#487dd5',
  meshHoverColor: '#487dd5',
  danger: '#e45454',
  success: '#2eb67d',
};

// The two brand colours are the sponsor's own (teal #0a667c, green #86c232); the
// neutrals are tinted to that teal so the surfaces read as one family instead of
// the default blue-greys with a teal accent dropped in. Light text is 17.9:1 on
// the background and muted text 11.9:1, the same within a tenth of the previous
// ratios on every surface.
//
// The brand teal only reaches 2.9:1 on this background and 2.3:1 on surface 2, so
// as UI chrome (icons, focus, active labels) it was too dark to read: the chrome
// is that same hue and saturation at 40% lightness (5.8:1 on the background,
// 4.6:1 on surface 2), and the green is lifted to 52% so it keeps pace with the
// brighter teal instead of reading as the duller of the two. Both filled buttons
// still carry dark ink, which gains contrast as their fills lighten — except the
// primary one, whose deeper fill is what keeps its white label readable. The mesh
// selection/hover highlight keeps the brand teal exactly.
const ATLAS_3DSS_THEME_COLORS: ThemeCustomColors = {
  background: '#0c1112',
  foreground: '#f5f9fa',
  surface0: '#111618',
  surface1: '#181e20',
  surface2: '#21292b',
  textStrong: '#f5f9fa',
  textMuted: '#c0cfd3',
  indicator: '#c0cfd3',
  borderSubtle: '#273134',
  borderStrong: '#374448',
  accent: '#0f9bbd',
  accentHover: '#0e8caa',
  // Kept dark: the filled primary button carries a white label (8.7:1) and an
  // 11px extension list line mixed 16% toward black (6.0:1). Lifting this fill
  // to the new accent drops that second line under 4:1, so the button keeps the
  // brand-tone depth and only the chrome above it brightens.
  primaryButtonSurface: '#085061',
  accentContrast: '#f8fbfc',
  accentSecondary: '#91cd3c',
  accentSecondaryHover: '#7db034',
  secondaryButtonSurface: '#74a430',
  accentSecondaryContrast: '#0e1415',
  topbarAccent: '#0f9bbd',
  sceneGradientRadial: '#123e49',
  sceneGradientLinearStart: '#122e36',
  sceneGradientLinearMid: '#1b3c2b',
  meshSelectionColor: '#0a667c',
  meshHoverColor: '#0a667c',
  danger: '#e45454',
  success: '#36ba78',
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
  {
    id: 'concepts-3d',
    name: 'Concepts 3D',
    preference: 'dark',
    colors: CONCEPTS_3D_THEME_COLORS,
    isBuiltIn: true,
  },
  {
    id: 'atlas-3dss',
    name: 'Atlas 3DSS',
    preference: 'dark',
    colors: ATLAS_3DSS_THEME_COLORS,
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
  return (BUILT_IN_THEME_PRESET_IDS as readonly string[]).includes(preset);
}

function normalizeThemePreference(value: unknown, fallback: ThemePreference): ThemePreference {
  return value === 'dark' || value === 'light' ? value : fallback;
}

function normalizeThemeCustomColors(parsed: Partial<ThemeCustomColors> | undefined, defaults: ThemeCustomColors): ThemeCustomColors {
  const d = defaults;

  const accent = normalizeHex(parsed?.accent ?? d.accent, d.accent);
  const topbarAccent = normalizeHex(parsed?.topbarAccent ?? d.topbarAccent, d.topbarAccent);

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
    meshSelectionColor: normalizeHex(parsed?.meshSelectionColor ?? d.meshSelectionColor, d.meshSelectionColor),
    meshHoverColor: normalizeHex(parsed?.meshHoverColor ?? d.meshHoverColor, d.meshHoverColor),
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
  const profile = BUILT_IN_THEME_PROFILES.find((entry) => entry.id === preset);
  return cloneThemeColors(profile?.colors ?? DEFAULT_THEME_CUSTOM_COLORS);
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
        preference: normalizeThemePreference(candidate.preference, 'dark'),
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
      preference: normalizeThemePreference(params.preference, 'dark'),
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
    preference: normalizeThemePreference(theme.preference, 'dark'),
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
    meshSelectionColor: primary,
    meshHoverColor: primary,
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
  if (typeof window === 'undefined') return 'dark';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === 'dark' || raw === 'light') return raw;
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

/**
 * Mesh selection/hover tint, resolved from the theme and published by
 * {@link applyThemeCustomColors}. The 3D viewport is not a DOM consumer — it
 * cannot read these off the CSS variables the rest of the theme is applied
 * through — so it subscribes here instead. Both colors live in the theme
 * (`ThemeCustomColors.meshSelectionColor` / `meshHoverColor`), which is also
 * what the Mesh tab's Selection & Hover section edits.
 */
export type ThemeMeshHighlightColors = {
  selection: string;
  hover: string;
};

const themeMeshHighlightListeners = new Set<() => void>();
let appliedMeshHighlightColors: ThemeMeshHighlightColors | null = null;

export function subscribeToThemeMeshHighlightColors(listener: () => void): () => void {
  themeMeshHighlightListeners.add(listener);
  return () => {
    themeMeshHighlightListeners.delete(listener);
  };
}

/**
 * The applied tint. Resolves from the saved theme on first read so the viewport
 * paints the saved theme rather than the built-in default until the app bar
 * re-applies it on mount.
 */
export function getThemeMeshHighlightColors(): ThemeMeshHighlightColors {
  if (!appliedMeshHighlightColors) {
    const saved = getSavedThemeCustomColors();
    appliedMeshHighlightColors = {
      selection: saved.meshSelectionColor,
      hover: saved.meshHoverColor,
    };
  }
  return appliedMeshHighlightColors;
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
  const meshSelectionColor = normalizeHex(themeColors.meshSelectionColor, d.meshSelectionColor);
  const meshHoverColor = normalizeHex(themeColors.meshHoverColor, d.meshHoverColor);
  const danger = normalizeHex(themeColors.danger, d.danger);
  const success = normalizeHex(themeColors.success, d.success);

  if (
    !appliedMeshHighlightColors
    || appliedMeshHighlightColors.selection !== meshSelectionColor
    || appliedMeshHighlightColors.hover !== meshHoverColor
  ) {
    appliedMeshHighlightColors = { selection: meshSelectionColor, hover: meshHoverColor };
    for (const listener of themeMeshHighlightListeners) listener();
  }

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
