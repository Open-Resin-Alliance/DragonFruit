/**
 * Selection Outline Effect
 * 
 * Renders an outline using the same geometry with GPU-based vertex displacement.
 * No geometry cloning - displacement happens in the vertex shader.
 */

"use client";

import React from 'react';
import * as THREE from 'three';

// Vertex shader that pushes vertices outward along normals (GPU-side, no cloning)
const outlineVertexShader = `
  uniform float thickness;
  
  void main() {
    vec3 newPosition = position + normal * thickness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

// Fragment shader for solid outline color
const outlineFragmentShader = `
  uniform vec3 outlineColor;
  
  void main() {
    gl_FragColor = vec4(outlineColor, 1.0);
  }
`;

interface SelectionOutlineProps {
  /** Refs to meshes that should be outlined */
  selectedMeshes: React.RefObject<THREE.Mesh | null>[];
  /** Whether outline is enabled */
  enabled?: boolean;
  /** Outline color */
  color?: string;
  /** Outline thickness in world units */
  thickness?: number;
}

/**
 * SelectionOutline - Renders outline by extruding along normals.
 */
export function SelectionOutline({
  selectedMeshes,
  enabled = true,
  color = '#aaaaaa',
  thickness = 0.5,
}: SelectionOutlineProps) {
  const validMeshes = selectedMeshes
    .map(ref => ref.current)
    .filter((mesh): mesh is THREE.Mesh => mesh !== null);

  if (!enabled || validMeshes.length === 0) {
    return null;
  }

  return (
    <>
      {validMeshes.map((mesh, index) => (
        <OutlineMesh 
          key={index} 
          sourceMesh={mesh} 
          color={color} 
          thickness={thickness} 
        />
      ))}
    </>
  );
}

/**
 * OutlineMesh - Renders outline for a single mesh using normal extrusion
 */
function OutlineMesh({ 
  sourceMesh, 
  color, 
  thickness 
}: { 
  sourceMesh: THREE.Mesh; 
  color: string; 
  thickness: number;
}) {
  const outlineRef = React.useRef<THREE.Mesh>(null);
  
  // Create shader material - displacement happens on GPU, no geometry cloning
  // depthTest: true ensures outline is hidden behind the model (silhouette only)
  const outlineMaterial = React.useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        thickness: { value: thickness },
        outlineColor: { value: new THREE.Color(color) },
      },
      vertexShader: outlineVertexShader,
      fragmentShader: outlineFragmentShader,
      side: THREE.BackSide,
      toneMapped: false,
      depthTest: true,
      depthWrite: true,
    });
  }, [color, thickness]);

  // Sync transform with source mesh
  React.useEffect(() => {
    if (!outlineRef.current || !sourceMesh) return;
    
    // Set initial position immediately to avoid flicker
    sourceMesh.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    sourceMesh.matrixWorld.decompose(position, quaternion, scale);
    outlineRef.current.position.copy(position);
    outlineRef.current.quaternion.copy(quaternion);
    outlineRef.current.scale.copy(scale);
    
    let animationId: number;
    
    const updateTransform = () => {
      if (outlineRef.current && sourceMesh) {
        sourceMesh.updateWorldMatrix(true, false);
        sourceMesh.matrixWorld.decompose(position, quaternion, scale);
        
        outlineRef.current.position.copy(position);
        outlineRef.current.quaternion.copy(quaternion);
        outlineRef.current.scale.copy(scale);
      }
      animationId = requestAnimationFrame(updateTransform);
    };
    
    animationId = requestAnimationFrame(updateTransform);
    return () => cancelAnimationFrame(animationId);
  }, [sourceMesh]);

  if (!sourceMesh.geometry) return null;

  // Use the SAME geometry reference - no cloning, displacement is in shader
  return (
    <mesh
      ref={outlineRef}
      geometry={sourceMesh.geometry}
      material={outlineMaterial}
    />
  );
}
