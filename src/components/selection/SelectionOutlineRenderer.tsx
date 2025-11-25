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
  /** Outline color */
  color?: string;
  /** Outline thickness in world units */
  thickness?: number;
}

/**
 * SelectionOutlineRenderer - Renders outline for selected model.
 * Listens to selection events for reactive updates.
 */
export function SelectionOutlineRenderer({
  meshRef,
  enabled = true,
  color = '#00ff00',
  thickness = 0.3,
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
      thickness={thickness}
    />
  );
}
