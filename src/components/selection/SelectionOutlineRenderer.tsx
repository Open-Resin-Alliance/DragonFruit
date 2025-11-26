/**
 * Selection Outline Renderer
 * 
 * Renders the selection outline for a mesh.
 * Subscribes to selection state for reactive updates.
 */

"use client";

import React, { useState, useEffect } from 'react';
import * as THREE from 'three';
import { SelectionOutline } from './SelectionOutline';

interface SelectionOutlineRendererProps {
  /** Ref to the mesh to outline */
  meshRef: React.RefObject<THREE.Mesh | null>;
  /** Whether outline is enabled */
  enabled?: boolean;
  /** Glow color */
  color?: string;
  /** Fresnel glow intensity (0-1) */
  intensity?: number;
  /** Fresnel power - higher = tighter edge glow */
  power?: number;
  /** Rim smoothing range */
  rimMin?: number;
  rimMax?: number;
  /** Alpha discard threshold */
  alphaCut?: number;
}

/**
 * SelectionOutlineRenderer - Renders outline for selected model.
 * Listens to selection events for reactive updates.
 */
export function SelectionOutlineRenderer({
  meshRef,
  enabled = true,
  color = '#00ff00',
  intensity = 1.0,
  power = 2.0,
  rimMin,
  rimMax,
  alphaCut,
}: SelectionOutlineRendererProps) {
  const [isSelected, setIsSelected] = useState(true); // Start selected
  
  // Listen for selection changes
  useEffect(() => {
    const handleModelClicked = () => {
      setIsSelected(true);
    };
    
    const handleDeselect = () => {
      setIsSelected(false);
    };
    
    window.addEventListener('model-clicked', handleModelClicked);
    window.addEventListener('model-deselected', handleDeselect);
    
    return () => {
      window.removeEventListener('model-clicked', handleModelClicked);
      window.removeEventListener('model-deselected', handleDeselect);
    };
  }, []);

  if (!enabled || !isSelected || !meshRef.current) {
    return null;
  }

  return (
    <SelectionOutline
      selectedMeshes={[meshRef]}
      enabled={true}
      color={color}
      intensity={intensity}
      power={power}
      rimMin={rimMin}
      rimMax={rimMax}
      alphaCut={alphaCut}
    />
  );
}
