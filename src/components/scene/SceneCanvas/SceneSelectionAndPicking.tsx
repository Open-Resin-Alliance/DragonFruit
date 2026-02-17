"use client";

import React, { useEffect } from 'react';
import { PickingProvider } from '@/components/picking';
import { useSelection } from '@/components/selection';
import { subscribe, getSnapshot } from '@/supports/state';

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
 * Wrapper that always applies PickingProvider, but conditionally enables debug mode.
 */
export function PickingProviderWrapper({ enabled, children }: { enabled?: boolean; children: React.ReactNode }) {
  // Always render PickingProvider, pass enabled as debug flag
  return <PickingProvider debug={enabled}>{children}</PickingProvider>;
}
