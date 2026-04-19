/**
 * Three-value toggle for R3F demand-mode rendering on the main SceneCanvas.
 * - `null`: follow the platform default (currently OFF everywhere — this is opt-in)
 * - `true`: user-forced ON
 * - `false`: user-forced OFF
 *
 * The three-value state preserves an explicit user opt-out across any future
 * default flip (tracked by dragonfruit-120-1). See ADR / rendering-contract
 * section in ARCHITECTURE_AND_HANDOFF for context.
 */

export type DemandFrameloopPreference = true | false | null;

export type DemandFrameloopSettings = {
  preference: DemandFrameloopPreference;
  showDiagnosticsOverlay: boolean;
};

export const DEMAND_FRAMELOOP_STORAGE_KEY = 'demand-frameloop-settings';
const DEMAND_FRAMELOOP_EVENT = 'demand-frameloop-settings-changed';

export const DEFAULT_DEMAND_FRAMELOOP_SETTINGS: DemandFrameloopSettings = {
  preference: null,
  showDiagnosticsOverlay: false,
};

function normalizePreference(input: unknown): DemandFrameloopPreference {
  if (input === true || input === false || input === null) return input;
  return null;
}

export function normalizeDemandFrameloopSettings(input: unknown): DemandFrameloopSettings {
  if (!input || typeof input !== 'object') return DEFAULT_DEMAND_FRAMELOOP_SETTINGS;
  const candidate = input as Partial<DemandFrameloopSettings>;
  return {
    preference: normalizePreference(candidate.preference),
    showDiagnosticsOverlay: candidate.showDiagnosticsOverlay === true,
  };
}

export function getSavedDemandFrameloopSettings(): DemandFrameloopSettings {
  if (typeof window === 'undefined') return DEFAULT_DEMAND_FRAMELOOP_SETTINGS;

  try {
    const raw = window.localStorage.getItem(DEMAND_FRAMELOOP_STORAGE_KEY);
    if (!raw) return DEFAULT_DEMAND_FRAMELOOP_SETTINGS;
    return normalizeDemandFrameloopSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_DEMAND_FRAMELOOP_SETTINGS;
  }
}

export function saveDemandFrameloopSettings(settings: DemandFrameloopSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeDemandFrameloopSettings(settings);

  try {
    window.localStorage.setItem(DEMAND_FRAMELOOP_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(DEMAND_FRAMELOOP_EVENT, { detail: normalized }));
}

export function subscribeToDemandFrameloopSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== DEMAND_FRAMELOOP_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(DEMAND_FRAMELOOP_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(DEMAND_FRAMELOOP_EVENT, onCustom as EventListener);
  };
}

/**
 * Resolve the effective frameloop based on: env override → user preference → platform default.
 * Platform default is OFF this PR (opt-in). Follow-up flip is gated on dragonfruit-120-1.
 */
export function resolveDemandFrameloop(
  settings: DemandFrameloopSettings,
  envOverride?: string | boolean | undefined,
): 'demand' | 'always' {
  if (envOverride === true || envOverride === 'true' || envOverride === '1') return 'demand';
  if (envOverride === false || envOverride === 'false' || envOverride === '0') return 'always';

  if (settings.preference === true) return 'demand';
  if (settings.preference === false) return 'always';

  return 'always';
}
