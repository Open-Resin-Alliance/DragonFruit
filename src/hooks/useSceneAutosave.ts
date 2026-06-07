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

type AutosavePaths = { voxlPath: string; manifestPath: string };

let cachedPaths: AutosavePaths | null = null;
let cachedPreferredSavePath: string | null | undefined;

async function getAutosavePaths(preferredSavePath?: string | null): Promise<AutosavePaths> {
  // Invalidate cache if preferredSavePath changes
  if (cachedPaths && preferredSavePath !== cachedPreferredSavePath) {
    cachedPaths = null;
  }
  if (cachedPaths) return cachedPaths;
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<AutosavePaths>(
    'scene_autosave_get_paths',
    preferredSavePath ? { preferredSavePath } : {},
  );
  cachedPaths = result;
  cachedPreferredSavePath = preferredSavePath;
  return cachedPaths;
}

async function writeManifest(savedAt: string, clean: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('scene_autosave_write_manifest', { savedAt, clean });
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
        const { voxlPath } = await getAutosavePaths(preferredSavePathRef.current);

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

        const savedAt = new Date().toISOString();
        await writeManifest(savedAt, false);
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

  const clearAutosave = React.useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      await writeManifest(new Date().toISOString(), true);
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
