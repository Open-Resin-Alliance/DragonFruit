/**
 * GPU Picking System - Constants
 * 
 * Centralized configuration values for the picking system.
 */

import type { PickingConfig } from './types';

/**
 * Default picking configuration.
 */
export const DEFAULT_PICKING_CONFIG: PickingConfig = {
  enabled: true,
  patchSize: 3,           // 3x3 majority vote for stability
  hoverUpdateRate: 30,    // 30 Hz during normal hover
  dragUpdateRate: 60,     // 60 Hz during drags
  allowedCategories: null,
  includeGizmo: true,     // Include gizmo handles when visible
  debug: false,           // Don't show debug overlay by default
};

/**
 * Special pick IDs with reserved meanings.
 */
export const PICK_ID = {
  /** Background / nothing hit */
  NONE: 0,
  /** Reserved range start for model (just one ID needed) */
  MODEL: 1,
  /** Reserved range start for gizmo handles */
  GIZMO_START: 2,
  GIZMO_END: 20,
  /** Dynamic IDs start here (supports, joints, etc.) */
  DYNAMIC_START: 100,
} as const;

/**
 * Gizmo handle pick IDs (within reserved range).
 */
export const GIZMO_PICK_IDS = {
  'move-x': 2,
  'move-y': 3,
  'move-z': 4,
  'move-center': 5,
  'rotate-x': 6,
  'rotate-y': 7,
  'rotate-z': 8,
  'scale-x': 9,
  'scale-y': 10,
  'scale-z': 11,
  'scale-uniform': 12,
} as const;

/**
 * Reverse lookup for gizmo handle types.
 */
export const GIZMO_PICK_ID_TO_HANDLE = Object.fromEntries(
  Object.entries(GIZMO_PICK_IDS).map(([k, v]) => [v, k])
) as Record<number, keyof typeof GIZMO_PICK_IDS>;

/**
 * Timing constants.
 */
export const TIMING = {
  /** Minimum ms between updates during hover */
  MIN_HOVER_INTERVAL_MS: 1000 / 30,  // ~33ms for 30Hz
  /** Minimum ms between updates during drag */
  MIN_DRAG_INTERVAL_MS: 1000 / 60,   // ~16ms for 60Hz
  /** How long to wait before considering pointer idle */
  IDLE_THRESHOLD_MS: 100,
} as const;

/**
 * Render target configuration.
 */
export const RENDER_TARGET = {
  /** Size of the pick buffer (3x3 for majority vote) */
  SIZE: 3,
  /** Format for the render target */
  FORMAT: 'RGBA',
} as const;

/**
 * Colors used in the picking material (for debugging).
 * In actual use, colors are generated from pick IDs.
 */
export const DEBUG_COLORS = {
  BACKGROUND: 0x000000,  // Black = nothing
  MODEL: 0x010000,       // Very dark red = model (ID 1)
} as const;
