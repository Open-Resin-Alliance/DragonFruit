/**
 * Selection System - Type Definitions
 */

import * as THREE from 'three';

/**
 * Selectable object types
 */
export type SelectableType = 'model' | 'support' | 'joint';

/**
 * Selection state
 */
export interface SelectionState {
  /** Currently selected model ID */
  selectedModelId: string | null;
  /** Whether any model is selected */
  hasSelection: boolean;
}

/**
 * Selection context value
 */
export interface SelectionContextValue {
  /** Current selection state */
  state: SelectionState;
  /** Select a model by ID */
  select: (modelId: string) => void;
  /** Deselect current selection */
  deselect: () => void;
  /** Toggle selection */
  toggle: (modelId: string) => void;
  /** Check if a specific model is selected */
  isSelected: (modelId: string) => boolean;
}
