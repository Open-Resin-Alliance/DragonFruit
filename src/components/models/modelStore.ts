/**
 * Model Management - Store
 * 
 * Centralized store for managing multiple models on the build plate.
 * Uses the same subscription pattern as the support store.
 */

import * as THREE from 'three';
import type { ModelId, ModelInstance, ModelStoreState, ModelTransform } from './types';

// ---------------------------------------------------------------------------
// Store State
// ---------------------------------------------------------------------------

const state: ModelStoreState = {
  models: new Map(),
  selectedIds: new Set(),
  primarySelectedId: null,
};

// ---------------------------------------------------------------------------
// ID Generation (same pattern as supports)
// ---------------------------------------------------------------------------

let nextId = 1;

function generateModelId(): ModelId {
  return `model-${nextId++}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

/**
 * Subscribe to store changes.
 */
export function subscribeToModelStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Selectors (for useSyncExternalStore)
// ---------------------------------------------------------------------------

let cachedModelList: ModelInstance[] = [];
let cachedModelListVersion = -1;
let currentVersion = 0;

export function getModelList(): ModelInstance[] {
  if (cachedModelListVersion !== currentVersion) {
    cachedModelList = Array.from(state.models.values());
    cachedModelListVersion = currentVersion;
  }
  return cachedModelList;
}

export function getSelectedModelIds(): ModelId[] {
  return Array.from(state.selectedIds);
}

export function getPrimarySelectedId(): ModelId | null {
  return state.primarySelectedId;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Add a new model to the build plate.
 */
export function addModel(
  geometry: THREE.BufferGeometry,
  name: string,
  bbox: THREE.Box3,
  center: THREE.Vector3,
  size: THREE.Vector3
): ModelId {
  const id = generateModelId();
  
  const model: ModelInstance = {
    id,
    name,
    geometry,
    bbox,
    center,
    size,
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0, 'XYZ'),
      scale: new THREE.Vector3(1, 1, 1),
    },
    isSelected: true,
    color: '#a3a3a3',
    visible: true,
    addedAt: Date.now(),
  };
  
  state.models.set(id, model);
  
  // Select the new model (deselect others)
  state.selectedIds.clear();
  state.selectedIds.add(id);
  state.primarySelectedId = id;
  
  for (const [modelId, m] of state.models) {
    m.isSelected = state.selectedIds.has(modelId);
  }
  
  currentVersion++;
  notifyListeners();
  
  console.log('[ModelStore] Added model:', { id, name });
  return id;
}

/**
 * Remove a model from the build plate.
 */
export function removeModel(id: ModelId): void {
  if (!state.models.has(id)) return;
  
  state.models.delete(id);
  state.selectedIds.delete(id);
  
  if (state.primarySelectedId === id) {
    state.primarySelectedId = state.selectedIds.size > 0 
      ? Array.from(state.selectedIds)[0] 
      : null;
  }
  
  currentVersion++;
  notifyListeners();
  
  console.log('[ModelStore] Removed model:', id);
}

/**
 * Select a single model (clears other selections).
 */
export function selectModel(id: ModelId | null): void {
  state.selectedIds.clear();
  
  if (id !== null && state.models.has(id)) {
    state.selectedIds.add(id);
    state.primarySelectedId = id;
  } else {
    state.primarySelectedId = null;
  }
  
  for (const [modelId, model] of state.models) {
    model.isSelected = state.selectedIds.has(modelId);
  }
  
  currentVersion++;
  notifyListeners();
  
  console.log('[ModelStore] Selected model:', id);
}

/**
 * Toggle a model's selection state.
 */
export function toggleModelSelection(id: ModelId): void {
  if (!state.models.has(id)) return;
  
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
    if (state.primarySelectedId === id) {
      state.primarySelectedId = state.selectedIds.size > 0 
        ? Array.from(state.selectedIds)[0] 
        : null;
    }
  } else {
    state.selectedIds.add(id);
    state.primarySelectedId = id;
  }
  
  const model = state.models.get(id);
  if (model) {
    model.isSelected = state.selectedIds.has(id);
  }
  
  currentVersion++;
  notifyListeners();
}

/**
 * Clear all selections.
 */
export function clearSelection(): void {
  for (const model of state.models.values()) {
    model.isSelected = false;
  }
  
  state.selectedIds.clear();
  state.primarySelectedId = null;
  
  currentVersion++;
  notifyListeners();
  
  console.log('[ModelStore] Cleared selection');
}

/**
 * Update a model's transform.
 */
export function updateModelTransform(id: ModelId, updates: Partial<ModelTransform>): void {
  const model = state.models.get(id);
  if (!model) return;
  
  if (updates.position) {
    model.transform.position = updates.position.clone();
  }
  if (updates.rotation) {
    model.transform.rotation = updates.rotation.clone();
  }
  if (updates.scale) {
    model.transform.scale = updates.scale.clone();
  }
  
  currentVersion++;
  notifyListeners();
}

/**
 * Update model properties.
 */
export function updateModel(id: ModelId, updates: Partial<Omit<ModelInstance, 'id' | 'geometry'>>): void {
  const model = state.models.get(id);
  if (!model) return;
  
  Object.assign(model, updates);
  
  currentVersion++;
  notifyListeners();
}

/**
 * Get a model by ID.
 */
export function getModel(id: ModelId): ModelInstance | undefined {
  return state.models.get(id);
}

/**
 * Get selected models.
 */
export function getSelectedModels(): ModelInstance[] {
  return Array.from(state.selectedIds)
    .map(id => state.models.get(id))
    .filter((m): m is ModelInstance => m !== undefined);
}

/**
 * Get the primary selected model.
 */
export function getPrimarySelectedModel(): ModelInstance | null {
  if (!state.primarySelectedId) return null;
  return state.models.get(state.primarySelectedId) ?? null;
}

/**
 * Check if a model is selected.
 */
export function isModelSelected(id: ModelId): boolean {
  return state.selectedIds.has(id);
}

/**
 * Get model count.
 */
export function getModelCount(): number {
  return state.models.size;
}
