'use client';

import React from 'react';
import { subscribeHistory } from '@/history/historyStore';
import { ExportManager } from '@/features/export/logic/ExportManager';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 30_000;  // 30 s of quiet → write
const AUTOSAVE_CAP_MS = 2 * 60_000;  // write at most every 2 min even under churn
const AUTOSAVE_NAVIGATION_SETTLE_MS = 900;

// ---------------------------------------------------------------------------
// Tauri helpers
// ---------------------------------------------------------------------------

export type AutosaveOrigin = 'sidecar' | 'recovery-dir';

export type AutosavePaths = {
  voxlPath: string;
  manifestPath: string;
  origin: AutosaveOrigin;
  projectPath: string | null;
  /** Set only when the sidecar target was unusable. See `resolve_scene_autosave_target`. */
  fallbackReason: string | null;
};

export type AutosaveRecoveryCandidate = {
  voxlPath: string;
  origin: AutosaveOrigin;
  savedAt: string | null;
  clean: boolean;
  projectPath: string | null;
  payloadBytes: number;
  fallbackReason: string | null;
};

/** Minimal shape of `@tauri-apps/api/core`'s `invoke`, so tests can inject one. */
export type AutosaveInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function desktopInvoke(): Promise<AutosaveInvoke> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as AutosaveInvoke;
}

let cachedPaths: AutosavePaths | null = null;
let cachedPreferredSavePath: string | null | undefined;
let warnedFallbackFor: string | null = null;

/** Drops the resolved-path cache. Used by tests, which would otherwise leak it between cases. */
export function resetAutosavePathCache(): void {
  cachedPaths = null;
  cachedPreferredSavePath = undefined;
  warnedFallbackFor = null;
}

/**
 * Resolves the autosave target at **tick time** (finding N3).
 *
 * The cache is keyed on the project path, so a Save As to a new folder moves the
 * sidecar with it instead of writing next to the old project forever. A resolved
 * *fallback* is deliberately never cached: falling back means the project folder
 * was unusable at that moment (read-only, permission-denied, disconnected
 * share), which is exactly the kind of condition that clears — re-probing costs
 * one syscall per tick and lets the sidecar come back on its own.
 */
export async function resolveAutosavePaths(
  invoke: AutosaveInvoke,
  preferredSavePath?: string | null,
): Promise<AutosavePaths> {
  if (cachedPaths && preferredSavePath !== cachedPreferredSavePath) {
    cachedPaths = null;
  }
  if (cachedPaths) return cachedPaths;

  const result = await invoke<AutosavePaths>(
    'scene_autosave_get_paths',
    preferredSavePath ? { preferredSavePath } : {},
  );

  if (result.fallbackReason) {
    // Never fail an autosave over a folder-policy question — but never hide it
    // either. Warned once per distinct project so a 30 s tick cannot spam.
    const key = `${preferredSavePath ?? ''}:${result.fallbackReason}`;
    if (warnedFallbackFor !== key) {
      warnedFallbackFor = key;
      console.warn(
        `[SceneAutosave] Cannot write a recovery file beside this project (${result.fallbackReason}); `
        + `using the default recovery location instead: ${result.voxlPath}`,
      );
    }
    cachedPaths = null;
    cachedPreferredSavePath = undefined;
    return result;
  }

  warnedFallbackFor = null;
  cachedPaths = result;
  cachedPreferredSavePath = preferredSavePath;
  return result;
}

async function getAutosavePaths(preferredSavePath?: string | null): Promise<AutosavePaths> {
  return resolveAutosavePaths(await desktopInvoke(), preferredSavePath);
}

export type WriteManifestOptions = {
  voxlPath?: string | null;
  origin?: string | null;
  projectPath?: string | null;
  payloadBytes?: number | null;
  fallbackReason?: string | null;
  /**
   * Deletes the advertised payload as well as marking the manifest clean.
   * **Only ever passed when there is no unsaved work to lose** — after a
   * successful save, a successful restore, or an explicit discard.
   */
  deletePayload?: boolean;
};

