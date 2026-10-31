'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  installRenderProfiler,
  isRenderProfilerEnabled,
  markRenderFrame,
  subscribeRenderProfilerEnabled,
  uninstallRenderProfiler,
} from '@/utils/debug/renderProfiler';

/**
 * Connects the renderer to the render profiler while the overlay is open.
 *
 * Mounted first inside the canvas so its `useFrame` subscription runs before
 * the picking pass's: `markRenderFrame` must close the previous frame before
 * any render of the next one is recorded, and R3F runs subscribers in mount
 * order.
 *
 * With the profiler closed this component costs one store read per frame and
 * nothing else; the renderer is not patched and no samples are kept.
 */
export function SceneRenderProfiler() {
  const { gl, scene } = useThree();
  const enabled = useSyncExternalStore(
    subscribeRenderProfilerEnabled,
    isRenderProfilerEnabled,
    isRenderProfilerEnabled,
  );

  useEffect(() => {
    if (!enabled) {
      uninstallRenderProfiler();
      return;
    }
    installRenderProfiler(gl, scene);
    return () => {
      uninstallRenderProfiler();
    };
  }, [enabled, gl, scene]);

  useFrame(() => {
    if (isRenderProfilerEnabled()) markRenderFrame();
  });

  return null;
}
