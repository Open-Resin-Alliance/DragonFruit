"use client";

import React from 'react';
import type * as THREE from 'three';

import { endMeshSmoothingStroke, getMeshSmoothingBrushState, subscribeToMeshSmoothingBrushState } from './brushController';
import { endMeshSmoothingEngineStroke } from './meshSmoothingEngine';
import { getMeshSmoothingSettings, updateMeshSmoothingSettings } from './settings';
import { useMeshSmoothingHistoryHandlers } from './history/useMeshSmoothingHistoryHandlers';

export function useMeshSmoothingSceneBindings({
  mode,
  transformMode,
  containerRef,
}: {
  mode?: string;
  transformMode?: string;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  useMeshSmoothingHistoryHandlers();

  const activeSmoothingGeometryRef = React.useRef<THREE.BufferGeometry | null>(null);

  const smoothingBrushState = React.useSyncExternalStore(
    subscribeToMeshSmoothingBrushState,
    getMeshSmoothingBrushState,
    getMeshSmoothingBrushState,
  );

  const onSmoothingGeometryActivate = React.useCallback((geometry: THREE.BufferGeometry | null) => {
    activeSmoothingGeometryRef.current = geometry;
  }, []);

  React.useEffect(() => {
    if (mode !== 'prepare' || transformMode !== 'smoothing') return;

    const handlePointerUp = () => {
      endMeshSmoothingStroke();
      if (activeSmoothingGeometryRef.current) {
        endMeshSmoothingEngineStroke(activeSmoothingGeometryRef.current);
        activeSmoothingGeometryRef.current = null;
      }
    };
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [mode, transformMode]);

  React.useEffect(() => {
    if (mode !== 'prepare' || transformMode !== 'smoothing') return;
    if (!containerRef.current) return;

    const el = containerRef.current;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      e.preventDefault();
      // Stop OrbitControls (and any other listeners) from zooming while Ctrl is held.
      // Capture-phase listener ensures we run before the Canvas/OrbitControls wheel handler.
      // @ts-ignore
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      e.stopPropagation();

      const current = getMeshSmoothingSettings().brushSizeMm;
      const direction = e.deltaY > 0 ? -1 : 1;
      const next = current + direction * 0.05;
      updateMeshSmoothingSettings({ brushSizeMm: next });
    };

    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true } as any);
    };
  }, [mode, transformMode, containerRef]);

  return { smoothingBrushState, onSmoothingGeometryActivate };
}
