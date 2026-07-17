import type { ModelMeshModifiers } from './types';

// Mesh modifiers (which can carry very large payloads, e.g. hollowing
// sourcePositionsBase64 from LYS imports) are kept in this module-level Map
// instead of on model objects. This prevents React's state reconciliation
// from churning on large payloads during selection, copy, paste, and
// duplicate operations.
//
// IMPORTANT for anything that persists or exports models: model objects in
// React state carry `meshModifiers: undefined` by design. Any code that
// serializes models (VOXL save, autosave, scene export) or applies modifiers
// at output time (slicing) must resolve modifiers through this store — use
// `resolveModelMeshModifiers` — or it will silently persist nothing. That
// exact omission shipped in the June 2026 externalization refactor and made
// every VOXL saved afterward lose hollowing/hole-punch re-editability.
const meshModifierStoreRef: { current: Map<string, ModelMeshModifiers> } = {
  current: new Map(),
};

export function storeModelMeshModifiers(
  modelId: string,
  modifiers: ModelMeshModifiers | undefined | null,
): void {
  if (modifiers) {
    meshModifierStoreRef.current.set(modelId, modifiers);
  } else {
    meshModifierStoreRef.current.delete(modelId);
  }
}

export function getStoredMeshModifiers(modelId: string): ModelMeshModifiers | undefined {
  return meshModifierStoreRef.current.get(modelId);
}

export function deleteStoredMeshModifiers(modelId: string): void {
  meshModifierStoreRef.current.delete(modelId);
}

/**
 * Resolves a model's mesh modifiers, preferring any copy still attached to
 * the model object (pre-externalization data, tests) and falling back to
 * the external store. Every save/export/slice boundary must use this
 * instead of reading `model.meshModifiers` directly.
 */
export function resolveModelMeshModifiers(model: {
  id: string;
  meshModifiers?: ModelMeshModifiers;
}): ModelMeshModifiers | undefined {
  return model.meshModifiers ?? getStoredMeshModifiers(model.id);
}
