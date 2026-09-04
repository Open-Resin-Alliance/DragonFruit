/**
 * Colours the Cut tool draws with, as a preference rather than a pile of hex
 * literals scattered through the renderer.
 *
 * Follows the shape of the other preference modules (defaults → normalize →
 * get/save → subscribe, see `cameraProjectionPreferences`), so the values persist,
 * survive a bad localStorage payload, and update every open view at once.
 *
 * Stored as `#rrggbb` strings (what an `<input type="color">` speaks); the tool
 * reads them as the numbers three.js wants via `useOrganicCutColorNumbers`.
 */

export type OrganicCutColors = {
  /** The seam the cut will follow — the drawn line, in both cut modes. */
  seam: string;
  /** The seam under the cursor (hover-to-insert is armed). */
  seamHover: string;
  /** Seams of the OTHER loops in a multi-loop cut, drawn dimmed. */
  seamInactive: string;
  /** Soft halo drawn around the seam while it is hovered. */
  seamGlow: string;
  /** The cutter surface: the contour membrane and the flat plane's quad. */
  cutSurface: string;
  /** The tenon's TENON, lit face / far face / silhouette edges. */
  tenonFront: string;
  tenonBack: string;
  tenonEdge: string;
  /**
   * The tenon's MORTISE, same three. Drawn apart from the tenon because they overlap
   * almost exactly: the mortise is the tenon plus the fit tolerance, so a single
   * colour made the tolerance knob look like it did nothing.
   */
  mortiseFront: string;
  mortiseBack: string;
  mortiseEdge: string;
  /** The handle that slides the tenon across the cut face. */
  tenonHandle: string;
  /** Loop waypoints: the first one, the rest, the selected one, the dragged one. */
  markerFirst: string;
  markerPoint: string;
  markerSelected: string;
  markerDragging: string;
};

export const ORGANIC_CUT_COLORS_STORAGE_KEY = 'organic-cut-colors';
const ORGANIC_CUT_COLORS_EVENT = 'organic-cut-colors-changed';

/**
 * Factory colours.
 *
 * The seam is navy blue: it used to be a bright green that vanished against pale
 * models and washed out under the viewport's lighting — the one line the user has
 * to see precisely was the hardest to see. Blue holds against both pale and
 * mid-tone surfaces, and the waypoints stay green so the handles still pop off it.
 */
/**
 * The colours a tenon takes when it does NOT fit where the user put it.
 *
 * Deliberately NOT a preference: this is a status, like a form error, and a
 * preference is a way to make it invisible. It replaces the tenon's own three
 * colours wholesale — face, far face and outline — because tinting only the
 * outline reads as decoration on a translucent solid.
 */
export const TENON_WONT_FIT_COLORS = {
  front: '#b3121b',
  back: '#5c0a0f',
  edge: '#ff4d4d',
} as const;

export const DEFAULT_ORGANIC_CUT_COLORS: OrganicCutColors = {
  seam: '#00008b',
  seamHover: '#c9752e',
  seamInactive: '#5e3418',
  seamGlow: '#ffe6cc',
  cutSurface: '#37ff7a',
  tenonFront: '#001e57',
  tenonBack: '#8a4a08',
  tenonEdge: '#ff7a00',
  mortiseFront: '#c07bff',
  mortiseBack: '#4a2a7a',
  mortiseEdge: '#a24bff',
  tenonHandle: '#0091ff',
  markerFirst: '#37ff7a',
  markerPoint: '#ffd24a',
  markerSelected: '#0091ff',
  markerDragging: '#35e3ff',
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function normalizeColor(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

export function normalizeOrganicCutColors(input: unknown): OrganicCutColors {
  if (!input || typeof input !== 'object') return DEFAULT_ORGANIC_CUT_COLORS;
  const candidate = input as Partial<Record<keyof OrganicCutColors, unknown>>;
  const out = {} as OrganicCutColors;
  for (const key of Object.keys(DEFAULT_ORGANIC_CUT_COLORS) as (keyof OrganicCutColors)[]) {
    out[key] = normalizeColor(candidate[key], DEFAULT_ORGANIC_CUT_COLORS[key]);
  }
  return out;
}

/**
 * Cached snapshot. `useSyncExternalStore` compares snapshots by IDENTITY, so
 * parsing localStorage afresh on every call would hand it a new object each
 * render and spin forever. Reads are served from here and the cache is dropped
 * the moment the values change.
 */
let cachedColors: OrganicCutColors | null = null;

function readOrganicCutColors(): OrganicCutColors {
  if (typeof window === 'undefined') return DEFAULT_ORGANIC_CUT_COLORS;
  try {
    const raw = window.localStorage.getItem(ORGANIC_CUT_COLORS_STORAGE_KEY);
    if (!raw) return DEFAULT_ORGANIC_CUT_COLORS;
    return normalizeOrganicCutColors(JSON.parse(raw));
  } catch {
    return DEFAULT_ORGANIC_CUT_COLORS;
  }
}

export function getSavedOrganicCutColors(): OrganicCutColors {
  if (cachedColors === null) cachedColors = readOrganicCutColors();
  return cachedColors;
}

export function saveOrganicCutColors(colors: OrganicCutColors): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeOrganicCutColors(colors);
  cachedColors = normalized;
  try {
    window.localStorage.setItem(ORGANIC_CUT_COLORS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }
  window.dispatchEvent(new CustomEvent(ORGANIC_CUT_COLORS_EVENT, { detail: normalized }));
}

export function subscribeToOrganicCutColors(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  // Drop the cache BEFORE notifying, so a subscriber that reads the snapshot from
  // inside its callback sees the new values rather than the ones that woke it.
  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== ORGANIC_CUT_COLORS_STORAGE_KEY) return;
    cachedColors = null;
    listener();
  };
  const onCustom = () => {
    cachedColors = null;
    listener();
  };

  window.addEventListener('storage', onStorage);
  window.addEventListener(ORGANIC_CUT_COLORS_EVENT, onCustom as EventListener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(ORGANIC_CUT_COLORS_EVENT, onCustom as EventListener);
  };
}

/** `#rrggbb` → the 0xrrggbb number three.js materials take. */
export function colorToNumber(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}
