import React, { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';

/**
 * Renders overhang regions as translucent surface highlights — the actual
 * region triangles from the model geometry, not flat decal discs.
 *
 * Mounted inside the model's local frame (same context as StlMesh), so the
 * geometry is the raw model geometry and the group carries the same centering
 * offset the rest of the scene uses (negated bbox center). No transform math
 * of our own: the model matrix positions the highlight with the model.
 */

const OVERHANG_COLOR = '#ffa500';
const OVERHANG_OPACITY = 0.4;
/** A topple patch carrying little of the pose's drag moment: light amber, so it
 *  stays clearly visible on the model. The ramp encodes the share in
 *  saturation, never in brightness — a dim end reads as "the overlay is broken"
 *  rather than as "this patch matters less". */
const TOPPLE_COOL = new THREE.Color('#ffd28a');
/** ...and the patch carrying the most: saturated orange-red. */
const TOPPLE_HOT = new THREE.Color('#ff3d00');

/**
 * Per-vertex topple weight: the average of the load shares carried by the faces
 * meeting at that vertex.
 *
 * Painting whole regions leaves the boundary between two of them running along
 * a triangle edge, which on a coarse mesh reads as a staircase. A vertex weight
 * shared by both sides of that boundary is what removes it: the rasteriser then
 * interpolates from one patch's value to the other's across the adjacent
 * triangles instead of stepping at the edge. Faces are matched by welded
 * position, so the shared corners of two patches average.
 *
 * `faceShare` is one share per triangle (the patch's fraction of the pose's
 * drag moment, normalised by the largest patch in the scan, so no calibrated
 * constant is involved).
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

/** Quantized position key. Shared by the weight field and the boundary test, so
 *  the two agree on what "the same vertex" means. */
export function vertexKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
}

/**
 * Shader injection for an overlay material.
 *
 * `aWeight`, when ramped, blends the colour across the seams inside the
 * painted set. An alpha feather at the set's outer edge was tried and removed:
 * semi-transparent overlay triangles glitch against the model.
 *
 * The colours travel as uniforms, not as a vertex colour attribute: three
 * converts a uniform Color exactly as it converts material.color, so the ramp
 * lands in the same space as the flat material that already rendered correctly.
 * Only the weights are per-vertex, and a scalar has no colour space.
 */
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

/** Formation overhangs keep a flat colour: they are a different mechanism from
 *  topple patches, and the two should not look alike. */
export function formationOverhangColor(): THREE.Color {
  return new THREE.Color(OVERHANG_COLOR);
}

interface IslandOverhangOverlayProps {
  /** Raw model geometry (local frame, may be indexed or non-indexed). */
  geometry: THREE.BufferGeometry;
  /** Overhang islands for this model (source 'overhang', with triangleIds). */
  regions: DetectedIsland[];
}

export function IslandOverhangOverlay({ geometry, regions }: IslandOverhangOverlayProps) {
  const centerOffset = useMemo(() => {
    if (!geometry) return new THREE.Vector3();
    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute
    );
    return bbox.getCenter(new THREE.Vector3());
  }, [geometry]);

  const built = useMemo(() => {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return { meshes: [], toppleGeometry: null as THREE.BufferGeometry | null };
    const index = geometry.index;
    const meshes: Array<{ id: string; geometry: THREE.BufferGeometry; color: THREE.Color }> = [];
    // The ramp is normalised by the largest patch in the scan, so it needs no
    // calibrated constant and every scan shows its own relative loads.
    const maxMomentMm3 = regions.reduce((m, r) => Math.max(m, r.dragMomentMm3 ?? 0), 0);

    // Topple patches go into ONE mesh so a shared boundary vertex can carry the
    // average of both sides: per-region meshes cannot blend across an edge.
    const topplePositions: number[] = [];
    const toppleShares: number[] = [];
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
        topplePositions.push(...arr);
        const share = maxMomentMm3 > 0 ? Math.min(1, Math.max(0, (region.dragMomentMm3 ?? 0) / maxMomentMm3)) : 0;
        for (let t = 0; t < ids.length; t++) toppleShares.push(share);
        continue;
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(copyRegion(region), 3));
      g.computeVertexNormals();
      meshes.push({ id: region.id, geometry: g, color: formationOverhangColor() });
    }

    let toppleGeometry: THREE.BufferGeometry | null = null;
    if (topplePositions.length > 0) {
      toppleGeometry = new THREE.BufferGeometry();
      toppleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(topplePositions, 3));
      toppleGeometry.setAttribute(
        'aWeight',
        new THREE.BufferAttribute(toppleVertexWeights(topplePositions, toppleShares), 1),
      );
      toppleGeometry.computeVertexNormals();
    }
    return { meshes, toppleGeometry };
  }, [geometry, regions]);

  // Colours travel as uniforms, not as a vertex colour attribute: three
  // converts a uniform Color exactly as it converts material.color, so the
  // ramp lands in the same space as the flat material that already rendered
  // correctly. Only the weight is per-vertex, and a scalar has no colour space.
  const toppleMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: OVERHANG_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
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
    });
    applyOverhangShader(material, false);
    return material;
  }, []);

  useEffect(() => {
    return () => {
      for (const b of built.meshes) b.geometry.dispose();
      built.toppleGeometry?.dispose();
    };
  }, [built]);

  useEffect(
    () => () => {
      toppleMaterial.dispose();
      formationMaterial.dispose();
    },
    [toppleMaterial, formationMaterial],
  );

  if (built.meshes.length === 0 && !built.toppleGeometry) return null;

  return (
    <group position={[-centerOffset.x, -centerOffset.y, -centerOffset.z]}>
      {built.meshes.map((b) => (
        <mesh key={b.id} geometry={b.geometry} renderOrder={1001} raycast={() => null}>
          <primitive object={formationMaterial} attach="material" />
        </mesh>
      ))}
      {built.toppleGeometry && (
        <mesh geometry={built.toppleGeometry} renderOrder={1001} raycast={() => null}>
          <primitive object={toppleMaterial} attach="material" />
        </mesh>
      )}
    </group>
  );
}
