import {
  SNAP_COARSE,
  SNAP_FINE,
  type SnapTickConfig,
} from '@/components/gizmo/rotate/snapRotation';

/** Role of a tier: coarse/fine drive the snap increments; visual is ticks-only. */
export type SnapTierRole = 'coarse' | 'fine' | 'visual';

/** One configurable tier — pairs a tick interval with its snap/visual role. */
export interface SnapTier {
  /** Interval in whole degrees (must be a positive integer that divides 360). */
  degrees: number;
  /** Tick length as a fraction of the major tick length (derived from role). */
  lengthMult: number;
  role: SnapTierRole;
}

/** Rotation snap configuration: exactly one tier per role. */
export interface RotationSnapSettings {
  tiers: SnapTier[];
}

export const ROTATION_SNAP_STORAGE_KEY = 'dragonfruit:rotation-snap-ticks';
const ROTATION_SNAP_EVENT = 'dragonfruit:rotation-snap-ticks-changed';

const DEG_TO_RAD = Math.PI / 180;

/** Tick length per role: coarse (major) longest, visual (minor) shortest. */
const ROLE_LENGTH_MULT: Record<SnapTierRole, number> = {
  coarse: 1.0,
  fine: 0.6,
  visual: 0.3,
};

const ROLES: SnapTierRole[] = ['coarse', 'fine', 'visual'];

/** Default tiers: 45 / 15 / 5 degrees (the common slicer default; nesting-valid). */
export const DEFAULT_ROTATION_SNAP_SETTINGS: RotationSnapSettings = {
  tiers: [
    { degrees: 45, lengthMult: 1.0, role: 'coarse' },
    { degrees: 15, lengthMult: 0.6, role: 'fine' },
    { degrees: 5, lengthMult: 0.3, role: 'visual' },
  ],
};

/** Built-in presets. All nesting-valid; users wanting off-grid intervals use Custom. */
export const ROTATION_SNAP_PRESETS = {
  standard: DEFAULT_ROTATION_SNAP_SETTINGS,
  fine: {
    tiers: [
      { degrees: 15, lengthMult: 1.0, role: 'coarse' },
      { degrees: 5, lengthMult: 0.6, role: 'fine' },
      { degrees: 1, lengthMult: 0.3, role: 'visual' },
    ],
  },
} satisfies Record<string, RotationSnapSettings>;

export type RotationSnapPresetId = keyof typeof ROTATION_SNAP_PRESETS | 'custom';

/** Accepted interval bounds (degrees) for any tier. */
export const MIN_TIER_DEGREES = 1;
export const MAX_TIER_DEGREES = 360;

/**
 * A whole number of degrees within the accepted range. Custom tiers may be ANY
 * such value — they need not divide 360. Non-tiling values just leave a small
 * gap at the wrap; that is the user's choice and the preview reflects it.
 */
function isValidDegrees(degrees: unknown): degrees is number {
  return (
    typeof degrees === 'number' &&
    Number.isInteger(degrees) &&
    degrees >= MIN_TIER_DEGREES &&
    degrees <= MAX_TIER_DEGREES
  );
}

/**
 * Validate untrusted settings (e.g. parsed from localStorage). Requires exactly
 * three tiers — one each of coarse/fine/visual — whose degrees are whole numbers
 * in [1, 360]. lengthMult is always derived from the role, so a tampered value
 * cannot desync the visuals. Any violation falls back to the default. Arbitrary
 * (non-360-dividing, non-nesting) Custom values are accepted by design.
 */
export function normalizeRotationSnapSettings(input: unknown): RotationSnapSettings {
  if (!input || typeof input !== 'object') return DEFAULT_ROTATION_SNAP_SETTINGS;

  const tiers = (input as Partial<RotationSnapSettings>).tiers;
  if (!Array.isArray(tiers) || tiers.length !== 3) return DEFAULT_ROTATION_SNAP_SETTINGS;

  const degreesByRole = new Map<SnapTierRole, number>();
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object') return DEFAULT_ROTATION_SNAP_SETTINGS;
    const { role, degrees } = tier as Partial<SnapTier>;
    if (role !== 'coarse' && role !== 'fine' && role !== 'visual') {
      return DEFAULT_ROTATION_SNAP_SETTINGS;
    }
    if (degreesByRole.has(role)) return DEFAULT_ROTATION_SNAP_SETTINGS; // duplicate role
    if (!isValidDegrees(degrees)) return DEFAULT_ROTATION_SNAP_SETTINGS;
    degreesByRole.set(role, degrees);
  }
  if (degreesByRole.size !== 3) return DEFAULT_ROTATION_SNAP_SETTINGS; // a role was missing

  return {
    tiers: ROLES.map((role) => ({
      role,
      degrees: degreesByRole.get(role) as number,
      lengthMult: ROLE_LENGTH_MULT[role],
    })),
  };
}

