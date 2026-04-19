"use client";

import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

interface SelectionSpotlightProps {
  /** Ref to the mesh to illuminate */
  meshRef: React.RefObject<THREE.Mesh | null>;
  /** Whether the spotlight is active */
  enabled?: boolean;
  /** Spotlight color */
  color?: string;
  /** Spotlight intensity */
  intensity?: number;
  /** Spotlight angle in radians (overridden dynamically to fit model) */
  angle?: number;
  /** Penumbra (0-1) softness */
  penumbra?: number;
  /** Elevation offset above model center for light positioning */
  elevation?: number;
  /** Horizontal offset from model center (camera-side) for light positioning */
  radius?: number;
  /** If true, show a SpotLightHelper */
  debug?: boolean;
}

/**
 * SelectionSpotlight
 *
 * Illuminates the selected model with a camera-following spotlight.
 *
 * WebGLRenderer does NOT filter lights per-object via layers, so we bound
 * spotlight distance to cover only the selected model and taper out before
 * reaching the build plate (z = 0 plane). The cone is auto-fitted to the
 * model's bounding box with generous margin.
 */
export function SelectionSpotlight({
  meshRef,
  enabled = true,
  color = "#82ccff",
  intensity = 0.9,
  angle = Math.PI / 6,
  penumbra = 0.35,
  elevation = 120,
  radius = 160,
  debug = false,
}: SelectionSpotlightProps) {
  const lightRef = React.useRef<THREE.SpotLight>(null);
  const targetRef = React.useRef<THREE.Object3D>(null);
  const helperRef = React.useRef<THREE.SpotLightHelper | null>(null);
  const hasValidPlacementRef = React.useRef(false);
  const lastMeshIdRef = React.useRef<string | null>(null);
  const lastLightPosRef = React.useRef<THREE.Vector3>(new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN));
  const { invalidate } = useThree();

  React.useEffect(() => {
    hasValidPlacementRef.current = false;
    lastMeshIdRef.current = null;
    const light = lightRef.current;
    if (!light) return;
    light.visible = false;
    light.intensity = 0;
    light.distance = 0;
  }, [enabled]);

  useFrame(() => {
    if (!enabled) return;

    const mesh = meshRef.current;
    const light = lightRef.current;
    const target = targetRef.current;
    if (!mesh || !light || !target) return;

    if (lastMeshIdRef.current !== mesh.uuid) {
      lastMeshIdRef.current = mesh.uuid;
      hasValidPlacementRef.current = false;
      light.visible = false;
      light.intensity = 0;
      light.distance = 0;
    }

    // ---- geometry centre in world space ----
    const geom = mesh.geometry as THREE.BufferGeometry | null;
    if (!geom) return;
    const bbox = geom.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geom.getAttribute('position') as THREE.BufferAttribute,
    );
    const localCenter = bbox.getCenter(new THREE.Vector3());
    const worldCenter = localCenter.clone().applyMatrix4(mesh.matrixWorld);

    const worldBox = bbox.clone().applyMatrix4(mesh.matrixWorld);
    const worldSize = worldBox.getSize(new THREE.Vector3());
    const fitRadius = 0.5 * Math.max(worldSize.x, worldSize.y, worldSize.z);

    // Place the light at a fixed world-space offset above the model center.
    // Position is derived entirely from the model bounding box -- camera movement
    // (orbit, zoom, F-focus) has zero effect on illumination.
    const lightZ = worldCenter.z + Math.max(elevation, fitRadius * 1.2);
    // Slight -Y bias gives a natural top-front key-light look.
    const horizontalOffset = radius > 0 ? radius : fitRadius * 0.3;
    light.position.set(worldCenter.x, worldCenter.y - horizontalOffset, lightZ);
    target.position.copy(worldCenter);
    light.target = target;

    // Auto-fit cone angle to the model from the fixed light position.
    const distToModel = Math.max(1e-3, light.position.distanceTo(worldCenter));
    const halfAngle = Math.atan((fitRadius * 1.2) / distToModel);
    light.angle = THREE.MathUtils.clamp(halfAngle, THREE.MathUtils.degToRad(10), THREE.MathUtils.degToRad(55));
    light.penumbra = THREE.MathUtils.clamp(penumbra, 0.2, 0.6);
    light.distance = distToModel + fitRadius * 1.5;
    light.decay = 0;

    let mutated = false;
    if (!hasValidPlacementRef.current) {
      hasValidPlacementRef.current = true;
      light.visible = true;
      mutated = true;
    }
    if (Math.abs(intensity - light.intensity) > 1e-4) {
      light.intensity = intensity;
      mutated = true;
    }

    if (!lastLightPosRef.current.equals(light.position)) {
      lastLightPosRef.current.copy(light.position);
      mutated = true;
    }

    light.updateMatrixWorld();
    if (mutated) invalidate();

    if (debug) {
      if (!helperRef.current) {
        helperRef.current = new THREE.SpotLightHelper(light);
      } else {
        helperRef.current.update();
      }
    }
  });

  if (!enabled) return null;

  return (
    <>
      <spotLight
        ref={lightRef}
        userData={{ thumbnailCaptureExclude: true, thumbnailCaptureExcludeReason: 'selection-spotlight' }}
        color={color}
        intensity={0}
        angle={angle}
        distance={0}
        position={[0, 0, 0]}
        penumbra={penumbra}
        decay={0}
        visible={false}
        castShadow={false}
      />
      <object3D ref={targetRef} userData={{ thumbnailCaptureExclude: true, thumbnailCaptureExcludeReason: 'selection-spotlight-target' }} />
      {debug && helperRef.current && <primitive object={helperRef.current} />}
    </>
  );
}

export default SelectionSpotlight;
