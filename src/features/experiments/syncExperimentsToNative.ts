import { isTauriRuntime } from '@/utils/tauriRuntime';
import {
  getExperimentOverrides,
  subscribeToExperiments,
} from '@/features/experiments/experimentsRegistry';

/**
 * Keeps Rust's view of the Experiments state up to date so gated Rust commands
 * can enforce the gate themselves (see `docs/dev/experiments-framework.md`,
 * "Gating Rust code"). Rust embeds `src/config/experiments.json` at compile
 * time, so it already knows every experiment and its `defaultEnabled`; the only
 * thing it cannot see is the user's per-experiment toggles in webview
 * `localStorage`. The frontend pushes just that delta — the user overrides,
 * i.e. experiments whose effective state deviates from the manifest default —
 * via the `set_experiment_overrides` command, and Rust computes the effective
 * enabled state as `default ⊕ override`. A `false` override only ever means an
 * explicit opt-out of a default-enabled (promoted) experiment; stale values
 * that match the default are not pushed (see "Promotion semantics" in
 * `docs/dev/experiments-framework.md`).
 *
 * Desktop-only — a no-op in the plain web build (no `__TAURI_INTERNALS__`).
 */

type TauriCoreModule = typeof import('@tauri-apps/api/core');


let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core').catch(() => null);
  }
  return tauriCorePromise;
}

async function pushExperimentOverridesToNative(): Promise<void> {
  const core = await loadTauriCore();
  if (!core) return;
  try {
    await core.invoke('set_experiment_overrides', { overrides: getExperimentOverrides() });
  } catch (error) {
    console.warn('[ExperimentsNativeSync] Failed to sync experiment overrides to native:', error);
  }
}

/**
 * Pushes the user's experiment overrides on startup and re-pushes whenever an
 * experiment is toggled. Returns an unsubscribe function (no-op off-desktop).
 */
export function syncExperimentsToNative(): () => void {
  if (!isTauriRuntime()) return () => {};
  void pushExperimentOverridesToNative();
  return subscribeToExperiments(() => {
    void pushExperimentOverridesToNative();
  });
}
