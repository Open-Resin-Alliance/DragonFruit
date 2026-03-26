export const DEFAULT_OUTPUT_FORMAT = '.lumen';
const FORMAT_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export type WebcamRotationDeg = 0 | 90 | 180 | 270;

export const DEFAULT_WEBCAM_ROTATION_DEG: WebcamRotationDeg = 0;

const LEGACY_FORMAT_ALIASES: Record<string, string> = {
  '.luman': '.lumen',
};

const OUTPUT_FORMAT_RE = /^\.[a-z0-9][a-z0-9_-]*$/i;
const WEBCAM_ROTATION_DEG_RE = /^(0|90|180|270)$/;

/**
 * Normalize output format values to a stable, extensible extension string.
 *
 * This intentionally does not hardcode a finite format allowlist so plugin-
 * owned output formats can flow through core profile/preset persistence.
 */
export function normalizeOutputFormat(value: unknown, fallback = DEFAULT_OUTPUT_FORMAT): string {
  if (typeof value !== 'string') return fallback;

  const raw = value.trim().toLowerCase();
  if (!raw) return fallback;

  const aliased = LEGACY_FORMAT_ALIASES[raw] ?? raw;
  if (!OUTPUT_FORMAT_RE.test(aliased)) return fallback;

  return aliased;
}

/**
 * Normalize optional format-version tags used by encoder-specific versioning.
 *
 * Examples: `v1`, `v2v3`, `v4v5`, `v5enc`.
 */
export function normalizeFormatVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!FORMAT_VERSION_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Normalize optional settings-mode tags used by encoder-specific material schemas.
 *
 * Examples: `basic`, `twostage`, `highspeed`.
 */
export function normalizeSettingsMode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!FORMAT_VERSION_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Normalize webcam rotation values used by printer definitions and profiles.
 *
 * Accepts canonical rotation values (0/90/180/270), plus legacy
 * orientation aliases for backward compatibility (`landscape` => 0,
 * `portrait` => 90).
 */
export function normalizeWebcamRotationDeg(value: unknown, fallback: WebcamRotationDeg = DEFAULT_WEBCAM_ROTATION_DEG): WebcamRotationDeg {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value);
    if (rounded === 0 || rounded === 90 || rounded === 180 || rounded === 270) {
      return rounded as WebcamRotationDeg;
    }
    return fallback;
  }

  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return fallback;

  if (trimmed === 'landscape') return 0;
  if (trimmed === 'portrait') return 90;

  if (!WEBCAM_ROTATION_DEG_RE.test(trimmed)) return fallback;
  const numeric = Number(trimmed);
  if (numeric === 0 || numeric === 90 || numeric === 180 || numeric === 270) {
    return numeric as WebcamRotationDeg;
  }

  return fallback;
}

// Backward-compat exports for older callsites while migration settles.
export type WebcamOrientation = WebcamRotationDeg;
export const DEFAULT_WEBCAM_ORIENTATION = DEFAULT_WEBCAM_ROTATION_DEG;
export const normalizeWebcamOrientation = normalizeWebcamRotationDeg;
