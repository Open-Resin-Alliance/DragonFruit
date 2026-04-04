/**
 * GPU Picking System - Subscription Hook
 * 
 * Hook for components to subscribe to picking results and register themselves.
 */

"use client";

import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { usePicking } from '../PickingContext';
import type { PickableCategory, PickingResult, GizmoHandleType } from '../types';

interface UsePickingSubscriptionOptions {
  /** Category of this pickable object */
  category: PickableCategory;
  /** Application-level ID (e.g., support UUID) */
  objectId?: string | null;
  /** Parent ID for hierarchical objects */
  parentId?: string | null;
  /** Gizmo handle type (only for gizmo category) */
  gizmoHandle?: GizmoHandleType;
  /** Whether this object should be registered for picking */
  enabled?: boolean;
  /** Callback when this object is hovered */
  onHover?: () => void;
  /** Callback when hover leaves this object */
  onHoverEnd?: () => void;
  /** Callback when this object is clicked */
  onClick?: () => void;
}

interface UsePickingSubscriptionResult {
  /** Whether this object is currently being hovered */
  isHovered: boolean;
  /** The pick ID assigned to this object (for debugging) */
  pickId: number | null;
  /** Ref to attach to the Three.js object for picking */
  pickRef: React.RefObject<THREE.Object3D | null>;
}

/**
 * usePickingSubscription - Subscribe a component to the picking system.
 * 
 * This hook:
 * 1. Registers the object with the picking system
 * 2. Tracks whether the object is currently hovered
 * 3. Calls hover/click callbacks when appropriate
 * 
 * @example
 * function MySupport({ supportId }) {
 *   const { isHovered, pickRef } = usePickingSubscription({
 *     category: 'support',
 *     objectId: supportId,
 *     onHover: () => console.log('Hovered!'),
 *     onHoverEnd: () => console.log('Hover ended'),
 *   });
 *   
 *   return (
 *     <group ref={pickRef}>
 *       <mesh>...</mesh>
 *     </group>
 *   );
 * }
 */
export function usePickingSubscription({
  category,
  objectId = null,
  parentId = null,
  gizmoHandle,
  enabled = true,
  onHover,
  onHoverEnd,
  onClick,
}: UsePickingSubscriptionOptions): UsePickingSubscriptionResult {
  const { hit, register, unregister, isDragging } = usePicking();
  
  // Ref to the Three.js object
  const pickRef = useRef<THREE.Object3D | null>(null);
  
  // Track the assigned pick ID
  const pickIdRef = useRef<number | null>(null);
  
  // Track previous hover state for change detection
  const wasHoveredRef = useRef<boolean>(false);
  
  // Register on mount, unregister on unmount
  useEffect(() => {
    if (!enabled) {
      // If disabled, unregister if we were registered
      if (pickIdRef.current !== null) {
        unregister(pickIdRef.current);
        pickIdRef.current = null;
      }
      return;
    }
    
    // Wait for the ref to be attached
    if (!pickRef.current) {
      // Try again on next frame
      const timeout = setTimeout(() => {
        if (pickRef.current && pickIdRef.current === null) {
          pickIdRef.current = register({
            category,
            objectId,
            parentId,
            gizmoHandle,
            object: pickRef.current,
          });
        }
      }, 0);
      return () => clearTimeout(timeout);
    }
    
    // Register immediately
    pickIdRef.current = register({
      category,
      objectId,
      parentId,
      gizmoHandle,
      object: pickRef.current,
    });
    
    return () => {
      if (pickIdRef.current !== null) {
        unregister(pickIdRef.current);
        pickIdRef.current = null;
      }
    };
  }, [enabled, category, objectId, parentId, gizmoHandle, register, unregister]);
  
  // Check if this object is currently hovered
  const isHovered = enabled && !isDragging && pickIdRef.current !== null && hit.pickId === pickIdRef.current;
  
  // Handle hover state changes
  useEffect(() => {
    if (!enabled) return;
    
    const wasHovered = wasHoveredRef.current;
    
    if (isHovered && !wasHovered) {
      // Just started hovering
      onHover?.();
    } else if (!isHovered && wasHovered) {
      // Just stopped hovering
      onHoverEnd?.();
    }
    
    wasHoveredRef.current = isHovered;
  }, [isHovered, enabled, onHover, onHoverEnd]);
  
  return {
    isHovered,
    pickId: pickIdRef.current,
    pickRef,
  };
}

/**
 * usePickingHover - Simplified hook that just tracks hover state.
 * Use this when you don't need to register a new pickable, just react to picks.
 * 
 * @param objectId - The object ID to watch for
 * @param category - Optional category filter
 */
export function usePickingHover(
  objectId: string | null,
  category?: PickableCategory
): boolean {
  const { hit } = usePicking();
  
  if (!objectId) return false;
  if (category && hit.category !== category) return false;
  
  return hit.objectId === objectId;
}

/**
 * usePickingCategory - Watch for any pick in a category.
 * 
 * @param category - Category to watch
 * @returns The current hit if it matches the category, null otherwise
 */
export function usePickingCategory(category: PickableCategory): PickingResult | null {
  const { hit } = usePicking();
  
  if (hit.category === category) {
    return hit;
  }
  
  return null;
}
