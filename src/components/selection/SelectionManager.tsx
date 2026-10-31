/**
 * Selection Manager
 * 
 * Handles selection logic - listens for model clicks and background clicks.
 * Uses custom events instead of GPU picking for better performance.
 */

"use client";

import { useEffect } from 'react';
import { useSelection } from './SelectionContext';
import type { SupportMode } from '@/supports/types';

interface SelectionManagerProps {
  /** Whether selection is enabled */
  enabled?: boolean;
  /** App mode - selection only works in prepare mode */
  mode?: SupportMode;
  /** Whether SelectionManager should handle background canvas deselect itself */
  handleCanvasDeselect?: boolean;
}

/**
 * SelectionManager - Handles model selection/deselection.
 * 
 * Listens for:
 * - 'model-clicked' custom event (dispatched by mesh onClick)
 * - Canvas background clicks (deselect)
 */
export function SelectionManager({
  enabled = true,
  mode = 'prepare',
  handleCanvasDeselect = true,
}: SelectionManagerProps) {
  const { select, deselect, state } = useSelection();

  // Listen for model click events
  useEffect(() => {
    if (!enabled || mode !== 'prepare') return;

    const handleModelClick = (e: CustomEvent<{ modelId: string }>) => {
      const modelId = e.detail.modelId;
      select(modelId);
    };

    window.addEventListener('model-clicked', handleModelClick as EventListener);
    return () => window.removeEventListener('model-clicked', handleModelClick as EventListener);
  }, [enabled, mode, select]);

  // Listen for canvas clicks - toggle selection
  useEffect(() => {
    if (!enabled || mode !== 'prepare' || !handleCanvasDeselect) return;

    const handleCanvasClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'CANVAS') {
        // A direct model click already handled this gesture. The one-frame flag
        // can expire before the browser dispatches the follow-up click (the
        // selection is applied on pointer-down), so the short guard window is
        // the reliable answer; without it a click on the model's supports
        // deselected the model again and the tint flickered.
        if (
          window.__modelClickedThisFrame
          || performance.now() < (window.__modelClickGuardUntil ?? 0)
        ) {
          return;
        }

        // If gizmo drag just ended, don't toggle selection
        if (window.__gizmoDragEndedThisFrame) {
          window.__gizmoDragEndedThisFrame = false;
          return;
        }

        // Canvas click only deselects - clicking model is required to select
        // Check global state directly to avoid stale closure issues
        if (state.hasSelection) {
          deselect();
          window.dispatchEvent(new CustomEvent('model-deselected'));
        }
      }
    };

    document.addEventListener('click', handleCanvasClick);
    return () => document.removeEventListener('click', handleCanvasClick);
  }, [enabled, mode, handleCanvasDeselect, deselect, select, state.hasSelection]);

  return null;
}

// Type declarations for global flags
declare global {
  interface Window {
    __modelClickedThisFrame?: boolean;
    __modelClickGuardUntil?: number;
    __gizmoDragEndedThisFrame?: boolean;
  }
}
