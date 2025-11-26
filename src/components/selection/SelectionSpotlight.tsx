"use client";

import React from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';

interface SelectionSpotlightProps {
  /** Ref to the mesh to illuminate */
  meshRef: React.RefObject<THREE.Mesh | null>;
  /** Whether the spotlight is active */
  enabled?: boolean;
  /** Spotlight color */
  color?: string;
  /** Spotlight intensity */
  intensity?: number;
  /** Spotlight angle in radians */
  angle?: number;
  /** Distance falloff (0 = no limit) */
  distance?: number;
  /** Penumbra (0-1) softness */
  penumbra?: number;
  /** Elevation and radius for auto positioning around the model */
  elevation?: number;
  radius?: number;
  /** If true, ignore layers and light everything (debug) */
  affectAll?: boolean;
  /** If true, show a SpotLightHelper */
  debug?: boolean;
}

/**
 * SelectionSpotlight
 * - A spotlight that only affects the selected mesh using THREE.Layers.
 * - We place the light on layer 1 and temporarily enable layer 1 on the mesh (and children).
 * - Camera remains on default layer 0, so rendering is unaffected; lighting still applies.
 */
export function SelectionSpotlight({
  meshRef,
  enabled = true,
  color = "#82ccff",
  intensity = 0.9,
  angle = Math.PI / 6,
  distance = 0,
  penumbra = 0.35,
  elevation = 120,
  radius = 160,
  affectAll = false,
  debug = false,
}: SelectionSpotlightProps) {
  const lightRef = React.useRef<THREE.SpotLight>(null);
  const targetRef = React.useRef<THREE.Object3D>(null);
  const restoredRefs = React.useRef<{ object: THREE.Object3D; hadLayer1: boolean }[]>([]);
  const helperRef = React.useRef<THREE.SpotLightHelper | null>(null);
  const layer1 = React.useMemo(() => {
    const l = new THREE.Layers();
    l.set(1);
    return l;
  }, []);
  const { camera } = useThree();

  // Attach/detach layer 1 to the mesh and its children while enabled
  // Use useFrame to ensure layers are set correctly each frame when enabled
  const layersSetupRef = React.useRef(false);
  
  React.useEffect(() => {
    // Reset setup flag when enabled changes
    layersSetupRef.current = false;
    
    if (!enabled) {
      // Restore previous layer 1 state when disabled
      if (!affectAll) {
        restoredRefs.current.forEach(({ object, hadLayer1 }) => {
          if (!hadLayer1) object.layers.disable(1);
        });
      }
      restoredRefs.current = [];
    }
  }, [enabled, affectAll]);
  
  // Update light position/orientation every frame to follow mesh in world space
  // Also setup layers once per enable cycle
  useFrame(() => {
    if (!enabled) return;
    
    const mesh = meshRef.current;
    const light = lightRef.current;
    const target = targetRef.current;
    if (!mesh || !light || !target) return;
    
    // Only setup layers once per enable cycle
    if (!layersSetupRef.current) {
      layersSetupRef.current = true;
      
      // Enable layer 1 on mesh and descendants
      restoredRefs.current = [];
      if (!affectAll) {
        mesh.traverse((obj) => {
          const had = obj.layers.test(layer1);
          if (!had) obj.layers.enable(1);
          restoredRefs.current.push({ object: obj, hadLayer1: had });
        });
      }
      
      // Ensure light only affects layer 1
      light.layers.set(affectAll ? 0 : 1);
    }

    // Compute geometry center in local space
    const geom = mesh.geometry as THREE.BufferGeometry | null;
    if (!geom) return;
    const bbox = geom.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geom.getAttribute('position') as THREE.BufferAttribute
    );
    const localCenter = bbox.getCenter(new THREE.Vector3());

    // Convert to world space using mesh.matrixWorld
    const worldCenter = localCenter.clone().applyMatrix4(mesh.matrixWorld);

    // Point target at world center
    target.position.copy(worldCenter);

    // Derive light position from camera direction
    const dir = new THREE.Vector3().subVectors(worldCenter, camera.position).normalize();
    // Place light opposite the view direction so it shines from camera side toward the model
    const lightPos = worldCenter.clone()
      .addScaledVector(dir.clone().negate(), radius)
      .add(new THREE.Vector3(0, 0, elevation));

    light.position.copy(lightPos);
    light.target = target as any;
    
    // Compute world-space bounding box and adapt cone angle to fit the model
    const worldBox = bbox.clone().applyMatrix4(mesh.matrixWorld);
    const worldSize = worldBox.getSize(new THREE.Vector3());
    const fitRadius = 0.5 * Math.max(worldSize.x, worldSize.y, worldSize.z);
    const dist = lightPos.distanceTo(worldCenter);
    const minHalfAngle = THREE.MathUtils.degToRad(5);
    const maxHalfAngle = THREE.MathUtils.degToRad(65);
    const halfAngle = Math.atan(fitRadius / Math.max(dist, 1e-3));
    light.angle = THREE.MathUtils.clamp(halfAngle * 1.15, minHalfAngle, maxHalfAngle);
    light.penumbra = Math.min(0.6, Math.max(0.2, light.penumbra));
    
    light.updateMatrixWorld();
    // Debug helper update
    if (debug) {
      if (!helperRef.current) {
        helperRef.current = new THREE.SpotLightHelper(light);
      } else {
        helperRef.current.update();
      }
    }
  });

  if (!enabled || !meshRef.current) return null;

  return (
    <>
      <spotLight
        ref={lightRef}
        color={color}
        intensity={intensity}
        angle={angle}
        distance={distance}
        penumbra={penumbra}
        decay={0}
        castShadow={false}
      />
      {/* Dedicated target for clean orientation */}
      <object3D ref={targetRef} />
      {debug && helperRef.current && <primitive object={helperRef.current} />}
    </>
  );
}

export default SelectionSpotlight;
