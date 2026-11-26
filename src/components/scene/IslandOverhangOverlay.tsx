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
/** A topple patch carrying little of the pose's drag moment: light amber. */
const TOPPLE_COOL = new THREE.Color('#ffd28a');
/** ...and the patch carrying the most: saturated orange-red. */
const TOPPLE_HOT = new THREE.Color('#ff3d00');

/** Formation overhangs keep a flat colour: they print on their own mechanism
 *  (unsupported material formation) distinct from steep-flat anchoring. */
export function formationOverhangColor(): THREE.Color {
  return new THREE.Color(OVERHANG_COLOR);
}

/** Uniform colour for steep self-supporting flat patches. */
export function steepFlatOverlayColor(): THREE.Color {
  return new THREE.Color(STEEP_FLAT_COLOR);
}

/**
 * Per-vertex topple weight: the average of the load shares carried by the faces
 * meeting at that vertex. Painting whole regions leaves boundaries as a
 * staircase on a coarse mesh; shared vertex weights blend across them.
 */
export function toppleVertexWeights(
  positions: ArrayLike<number>,
  faceShare: ArrayLike<number>,
): Float32Array {
  const triCount = Math.floor(positions.length / 9);
  const sums = new Map<string, { sum: number; count: number }>();
  const keys: string[] = new Array(triCount * 3);
  const keyAt = (i: number): string => vertexKey(positions[i], positions[i + 1], positions[i + 2]);
  for (let t = 0; t < triCount; t++) {
    const share = faceShare[t] ?? 0;
    for (let c = 0; c < 3; c++) {
      const v = t * 3 + c;
      const key = keyAt(v * 3);
      keys[v] = key;
      const acc = sums.get(key);
      if (acc) {
        acc.sum += share;
        acc.count += 1;
      } else {
        sums.set(key, { sum: share, count: 1 });
      }
    }
  }
  const out = new Float32Array(triCount * 3);
  for (let v = 0; v < triCount * 3; v++) {
    const acc = sums.get(keys[v]);
    out[v] = acc && acc.count > 0 ? acc.sum / acc.count : 0;
  }
  return out;
}

/** Quantized position key. Shared by the weight field and the boundary test. */
export function vertexKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
}

/** Shader injection for the topple ramp; the flat formation material skips it. */
function applyOverhangShader(material: THREE.MeshBasicMaterial, ramped: boolean): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${ramped ? 'attribute float aWeight;\nvarying float vWeight;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${ramped ? 'vWeight = aWeight;' : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${ramped ? 'varying float vWeight;\nuniform vec3 uCool;\nuniform vec3 uHot;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `${ramped ? 'diffuseColor.rgb = mix( uCool, uHot, clamp( vWeight, 0.0, 1.0 ) );' : ''}`,
      );
    if (ramped) {
      shader.uniforms.uCool = { value: TOPPLE_COOL };
      shader.uniforms.uHot = { value: TOPPLE_HOT };
    }
  };
  material.customProgramCacheKey = () => (ramped ? 'overhang-topple-ramp' : 'overhang-fade');
}

interface IslandOverhangOverlayProps {
  /** Raw model geometry (local frame, may be indexed or non-indexed). */
  geometry: THREE.BufferGeometry;
  /** Overhang islands for this model (source 'overhang', with triangleIds). */
  regions: DetectedIsland[];
  /** False when the pose needs no anti-topple contact. The steep-flat patches
   *  are then muted rather than drawn as if they were about to be covered. */
  toppleCoverage?: boolean;
  /** The pose's total drag moment (mm³), kept for caller compatibility. */
  dragTotalMm3?: number;
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
    if (!pos) {
      return {
        formationGeometry: null as THREE.BufferGeometry | null,
        toppleGeometry: null as THREE.BufferGeometry | null,
        mutedGeometry: null as THREE.BufferGeometry | null,
      };
    }
    const index = geometry.index;
    const maxMomentMm3 = regions.reduce((m, r) => Math.max(m, r.dragMomentMm3 ?? 0), 0);

    // One merged geometry per class instead of one mesh per region: a scan can
    // produce hundreds of formation patches, and each extra transparent mesh is
    // its own draw call plus sort entry. These materials are unlit, so no
    // normals are needed either — only positions.
    const formationPositions: number[] = [];
    const topplePositions: number[] = [];
    const mutedPositions: number[] = [];
    const toppleShares: number[] = [];
    const mutedShares: number[] = [];
    const appendRegion = (region: DetectedIsland, into: number[], shares?: number[]): void => {
      const ids = region.triangleIds as number[];
      const share = maxMomentMm3 > 0
        ? Math.min(1, Math.max(0, (region.dragMomentMm3 ?? 0) / maxMomentMm3))
        : 0;
      for (const ti of ids) {
        const i0 = index ? index.getX(ti * 3) : ti * 3;
        const i1 = index ? index.getX(ti * 3 + 1) : ti * 3 + 1;
        const i2 = index ? index.getX(ti * 3 + 2) : ti * 3 + 2;
        into.push(
          pos.getX(i0), pos.getY(i0), pos.getZ(i0),
          pos.getX(i1), pos.getY(i1), pos.getZ(i1),
          pos.getX(i2), pos.getY(i2), pos.getZ(i2),
        );
        if (shares) shares.push(share);
      }
    };

    for (const region of regions) {
      const ids = region.triangleIds;
      if (!ids || ids.length === 0) continue;

      if (region.steepFlat) {
        const covered = steepFlatNeedsCoverage(region.surfaceAreaMm2, toppleCoverage);
        appendRegion(
          region,
          covered ? topplePositions : mutedPositions,
          covered ? toppleShares : mutedShares,
        );
        continue;
      }

      appendRegion(region, formationPositions);
    }

    const buildFlat = (positions: number[]): THREE.BufferGeometry | null => {
      if (positions.length === 0) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      return g;
    };
    const buildTopple = (positions: number[], shares: number[]): THREE.BufferGeometry | null => {
      if (positions.length === 0) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('aWeight', new THREE.BufferAttribute(toppleVertexWeights(positions, shares), 1));
      return g;
    };
    return {
      formationGeometry: buildFlat(formationPositions),
      mutedGeometry: buildTopple(mutedPositions, mutedShares),
      toppleGeometry: buildTopple(topplePositions, toppleShares),
    };
  }, [geometry, regions, toppleCoverage]);

  const toppleMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: OVERHANG_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
      polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
    });
    applyOverhangShader(material, true);
    return material;
  }, []);

  const mutedMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: MUTED_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
      polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
    });
    applyOverhangShader(material, true);
    return material;
  }, []);

  const formationMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      color: formationOverhangColor(),
      transparent: true,
      opacity: OVERHANG_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
      polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
    });
    applyOverhangShader(material, false);
    return material;
  }, []);

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
      built.formationGeometry?.dispose();
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

  if (!built.formationGeometry && !built.toppleGeometry && !built.mutedGeometry) return null;

  return (
    <group
      position={[-centerOffset.x, -centerOffset.y, -centerOffset.z]}
      // The overhang scan is an overlay on the model, not part of its solid.
      // Feeding it to the cross-section stencil painted the cap over the
      // cut-away region wherever an overhang was scanned.
      userData={{ noStencil: true }}
    >
      {built.formationGeometry && (
        <mesh geometry={built.formationGeometry} renderOrder={OVERHANG_OVERLAY_RENDER_ORDER} raycast={() => null}>
          <primitive object={formationMaterial} attach="material" />
        </mesh>
      )}
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
