"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import type { GizmoAxis as AxisType } from '../types';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

interface GizmoMoveProps {
  axis: AxisType;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  enableLighting?: boolean;
  gizmoPosition: THREE.Vector3;
  handleScale?: number; // New prop for scaling handles
  onDragStart: () => void;
  onDrag: (delta: THREE.Vector3) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * GizmoMove - Arrow for axis-constrained movement
 */
export function GizmoMove({
  axis,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  enableLighting = true,
  gizmoPosition,
  handleScale = 1.0, // Default to 1.0
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoMoveProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [shouldFlipX, setShouldFlipX] = useState(false);
  const [shouldFlipY, setShouldFlipY] = useState(false);
  const [shouldFlipZ, setShouldFlipZ] = useState(false);
  const dragPlaneRef = useRef<THREE.Plane | null>(null);
  const lastPointRef = useRef<THREE.Vector3 | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const { camera, gl } = useThree();

  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();
  
  // Map axis to gizmo handle type
  const handleType: GizmoHandleType = `move-${axis}` as GizmoHandleType;
  
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

  // Get colors for this axis
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  // Update axis flip states every frame based on camera position relative to gizmo
  useFrame(() => {
    // X axis flips when camera crosses X axis (camera.x vs gizmo.x)
    if (axis === 'x') {
      const cameraRelativeX = camera.position.x - gizmoPosition.x;
      setShouldFlipX(cameraRelativeX > 0);
    }
    
    // Y axis flips when camera crosses Y axis (camera.y vs gizmo.y)
    if (axis === 'y') {
      const cameraRelativeY = camera.position.y - gizmoPosition.y;
      setShouldFlipY(cameraRelativeY > 0);
    }
    
    // Z axis flips when camera crosses horizontal plane (camera.z vs gizmo.z)
    if (axis === 'z') {
      const cameraRelativeZ = camera.position.z - gizmoPosition.z;
      setShouldFlipZ(cameraRelativeZ > 0);
    }
  });

  // Rotation for each axis with camera-relative flipping
  const rotation: [number, number, number] =
    axis === 'x' ? [0, 0, shouldFlipX ? -Math.PI / 2 : Math.PI / 2]
    : axis === 'y' ? [0, 0, shouldFlipY ? 0 : Math.PI]
    : axis === 'z' ? (shouldFlipZ ? [Math.PI / 2, 0, 0] : [-Math.PI / 2, 0, 0])
    : [0, 0, 0];

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) {
      return;
    }
    
    e.stopPropagation();
    (e as any).stopped = true; // Mark event as handled for OrbitControls

    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir);
    dragPlaneRef.current = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, gizmoPosition);

    const initialPoint = getWorldPointFromMouse(e.clientX, e.clientY);
    if (!initialPoint) return;
    
    setIsDragging(true);
    lastPointRef.current = initialPoint;
    onDragStart();
  };

  const handlePointerEnterLocal = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerEnter();
  };

  const handlePointerLeaveLocal = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerLeave();
  };

  const getAxisDirection = useCallback((): THREE.Vector3 => {
    if (axis === 'x') return new THREE.Vector3(1, 0, 0);
    if (axis === 'y') return new THREE.Vector3(0, 1, 0);
    return new THREE.Vector3(0, 0, 1);
  }, [axis]);

  const getWorldPointFromMouse = useCallback((clientX: number, clientY: number): THREE.Vector3 | null => {
    if (!dragPlaneRef.current) return null;

    const rect = gl.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

    const intersection = new THREE.Vector3();
    const hitPoint = raycaster.ray.intersectPlane(dragPlaneRef.current, intersection);
    if (!hitPoint) return null;
    return intersection;
  }, [camera, gl]);

  const handlePointerUp = () => {
    if (!isDragging) return;

    setIsDragging(false);
    lastPointRef.current = null;
    dragPlaneRef.current = null;
    onDragEnd();
  };

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!lastPointRef.current) return;

      const nextPoint = getWorldPointFromMouse(e.clientX, e.clientY);
      if (!nextPoint || !lastPointRef.current) return;

      const worldDelta = nextPoint.clone().sub(lastPointRef.current);
      const axisDir = getAxisDirection().normalize();
      const axisMagnitude = worldDelta.dot(axisDir);
      if (Math.abs(axisMagnitude) < 1e-8) return;

      const delta = axisDir.multiplyScalar(axisMagnitude);
      onDrag(delta);
      lastPointRef.current = nextPoint;
    };

    const handleGlobalPointerUp = () => {
      setIsDragging(false);
      lastPointRef.current = null;
      dragPlaneRef.current = null;
      onDragEnd();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [getAxisDirection, getWorldPointFromMouse, isDragging, onDrag, onDragEnd]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = isPickingHovered || isHovered;
  const isHighlighted = !!(effectiveHovered || isActive);

  const opacity = isHidden ? 0 : isDimmed ? 0.15 : isHighlighted ? 1.0 : 0.9;
  const hoverScale = isActive ? 1.18 : effectiveHovered ? 1.1 : 1.0;
  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  
  // Emissive intensity based on state (uses effectiveHovered for GPU picking support)
  const emissiveIntensity = isDimmed ? 0 : isActive
    ? GIZMO_LIGHTING.emissiveIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.emissiveIntensity.hovered
    : GIZMO_LIGHTING.emissiveIntensity.idle;

  // Point light intensity based on state (uses effectiveHovered for GPU picking support)
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  // Create gradient cylinder geometry with vertex colors
  const gradientGeometry = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(0.02, 0.02, GIZMO_SIZES.arrowShaftLength, 8, 1);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    
    // Pure colors at center, secondary colors at arrow tip (matching rotation arcs)
    const pureCenterColor = axis === 'x' ? '#ff0000' : axis === 'y' ? '#0ce300' : '#0000ff';
    const secondaryColor = axis === 'x' ? '#ff9900' : axis === 'y' ? '#ffcc00' : '#1596ff';
    
    const startColor = new THREE.Color(pureCenterColor);
    const endColor = new THREE.Color(secondaryColor);
    
    // Apply gradient based on Y position (cylinder is vertical)
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const y = geometry.attributes.position.getY(i);
      const normalizedPos = (y + GIZMO_SIZES.arrowShaftLength / 2) / GIZMO_SIZES.arrowShaftLength; // Normalize to 0-1
      
      // Keep pure color for first 1/3, then fade to secondary in remaining 2/3
      const t = Math.max(0, (normalizedPos - 0.33) / 0.67); // 0 for first 1/3, then 0-1 for remaining
      const color = new THREE.Color().lerpColors(startColor, endColor, t);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [axis]);

  // Arrow tip color - keep axis color always
  const endColorHex = isActive
    ? GIZMO_COLORS.active
    : effectiveHovered
      ? GIZMO_COLORS.hover
      : axisColors.end;

  // Arrow tip position in local Y direction (will be rotated with group)
  const arrowTipPosition: [number, number, number] = [
    0,
    GIZMO_SIZES.arrowShaftLength,
    0
  ];

  return (
    <group rotation={rotation}>
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass */}
      <mesh 
        ref={pickMeshRef}
        position={arrowTipPosition}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnterLocal}
        onPointerLeave={handlePointerLeaveLocal}
        scale={handleScale}
      >
        <sphereGeometry args={[Math.max(0.1, GIZMO_SIZES.arrowHeadRadius * 1.6), 12, 12]} />
        <meshBasicMaterial 
          visible={false}
          depthTest={false} 
        />
      </mesh>
      
      {/* Gradient cylinder shaft - NOT SCALED */}
      <mesh position={[0, GIZMO_SIZES.arrowShaftLength / 2, 0]} geometry={gradientGeometry} renderOrder={-10}>
        <meshBasicMaterial 
          vertexColors={!isDimmed}
          color={isDimmed ? dimmedColor : isHighlighted ? '#ffffff' : '#f2f2f2'}
          opacity={opacity}
          transparent
          depthTest={false}
          toneMapped={false} 
        />
      </mesh>
      
      {/* Arrow head (cone) with outline - SCALED */}
      <group position={arrowTipPosition} scale={handleScale * hoverScale}>
        {/* Outline - slightly larger with darker color */}
        <mesh scale={1.15}>
          <coneGeometry args={[GIZMO_SIZES.arrowHeadRadius, GIZMO_SIZES.arrowHeadLength, 8]} />
          <meshBasicMaterial
            color={isDimmed ? new THREE.Color(dimmedColor).multiplyScalar(0.7).getHex() : new THREE.Color(endColorHex).multiplyScalar(0.3).getHex()}
            opacity={opacity}
            transparent
            depthTest={false}
          />
        </mesh>
        
        {/* Main colored cone */}
        <mesh>
          <coneGeometry args={[GIZMO_SIZES.arrowHeadRadius, GIZMO_SIZES.arrowHeadLength, 8]} />
          <meshBasicMaterial
            color={isDimmed ? dimmedColor : endColorHex}
            opacity={opacity}
            transparent
            depthTest={false}
          />
        </mesh>
      </group>

      {/* Point light at arrow tip to cast colored light on model */}
      {enableLighting && !isDimmed && (
        <pointLight
          position={arrowTipPosition}
          color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : axisColors.end}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
