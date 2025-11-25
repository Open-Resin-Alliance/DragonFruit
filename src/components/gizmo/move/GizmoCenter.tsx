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
  onDragStart: () => void;
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
  const startPoint = useRef<THREE.Vector3 | null>(null);
  const rafId = useRef<number | null>(null);
  const dragPlane = useRef<THREE.Plane | null>(null);
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
    e.stopPropagation();
    (e as any).stopped = true; // Mark event as handled for OrbitControls
    
    // Create XY plane (horizontal) at gizmo's Z position
    // Normal points up (0,0,1), plane passes through gizmo position
    dragPlane.current = new THREE.Plane(new THREE.Vector3(0, 0, 1), -gizmoPosition.z);
    
    // Calculate initial point on drag plane from mouse position
    const rect = gl.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const mouse = new THREE.Vector2(x, y);
    const ray = new THREE.Ray();
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(mouse.x, mouse.y, 0.5).unproject(camera).sub(ray.origin).normalize();
    const initialPoint = new THREE.Vector3();
    ray.intersectPlane(dragPlane.current, initialPoint);
    
    setIsDragging(true);
    startPoint.current = initialPoint;
    onDragStart();
  };

  const getWorldPointFromMouse = useCallback((clientX: number, clientY: number): THREE.Vector3 | null => {
    if (!dragPlane.current) return null;
    
    const rect = gl.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    // Create ray from camera through mouse position (no raycaster needed)
    const mouse = new THREE.Vector2(x, y);
    const ray = new THREE.Ray();
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(mouse.x, mouse.y, 0.5).unproject(camera).sub(ray.origin).normalize();
    
    // Intersect with XY plane
    const intersection = new THREE.Vector3();
    ray.intersectPlane(dragPlane.current, intersection);
    
    return intersection;
  }, [camera, gl]);

  const handlePointerUp = () => {
    if (!isDragging) return;
    
    setIsDragging(false);
    startPoint.current = null;
    dragPlane.current = null;
    onDragEnd();
  };

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!startPoint.current) return;
      
      // Cancel any pending animation frame
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
      
      // Schedule update on next frame
      rafId.current = requestAnimationFrame(() => {
        const worldPoint = getWorldPointFromMouse(e.clientX, e.clientY);
        if (!worldPoint || !startPoint.current) return;

        const delta = worldPoint.clone().sub(startPoint.current);
        // Restrict movement to XY plane only (zero out Z component)
        delta.z = 0;
        onDrag(delta);
        startPoint.current = worldPoint;
        rafId.current = null;
      });
    };

    const handleGlobalPointerUp = () => {
      setIsDragging(false);
      startPoint.current = null;
      onDragEnd();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [isDragging, onDrag, onDragEnd, getWorldPointFromMouse]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = isPickingHovered || isHovered;

  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  const centerColor = isDimmed ? dimmedColor : GIZMO_COLORS.center;

  const opacity = isHidden ? 0 : isDimmed ? 0.15 : isActive || effectiveHovered ? 1.0 : 0.5;

  // Emissive intensity - disabled for center disc (no glow)
  const emissiveIntensity = 0;

  // Point light intensity based on state (uses effectiveHovered for GPU picking support)
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  return (
    <group
      onPointerDown={handlePointerDown}
    >
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass */}
      <mesh ref={pickMeshRef}>
        <circleGeometry args={[GIZMO_SIZES.centerRadius * 1.8, 32]} />
        <meshBasicMaterial
          visible={false}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      
      {/* Filled disc */}
      <mesh>
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
      <mesh>
        <ringGeometry args={[GIZMO_SIZES.centerRadius * 1.0, GIZMO_SIZES.centerRadius * 1.05, 32]} />
        <meshBasicMaterial
          color={isDimmed ? dimmedColor : "#ffffff"}
          transparent
          opacity={opacity}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Point light disabled for center disc */}
    </group>
  );
}
