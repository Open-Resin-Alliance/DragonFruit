import React from 'react';
import * as THREE from 'three';

interface HolePunchPreviewCylinderProps {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  radiusMm: number;
  lengthMm: number;
  cavityBoundaryDepthMm?: number | null;
  variant?: 'placed' | 'selected' | 'hover';
  applied?: boolean;
  onClick?: () => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);
const PUNCH_PREVIEW_OUTSIDE_PROTRUSION_MM = 0.25;
const APPLIED_PREVIEW_RADIUS_INSET_MM = 0.01;
// Interaction mesh stays high-priority for reliable hover/click targeting.
const PUNCH_PREVIEW_RENDER_ORDER_INTERACTION = 10021;
const PUNCH_PREVIEW_RENDER_ORDER_NORMAL_INSIDE = 4;
const PUNCH_PREVIEW_RENDER_ORDER_NORMAL_OUTSIDE = 5;

export function HolePunchPreviewCylinder({
  position,
  normal,
  radiusMm,
  lengthMm,
  cavityBoundaryDepthMm = null,
  variant = 'placed',
  applied = false,
  onClick,
  onHoverStart,
  onHoverEnd,
}: HolePunchPreviewCylinderProps) {
  const insideDepth = Math.max(0.2, lengthMm);
  const outsideDepth = PUNCH_PREVIEW_OUTSIDE_PROTRUSION_MM;
  const baseRadius = Math.max(0.1, radiusMm);
  const renderRadius = applied
    ? Math.max(0.05, baseRadius - APPLIED_PREVIEW_RADIUS_INSET_MM)
    : baseRadius;

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

  const interactionLength = insideDepth + outsideDepth;
  const interactionPosition = React.useMemo(
    () => position.clone().add(safeNormal.clone().multiplyScalar((insideDepth - outsideDepth) * 0.5)),
    [insideDepth, outsideDepth, position, safeNormal],
  );

  const interactionRadius = Math.max(baseRadius * 1.1, baseRadius + 0.15);
  const insideRenderOrder = PUNCH_PREVIEW_RENDER_ORDER_NORMAL_INSIDE;
  const outsideRenderOrder = PUNCH_PREVIEW_RENDER_ORDER_NORMAL_OUTSIDE;

  const palette = React.useMemo(() => {
    if (!applied) {
      if (variant === 'selected') {
        return {
          color: '#ff8c00',
          emissive: '#ff8c00',
          emissiveIntensity: 0.22,
          opacity: 0.82,
        };
      }
      if (variant === 'hover') {
        return {
          color: '#ff8c00',
          emissive: '#ff8c00',
          emissiveIntensity: 0.16,
          opacity: 0.52,
        };
      }
      return {
        color: '#8a909b',
        emissive: '#8a909b',
        emissiveIntensity: 0.08,
        opacity: 0.42,
      };
    }

    if (variant === 'selected') {
      return {
        color: '#2ecc71',
        emissive: '#2ecc71',
        emissiveIntensity: 0.24,
        opacity: 0.82,
      };
    }
    if (variant === 'hover') {
      return {
        color: '#2ecc71',
        emissive: '#2ecc71',
        emissiveIntensity: 0.16,
        opacity: 0.46,
      };
    }

    return {
      color: '#123a8f',
      emissive: '#123a8f',
      emissiveIntensity: 0.18,
      opacity: 0.72,
    };
  }, [applied, variant]);

  const cavityAid = React.useMemo(() => {
    if (cavityBoundaryDepthMm == null || !Number.isFinite(cavityBoundaryDepthMm)) {
      return {
        shellDepth: insideDepth,
        cavityDepth: 0,
      };
    }

    const boundaryDepth = THREE.MathUtils.clamp(cavityBoundaryDepthMm, 0, insideDepth);
    const shellDepth = boundaryDepth;
    const cavityDepth = Math.max(0, insideDepth - shellDepth);

    return {
      shellDepth,
      cavityDepth,
    };
  }, [cavityBoundaryDepthMm, insideDepth]);

  const shellDisplayPosition = React.useMemo(
    () => position.clone().add(safeNormal.clone().multiplyScalar(cavityAid.shellDepth * 0.5)),
    [cavityAid.shellDepth, position, safeNormal],
  );

  const cavityDisplayPosition = React.useMemo(
    () => position.clone().add(safeNormal.clone().multiplyScalar(cavityAid.shellDepth + cavityAid.cavityDepth * 0.5)),
    [cavityAid.cavityDepth, cavityAid.shellDepth, position, safeNormal],
  );

  const inversePalette = React.useMemo(() => {
    const base = new THREE.Color(palette.color);
    const inverse = new THREE.Color(1 - base.r, 1 - base.g, 1 - base.b);
    return {
      color: `#${inverse.getHexString()}`,
      emissive: `#${inverse.getHexString()}`,
      emissiveIntensity: Math.min(0.28, palette.emissiveIntensity + 0.04),
      opacity: palette.opacity,
    };
  }, [palette.color, palette.emissiveIntensity, palette.opacity]);

  const SEGMENT_EPSILON_MM = 0.001;
  const showShellSegment = cavityAid.shellDepth > SEGMENT_EPSILON_MM;
  const showCavitySegment = cavityAid.cavityDepth > SEGMENT_EPSILON_MM;

  return (
    <>
      {(onClick || onHoverStart || onHoverEnd) && (
        <mesh
          position={interactionPosition}
          quaternion={quaternion}
          renderOrder={PUNCH_PREVIEW_RENDER_ORDER_INTERACTION}
          onClick={onClick ? (event) => {
            event.stopPropagation();
            onClick();
          } : undefined}
          onPointerOver={onHoverStart ? (event) => {
            event.stopPropagation();
            onHoverStart();
          } : undefined}
          onPointerOut={onHoverEnd ? (event) => {
            event.stopPropagation();
            onHoverEnd();
          } : undefined}
        >
          <cylinderGeometry args={[interactionRadius, interactionRadius, interactionLength, 16, 1, false]} />
          <meshBasicMaterial
            transparent
            opacity={0}
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
      )}

      {showShellSegment && (
        <mesh
          position={shellDisplayPosition}
          quaternion={quaternion}
          renderOrder={insideRenderOrder}
        >
          <cylinderGeometry args={[renderRadius, renderRadius, cavityAid.shellDepth, 24, 1, false]} />
          <meshStandardMaterial
            color={palette.color}
            emissive={palette.emissive}
            emissiveIntensity={palette.emissiveIntensity}
            roughness={0.52}
            metalness={0.04}
            transparent
            opacity={palette.opacity}
            depthWrite
            depthTest
          />
        </mesh>
      )}

      {showCavitySegment && (
        <mesh
          position={cavityDisplayPosition}
          quaternion={quaternion}
          renderOrder={insideRenderOrder}
        >
          <cylinderGeometry args={[renderRadius, renderRadius, cavityAid.cavityDepth, 24, 1, false]} />
          <meshStandardMaterial
            color={inversePalette.color}
            emissive={inversePalette.emissive}
            emissiveIntensity={inversePalette.emissiveIntensity}
            roughness={0.52}
            metalness={0.04}
            transparent
            opacity={inversePalette.opacity}
            depthWrite
            depthTest
          />
        </mesh>
      )}

      <mesh
        position={outsideDisplayPosition}
        quaternion={quaternion}
        renderOrder={outsideRenderOrder}
      >
        <cylinderGeometry args={[renderRadius, renderRadius, outsideDepth, 24, 1, false]} />
        <meshStandardMaterial
          color={palette.color}
          emissive={palette.emissive}
          emissiveIntensity={palette.emissiveIntensity}
          roughness={0.52}
          metalness={0.04}
          transparent={false}
          opacity={1}
          depthWrite
          depthTest
        />
      </mesh>
    </>
  );
}
