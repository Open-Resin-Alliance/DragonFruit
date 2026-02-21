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
  const isPausedRef = React.useRef(false);

  useEffect(() => {
    const handleOrbitChange = () => {
      if (resumeTimeoutRef.current !== null) {
        window.clearTimeout(resumeTimeoutRef.current);
        resumeTimeoutRef.current = null;
      }
      if (!isPausedRef.current) {
        isPausedRef.current = true;
        pause();
      }
    };
    const handleOrbitEnd = () => {
      resumeTimeoutRef.current = window.setTimeout(() => {
        isPausedRef.current = false;
        resumeTimeoutRef.current = null;
        resume();
      }, 150);
    };

    window.addEventListener('picking-orbit-change', handleOrbitChange);
    window.addEventListener('picking-orbit-end', handleOrbitEnd);
    return () => {
      window.removeEventListener('picking-orbit-change', handleOrbitChange);
      window.removeEventListener('picking-orbit-end', handleOrbitEnd);
      if (resumeTimeoutRef.current !== null) window.clearTimeout(resumeTimeoutRef.current);
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
      allowedCategories: ['model', 'gizmo'],
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
