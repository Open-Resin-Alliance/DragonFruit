"use client";

import React, { useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree } from '@react-three/fiber';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

interface GizmoCenterProps {
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  enableLighting?: boolean;
  gizmoPosition: THREE.Vector3;
  onDragStart: () => boolean | void;
  onDrag: (delta: THREE.Vector3) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * GizmoCenter - Center sphere for free movement
 */
export function GizmoCenter({
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  enableLighting = true,
  gizmoPosition,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoCenterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const lastPointRef = useRef<THREE.Vector3 | null>(null);
  const dragPlane = useRef<THREE.Plane | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const { camera, gl } = useThree();

  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();
  
  // Handle type for center
  const handleType: GizmoHandleType = 'move-center';
  
  // Register with picking system
  useEffect(() => {
    if (!pickMeshRef.current) return;
    
    pickIdRef.current = register({
      category: 'gizmo',
      objectId: null,
      gizmoHandle: handleType,
      object: pickMeshRef.current,
    });
    
    return () => {
      if (pickIdRef.current !== null) {
        unregister(pickIdRef.current);
        pickIdRef.current = null;
      }
    };
  }, [register, unregister, handleType]);
  
  // Check if this handle is hovered via GPU picking
  const isPickingHovered = hit.category === 'gizmo' && 
    'gizmoHandle' in hit && 
    hit.gizmoHandle === handleType;

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) {
      return;
    }
    
    e.stopPropagation();
    (e as any).stopped = true; // Mark event as handled for OrbitControls

    // Keep center drag strictly on world XY plane at the current gizmo Z.
    dragPlane.current = new THREE.Plane(new THREE.Vector3(0, 0, 1), -gizmoPosition.z);
    
    // Calculate initial point on drag plane from mouse position
    const initialPoint = getWorldPointFromMouse(e.clientX, e.clientY);
    if (!initialPoint) return;
    
    const allowed = onDragStart();
    if (allowed === false) {
      return;
    }

    setIsDragging(true);
    lastPointRef.current = initialPoint;
  };

  const getWorldPointFromMouse = useCallback((clientX: number, clientY: number): THREE.Vector3 | null => {
    if (!dragPlane.current) return null;
    
    const rect = gl.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    
    // Intersect with drag plane
    const intersection = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(dragPlane.current, intersection);
    if (!hit) return null;
    
    return intersection;
  }, [camera, gl]);

  const handlePointerEnterLocal = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerEnter();
  };

  const handlePointerLeaveLocal = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerLeave();
  };

  const handlePointerUp = () => {
    if (!isDragging) return;
    
    setIsDragging(false);
    lastPointRef.current = null;
    dragPlane.current = null;
    onDragEnd();
  };

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!lastPointRef.current) return;

      const worldPoint = getWorldPointFromMouse(e.clientX, e.clientY);
      if (!worldPoint || !lastPointRef.current) return;

      const delta = worldPoint.clone().sub(lastPointRef.current);
      // Restrict movement to XY plane only (zero out Z component)
      delta.z = 0;
      if (delta.lengthSq() < 1e-12) return;

      onDrag(delta);
      lastPointRef.current = worldPoint;
    };

    const handleGlobalPointerUp = () => {
      setIsDragging(false);
      lastPointRef.current = null;
      onDragEnd();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [isDragging, onDrag, onDragEnd, getWorldPointFromMouse]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = isPickingHovered || isHovered;
  const isHighlighted = !!(effectiveHovered || isActive);

  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  const centerColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : effectiveHovered
        ? GIZMO_COLORS.hover
        : GIZMO_COLORS.center;

  const opacity = isHidden ? 0 : isDimmed ? 0.15 : isHighlighted ? 1.0 : 0.55;

  // Emissive intensity - disabled for center disc (no glow)
  const emissiveIntensity = 0;

  // Point light intensity based on state (uses effectiveHovered for GPU picking support)
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  return (
    <group>
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass */}
      <mesh
        ref={pickMeshRef}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnterLocal}
        onPointerLeave={handlePointerLeaveLocal}
      >
        <circleGeometry args={[GIZMO_SIZES.centerRadius * 3.1, 48]} />
        <meshBasicMaterial
          visible={false}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      
      {/* Filled disc */}
      <mesh onPointerDown={handlePointerDown} onPointerEnter={handlePointerEnterLocal} onPointerLeave={handlePointerLeaveLocal}>
        <circleGeometry args={[GIZMO_SIZES.centerRadius * 1.05, 32]} />
        <meshBasicMaterial
          color={centerColor}
          transparent
          opacity={opacity}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      
      {/* White border ring */}
      <mesh onPointerDown={handlePointerDown} onPointerEnter={handlePointerEnterLocal} onPointerLeave={handlePointerLeaveLocal}>
        <ringGeometry args={[GIZMO_SIZES.centerRadius * 1.0, GIZMO_SIZES.centerRadius * 1.05, 32]} />
        <meshBasicMaterial
          color={isDimmed ? dimmedColor : "#ffffff"}
          transparent
          opacity={opacity}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Hover/active halo */}
      {isHighlighted && !isDimmed && !isHidden && (
        <mesh>
          <ringGeometry args={[GIZMO_SIZES.centerRadius * 1.1, GIZMO_SIZES.centerRadius * 1.32, 32]} />
          <meshBasicMaterial
            color={isActive ? GIZMO_COLORS.active : GIZMO_COLORS.hover}
            transparent
            opacity={isActive ? 0.5 : 0.38}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Point light disabled for center disc */}
    </group>
  );
}
