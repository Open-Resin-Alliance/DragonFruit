'use client';

import { useEffect } from 'react';
import {
  getSavedUiScale,
  subscribeToUiScale,
} from '@/components/settings/uiScalePreference';

/**
 * Maps the screen's DPI-normalized (logical) size to a base UI scale factor, so
 * the default density is compact on smaller monitors instead of crowded while
 * staying at the reference size on 1440p-and-larger. `screen.avail*` are in
 * CSS px (logical), so this corresponds to the DPI-scaled rendering.
 */
function computeScreenSizeFactor(width: number): number {
  if (width >= 2000) return 1; // 1440p & larger → reference size
  if (width >= 1600) return 0.9; // 1080p → 90%
  if (width >= 1200) return 0.82; // small laptops
  return 0.72; // tiny
}

/**
 * Applies the effective UI zoom as native webview zoom (`Webview::setZoom`):
 *
 *   effective zoom = user UI scale × screen-size factor
 *
 * 100% user scale means "adapt automatically to the screen" (the screen factor
 * does the work); other values are a manual multiplier on top. `window.screen`
 * dimensions are DPI-normalized and unaffected by webview zoom, so the factor
 * is stable and there's no feedback loop. Native page zoom scales the whole
 * interface uniformly and keeps all `getBoundingClientRect()` / pointer math
 * consistent, so the 3D canvas, gizmos, and picking stay correct. No-op outside
 * a Tauri webview (e.g. browser dev).
 */
export function useUiScale() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let lastZoom = 0;

    const applyScale = async () => {
      if (cancelled) return;
      try {
        const { isTauri } = await import('@tauri-apps/api/core');
        if (!isTauri()) return;
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');

        const userScale = getSavedUiScale();
        const screenFactor = computeScreenSizeFactor(window.screen.availWidth);
        const effectiveZoom = userScale * screenFactor;

        if (Math.abs(effectiveZoom - lastZoom) < 0.001) return;
        lastZoom = effectiveZoom;

        await getCurrentWebview().setZoom(effectiveZoom);
      } catch {
        // Not running inside a Tauri webview, or zoom not permitted — ignore.
      }
    };

    // Apply on startup...
    void applyScale();

    // ...on UI-scale preference change, and on window resize / monitor move
    // (the screen factor may change when the window lands on another display).
    const unsubscribe = subscribeToUiScale(() => {
      void applyScale();
    });
    window.addEventListener('resize', applyScale);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('resize', applyScale);
    };
  }, []);
}
