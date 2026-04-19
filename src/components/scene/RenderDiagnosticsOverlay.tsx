'use client';

import React from 'react';
import { useFrame } from '@react-three/fiber';
import {
  recordFrame,
  recordInvalidation,
  subscribeToRenderStats,
  getRenderStats,
  type RenderStats,
} from './renderDiagnostics';

/**
 * R3F component that lives inside the Canvas and probes the render rate.
 * In demand mode, useFrame only fires on actually-rendered frames, so each
 * call is one real render — a perfect rate probe.
 *
 * Invalidation counting is intentionally not wired: useThree().invalidate
 * returns a per-consumer bound copy, so a single wrapper here would only
 * count the probe's own invalidate calls (zero). A real invalidation
 * counter requires a singleton wrapper threaded into every invalidate
 * call site — tracked at dragonfruit-120-1.
 */
export function RenderDiagnosticsProbe() {
  useFrame(() => {
    recordFrame();
  });

  return null;
}

/**
 * DOM overlay that shows the current render stats. Mounts as a sibling of
 * the Canvas (not inside it). Gated by the `showDiagnosticsOverlay` user
 * preference upstream.
 */
export function RenderDiagnosticsOverlay() {
  const [stats, setStats] = React.useState<RenderStats>(() => getRenderStats());

  React.useEffect(() => {
    return subscribeToRenderStats(setStats);
  }, []);

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        padding: '4px 8px',
        borderRadius: 4,
        background: 'rgba(16, 16, 22, 0.78)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        color: '#e6e8ed',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        lineHeight: 1.3,
        pointerEvents: 'none',
        zIndex: 300,
        whiteSpace: 'pre',
      }}
    >
      {`renders/sec: ${stats.rendersPerSec.toFixed(1)}\n`}
      {`total renders: ${stats.totalRenders}`}
    </div>
  );
}

/**
 * Re-export recordInvalidation so a future call-site wrapper can hook into
 * the module without importing from two places. Unused today.
 */
export { recordInvalidation };
