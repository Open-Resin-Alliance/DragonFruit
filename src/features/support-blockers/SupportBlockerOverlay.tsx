import React, { useMemo } from 'react';
import * as THREE from 'three';

import {
  getSupportBlockedTriangles,
  subscribeSupportBlockers,
  getSupportBlockersVersion,
} from '@/supports/autoSupport/supportBlockers';

const BLOCKER_COLOR = '#3b82f6';
const BLOCKER_OPACITY = 0.45;

interface SupportBlockerOverlayProps {
  /** Raw model geometry (local frame, may be indexed or non-indexed). */
  geometry: THREE.BufferGeometry;
  /** Model owning the blocker mask. */
  modelId: string;
}

/**
 * Renders support-blocker paint as a translucent red skin over the blocked
 * triangles. Same build pattern as the overhang overlay (sub-geometry from
 * triangle ids, mounted in the model frame, no picking) so blocked paint
 * tracks the model through transforms.
 */
export function SupportBlockerOverlay({ geometry, modelId }: SupportBlockerOverlayProps) {
  // The blocked set mutates in place, so the build keys off the store
  // version — depending on the set itself would never recompute.
  const version = React.useSyncExternalStore(subscribeSupportBlockers, getSupportBlockersVersion, getSupportBlockersVersion);
  const centerOffset = React.useMemo(() => {
    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    return bbox.getCenter(new THREE.Vector3());
  }, [geometry]);
  const built = useMemo(() => {
    const blocked = getSupportBlockedTriangles(modelId);
    if (blocked.size === 0) return null;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const index = geometry.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    const arr = new Float32Array(blocked.size * 9);
    let o = 0;
    for (const ti of blocked) {
      if (ti < 0 || ti >= triCount) continue;
      const i0 = index ? index.getX(ti * 3) : ti * 3;
      const i1 = index ? index.getX(ti * 3 + 1) : ti * 3 + 1;
      const i2 = index ? index.getX(ti * 3 + 2) : ti * 3 + 2;
      if (i0 >= pos.count || i1 >= pos.count || i2 >= pos.count) continue;
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
    if (o === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr.slice(0, o), 3));
    g.computeVertexNormals();
    return g;
    // `version` intentionally only retriggers: the set mutates in place, so
    // no value read here changes when paint lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, modelId, version]);

  React.useEffect(() => {
    return () => {
      built?.dispose();
    };
  }, [built]);

  if (!built) return null;
  return (
    <group position={[-centerOffset.x, -centerOffset.y, -centerOffset.z]}>
      <mesh geometry={built} renderOrder={1002} raycast={() => null}>
        <meshBasicMaterial
          color={BLOCKER_COLOR}
          transparent
          opacity={BLOCKER_OPACITY}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>
    </group>
  );
}
