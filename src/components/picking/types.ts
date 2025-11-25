/**
 * GPU Picking System - Type Definitions
 * 
 * Defines all types for the centralized picking system that replaces
 * per-component raycasting with a single authoritative "what's under the mouse" answer.
 */

import * as THREE from 'three';

/**
 * Categories of pickable objects in the scene.
 * Used to filter what participates in picking and to identify hit types.
 */
export type PickableCategory = 
  | 'model'      // The main STL mesh
  | 'support'    // Support structures (trunks, branches, leaves)
  | 'joint'      // Ball joints on supports
  | 'raft'       // Raft/base structures
  | 'gizmo'      // Transform gizmo handles (only when visible)
  | 'none';      // Background / nothing hit

/**
 * Gizmo handle types for fine-grained identification.
 */
export type GizmoHandleType = 
  | 'move-x' | 'move-y' | 'move-z' | 'move-center'
  | 'rotate-x' | 'rotate-y' | 'rotate-z'
  | 'scale-x' | 'scale-y' | 'scale-z' | 'scale-uniform';

/**
 * Registration info for a pickable object.
 * Each pickable registers itself with the picking system.
 */
export interface PickableRegistration {
  /** Unique numeric ID (encoded into RGB) */
  pickId: number;
  /** Category for filtering and identification */
  category: PickableCategory;
  /** Application-level ID (e.g., support UUID, joint ID) */
  objectId: string | null;
  /** Parent ID for hierarchical objects (e.g., joint's parent support) */
  parentId?: string | null;
  /** For gizmo handles, which specific handle */
  gizmoHandle?: GizmoHandleType;
  /** Reference to the Three.js object (for fallback raycasting) */
  object?: THREE.Object3D;
}

/**
 * Result of a picking query - what's under the mouse.
 */
export interface PickingHit {
  /** The numeric pick ID that was detected */
  pickId: number;
  /** Category of the hit object */
  category: PickableCategory;
  /** Application-level ID */
  objectId: string | null;
  /** Parent ID if applicable */
  parentId?: string | null;
  /** Gizmo handle type if applicable */
  gizmoHandle?: GizmoHandleType;
  /** Screen position where the pick occurred */
  screenPosition: { x: number; y: number };
  /** Timestamp of the pick */
  timestamp: number;
}

/**
 * Null hit - nothing under the mouse.
 */
export interface PickingMiss {
  pickId: 0;
  category: 'none';
  objectId: null;
  screenPosition: { x: number; y: number };
  timestamp: number;
}

/**
 * Union type for any picking result.
 */
export type PickingResult = PickingHit | PickingMiss;

/**
 * Configuration for the picking system.
 */
export interface PickingConfig {
  /** Whether GPU picking is enabled (vs fallback to raycasting) */
  enabled: boolean;
  /** Patch size for sampling (1 = single pixel, 3 = 3x3 majority vote) */
  patchSize: 1 | 3;
  /** Update rate in Hz during normal hover */
  hoverUpdateRate: number;
  /** Update rate in Hz during drag operations */
  dragUpdateRate: number;
  /** Whether to include gizmo handles in picking */
  includeGizmo: boolean;
  /** Debug mode - renders pick buffer to screen */
  debug: boolean;
}

/**
 * State of the picking system.
 */
export interface PickingState {
  /** Current picking result */
  currentHit: PickingResult;
  /** Previous picking result (for change detection) */
  previousHit: PickingResult | null;
  /** Whether the system is currently active */
  isActive: boolean;
  /** Whether a drag operation is in progress */
  isDragging: boolean;
  /** Last update timestamp */
  lastUpdateTime: number;
}

/**
 * Context value provided by PickingProvider.
 */
export interface PickingContextValue {
  /** Current picking result - the single source of truth */
  hit: PickingResult;
  /** Register a pickable object */
  register: (registration: Omit<PickableRegistration, 'pickId'>) => number;
  /** Unregister a pickable object */
  unregister: (pickId: number) => void;
  /** Update configuration */
  setConfig: (config: Partial<PickingConfig>) => void;
  /** Current configuration */
  config: PickingConfig;
  /** Notify system that a drag started (increases update rate) */
  onDragStart: () => void;
  /** Notify system that a drag ended */
  onDragEnd: () => void;
  /** Temporarily disable picking (e.g., during heavy operations) */
  pause: () => void;
  /** Re-enable picking */
  resume: () => void;
  /** Whether picking is currently paused */
  isPaused: boolean;
}