const degreesForRole = (settings: RotationSnapSettings, role: SnapTierRole): number | undefined =>
  settings.tiers.find((tier) => tier.role === role)?.degrees;

/** Map the role-based settings to the tier-interval shape getSnapTicks expects. */
export function toSnapTickConfig(settings: RotationSnapSettings): SnapTickConfig {
  return {
    majorDeg: degreesForRole(settings, 'coarse') ?? 45,
    mediumDeg: degreesForRole(settings, 'fine') ?? 15,
    minorDeg: degreesForRole(settings, 'visual') ?? 5,
  };
}

/**
 * The active snap increments (radians) from the config. Falls back to the
 * SNAP_COARSE/SNAP_FINE constants if a role is somehow absent, so the gizmo's
 * modifier-key snapping (#39) can never regress to no-snap.
 */
export function getRotationSnapIncrements(settings: RotationSnapSettings): {
  coarse: number;
  fine: number;
} {
  const coarseDeg = degreesForRole(settings, 'coarse');
  const fineDeg = degreesForRole(settings, 'fine');
  return {
    coarse: coarseDeg != null ? coarseDeg * DEG_TO_RAD : SNAP_COARSE,
    fine: fineDeg != null ? fineDeg * DEG_TO_RAD : SNAP_FINE,
  };
}

/** Per-role interval degrees, for display (tooltip, labels). */
export function getRotationSnapDegrees(settings: RotationSnapSettings): {
  coarse: number;
  fine: number;
  visual: number;
} {
  return {
    coarse: degreesForRole(settings, 'coarse') ?? 45,
    fine: degreesForRole(settings, 'fine') ?? 15,
    visual: degreesForRole(settings, 'visual') ?? 5,
  };
}

/** Which built-in preset these settings match, or 'custom'. */
export function getRotationSnapPresetId(settings: RotationSnapSettings): RotationSnapPresetId {
  for (const key of Object.keys(ROTATION_SNAP_PRESETS) as (keyof typeof ROTATION_SNAP_PRESETS)[]) {
    const preset = ROTATION_SNAP_PRESETS[key];
    const matchesAll = (['coarse', 'fine', 'visual'] as SnapTierRole[]).every(
      (role) => degreesForRole(preset, role) === degreesForRole(settings, role),
    );
    if (matchesAll) return key;
  }
  return 'custom';
}

/** Human-readable preset labels. */
export const ROTATION_SNAP_PRESET_LABELS: Record<RotationSnapPresetId, string> = {
  standard: 'Standard',
  fine: 'Fine',
  custom: 'Custom',
};

export function getSavedRotationSnapSettings(): RotationSnapSettings {
  if (typeof window === 'undefined') return DEFAULT_ROTATION_SNAP_SETTINGS;

  try {
    const raw = window.localStorage.getItem(ROTATION_SNAP_STORAGE_KEY);
    if (!raw) return DEFAULT_ROTATION_SNAP_SETTINGS;
    return normalizeRotationSnapSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_ROTATION_SNAP_SETTINGS;
  }
}

export function saveRotationSnapSettings(settings: RotationSnapSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeRotationSnapSettings(settings);

  try {
    window.localStorage.setItem(ROTATION_SNAP_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(ROTATION_SNAP_EVENT, { detail: normalized }));
}

export function subscribeToRotationSnapSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== ROTATION_SNAP_STORAGE_KEY) return;
    listener();
  };
  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(ROTATION_SNAP_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(ROTATION_SNAP_EVENT, onCustom as EventListener);
  };
}
