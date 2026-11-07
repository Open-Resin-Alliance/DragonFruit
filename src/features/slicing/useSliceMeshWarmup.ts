import { useCallback, useEffect, useRef } from 'react';
import { SliceMeshWarmup } from './sliceMeshWarmup';
import type { SliceMeshPrewarmOptions } from './sliceMeshSnapshot';

/** Only mounted by the active slicing panel; no inactive-tool modifier warmups. */
export function useSliceMeshWarmup(options: SliceMeshPrewarmOptions | null, imminentSlice = false): () => void {
  const warmup = useRef<SliceMeshWarmup | null>(null);

  // Compare real input signatures after every render, not the options wrapper's identity.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    warmup.current ??= new SliceMeshWarmup(window);
    warmup.current.update(options, imminentSlice);
  });

  useEffect(() => () => {
    warmup.current?.dispose();
    warmup.current = null;
  }, []);

  return useCallback(() => { warmup.current?.cancel(); }, []);
}
