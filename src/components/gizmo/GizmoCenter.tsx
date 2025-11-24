"use client";

import React, { useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { GIZMO_COLORS, GIZMO_SIZES } from './constants';

interface GizmoCenterProps {
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  onDragStart: () => void;
  onDrag: (delta: THREE.Vector3) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * GizmoCenter - Horizontal plane for XY movement only
 */
export function GizmoCenter({
  isHovered,
  isActive,
  isDimmed,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoCenterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startPoint = useRef<THREE.Vector3 | null>(null);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setIsDragging(true);
    startPoint.current = e.point.clone();
    onDragStart();
  };

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!isDragging || !startPoint.current) return;
    e.stopPropagation();
    
    const delta = e.point.clone().sub(startPoint.current);
    // Restrict movement to XY plane only (zero out Z component)
    delta.z = 0;
    onDrag(delta);
    startPoint.current = e.point.clone();
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!isDragging) return;
    e.stopPropagation();
    
    setIsDragging(false);
    startPoint.current = null;
    onDragEnd();
  };

  const color = isActive
    ? GIZMO_COLORS.active
    : isHovered
    ? GIZMO_COLORS.hover
    : GIZMO_COLORS.center;

  const opacity = isDimmed ? 0.3 : 1.0;

  return (
    <mesh
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      rotation={[Math.PI / 2, 0, 0]}
    >
      <circleGeometry args={[GIZMO_SIZES.centerRadius * 1.5, 32]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthTest={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