async function writeManifest(
  savedAt: string,
  clean: boolean,
  options: WriteManifestOptions = {},
): Promise<void> {
  const invoke = await desktopInvoke();
  await invoke('scene_autosave_write_manifest', {
    savedAt,
    clean,
    voxlPath: options.voxlPath ?? null,
    origin: options.origin ?? null,
    projectPath: options.projectPath ?? null,
    payloadBytes: options.payloadBytes ?? null,
    fallbackReason: options.fallbackReason ?? null,
    deletePayload: options.deletePayload ?? false,
  });
}

/**
 * The single entry point for recovery discovery. Resolves, in order: the
 * manifest's committed `voxlPath` → the sidecar derived from its `projectPath` →
 * the legacy generic location → none.
 */
export async function resolveAutosaveRecovery(): Promise<AutosaveRecoveryCandidate | null> {
  const invoke = await desktopInvoke();
  return invoke<AutosaveRecoveryCandidate | null>('scene_autosave_resolve_recovery');
}

/** Reads a recovery payload. The backend accepts only its own candidates. */
export async function readAutosaveRecoveryBytes(path: string | null): Promise<ArrayBuffer> {
  const invoke = await desktopInvoke();
  return invoke<ArrayBuffer>('scene_autosave_read_voxl_bytes', path ? { path } : {});
}

/**
 * Removes the sidecar belonging to `projectPath`. Used on Save As against the
 * **old** project, so a rename never leaves an orphaned `_autosave.voxl` implying
 * unsaved work that does not exist.
 */
export async function deleteAutosaveSidecarForProject(projectPath: string): Promise<void> {
  const invoke = await desktopInvoke();
  await invoke('scene_autosave_delete_sidecar', { projectPath });
}

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type UseSceneAutosaveOptions = {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
  enabled?: boolean;
  debounceMs?: number;
  capMs?: number;
  preferredSavePath?: string | null;
};

export type UseSceneAutosaveResult = {
  isAutosaving: boolean;
  lastAutosaveAt: string | null;
  clearAutosave: () => Promise<void>;
  flushAutosave: () => Promise<void>;
};

