"use client";

import React from 'react';

import {
  finishSupportBlockerStroke,
} from '@/supports/autoSupport/supportBlockers';
import {
  SUPPORT_BLOCKER_STROKE,
} from '@/supports/history/actionTypes';
import { pushSupportHistory } from '@/supports/history/supportHistory';

/**
 * Scene bindings for support-blocker painting: finishes the active stroke
 * on pointer release anywhere (releasing off-mesh must not strand the
 * stroke or the orbit gate) and records one history entry per stroke.
 * Mirrors the smoothing window-pointerup binding.
 */
export function useSupportBlockerSceneBindings({
  mode,
  transformMode,
}: {
  mode?: string;
  transformMode?: string;
}) {
  const finishWithHistory = React.useCallback(() => {
    const diff = finishSupportBlockerStroke();
    if (diff) {
      pushSupportHistory({ type: SUPPORT_BLOCKER_STROKE, payload: diff });
    }
  }, []);

  React.useEffect(() => {
    if ((mode !== 'prepare' && mode !== 'support') || transformMode !== 'supportBlockers') return;
    const handlePointerUp = () => {
      finishWithHistory();
    };
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      // Leaving the mode mid-stroke still records what was painted.
      finishWithHistory();
    };
  }, [mode, transformMode, finishWithHistory]);
}
