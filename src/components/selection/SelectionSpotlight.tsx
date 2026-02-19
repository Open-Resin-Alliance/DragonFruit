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
  const boostRef = React.useRef<THREE.PointLight>(null);
  const targetRef = React.useRef<THREE.Object3D>(null);
  const helperRef = React.useRef<THREE.SpotLightHelper | null>(null);
  const { camera } = useThree();

  useFrame(() => {
    if (!enabled) return;

    const mesh = meshRef.current;
    const light = lightRef.current;
    const boost = boostRef.current;
    const target = targetRef.current;
    if (!mesh || !light || !boost || !target) return;

    // ---- geometry centre in world space ----
    const geom = mesh.geometry as THREE.BufferGeometry | null;
    if (!geom) return;
    const bbox = geom.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geom.getAttribute('position') as THREE.BufferAttribute,
    );
    const localCenter = bbox.getCenter(new THREE.Vector3());
    const worldCenter = localCenter.clone().applyMatrix4(mesh.matrixWorld);

    // ---- target ----
    target.position.copy(worldCenter);

    // ---- light position (camera-side, elevated) ----
    const dir = new THREE.Vector3().subVectors(worldCenter, camera.position).normalize();
    const lightPos = worldCenter.clone()
      .addScaledVector(dir.clone().negate(), radius)
      .add(new THREE.Vector3(0, 0, elevation));

    light.position.copy(lightPos);
    boost.position.copy(lightPos);
    light.target = target as any;

    // ---- cone angle fitted to model bounding box ----
    const worldBox = bbox.clone().applyMatrix4(mesh.matrixWorld);
    const worldSize = worldBox.getSize(new THREE.Vector3());
    const fitRadius = 0.5 * Math.max(worldSize.x, worldSize.y, worldSize.z);
    const distToModel = lightPos.distanceTo(worldCenter);
    const minHalfAngle = THREE.MathUtils.degToRad(5);
    const maxHalfAngle = THREE.MathUtils.degToRad(65);
    const halfAngle = Math.atan(fitRadius / Math.max(distToModel, 1e-3));
    light.angle = THREE.MathUtils.clamp(halfAngle * 1.15, minHalfAngle, maxHalfAngle);
    light.penumbra = THREE.MathUtils.clamp(penumbra, 0.2, 0.6);

    // ---- bounded distance: keep model lit, limit floor spill ----
    // Floor plane at z = 0.  Compute distance from light to the point on the
    // floor directly beneath the model centre.
    const floorBeneath = new THREE.Vector3(worldCenter.x, worldCenter.y, 0);
    const distToFloor = lightPos.distanceTo(floorBeneath);

    // Ensure we always light the model centre and most silhouette extents.
    const minReach = distToModel + Math.min(fitRadius * 0.35, 8);
    const desiredCoverage = distToModel + fitRadius * 1.2;

    // Keep distance short enough that illumination dies off before floor haloing.
    const floorSafe = Math.max(distToModel * 1.03, distToFloor * 0.82);

    light.distance = Math.max(minReach, Math.min(desiredCoverage, floorSafe));
    light.decay = 0;

    // Small omni boost to make spotlight mode perceptibly brighter even under
    // high ambient/hemisphere lighting. Kept bounded to the same reach.
    boost.distance = light.distance;
    boost.decay = 0;

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
        intensity={intensity}
        angle={angle}
        distance={220}
        penumbra={penumbra}
        decay={0}
        castShadow={false}
      />
      <pointLight
        ref={boostRef}
        color={color}
        intensity={intensity * 0.65}
        distance={220}
        decay={0}
      />
      <object3D ref={targetRef} />
      {debug && helperRef.current && <primitive object={helperRef.current} />}
    </>
  );
}

export default SelectionSpotlight;
