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
 * Illuminates the selected model with a camera-tracking spotlight.
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
  const { camera } = useThree();

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

    // Camera-mounted spotlight: source follows camera position,
    // direction follows camera forward vector.
    const camForward = new THREE.Vector3();
    camera.getWorldDirection(camForward);
    const targetDistance = Math.max(120, Math.min(420, worldCenter.distanceTo(camera.position) + fitRadius));
    const targetPoint = camera.position.clone().addScaledVector(camForward.normalize(), targetDistance);

    light.position.copy(camera.position);
    target.position.copy(targetPoint);
    light.target = target as any;

    // Keep cone wide enough for selected model, but stable.
    const distToModel = Math.max(1e-3, worldCenter.distanceTo(camera.position));
    const halfAngle = Math.atan((fitRadius * 1.2) / distToModel);
    light.angle = THREE.MathUtils.clamp(halfAngle, THREE.MathUtils.degToRad(10), THREE.MathUtils.degToRad(55));
    light.penumbra = THREE.MathUtils.clamp(penumbra, 0.2, 0.6);

    // ---- bounded distance: keep model lit, limit floor spill ----
    // Floor plane at z = 0.  Compute distance from light to the point on the
    // floor directly beneath the model centre.
    const floorBeneath = new THREE.Vector3(worldCenter.x, worldCenter.y, 0);
    const distToFloor = camera.position.distanceTo(floorBeneath);

    // Ensure we always light model center + silhouette, but keep reach tight.
    const minReach = distToModel + Math.min(fitRadius * 0.25, 5);
    const desiredCoverage = distToModel + fitRadius * 0.95;

    // Keep distance short so floor illumination is strongly suppressed.
    const floorSafe = Math.max(distToModel * 1.015, distToFloor * 0.78);

    light.distance = Math.max(minReach, Math.min(desiredCoverage, floorSafe));
    light.decay = 0;

    if (!hasValidPlacementRef.current) {
      hasValidPlacementRef.current = true;
      light.visible = true;
    }
    light.intensity = intensity;

    light.updateMatrixWorld();

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
        color={color}
        intensity={0}
        angle={angle}
        distance={0}
        position={[camera.position.x, camera.position.y, camera.position.z]}
        penumbra={penumbra}
        decay={0}
        visible={false}
        castShadow={false}
      />
      <object3D ref={targetRef} />
      {debug && helperRef.current && <primitive object={helperRef.current} />}
    </>
  );
}

export default SelectionSpotlight;
