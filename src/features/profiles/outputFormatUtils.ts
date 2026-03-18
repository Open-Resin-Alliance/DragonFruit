export const DEFAULT_OUTPUT_FORMAT = '.lumen';

const LEGACY_FORMAT_ALIASES: Record<string, string> = {
  '.luman': '.lumen',
};

const OUTPUT_FORMAT_RE = /^\.[a-z0-9][a-z0-9_-]*$/i;

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
