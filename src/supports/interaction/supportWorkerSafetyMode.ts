const SAFE_MODE_ENV = 'NEXT_PUBLIC_SUPPORT_WORKERS_SAFE_MODE';

let cachedSafeModeValue: boolean | null = null;

function readSafeModeFromEnv() {
  const raw = process.env[SAFE_MODE_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readSafeModeFromWindowOverride() {
  if (typeof window === 'undefined') return false;
  const override = (window as any).__supportWorkersSafeMode;
  return override === true;
}

/**
 * Phase 0 safety gate for supports worker traffic.
 *
 * Enabled by setting `NEXT_PUBLIC_SUPPORT_WORKERS_SAFE_MODE=1`.
 * In development, can also be toggled from DevTools via:
 *   window.__supportWorkersSafeMode = true
 */
export function isSupportWorkerSafetyModeEnabled() {
  if (cachedSafeModeValue === null) {
    cachedSafeModeValue = readSafeModeFromEnv();
  }
  return cachedSafeModeValue || readSafeModeFromWindowOverride();
}
