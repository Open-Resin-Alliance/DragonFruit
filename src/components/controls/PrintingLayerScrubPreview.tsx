'use client';

import React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  buildProjectedCrossSectionContext,
  buildProjectedCrossSectionLoopsAtZFromContext,
  type ProjectedCrossSectionContext,
} from '@/features/slicing/rasterLayerZipExport';

// Same limits as CrossSectionCap
const CONTEXT_CACHE_LIMIT = 8;
const LOOPS_CACHE_LIMIT = 48;

function computeModelSignature(models: LoadedModel[]): string {
  return models
    .filter((m) => m.visible)
    .map((m) => {
      const t = m.transform;
      return [
        m.id,
        m.geometry.geometry.uuid,
        t.position.x.toFixed(3),
        t.position.y.toFixed(3),
        t.position.z.toFixed(3),
        t.rotation.x.toFixed(3),
        t.rotation.y.toFixed(3),
        t.rotation.z.toFixed(3),
        t.scale.x.toFixed(3),
        t.scale.y.toFixed(3),
        t.scale.z.toFixed(3),
      ].join('|');
    })
    .join(';');
}

interface Props {
  models: LoadedModel[];
  /** World-space Z height of the cross-section plane (mm) */
  clipZ: number | null;
  /** Build plate X extent (mm) — used to map world coords to canvas */
  buildPlateWidthMm: number;
  /** Build plate Y extent (mm) */
  buildPlateDepthMm: number;
  /** Layer height for quantized bucketing (mm) */
  layerHeightMm?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders a 2D cross-section preview of the model at the given Z height
 * onto a canvas.  Used as a fast, memory-friendly substitute for the PNG
 * preview while the layer slider is being scrubbed.
 *
 * The context (world-space triangles) and per-height loops are cached so
 * repeated scrubs over the same heights are essentially free.
 */
export function PrintingLayerScrubPreview({
  models,
  clipZ,
  buildPlateWidthMm,
  buildPlateDepthMm,
  layerHeightMm = 0.05,
  mirrorX = false,
  mirrorY = false,
  className,
  style,
}: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  // Per-instance caches — bounded, evict oldest on overflow
  const contextCacheRef = React.useRef<Map<string, ProjectedCrossSectionContext>>(new Map());
  const loopsCacheRef = React.useRef<Map<string, import('three').Vector2[][]>>(new Map());

  // Defer canvas rendering to avoid jank during rapid scrubbing
  const renderRafRef = React.useRef<number | null>(null);

  // Track container size so the canvas pixel dimensions stay correct on layout changes
  const [containerSize, setContainerSize] = React.useState<{ w: number; h: number } | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ w: width, h: height });
    });
    ro.observe(container);
    // Seed immediately
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      setContainerSize({ w: rect.width, h: rect.height });
    }
    return () => ro.disconnect();
  }, []);

  const modelSignature = React.useMemo(() => computeModelSignature(models), [models]);

  // Compute (or retrieve from cache) the cross-section loops at clipZ
  const loops = React.useMemo(() => {
    if (clipZ == null || !modelSignature) return null;

    let context = contextCacheRef.current.get(modelSignature);
    if (!context) {
      const computed = buildProjectedCrossSectionContext(models);
      if (computed) {
        context = computed;
        contextCacheRef.current.set(modelSignature, context);
        if (contextCacheRef.current.size > CONTEXT_CACHE_LIMIT) {
          const oldest = contextCacheRef.current.keys().next().value;
          if (oldest != null) contextCacheRef.current.delete(oldest);
        }
      }
    }
    if (!context) return null;

    const loopKey = `${modelSignature}|${clipZ.toFixed(3)}`;
    let cached = loopsCacheRef.current.get(loopKey);
    if (!cached) {
      cached = buildProjectedCrossSectionLoopsAtZFromContext({
        context,
        zMm: clipZ,
        quantizedStepMm: layerHeightMm,
      });
      loopsCacheRef.current.set(loopKey, cached);
      if (loopsCacheRef.current.size > LOOPS_CACHE_LIMIT) {
        const oldest = loopsCacheRef.current.keys().next().value;
        if (oldest != null) loopsCacheRef.current.delete(oldest);
      }
    }
    return cached;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSignature, clipZ, layerHeightMm]);
  // Note: `models` intentionally omitted — signature change covers it

  // Deferred render effect: only redraw canvas once per animation frame even if loops change multiple times
  React.useEffect(() => {
    if (renderRafRef.current !== null) {
      cancelAnimationFrame(renderRafRef.current);
    }

    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.max(1, window.devicePixelRatio ?? 1);
      const cssW = containerSize?.w ?? canvas.clientWidth;
      const cssH = containerSize?.h ?? canvas.clientHeight;
      const pxW = Math.max(1, Math.round(cssW * dpr));
      const pxH = Math.max(1, Math.round(cssH * dpr));

      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, pxW, pxH);

      if (loops && loops.length > 0) {
        const bwMm = Math.max(1, buildPlateWidthMm);
        const bdMm = Math.max(1, buildPlateDepthMm);
        const baseScale = Math.min(pxW / bwMm, pxH / bdMm);
        const scaleX = baseScale * (mirrorX ? -1 : 1);
        const scaleY = baseScale * (mirrorY ? 1 : -1);

        ctx.translate(pxW * 0.5, pxH * 0.5);
        ctx.scale(scaleX, scaleY);
        ctx.fillStyle = '#ffffff';

        const path = new Path2D();
        for (const loop of loops) {
          if (loop.length < 2) continue;
          path.moveTo(loop[0].x, loop[0].y);
          for (let i = 1; i < loop.length; i++) {
            path.lineTo(loop[i].x, loop[i].y);
          }
          path.closePath();
        }
        ctx.fill(path, 'nonzero');
      }

      ctx.restore();
    });

    return () => {
      if (renderRafRef.current !== null) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = null;
      }
    };
  }, [loops, buildPlateWidthMm, buildPlateDepthMm, mirrorX, mirrorY, containerSize]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', overflow: 'hidden', ...style }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}
