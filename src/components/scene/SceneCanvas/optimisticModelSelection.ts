"use client";

import { useSyncExternalStore } from 'react';

/**
 * The model a viewport click just selected, before the page's selection state
 * has re-rendered around it.
 *
 * A model click updates `scene.selectedModelIds` in the app root, and that
 * render is what used to carry the selection tint to `StlMesh`. On a heavy
 * scene that render is the latency between the click and the tint. The scene
 * now announces the click here first: every `StlMesh` subscribes, so only the
 * meshes re-render, and the real selection is applied in a transition that the
 * browser can paint behind.
 *
 * This is not a second selection: it holds one id for at most a frame (or the
 * fallback below), and `SceneCanvas` clears it the moment the real selection
 * lands. Multi-select gestures never use it — they have no single tint to show.
 */

let selectedModelId: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function setOptimisticSelectedModelId(modelId: string | null): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  if (selectedModelId === modelId) return;
  selectedModelId = modelId;
  notify();
  if (modelId !== null) {
    // The real selection normally clears this within a frame. A refused one
    // (a locked plate) never arrives, so the tint must not outlive it.
    clearTimer = setTimeout(() => {
      clearTimer = null;
      setOptimisticSelectedModelId(null);
    }, 1500);
  }
}

export function getOptimisticSelectedModelId(): string | null {
  return selectedModelId;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOptimisticSelectedModelId(): string | null {
  return useSyncExternalStore(subscribe, getOptimisticSelectedModelId, getOptimisticSelectedModelId);
}
