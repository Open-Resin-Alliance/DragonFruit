/**
 * Model Management System
 * 
 * Manages multiple models on the build plate with selection support.
 */

// Types
export type { ModelId, ModelInstance, ModelTransform, ModelStoreState } from './types';

// Store
export {
  subscribeToModelStore,
  getModelList,
  getSelectedModelIds,
  getPrimarySelectedId,
  addModel,
  removeModel,
  selectModel,
  toggleModelSelection,
  clearSelection,
  updateModelTransform,
  updateModel,
  getModel,
  getSelectedModels,
  getPrimarySelectedModel,
  isModelSelected,
  getModelCount,
} from './modelStore';

// Hooks
export { useModelSelection } from './hooks/useModelSelection';
