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
    if (!pos) return [];
    const index = geometry.index;
    const list: Array<{ id: string; geometry: THREE.BufferGeometry }> = [];

    for (const region of regions) {
      const ids = region.triangleIds;
      if (!ids || ids.length === 0) continue;

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

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      g.computeVertexNormals();
      list.push({ id: region.id, geometry: g });
    }
    return list;
  }, [geometry, regions]);

  useEffect(() => {
    return () => {
      for (const b of built) b.geometry.dispose();
    };
  }, [built]);

  if (built.length === 0) return null;

  return (
    <group position={[-centerOffset.x, -centerOffset.y, -centerOffset.z]}>
      {built.map((b) => (
        <mesh key={b.id} geometry={b.geometry} renderOrder={1001} raycast={() => null}>
          <meshBasicMaterial
            color={OVERHANG_COLOR}
            transparent
            opacity={OVERHANG_OPACITY}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}
