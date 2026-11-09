'use client';

import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

import {
  getSupportBlockerHover,
  subscribeSupportBlockers,
  getSupportBlockersVersion,
  isSupportBlockerStrokeActive,
  getSupportBlockerBrushSizeMm,
} from '@/supports/autoSupport/supportBlockers';

/**
 * Paint cursor for support-blocker mode: a ring at the live brush radius
 * plus a center dot. Compact sibling of the smoothing cursor.
 */
export function SupportBlockerCursor() {
  React.useSyncExternalStore(subscribeSupportBlockers, getSupportBlockersVersion, getSupportBlockersVersion);
  const hover = getSupportBlockerHover();
  const { camera, size } = useThree();

  const point = hover.point;
  const normal = (hover.normal ?? new THREE.Vector3(0, 0, 1)).clone().normalize();

  const unitsPerPixel = React.useMemo(() => {
    if (!camera || !size.height || !point) return 0.01;
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const perspective = camera as THREE.PerspectiveCamera;
      const dist = perspective.position.distanceTo(point);
      const vFov = THREE.MathUtils.degToRad(perspective.fov);
      return (2 * dist * Math.tan(vFov / 2)) / size.height;
    }
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      return (ortho.top - ortho.bottom) / size.height;
    }
    return 0.01;
  }, [camera, size.height, point]);

  const thickness = Math.max(0.01, Math.min(0.15, unitsPerPixel * 1.25));
  const dotRadius = Math.max(0.01, Math.min(0.18, unitsPerPixel * 1.75));
  const surfaceOffset = Math.max(0.01, Math.min(0.08, unitsPerPixel * 2.5));
  const radius = getSupportBlockerBrushSizeMm();

  const cursorQuaternion = React.useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    return q;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normal.x, normal.y, normal.z]);
  const color = isSupportBlockerStrokeActive() ? '#3b82f6' : '#7aa5f5';
  if (!point) return null;

  return (
    <group raycast={() => null}>
      <group
        position={[
          point.x + normal.x * surfaceOffset,
          point.y + normal.y * surfaceOffset,
          point.z + normal.z * surfaceOffset,
        ]}
        quaternion={cursorQuaternion}
      >
        <mesh renderOrder={99999}>
          <ringGeometry args={[Math.max(0.001, radius - thickness), radius, 64]} />
          <meshBasicMaterial
            color={new THREE.Color(color)}
            transparent
            opacity={0.9}
            depthTest={false}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
        <mesh renderOrder={99999}>
          <sphereGeometry args={[dotRadius, 12, 12]} />
          <meshBasicMaterial
            color={new THREE.Color(color)}
            transparent
            opacity={0.9}
            depthTest={false}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      </group>
    </group>
  );
}
