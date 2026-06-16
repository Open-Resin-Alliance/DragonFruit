/**
 * Selection Outline Renderer
 * 
 * Renders the selection outline for a mesh.
 * Subscribes to selection state for reactive updates.
 */

"use client";

import React from 'react';
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
  /** Rim max */
  rimMax?: number;
  /** Alpha discard threshold */
  alphaCut?: number;
}

/**
 * SelectionOutlineRenderer - Renders outline for selected model.
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
  if (!enabled) {
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
