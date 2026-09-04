// Per-session flag (Ctrl+Shift+U) to allow installing the same version via regular update logic
// Once triggered anywhere, all checks until reload use allow_same_version=true, so regular
// updater returns current version as available with real changelog, no fabricated debug states.
let allowSameVersionUntilReload = false;

export function isAllowSameVersionEnabled(): boolean { return allowSameVersionUntilReload; }
export function enableAllowSameVersionForSession(): void { allowSameVersionUntilReload = true; }
export function clearAllowSameVersion(): void { allowSameVersionUntilReload = false; }

// Back-compat shims for old callers (now no-ops, kept so imports don't break until callers updated)
export function getGlobalDebugInfo(): unknown { return null; }
export function setSessionDebug(_info: unknown): void { enableAllowSameVersionForSession(); }
export function getCheckerDebugState(): unknown { return null; }
export function setCheckerDebugState(_state: unknown): void {}
export function clearSessionDebug(): void { clearAllowSameVersion(); }
