import { useEffect, useRef } from 'react';
import { SliceMeshWarmup } from './sliceMeshWarmup';
import type { SliceMeshPrewarmOptions } from './sliceMeshSnapshot';

let activeWarmup: SliceMeshWarmup | null = null;

/** Release only background ownership; a foreground subscriber keeps its work. */
export function cancelSliceMeshWarmup(): void {
  activeWarmup?.cancel();
}

/** Mounted once at scene lifetime, independently of the visible editor panel. */
export function useSliceMeshWarmup(
  options: SliceMeshPrewarmOptions | null,
  revision: number,
  ready: boolean,
  paused: boolean,
): void {
  const warmup = useRef<SliceMeshWarmup | null>(null);

  // Compare real inputs, not wrapper identity; history also catches in-place edits.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    warmup.current ??= new SliceMeshWarmup(window);
    activeWarmup = warmup.current;
    warmup.current.update(options, revision, ready, paused);
  });

  useEffect(() => () => {
    if (activeWarmup === warmup.current) activeWarmup = null;
    warmup.current?.dispose();
    warmup.current = null;
  }, []);
}
