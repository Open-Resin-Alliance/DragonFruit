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
  const inFlightRef = React.useRef(false);
  const dirtyRef = React.useRef(false);

  const performAutosave = React.useCallback(async () => {
    if (!enabledRef.current) return;
    if (!isDesktopRuntime()) return;
    if (inFlightRef.current) return;
    if (Date.now() < sceneAutosaveSuppressRef.current) return;

    const currentModels = modelsRef.current;
    if (currentModels.length === 0) return;

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

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      if (capRef.current !== null) clearTimeout(capRef.current);
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

  return { isAutosaving, lastAutosaveAt, clearAutosave };
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
