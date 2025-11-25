/**
 * Model Selection Hook
 * 
 * Hook for components to interact with model selection via GPU picking.
 */

"use client";

import { useEffect, useCallback } from 'react';
import { usePicking } from '@/components/picking';
import { 
  selectModel, 
  clearSelection, 
  toggleModelSelection,
  getPrimarySelectedId,
  isModelSelected 
} from '../modelStore';
import type { ModelId } from '../types';

interface UseModelSelectionOptions {
  /** Whether selection is enabled */
  enabled?: boolean;
  /** Callback when selection changes */
  onSelectionChange?: (selectedId: ModelId | null) => void;
}

interface UseModelSelectionResult {
  /** Handle a click - selects/deselects based on what was clicked */
  handleClick: () => void;
  /** Whether a model is currently being hovered */
  isHoveringModel: boolean;
  /** The ID of the model being hovered (if any) */
  hoveredModelId: ModelId | null;
}

/**
 * useModelSelection - Handle model selection via GPU picking.
 * 
 * Listens to picking hits and provides click handling for selection.
 */
export function useModelSelection({
  enabled = true,
  onSelectionChange,
}: UseModelSelectionOptions = {}): UseModelSelectionResult {
  const { hit } = usePicking();
  
  // Check if we're hovering a model
  const isHoveringModel = enabled && hit.category === 'model';
  const hoveredModelId = isHoveringModel && hit.objectId ? hit.objectId : null;
  
  /**
   * Handle click - select or deselect based on what's under cursor.
   */
  const handleClick = useCallback(() => {
    if (!enabled) return;
    
    if (hit.category === 'model') {
      // Clicked on a model
      const modelId = hit.objectId;
      if (modelId) {
        selectModel(modelId);
        onSelectionChange?.(modelId);
      } else {
        // Model without ID (legacy single model) - select it
        // For now, we'll need the model to register with an ID
        console.log('[ModelSelection] Clicked model without ID');
      }
    } else if (hit.category === 'none') {
      // Clicked on background - deselect
      clearSelection();
      onSelectionChange?.(null);
    }
    // If clicked on gizmo, support, etc. - don't change model selection
  }, [enabled, hit, onSelectionChange]);
  
  return {
    handleClick,
    isHoveringModel,
    hoveredModelId,
  };
}
