/**
 * Selection Fresnel Rim Effect
 * 
 * Renders a glowing rim effect on mesh edges using Fresnel shading.
 * The glow is strongest at glancing angles (silhouette edges from camera view).
 */

"use client";

import React from 'react';
import * as THREE from 'three';

// Vertex shader - passes view direction and normal to fragment shader
const fresnelVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fragment shader - Fresnel rim glow effect with smoothing and thresholding
const fresnelFragmentShader = `
  uniform vec3 glowColor;
  uniform float intensity;
  uniform float power;
  uniform float rimMin;   // smoothstep lower bound
  uniform float rimMax;   // smoothstep upper bound
  uniform float alphaCut; // discard threshold
  
  varying vec3 vNormal;
  varying vec3 vViewDir;
  
  void main() {
    // Fresnel factor: 1 at edges (perpendicular to view), 0 facing camera
    float f = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
    f = pow(f, power);
    // Smooth the ramp to reduce speckling
    float rim = smoothstep(rimMin, rimMax, f);
    float alpha = rim * intensity;
    // Remove tiny values that cause stippling
    if (alpha < alphaCut) discard;
    gl_FragColor = vec4(glowColor, alpha);
  }
`;

interface SelectionOutlineProps {
  /** Refs to meshes that should be outlined */
  selectedMeshes: React.RefObject<THREE.Mesh | null>[];
  /** Whether outline is enabled */
  enabled?: boolean;
  /** Glow color */
  color?: string;
  /** Glow intensity (0-1) */
  intensity?: number;
  /** Fresnel power - higher = tighter edge glow */
  power?: number;
  /** Rim smoothing range: lower/upper bounds for smoothstep (0-1) */
  rimMin?: number;
  rimMax?: number;
  /** Alpha discard threshold to remove speckles */
  alphaCut?: number;
}

/**
 * SelectionOutline - Renders Fresnel rim glow on selected meshes.
 */
export function SelectionOutline({
  selectedMeshes,
  enabled = true,
  color = '#00ff00',
  intensity = 1.0,
  power = 2.0,
  rimMin = 0.15,
  rimMax = 0.6,
  alphaCut = 0.02,
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
        <FresnelGlowMesh 
          key={index} 
          sourceMesh={mesh} 
          color={color} 
          intensity={intensity}
          power={power}
          rimMin={rimMin}
          rimMax={rimMax}
          alphaCut={alphaCut}
        />
      ))}
    </>
  );
}

/**
 * FresnelGlowMesh - Renders Fresnel rim glow for a single mesh
 */
function FresnelGlowMesh({ 
  sourceMesh, 
  color, 
  intensity,
  power,
  rimMin,
  rimMax,
  alphaCut,
}: { 
  sourceMesh: THREE.Mesh; 
  color: string; 
  intensity: number;
  power: number;
  rimMin: number;
  rimMax: number;
  alphaCut: number;
}) {
  const glowRef = React.useRef<THREE.Mesh>(null);
  
  // Create Fresnel shader material
  const glowMaterial = React.useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(color) },
        intensity: { value: intensity },
        power: { value: power },
        rimMin: { value: rimMin },
        rimMax: { value: rimMax },
        alphaCut: { value: alphaCut },
      },
      vertexShader: fresnelVertexShader,
      fragmentShader: fresnelFragmentShader,
      side: THREE.FrontSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });
  }, [color, intensity, power, rimMin, rimMax, alphaCut]);

  // Sync transform with source mesh
  React.useEffect(() => {
    if (!glowRef.current || !sourceMesh) return;
    
    // Set initial position immediately
    sourceMesh.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    sourceMesh.matrixWorld.decompose(position, quaternion, scale);
    glowRef.current.position.copy(position);
    glowRef.current.quaternion.copy(quaternion);
    glowRef.current.scale.copy(scale);
    
    let animationId: number;
    
    const updateTransform = () => {
      if (glowRef.current && sourceMesh) {
        sourceMesh.updateWorldMatrix(true, false);
        sourceMesh.matrixWorld.decompose(position, quaternion, scale);
        
        glowRef.current.position.copy(position);
        glowRef.current.quaternion.copy(quaternion);
        glowRef.current.scale.copy(scale);
      }
      animationId = requestAnimationFrame(updateTransform);
    };
    
    animationId = requestAnimationFrame(updateTransform);
    return () => cancelAnimationFrame(animationId);
  }, [sourceMesh]);

  if (!sourceMesh.geometry) return null;

  return (
    <mesh
      ref={glowRef}
      userData={{ thumbnailCaptureExclude: true, thumbnailCaptureExcludeReason: 'selection-outline' }}
      geometry={sourceMesh.geometry}
      material={glowMaterial}
    />
  );
}
