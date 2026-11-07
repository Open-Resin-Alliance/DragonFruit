import { useCallback, useEffect, useRef } from 'react';
import { SliceMeshWarmup } from './sliceMeshWarmup';
import type { SliceMeshPrewarmOptions } from './sliceMeshSnapshot';

let activeWarmup: SliceMeshWarmup | null = null;

/** Cancel only the background subscriber; an export already joining it keeps ownership. */
export function cancelSliceMeshWarmup(): void {
  activeWarmup?.cancel();
}

/** Owned once at scene lifetime, independently of the active editor panel. */
export function useSliceMeshWarmup(
  options: SliceMeshPrewarmOptions | null,
  imminentSlice = false,
  ready = true,
  paused = false,
): () => void {
  const warmup = useRef<SliceMeshWarmup | null>(null);

  // Compare real input signatures after every render, not the options wrapper's identity.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    warmup.current ??= new SliceMeshWarmup(window);
    activeWarmup = warmup.current;
    warmup.current.update(options, imminentSlice, ready, paused);
  });

  useEffect(() => () => {
    if (activeWarmup === warmup.current) activeWarmup = null;
    warmup.current?.dispose();
    warmup.current = null;
  }, []);

  return useCallback(() => { warmup.current?.cancel(); }, []);
}
