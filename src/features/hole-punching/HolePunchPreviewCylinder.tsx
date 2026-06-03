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
const PUNCH_PREVIEW_OUTSIDE_PROTRUSION_MM = 0.25;
// Keep punch previews above hollowing overlays (renderOrder 6 in page.tsx),
// but below xray model meshes.
const PUNCH_PREVIEW_RENDER_ORDER_INSIDE = 10000;
// Render outside protrusion above xray so the exposed segment stays solid.
const PUNCH_PREVIEW_RENDER_ORDER_OUTSIDE = 10020;

export function HolePunchPreviewCylinder({
  position,
  normal,
  radiusMm,
  lengthMm,
  variant = 'placed',
  applied = false,
  onClick,
}: HolePunchPreviewCylinderProps) {
  const insideDepth = Math.max(0.2, lengthMm);
  const outsideDepth = PUNCH_PREVIEW_OUTSIDE_PROTRUSION_MM;
  const radius = Math.max(0.1, radiusMm);

  const safeNormal = React.useMemo(() => {
    const n = normal.clone();
    if (n.lengthSq() <= 1e-10) {
      n.set(0, 0, 1);
    } else {
      n.normalize();
    }
    return n;
  }, [normal]);

  const quaternion = React.useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(UP, safeNormal);
    return q;
  }, [safeNormal]);

  // Split into two segments so we can layer them differently vs xray:
  // - inside segment (below xray)
  // - 0.25mm outside segment (above xray)
  const insideDisplayPosition = React.useMemo(
    () => position.clone().add(safeNormal.clone().multiplyScalar(insideDepth * 0.5)),
    [insideDepth, position, safeNormal],
  );

  const outsideDisplayPosition = React.useMemo(
    () => position.clone().add(safeNormal.clone().multiplyScalar(-outsideDepth * 0.5)),
    [outsideDepth, position, safeNormal],
  );

  const palette = React.useMemo(() => {
    // Visual semantics requested:
    // - Orange while previewing/editing (not applied)
    // - Deep blue once applied
    if (applied) {
      return {
        color: '#123a8f',
        emissiveIntensity: variant === 'selected' ? 0.24 : 0.18,
      };
    }

    return {
      color: '#ff8c00',
      emissiveIntensity: variant === 'selected' ? 0.2 : variant === 'hover' ? 0.17 : 0.15,
    };
  }, [applied, variant]);

  return (
    <>
      <mesh
        position={insideDisplayPosition}
        quaternion={quaternion}
        renderOrder={PUNCH_PREVIEW_RENDER_ORDER_INSIDE}
        onClick={onClick ? (event) => {
          event.stopPropagation();
          onClick();
        } : undefined}
      >
        <cylinderGeometry args={[radius, radius, insideDepth, 24, 1, false]} />
        <meshStandardMaterial
          color={palette.color}
          emissive={palette.color}
          emissiveIntensity={palette.emissiveIntensity}
          roughness={0.52}
          metalness={0.04}
          transparent
          opacity={1}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>

      <mesh
        position={outsideDisplayPosition}
        quaternion={quaternion}
        renderOrder={PUNCH_PREVIEW_RENDER_ORDER_OUTSIDE}
        onClick={onClick ? (event) => {
          event.stopPropagation();
          onClick();
        } : undefined}
      >
        <cylinderGeometry args={[radius, radius, outsideDepth, 24, 1, false]} />
        <meshStandardMaterial
          color={palette.color}
          emissive={palette.color}
          emissiveIntensity={palette.emissiveIntensity}
          roughness={0.52}
          metalness={0.04}
          transparent
          opacity={1}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
    </>
  );
}
