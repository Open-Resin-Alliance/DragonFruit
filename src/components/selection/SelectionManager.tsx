/**
 * Selection Manager
 * 
 * Handles selection logic - listens for model clicks and background clicks.
 * Uses custom events instead of GPU picking for better performance.
 */

"use client";

import React, { useEffect } from 'react';
import { useSelection } from './SelectionContext';

interface SelectionManagerProps {
  /** Whether selection is enabled */
  enabled?: boolean;
  /** App mode - selection only works in prepare mode */
  mode?: 'prepare' | 'support';
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
}: SelectionManagerProps) {
  const { select, deselect } = useSelection();
  
  // Track selection locally for immediate updates
  const [hasSelection, setHasSelection] = React.useState(true);

  // Listen for model click events
  useEffect(() => {
    if (!enabled || mode !== 'prepare') return;

    const handleModelClick = (e: CustomEvent<{ modelId: string }>) => {
      const modelId = e.detail.modelId;
      console.log('[SelectionManager] Selecting model:', modelId);
      select(modelId);
      setHasSelection(true);
    };

    window.addEventListener('model-clicked', handleModelClick as EventListener);
    return () => window.removeEventListener('model-clicked', handleModelClick as EventListener);
  }, [enabled, mode, select]);

  // Listen for canvas clicks - toggle selection
  useEffect(() => {
    if (!enabled || mode !== 'prepare') return;

    const handleCanvasClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'CANVAS') {
        // If model-clicked event fired this frame, it was a direct mesh click - already handled
        if (window.__modelClickedThisFrame) {
          window.__modelClickedThisFrame = false;
          return;
        }
        
        // If gizmo drag just ended, don't toggle selection
        if (window.__gizmoDragEndedThisFrame) {
          window.__gizmoDragEndedThisFrame = false;
          return;
        }
        
        // Toggle selection on canvas click
        if (hasSelection) {
          console.log('[SelectionManager] Deselecting (canvas click)');
          deselect();
          setHasSelection(false);
          window.dispatchEvent(new CustomEvent('model-deselected'));
        } else {
          console.log('[SelectionManager] Selecting model (canvas click)');
          select('default-model');
          setHasSelection(true);
          window.dispatchEvent(new CustomEvent('model-clicked', { detail: { modelId: 'default-model' } }));
        }
      }
    };

    document.addEventListener('click', handleCanvasClick);
    return () => document.removeEventListener('click', handleCanvasClick);
  }, [enabled, mode, deselect, select, hasSelection]);

  return null;
}

// Type declarations for global flags
declare global {
  interface Window {
    __modelClickedThisFrame?: boolean;
    __gizmoDragEndedThisFrame?: boolean;
  }
}
