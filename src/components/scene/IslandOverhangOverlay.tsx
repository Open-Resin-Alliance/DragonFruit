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

/**
 * Keys (quantized positions, see `vertexKey`) of the painted vertices that also
 * belong to an unpainted face — the painted set's boundary.
 *
 * Blending the colour only fixes the seams *inside* the painted set. Where the
 * set ends, the overlay stops dead, and that edge runs along triangle edges
 * exactly like the seams did, so it still reads as a staircase. The boundary
 * vertices are what the shader fades out: the outermost ring of triangles then
 * ramps to transparent instead of cutting off.
 *
 * `paintedFace` is one flag per face of the whole mesh, `paintedKeys` the keys
 * of every painted face's corners.
 */
export function paintedBoundaryKeys(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  paintedFace: Uint8Array,
  paintedKeys: Set<string>,
): Set<string> {
  const boundary = new Set<string>();
  const hasIndex = !!index && index.length > 0;
  const faceCount = hasIndex
    ? Math.floor((index as ArrayLike<number>).length / 3)
    : Math.floor(positions.length / 9);
  for (let f = 0; f < faceCount; f++) {
    if (paintedFace[f]) continue;
    for (let c = 0; c < 3; c++) {
      const i = (hasIndex ? (index as ArrayLike<number>)[f * 3 + c] : f * 3 + c) * 3;
      const key = vertexKey(positions[i], positions[i + 1], positions[i + 2]);
      if (paintedKeys.has(key)) boundary.add(key);
    }
  }
  return boundary;
}

/** Quantized position key. Shared by the weight field and the boundary test, so
 *  the two agree on what "the same vertex" means. */
export function vertexKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
}

/**
 * Shader injection for an overlay material.
 *
 * `aFade` ramps the alpha to zero over the outermost ring of the painted set,
 * which is what removes the staircase where the overlay ends. `aWeight`, when
 * ramped, blends the colour across the seams inside it.
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
        `#include <common>\nattribute float aFade;\nvarying float vFade;\n${
          ramped ? 'attribute float aWeight;\nvarying float vWeight;' : ''
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvFade = aFade;\n${ramped ? 'vWeight = aWeight;' : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying float vFade;\n${
          ramped ? 'varying float vWeight;\nuniform vec3 uCool;\nuniform vec3 uHot;' : ''
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `diffuseColor.a *= clamp( vFade, 0.0, 1.0 );\n${
          ramped ? 'diffuseColor.rgb = mix( uCool, uHot, clamp( vWeight, 0.0, 1.0 ) );' : ''
        }`,
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
    const faceCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    const paintedFace = new Uint8Array(faceCount);
    const paintedKeys = new Set<string>();
    const cornerAt = (ti: number, c: number): number =>
      (index ? index.getX(ti * 3 + c) : ti * 3 + c) * 3;
    for (const region of regions) {
      for (const ti of region.triangleIds ?? []) {
        if (ti >= faceCount) continue;
        paintedFace[ti] = 1;
        for (let c = 0; c < 3; c++) {
          const i = cornerAt(ti, c);
          paintedKeys.add(vertexKey(pos.getX(i), pos.getY(i), pos.getZ(i)));
        }
      }
    }
    const boundary = paintedBoundaryKeys(pos.array, index?.array ?? null, paintedFace, paintedKeys);
    // One ring of triangles ramps to transparent at the painted set's edge, so
    // the overlay does not stop dead along a triangle edge.
    const fadeFor = (arr: ArrayLike<number>): Float32Array => {
      const out = new Float32Array(Math.floor(arr.length / 3));
      for (let v = 0; v < out.length; v++) {
        out[v] = boundary.has(vertexKey(arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2])) ? 0 : 1;
      }
      return out;
    };

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

      const arr = copyRegion(region);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      g.setAttribute('aFade', new THREE.BufferAttribute(fadeFor(arr), 1));
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
      toppleGeometry.setAttribute('aFade', new THREE.BufferAttribute(fadeFor(topplePositions), 1));
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
