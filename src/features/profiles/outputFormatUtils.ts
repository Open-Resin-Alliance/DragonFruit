export const DEFAULT_OUTPUT_FORMAT = '.lumen';
const FORMAT_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export type WebcamOrientation = 'landscape' | 'portrait';

export const DEFAULT_WEBCAM_ORIENTATION: WebcamOrientation = 'landscape';

const LEGACY_FORMAT_ALIASES: Record<string, string> = {
  '.luman': '.lumen',
};

const OUTPUT_FORMAT_RE = /^\.[a-z0-9][a-z0-9_-]*$/i;
const WEBCAM_ORIENTATION_RE = /^(landscape|portrait)$/i;

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
 * Normalize webcam orientation values used by printer definitions and profiles.
 *
 * Landscape is the conservative default for RTSP-style camera feeds.
 */
export function normalizeWebcamOrientation(value: unknown, fallback: WebcamOrientation = DEFAULT_WEBCAM_ORIENTATION): WebcamOrientation {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (!WEBCAM_ORIENTATION_RE.test(trimmed)) return fallback;
  return trimmed as WebcamOrientation;
}
