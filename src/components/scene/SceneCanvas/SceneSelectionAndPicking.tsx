"use client";

import React, { useEffect } from 'react';
import { PickingProvider, usePicking } from '@/components/picking';
import { useSelection } from '@/components/selection';
import { subscribe, getSnapshot } from '@/supports/state';
import type { SupportMode } from '@/supports/types';

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

    const handleOrbitStart = () => {
      pauseIfNeeded();
    };

    const handleOrbitChange = () => {
      pauseIfNeeded();
    };
    const handleOrbitEnd = () => {
      resumeTimeoutRef.current = window.setTimeout(() => {
        resumeTimeoutRef.current = null;
        resumeIfNeeded();
      }, 150);
    };

    window.addEventListener('picking-orbit-start', handleOrbitStart);
    window.addEventListener('picking-orbit-change', handleOrbitChange);
    window.addEventListener('picking-orbit-end', handleOrbitEnd);
    window.addEventListener('pointerup', resumeIfNeeded, true);
    window.addEventListener('pointercancel', resumeIfNeeded, true);
    window.addEventListener('blur', resumeIfNeeded);
    return () => {
      window.removeEventListener('picking-orbit-start', handleOrbitStart);
      window.removeEventListener('picking-orbit-change', handleOrbitChange);
      window.removeEventListener('picking-orbit-end', handleOrbitEnd);
      window.removeEventListener('pointerup', resumeIfNeeded, true);
      window.removeEventListener('pointercancel', resumeIfNeeded, true);
      window.removeEventListener('blur', resumeIfNeeded);
      if (resumeTimeoutRef.current !== null) window.clearTimeout(resumeTimeoutRef.current);
      if (orbitFallbackResumeRef.current !== null) window.clearTimeout(orbitFallbackResumeRef.current);
    };
  }, [pause, resume]);

  return null;
}

function PickingModeConfigSync({ mode }: { mode?: SupportMode }) {
  const { setConfig } = usePicking();

  useEffect(() => {
    const nextMode = mode ?? 'prepare';

    if (nextMode === 'support') {
      setConfig({
        includeGizmo: false,
        allowedCategories: ['support', 'joint', 'knot', 'segment', 'raft', 'model'],
      });
      return;
    }

    setConfig({
      includeGizmo: true,
      allowedCategories: ['model', 'gizmo', 'support', 'joint', 'knot', 'segment', 'raft'],
    });
  }, [mode, setConfig]);

  return null;
}

/**
 * Wrapper that always applies PickingProvider, but conditionally enables debug mode.
 */
export function PickingProviderWrapper({ enabled, mode, children }: { enabled?: boolean; mode?: SupportMode; children: React.ReactNode }) {
  // Always render PickingProvider, pass enabled as debug flag
  return <PickingProvider debug={enabled}><PickingOrbitPauser /><PickingModeConfigSync mode={mode} />{children}</PickingProvider>;
}
