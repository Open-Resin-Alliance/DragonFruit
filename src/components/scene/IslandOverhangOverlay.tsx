import React, { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { getSceneClipPlanes } from '@/features/slicing/sceneClipStore';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { steepFlatNeedsCoverage } from '@/supports/autoSupport/poseStability';

/**
 * Renders overhang regions as translucent surface highlights — the actual
 * region triangles from the model geometry, not flat decal discs.
 *
 * Mounted inside the model's local frame (same context as StlMesh), so the
 * geometry is the raw model geometry and the group carries the same centering
 * offset the rest of the scene uses (negated bbox center). No transform math
 * of our own: the model matrix positions the highlight with the model.
 */

export const OVERHANG_OVERLAY_RENDER_ORDER = 995;
export const OVERHANG_POLYGON_OFFSET = { factor: -1, units: -2 } as const;

const OVERHANG_COLOR = '#ffa500';
const STEEP_FLAT_COLOR = '#ffd28a';
const OVERHANG_OPACITY = 0.4;
/** ...and what a patch gets when the pose needs no topple coverage: visible
 *  enough to read the classification, quiet enough not to promise support. */
const MUTED_OPACITY = 0.12;

/** Formation overhangs keep a flat colour: they print on their own mechanism
 *  (unsupported material formation) distinct from steep-flat anchoring. */
export function formationOverhangColor(): THREE.Color {
  return new THREE.Color(OVERHANG_COLOR);
}

/** Uniform colour for steep self-supporting flat patches (`StressForceHeatmapMaterial`
 *  carries the spatial peel/stress field separately). */
export function steepFlatOverlayColor(): THREE.Color {
  return new THREE.Color(STEEP_FLAT_COLOR);
}

interface IslandOverhangOverlayProps {
  /** Raw model geometry (local frame, may be indexed or non-indexed). */
  geometry: THREE.BufferGeometry;
  /** Overhang islands for this model (source 'overhang', with triangleIds). */
  regions: DetectedIsland[];
  /** False when the pose needs no anti-topple contact. The steep-flat patches
   *  are then muted rather than drawn as if they were about to be covered:
   *  showing everything that was classified reads as "this will be supported",
   *  and it is not. */
  toppleCoverage?: boolean;
  /** Deprecated geometric drag moment prop kept optional for caller compatibility. */
  dragTotalMm3?: number;
  /** Cross-section planes: the overlay must disappear with the solid it marks. */
}

export function IslandOverhangOverlay({
  geometry,
  regions,
  toppleCoverage = true,
}: IslandOverhangOverlayProps) {
  const centerOffset = useMemo(() => {
    if (!geometry) return new THREE.Vector3();
    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute
    );
    return bbox.getCenter(new THREE.Vector3());
  }, [geometry]);

  const built = useMemo(() => {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return { meshes: [], toppleGeometry: null as THREE.BufferGeometry | null, mutedGeometry: null as THREE.BufferGeometry | null };
    const index = geometry.index;
    const meshes: Array<{ id: string; geometry: THREE.BufferGeometry; color: THREE.Color }> = [];

    // Combine steep-flat patches into covered vs muted geometries with uniform
    // color so symmetrical greedy patches render symmetrically across seams.
    const topplePositions: number[] = [];
    const mutedPositions: number[] = [];
    const copyRegion = (region: DetectedIsland): Float32Array => {
      const ids = region.triangleIds as number[];
      const arr = new Float32Array(ids.length * 9);
      let o = 0;
      for (const ti of ids) {
        const i0 = index ? index.getX(ti * 3) : ti * 3;
        const i1 = index ? index.getX(ti * 3 + 1) : ti * 3 + 1;
        const i2 = index ? index.getX(ti * 3 + 2) : ti * 3 + 2;
        arr[o++] = pos.getX(i0);
        arr[o++] = pos.getY(i0);
        arr[o++] = pos.getZ(i0);
        arr[o++] = pos.getX(i1);
        arr[o++] = pos.getY(i1);
        arr[o++] = pos.getZ(i1);
        arr[o++] = pos.getX(i2);
        arr[o++] = pos.getY(i2);
        arr[o++] = pos.getZ(i2);
      }
      return arr;
    };

    for (const region of regions) {
      const ids = region.triangleIds;
      if (!ids || ids.length === 0) continue;

      if (region.steepFlat) {
        const arr = copyRegion(region);
        const covered = steepFlatNeedsCoverage(region.surfaceAreaMm2, toppleCoverage);
        const into = covered ? topplePositions : mutedPositions;
        for (let i = 0; i < arr.length; i++) into.push(arr[i]);
        continue;
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(copyRegion(region), 3));
      g.computeVertexNormals();
      meshes.push({ id: region.id, geometry: g, color: formationOverhangColor() });
    }

    const buildFlat = (positions: number[]): THREE.BufferGeometry | null => {
      if (positions.length === 0) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.computeVertexNormals();
      return g;
    };
    const mutedGeometry = buildFlat(mutedPositions);
    const toppleGeometry = buildFlat(topplePositions);
    return { meshes, toppleGeometry, mutedGeometry };
  }, [geometry, regions, toppleCoverage]);

  const toppleMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: steepFlatOverlayColor(),
    transparent: true,
    opacity: OVERHANG_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
    polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
  }), []);

  const mutedMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: steepFlatOverlayColor(),
    transparent: true,
    opacity: MUTED_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
    polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
  }), []);

  const formationMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: formationOverhangColor(),
    transparent: true,
    opacity: OVERHANG_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
    polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
  }), []);

  // The scene's shared planes: stable identity and length, so a scrub moves
  // their constants without recompiling these materials.
  const clippingPlanes = getSceneClipPlanes();

  useEffect(() => {
    for (const material of [toppleMaterial, formationMaterial, mutedMaterial]) {
      material.clippingPlanes = clippingPlanes;
      material.needsUpdate = true;
    }
  }, [clippingPlanes, toppleMaterial, formationMaterial, mutedMaterial]);

  useEffect(() => {
    return () => {
      for (const b of built.meshes) b.geometry.dispose();
      built.toppleGeometry?.dispose();
      built.mutedGeometry?.dispose();
    };
  }, [built]);

  useEffect(
    () => () => {
      toppleMaterial.dispose();
      formationMaterial.dispose();
      mutedMaterial.dispose();
    },
    [toppleMaterial, formationMaterial, mutedMaterial],
  );

  if (built.meshes.length === 0 && !built.toppleGeometry && !built.mutedGeometry) return null;

  return (
    <group
      position={[-centerOffset.x, -centerOffset.y, -centerOffset.z]}
      // The overhang scan is an overlay on the model, not part of its solid.
      // Feeding it to the cross-section stencil painted the cap over the
      // cut-away region wherever an overhang was scanned.
      userData={{ noStencil: true }}
    >
      {built.meshes.map((b) => (
        <mesh key={b.id} geometry={b.geometry} renderOrder={OVERHANG_OVERLAY_RENDER_ORDER} raycast={() => null}>
          <primitive object={formationMaterial} attach="material" />
        </mesh>
      ))}
      {built.toppleGeometry && (
        <mesh geometry={built.toppleGeometry} renderOrder={OVERHANG_OVERLAY_RENDER_ORDER} raycast={() => null}>
          <primitive object={toppleMaterial} attach="material" />
        </mesh>
      )}
      {built.mutedGeometry && (
        <mesh geometry={built.mutedGeometry} renderOrder={OVERHANG_OVERLAY_RENDER_ORDER} raycast={() => null}>
          <primitive object={mutedMaterial} attach="material" />
        </mesh>
      )}
    </group>
  );
}
