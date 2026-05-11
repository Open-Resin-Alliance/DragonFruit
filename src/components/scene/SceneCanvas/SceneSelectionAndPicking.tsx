"use client";

import React, { useEffect } from 'react';
import { PickingProvider, usePicking } from '@/components/picking';
import { useSelection } from '@/components/selection';
import { subscribe, getSnapshot } from '@/supports/state';
import type { SupportMode } from '@/supports/types';
import type { TransformMode } from '@/hooks/useModelTransform';

export function SelectionSync({ activeModelId }: { activeModelId: string | null }) {
  const { select, deselect, state } = useSelection();

  useEffect(() => {
    if (activeModelId && state.selectedModelId !== activeModelId) {
      select(activeModelId);
    } else if (!activeModelId && state.selectedModelId !== null) {
      deselect();
    }
  }, [activeModelId, select, deselect, state.selectedModelId]);

  return null;
}

export function useInteractionWarning() {
  const [warning, setWarning] = React.useState(getSnapshot().interactionWarning);
  React.useEffect(() => {
    return subscribe(() => {
      const w = getSnapshot().interactionWarning;
      setWarning(w);
    });
  }, []);
  return warning;
}

/**
 * Pauses GPU picking while the camera is orbiting — picking results are meaningless during rotation.
 * Must be rendered inside PickingProvider.
 */
export function PickingOrbitPauser() {
  const { pause, resume } = usePicking();
  const resumeTimeoutRef = React.useRef<number | null>(null);
  const orbitFallbackResumeRef = React.useRef<number | null>(null);
  const isPausedRef = React.useRef(false);
  const lastRequestedResumeDelayRef = React.useRef(220);

  type SupportGizmoWindowState = Window & {
    __jointGizmoDragging?: boolean;
    __knotGizmoDragging?: boolean;
    __bezierGizmoDragging?: boolean;
    __jointGizmoGuardUntil?: number;
    __knotGizmoGuardUntil?: number;
    __bezierGizmoGuardUntil?: number;
  };

  useEffect(() => {
    const pauseIfNeeded = () => {
      if (resumeTimeoutRef.current !== null) {
        window.clearTimeout(resumeTimeoutRef.current);
        resumeTimeoutRef.current = null;
      }
      if (orbitFallbackResumeRef.current !== null) {
        window.clearTimeout(orbitFallbackResumeRef.current);
      }
      orbitFallbackResumeRef.current = window.setTimeout(() => {
        orbitFallbackResumeRef.current = null;
        if (!isPausedRef.current) return;
        isPausedRef.current = false;
        resume();
      }, 420);
      if (!isPausedRef.current) {
        isPausedRef.current = true;
        pause();
      }
    };

    const resumeIfNeeded = () => {
      if (resumeTimeoutRef.current !== null) {
        window.clearTimeout(resumeTimeoutRef.current);
        resumeTimeoutRef.current = null;
      }
      if (orbitFallbackResumeRef.current !== null) {
        window.clearTimeout(orbitFallbackResumeRef.current);
        orbitFallbackResumeRef.current = null;
      }
      if (!isPausedRef.current) return;
      isPausedRef.current = false;
      resume();
    };

    const scheduleResume = (delayMs?: number) => {
      const delay = Math.max(0, Number(delayMs ?? lastRequestedResumeDelayRef.current ?? 220));
      lastRequestedResumeDelayRef.current = delay;

      if (resumeTimeoutRef.current !== null) {
        window.clearTimeout(resumeTimeoutRef.current);
        resumeTimeoutRef.current = null;
      }

      resumeTimeoutRef.current = window.setTimeout(() => {
        resumeTimeoutRef.current = null;
        resumeIfNeeded();
      }, delay);
    };

    const scheduleResumeFromGuard = (guardUntil?: number) => {
      const guard = Number(guardUntil ?? 0);
      const delay = Math.max(0, guard - Date.now());
      scheduleResume(delay);
    };

    const refreshFromSupportGizmoGlobals = () => {
      const w = window as SupportGizmoWindowState;
      const dragging = !!(w.__jointGizmoDragging || w.__knotGizmoDragging || w.__bezierGizmoDragging);
      if (dragging) {
        pauseIfNeeded();
        return;
      }

      const guardUntil = Math.max(
        Number(w.__jointGizmoGuardUntil ?? 0),
        Number(w.__knotGizmoGuardUntil ?? 0),
        Number(w.__bezierGizmoGuardUntil ?? 0),
      );
      scheduleResumeFromGuard(guardUntil);
    };

    const handleOrbitStart = () => {
      pauseIfNeeded();
    };

    const handleOrbitChange = () => {
      pauseIfNeeded();
    };
    const handleOrbitEnd = (event: Event) => {
      const delay = (event as CustomEvent<{ resumeAfterMs?: number }>).detail?.resumeAfterMs;
      scheduleResume(delay);
    };

    const handlePanStart = () => {
      pauseIfNeeded();
    };

    const handlePanChange = () => {
      pauseIfNeeded();
    };

    const handlePanEnd = (event: Event) => {
      const delay = (event as CustomEvent<{ resumeAfterMs?: number }>).detail?.resumeAfterMs;
      scheduleResume(delay);
    };

    const handleZoomStart = () => {
      pauseIfNeeded();
    };

    const handleZoomChange = () => {
      pauseIfNeeded();
    };

    const handleZoomEnd = (event: Event) => {
      const delay = (event as CustomEvent<{ resumeAfterMs?: number }>).detail?.resumeAfterMs;
      scheduleResume(delay);
    };

    const handlePointerReleaseFallback = () => {
      scheduleResume();
    };

    const handleJointGizmoInteractionLock = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; guardUntil?: number }>).detail;
      if (detail?.active) {
        pauseIfNeeded();
        return;
      }
      scheduleResumeFromGuard(detail?.guardUntil);
    };

    const handleKnotGizmoInteractionLock = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; guardUntil?: number }>).detail;
      if (detail?.active) {
        pauseIfNeeded();
        return;
      }
      scheduleResumeFromGuard(detail?.guardUntil);
    };

    const handleBezierGizmoInteractionLock = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; guardUntil?: number }>).detail;
      if (detail?.active) {
        pauseIfNeeded();
        return;
      }
      scheduleResumeFromGuard(detail?.guardUntil);
    };

    refreshFromSupportGizmoGlobals();

    window.addEventListener('picking-orbit-start', handleOrbitStart);
    window.addEventListener('picking-orbit-change', handleOrbitChange);
    window.addEventListener('picking-orbit-end', handleOrbitEnd);
    window.addEventListener('picking-pan-start', handlePanStart);
    window.addEventListener('picking-pan-change', handlePanChange);
    window.addEventListener('picking-pan-end', handlePanEnd);
    window.addEventListener('picking-zoom-start', handleZoomStart);
    window.addEventListener('picking-zoom-change', handleZoomChange);
    window.addEventListener('picking-zoom-end', handleZoomEnd);
    window.addEventListener('joint-gizmo-interaction-lock', handleJointGizmoInteractionLock as EventListener);
    window.addEventListener('knot-gizmo-interaction-lock', handleKnotGizmoInteractionLock as EventListener);
    window.addEventListener('bezier-gizmo-interaction-lock', handleBezierGizmoInteractionLock as EventListener);
    window.addEventListener('pointerup', handlePointerReleaseFallback, true);
    window.addEventListener('pointercancel', handlePointerReleaseFallback, true);
    window.addEventListener('blur', resumeIfNeeded);
    return () => {
      window.removeEventListener('picking-orbit-start', handleOrbitStart);
      window.removeEventListener('picking-orbit-change', handleOrbitChange);
      window.removeEventListener('picking-orbit-end', handleOrbitEnd);
      window.removeEventListener('picking-pan-start', handlePanStart);
      window.removeEventListener('picking-pan-change', handlePanChange);
      window.removeEventListener('picking-pan-end', handlePanEnd);
      window.removeEventListener('picking-zoom-start', handleZoomStart);
      window.removeEventListener('picking-zoom-change', handleZoomChange);
      window.removeEventListener('picking-zoom-end', handleZoomEnd);
      window.removeEventListener('joint-gizmo-interaction-lock', handleJointGizmoInteractionLock as EventListener);
      window.removeEventListener('knot-gizmo-interaction-lock', handleKnotGizmoInteractionLock as EventListener);
      window.removeEventListener('bezier-gizmo-interaction-lock', handleBezierGizmoInteractionLock as EventListener);
      window.removeEventListener('pointerup', handlePointerReleaseFallback, true);
      window.removeEventListener('pointercancel', handlePointerReleaseFallback, true);
      window.removeEventListener('blur', resumeIfNeeded);
      if (resumeTimeoutRef.current !== null) window.clearTimeout(resumeTimeoutRef.current);
      if (orbitFallbackResumeRef.current !== null) window.clearTimeout(orbitFallbackResumeRef.current);
    };
  }, [pause, resume]);

  return null;
}

