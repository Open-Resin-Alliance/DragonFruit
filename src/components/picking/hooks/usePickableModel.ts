/**
 * GPU Picking - Model Registration Hook
 * 
 * Hook for registering a model mesh with the picking system.
 * Returns hover state and a ref to attach to the mesh.
 */

"use client";

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { usePicking } from '../PickingContext';
import type { PickableCategory } from '../types';

interface UsePickableModelOptions {
  /** Model ID for identification */
  modelId?: string | null;
  /** Whether picking is enabled for this model */
  enabled?: boolean;
}

interface UsePickableModelResult {
  /** Ref to attach to the mesh */
  pickRef: React.RefObject<THREE.Mesh | null>;
  /** Callback ref to use for registration */
  setPickRef: (node: THREE.Mesh | null) => void;
  /** Whether this model is currently hovered */
  isHovered: boolean;
  /** The assigned pick ID (for debugging) */
  pickId: number | null;
}

/**
 * usePickableModel - Register a model mesh with the picking system.
 * 
 * @example
 * function MyModel({ modelId }) {
 *   const { pickRef, isHovered } = usePickableModel({ modelId });
 *   
 *   return (
 *     <mesh ref={pickRef}>
 *       <boxGeometry />
 *       <meshStandardMaterial color={isHovered ? 'yellow' : 'gray'} />
 *     </mesh>
 *   );
 * }
 */
export function usePickableModel({
  modelId = null,
  enabled = true,
}: UsePickableModelOptions = {}): UsePickableModelResult {
  const { hit, register, unregister } = usePicking();
  
  const pickRef = useRef<THREE.Mesh | null>(null);
  const pickIdRef = useRef<number | null>(null);
  
  // Store functions in refs to avoid re-running effect when they change identity
  const registerRef = useRef(register);
  const unregisterRef = useRef(unregister);
  registerRef.current = register;
  unregisterRef.current = unregister;
  
  // Track if we've registered to avoid double registration
  const hasRegistered = useRef(false);
  
  // Register with picking system using a callback ref pattern
  // This avoids the effect running multiple times
  const setPickRef = (node: THREE.Mesh | null) => {
    pickRef.current = node;
    
    // Unregister if node is removed
    if (!node) {
      if (pickIdRef.current !== null) {
        unregisterRef.current(pickIdRef.current);
        pickIdRef.current = null;
        hasRegistered.current = false;
      }
      return;
    }
    
    // Register if enabled and not already registered
    if (enabled && !hasRegistered.current) {
      console.log('[usePickableModel] Registering model:', { modelId, mesh: node });
      
      pickIdRef.current = registerRef.current({
        category: 'model',
        objectId: modelId,
        object: node,
      });
      hasRegistered.current = true;
      
      console.log('[usePickableModel] Registered with pickId:', pickIdRef.current);
    }
  };
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pickIdRef.current !== null) {
        unregisterRef.current(pickIdRef.current);
        pickIdRef.current = null;
        hasRegistered.current = false;
      }
    };
  }, []);
  
  // Check if this model is hovered
  const isHovered = enabled && 
    hit.category === 'model' && 
    (modelId ? hit.objectId === modelId : true);
  
  return {
    pickRef: { current: pickRef.current } as React.RefObject<THREE.Mesh | null>,
    setPickRef,
    isHovered,
    pickId: pickIdRef.current,
  };
}
