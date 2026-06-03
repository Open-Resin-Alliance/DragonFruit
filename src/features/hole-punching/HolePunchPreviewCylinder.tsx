import React from 'react';
import * as THREE from 'three';

interface HolePunchPreviewCylinderProps {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  radiusMm: number;
  lengthMm: number;
  variant?: 'placed' | 'selected' | 'hover';
  applied?: boolean;
  onClick?: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);

export function HolePunchPreviewCylinder({
  position,
  normal,
  radiusMm,
  lengthMm,
  variant = 'placed',
  applied = false,
  onClick,
}: HolePunchPreviewCylinderProps) {
  const quaternion = React.useMemo(() => {
    const q = new THREE.Quaternion();
    const safeNormal = normal.clone();
    if (safeNormal.lengthSq() <= 1e-10) {
      safeNormal.set(0, 0, 1);
    } else {
      safeNormal.normalize();
    }
    q.setFromUnitVectors(UP, safeNormal);
    return q;
  }, [normal]);

  const height = Math.max(0.2, lengthMm);
  const radius = Math.max(0.1, radiusMm);

  const palette = React.useMemo(() => {
    if (variant === 'selected') {
      return {
        outer: applied ? '#8cffb2' : '#7df9ff',
        outerOpacity: 0.62,
        inner: applied ? '#3ddc84' : '#2dd4ff',
        innerOpacity: 0.24,
      };
    }
    if (variant === 'hover') {
      return {
        outer: '#ffe082',
        outerOpacity: 0.24,
        inner: '#ffb74d',
        innerOpacity: 0.08,
      };
    }
    return {
      outer: applied ? '#7ef29f' : '#ffd166',
      outerOpacity: 0.42,
      inner: applied ? '#2bbf6a' : '#ff8f3d',
      innerOpacity: 0.14,
    };
  }, [applied, variant]);

  return (
    <group position={position} quaternion={quaternion}>
      <mesh
        renderOrder={9997}
        onClick={onClick ? (event) => {
          event.stopPropagation();
          onClick();
        } : undefined}
      >
        <cylinderGeometry args={[radius, radius, height, 24, 1, false]} />
        <meshBasicMaterial
          color={palette.outer}
          transparent
          opacity={palette.outerOpacity}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
      <mesh renderOrder={9998}>
        <cylinderGeometry args={[radius * 0.62, radius * 0.62, height + 0.02, 24, 1, false]} />
        <meshBasicMaterial
          color={palette.inner}
          transparent
          opacity={palette.innerOpacity}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
    </group>
  );
}