function PickingModeConfigSync({
  mode,
  transformMode,
  interactionEnabled,
}: {
  mode?: SupportMode;
  transformMode?: TransformMode;
  interactionEnabled?: boolean;
}) {
  const { setConfig } = usePicking();

  useEffect(() => {
    if (!interactionEnabled) {
      setConfig({
        enabled: false,
        includeGizmo: false,
        allowedCategories: null,
      });
      return;
    }

    const nextMode = mode ?? 'prepare';

    if (nextMode === 'support') {
      setConfig({
        enabled: true,
        includeGizmo: false,
        allowedCategories: ['support', 'joint', 'knot', 'segment', 'raft', 'model'],
      });
      return;
    }

    if (nextMode === 'prepare' && transformMode === 'transform') {
      // In prepare/modify mode, prioritize transform responsiveness and avoid
      // traversing dense support registrations every hover sample.
      setConfig({
        enabled: true,
        includeGizmo: true,
        allowedCategories: ['model', 'gizmo'],
      });
      return;
    }

    setConfig({
      enabled: true,
      includeGizmo: true,
      allowedCategories: ['model', 'gizmo', 'support', 'joint', 'knot', 'segment', 'raft'],
    });
  }, [interactionEnabled, mode, setConfig, transformMode]);

  return null;
}

/**
 * Wrapper that always applies PickingProvider, but conditionally enables debug mode.
 */
export function PickingProviderWrapper({
  enabled,
  mode,
  transformMode,
  interactionEnabled = true,
  children,
}: {
  enabled?: boolean;
  mode?: SupportMode;
  transformMode?: TransformMode;
  interactionEnabled?: boolean;
  children: React.ReactNode;
}) {
  // Always render PickingProvider, pass enabled as debug flag
  return (
    <PickingProvider debug={enabled}>
      {interactionEnabled && <PickingOrbitPauser />}
      <PickingModeConfigSync mode={mode} transformMode={transformMode} interactionEnabled={interactionEnabled} />
      {children}
    </PickingProvider>
  );
}
