/**
 * GPU Picking System
 * 
 * Centralized mouse detection system using GPU color picking.
 * Replaces per-component raycasting with a single authoritative "what's under the mouse" answer.
 * 
 * @example
 * // In your Canvas:
 * <Canvas>
 *   <PickingProvider debug>
 *     <YourScene />
 *   </PickingProvider>
 * </Canvas>
 * 
 * // Outside Canvas (for debug overlay):
 * <PickingDebugOverlay position="top-right" />
 * 
 * // In a pickable component:
 * function MySupport({ id }) {
 *   const { isHovered, pickRef } = usePickingSubscription({
 *     category: 'support',
 *     objectId: id,
 *   });
 *   return <group ref={pickRef}>...</group>;
 * }
 */

// Provider and context
export { PickingProvider } from './PickingProvider';
export { PickingContext, usePicking, usePickingHit, EMPTY_PICK_RESULT } from './PickingContext';

// Hooks
export { 
  usePickingSubscription, 
  usePickingHover, 
  usePickingCategory 
} from './hooks/usePickingSubscription';
export { usePickableModel } from './hooks/usePickableModel';

// Debug
export { PickingDebugOverlay } from './PickingDebugOverlay';

// Types
export type {
  PickableCategory,
  GizmoHandleType,
  PickableRegistration,
  PickingHit,
  PickingMiss,
  PickingResult,
  PickingConfig,
  PickingState,
  PickingContextValue,
} from './types';

// Constants (for advanced usage)
export { 
  DEFAULT_PICKING_CONFIG, 
  PICK_ID, 
  GIZMO_PICK_IDS,
  TIMING,
} from './constants';

// Utilities (for advanced usage)
export {
  encodePickId,
  decodePickId,
  createPickingMaterial,
  createPickingMaterialNoDepth,
  isGizmoPickId,
  isDynamicPickId,
} from './pickingUtils';
