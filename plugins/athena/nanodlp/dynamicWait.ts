/**
 * Athena NanoDLP dynamic-wait detection module.
 *
 * Consumed by Profile Settings UI to lock wait-before-print fields when Dynamic
 * Wait is active in the selected profile.
 */

/**
 * Detect whether Dynamic Wait should be treated as enabled for the current
 * NanoDLP edit draft.
 *
 * Detection strategy:
 * 1) Prefer direct dynamic-wait enable flags when present.
 * 2) Fall back to slope-based signal (`dwflowendslope`) for older/variant keys.
 */
export function isNanoDlpDynamicWaitEnabled(draft: Record<string, string>): boolean {
  /** Normalize keys to make matching robust to punctuation/casing variants. */
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  /** Interpret common truthy forms seen across NanoDLP settings payloads. */
  const isTruthy = (rawValue: string) => {
    const trimmed = rawValue.trim().toLowerCase();
    if (!trimmed) return false;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric > 0;

    return ['true', 'on', 'yes', 'enabled', 'checked'].includes(trimmed);
  };

  let sawDynamicWaitKey = false;

  for (const [key, value] of Object.entries(draft)) {
    const normalizedKey = normalize(key);
    const isDynamicWaitKey = normalizedKey.includes('dynamicwait') || normalizedKey.includes('enabledynamicwait');
    if (!isDynamicWaitKey) continue;

    sawDynamicWaitKey = true;
    if (isTruthy(String(value ?? ''))) return true;
  }

  // If explicit dynamic-wait keys exist but evaluate false, honor that directly.
  if (sawDynamicWaitKey) return false;

  for (const [key, value] of Object.entries(draft)) {
    const normalizedKey = normalize(key);
    if (!normalizedKey.includes('dwflowendslope')) continue;
    if (isTruthy(String(value ?? ''))) return true;
  }

  // Legacy/variant fallback.
  return false;
}