export function useSceneAutosave({
  models,
  activeModelId,
  selectedModelIds,
  enabled = true,
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  capMs = AUTOSAVE_CAP_MS,
  preferredSavePath = null,
}: UseSceneAutosaveOptions): UseSceneAutosaveResult {
  const [isAutosaving, setIsAutosaving] = React.useState(false);
  const [lastAutosaveAt, setLastAutosaveAt] = React.useState<string | null>(null);

  // Keep stable refs so the debounce callback always sees fresh values
  const modelsRef = React.useRef(models);
  modelsRef.current = models;
  const activeModelIdRef = React.useRef(activeModelId);
  activeModelIdRef.current = activeModelId;
  const selectedModelIdsRef = React.useRef(selectedModelIds);
  selectedModelIdsRef.current = selectedModelIds;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const debounceMsRef = React.useRef(debounceMs);
  debounceMsRef.current = debounceMs;
  const capMsRef = React.useRef(capMs);
  capMsRef.current = capMs;
  const preferredSavePathRef = React.useRef(preferredSavePath);
  preferredSavePathRef.current = preferredSavePath;

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const capRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredAutosaveRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationSettleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationActiveRef = React.useRef(false);
  const navigationQuietUntilRef = React.useRef(0);
  const inFlightRef = React.useRef(false);
  const autosavePromiseRef = React.useRef<Promise<void> | null>(null);
  const dirtyRef = React.useRef(false);

  const clearDeferredAutosave = React.useCallback(() => {
    if (deferredAutosaveRef.current === null) return;
    clearTimeout(deferredAutosaveRef.current);
    deferredAutosaveRef.current = null;
  }, []);

  const shouldDeferAutosaveForNavigation = React.useCallback(() => {
    return navigationActiveRef.current || Date.now() < navigationQuietUntilRef.current;
  }, []);

  const scheduleDeferredAutosave = React.useCallback((perform: () => void) => {
    clearDeferredAutosave();

    const delay = Math.max(
      AUTOSAVE_NAVIGATION_SETTLE_MS,
      navigationQuietUntilRef.current - Date.now(),
      0,
    );

    deferredAutosaveRef.current = setTimeout(() => {
      deferredAutosaveRef.current = null;
      if (!dirtyRef.current) return;
      perform();
    }, delay);
  }, [clearDeferredAutosave]);

  const performAutosave = React.useCallback(async (options?: { force?: boolean }) => {
    if (autosavePromiseRef.current) {
      await autosavePromiseRef.current;
      return;
    }

    const run = async () => {
      if (!enabledRef.current) return;
      if (!isDesktopRuntime()) return;
      if (Date.now() < sceneAutosaveSuppressRef.current) return;

      if (!options?.force && shouldDeferAutosaveForNavigation()) {
        scheduleDeferredAutosave(() => {
          void performAutosave();
        });
        return;
      }

      const currentModels = modelsRef.current;
      if (currentModels.length === 0) return;

      clearDeferredAutosave();
      inFlightRef.current = true;
      dirtyRef.current = false;
      setIsAutosaving(true);

      try {
        // Resolved per tick, not per render: `preferredSavePathRef` now tracks
        // `activeSceneFilePath` state, so a Save As moves the sidecar with the
        // project instead of stranding it beside the old one (finding N3).
        const paths = await getAutosavePaths(preferredSavePathRef.current);
        const { voxlPath } = paths;

        await ExportManager.exportScene(
          null,
          null,
          {
            filename: 'autosave',
            format: 'voxl',
            binary: true,
            separateFiles: false,
            includeRaft: false,
            includeSupports: true,
            includeModel: true,
          },
          {
            models: currentModels,
            activeModelId: activeModelIdRef.current,
            selectedModelIds: selectedModelIdsRef.current,
          },
          { nativePath: voxlPath },
        );

        // Ordering is load-bearing and must stay this way: payload first, then
        // manifest. `exportScene` above commits the VOXL through the atomic
        // writer (temp → fsync → rename, ExportManager.downloadFile), so by the
        // time the manifest is written the file it advertises is guaranteed to
        // be complete. A manifest written first — or written on a failed
        // export — would point recovery at a file that may not exist or may be
        // half a scene. Sub-phase B relies on exactly this: `voxlPath` below is
        // what makes the manifest authoritative for recovery, and it is only
        // trustworthy because it is written after the commit.
        const savedAt = new Date().toISOString();
        await writeManifest(savedAt, false, {
          voxlPath,
          origin: paths.origin,
          projectPath: paths.projectPath,
          fallbackReason: paths.fallbackReason,
        });
        setLastAutosaveAt(savedAt);
      } catch (err) {
        console.warn('[SceneAutosave] Autosave failed:', err);
      } finally {
        inFlightRef.current = false;
        setIsAutosaving(false);
      }
    };

    const promise = run();
    autosavePromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (autosavePromiseRef.current === promise) {
        autosavePromiseRef.current = null;
      }
    }
  }, []);

  const scheduleSave = React.useCallback(() => {
    if (!enabledRef.current || !isDesktopRuntime()) return;
    dirtyRef.current = true;

    // Reset the debounce window
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void performAutosave();
    }, debounceMsRef.current);

    // Ensure we still fire within the cap if the scene is continuously dirty
    if (capRef.current === null) {
      capRef.current = setTimeout(() => {
        capRef.current = null;
        if (dirtyRef.current) {
          if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          void performAutosave();
        }
      }, capMsRef.current);
    }
  }, [performAutosave]);

  // Subscribe to history events (push / undo / redo)
  React.useEffect(() => {
    const unsubscribe = subscribeHistory(scheduleSave);
    return () => {
      unsubscribe();
    };
  }, [scheduleSave]);

  // Also fire when a model is added or removed
  const prevModelCountRef = React.useRef(models.length);
  React.useEffect(() => {
    const prev = prevModelCountRef.current;
    prevModelCountRef.current = models.length;
    if (models.length !== prev && models.length > 0) {
      scheduleSave();
    }
  }, [models.length, scheduleSave]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const markNavigationActive = () => {
      navigationActiveRef.current = true;
      navigationQuietUntilRef.current = Date.now() + AUTOSAVE_NAVIGATION_SETTLE_MS;
      if (navigationSettleRef.current !== null) {
        clearTimeout(navigationSettleRef.current);
        navigationSettleRef.current = null;
      }
    };

    const markNavigationSettling = (event?: Event) => {
      navigationActiveRef.current = false;
      const resumeAfterMs = event
        ? Number((event as CustomEvent<{ resumeAfterMs?: number }>).detail?.resumeAfterMs ?? 0)
        : 0;
      const settleMs = Math.max(AUTOSAVE_NAVIGATION_SETTLE_MS, resumeAfterMs + AUTOSAVE_NAVIGATION_SETTLE_MS);
      navigationQuietUntilRef.current = Date.now() + settleMs;

      if (navigationSettleRef.current !== null) {
        clearTimeout(navigationSettleRef.current);
      }

      navigationSettleRef.current = setTimeout(() => {
        navigationSettleRef.current = null;
        if (!dirtyRef.current) return;
        if (shouldDeferAutosaveForNavigation()) {
          scheduleDeferredAutosave(() => {
            void performAutosave();
          });
          return;
        }
        void performAutosave();
      }, settleMs);
    };

    window.addEventListener('picking-orbit-start', markNavigationActive);
    window.addEventListener('picking-orbit-change', markNavigationActive);
    window.addEventListener('picking-orbit-end', markNavigationSettling);
    window.addEventListener('picking-pan-start', markNavigationActive);
    window.addEventListener('picking-pan-change', markNavigationActive);
    window.addEventListener('picking-pan-end', markNavigationSettling);
    window.addEventListener('picking-zoom-start', markNavigationActive);
    window.addEventListener('picking-zoom-change', markNavigationActive);
    window.addEventListener('picking-zoom-end', markNavigationSettling);
    window.addEventListener('blur', markNavigationSettling);

    return () => {
      window.removeEventListener('picking-orbit-start', markNavigationActive);
      window.removeEventListener('picking-orbit-change', markNavigationActive);
      window.removeEventListener('picking-orbit-end', markNavigationSettling);
      window.removeEventListener('picking-pan-start', markNavigationActive);
      window.removeEventListener('picking-pan-change', markNavigationActive);
      window.removeEventListener('picking-pan-end', markNavigationSettling);
      window.removeEventListener('picking-zoom-start', markNavigationActive);
      window.removeEventListener('picking-zoom-change', markNavigationActive);
      window.removeEventListener('picking-zoom-end', markNavigationSettling);
      window.removeEventListener('blur', markNavigationSettling);
      if (navigationSettleRef.current !== null) {
        clearTimeout(navigationSettleRef.current);
        navigationSettleRef.current = null;
      }
    };
  }, [performAutosave, scheduleDeferredAutosave, shouldDeferAutosaveForNavigation]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      if (capRef.current !== null) clearTimeout(capRef.current);
      if (deferredAutosaveRef.current !== null) clearTimeout(deferredAutosaveRef.current);
      if (navigationSettleRef.current !== null) clearTimeout(navigationSettleRef.current);
    };
  }, []);

  /**
   * Marks the autosave clean **and deletes the payload**.
   *
   * A `_autosave.voxl` lingering beside a saved project is user-visible clutter
   * that implies unsaved work which does not exist. Deleting is safe only
   * because every caller runs after the work is already secured — a successful
   * explicit save, a successful restore, or an explicit discard. It is
   * deliberately NOT called on a clean exit that still has unsaved changes; see
   * `handleRequestProgramClose` in `page.tsx`.
   */
  const clearAutosave = React.useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      await writeManifest(new Date().toISOString(), true, { deletePayload: true });
    } catch (err) {
      console.warn('[SceneAutosave] Failed marking autosave clean:', err);
    }
  }, []);

  const flushAutosave = React.useCallback(async () => {
    if (!enabledRef.current || !isDesktopRuntime()) return;

    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (capRef.current !== null) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }

    dirtyRef.current = true;
    clearDeferredAutosave();
    await performAutosave({ force: true });
  }, [clearDeferredAutosave, performAutosave]);

  return { isAutosaving, lastAutosaveAt, clearAutosave, flushAutosave };
}

// ---------------------------------------------------------------------------
// Exported helper for recovery: suppress autosave briefly after restore
// ---------------------------------------------------------------------------

// We expose a module-level timestamp so page.tsx can tell the hook to hold off
// after restoring a scene (otherwise the newly-imported models immediately
// trigger another dirty write).  Call suppressSceneAutosave(30_000) after a
// recovery restore.
export const sceneAutosaveSuppressRef = { current: 0 };

export function suppressSceneAutosave(ms: number): void {
  sceneAutosaveSuppressRef.current = Date.now() + ms;
}
