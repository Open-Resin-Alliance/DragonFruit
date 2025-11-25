/**
 * Model Management - Type Definitions
 * 
 * Types for managing multiple models on the build plate.
 */

import * as THREE from 'three';

/**
 * Unique identifier for a model instance.
 */
export type ModelId = string;

/**
 * Transform state for a model.
 */
export interface ModelTransform {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
}

/**
 * A model instance on the build plate.
 */
export interface ModelInstance {
  /** Unique identifier */
  id: ModelId;
  /** Display name (usually filename) */
  name: string;
  /** The loaded geometry */
  geometry: THREE.BufferGeometry;
  /** Bounding box in local space */
  bbox: THREE.Box3;
  /** Center point in local space */
  center: THREE.Vector3;
  /** Size in local space */
  size: THREE.Vector3;
  /** Current transform */
  transform: ModelTransform;
  /** Whether this model is currently selected */
  isSelected: boolean;
  /** Color/material settings */
  color: string;
  /** Visibility */
  visible: boolean;
  /** Timestamp when added */
  addedAt: number;
}

/**
 * State for the model store.
 */
export interface ModelStoreState {
  /** All models on the build plate */
  models: Map<ModelId, ModelInstance>;
  /** Currently selected model IDs (supports multi-select in future) */
  selectedIds: Set<ModelId>;
  /** The "primary" selected model (for gizmo, etc.) */
  primarySelectedId: ModelId | null;
}
