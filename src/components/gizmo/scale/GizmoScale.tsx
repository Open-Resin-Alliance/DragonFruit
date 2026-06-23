"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree } from '@react-three/fiber';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import type { GizmoAxis } from '../types';
import { getCachedBoxGeometry, getCachedScaleCubeEdgeGeometry } from '../gizmoGeometryCache';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

interface GizmoScaleProps {
  axis: GizmoAxis;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  suppressHover?: boolean;
  opacityScale?: number;
  interactionsEnabled?: boolean;
  isUniform?: boolean;
  gizmoPosition: THREE.Vector3;
  onDragStart: (isUniform: boolean) => boolean | void;
  onDrag: (factor: number, isUniform: boolean) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * GizmoScale - Scale handle for scaling operations
 */
export function GizmoScale({
  axis,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  suppressHover = false,
  opacityScale = 1,
  interactionsEnabled = true,
  isUniform: isUniformProp = true,
  gizmoPosition,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoScaleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUniformScale, setIsUniformScale] = useState(false);
  const startDistance = useRef<number>(0);
  const startDirectionRef = useRef(new THREE.Vector2(1, 0));
  const { camera, gl } = useThree();

  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();
  
  // Map axis to gizmo handle type
  const handleType: GizmoHandleType = `scale-${axis}` as GizmoHandleType;
  
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
  const isPickingHovered = !suppressHover && hit.category === 'gizmo' && 
    'gizmoHandle' in hit && 
    hit.gizmoHandle === handleType;

  // Get colors for this axis
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  const shouldFlipX = axis === 'x' && (camera.position.x - gizmoPosition.x > 0);
  const shouldFlipY = axis === 'y' && (camera.position.y - gizmoPosition.y > 0);
  const shouldFlipZ = axis === 'z' && (camera.position.z - gizmoPosition.z > 0);

  // Position for each axis (at end of line) with camera-relative flipping
  const length = GIZMO_SIZES.scaleLineLength;
  const position: [number, number, number] =
    axis === 'x'
      ? [shouldFlipX ? length : -length, 0, 0]
      : axis === 'y'
      ? [0, shouldFlipY ? length : -length, 0]
      : [0, 0, shouldFlipZ ? length : -length];

  // Rotate hexagon to face perpendicular to axis
  const rotation: [number, number, number] =
    axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'y' ? [0, 0, 0] : [Math.PI / 2, 0, 0];

  const pickBoxGeometry = useMemo(
    () => getCachedBoxGeometry(
      GIZMO_SIZES.scaleHexagonRadius * 2.3,
      GIZMO_SIZES.scaleHexagonRadius * 2.3,
      GIZMO_SIZES.scaleHexagonRadius * 2.3,
    ),
    [],
  );
  const handleBoxGeometry = useMemo(() => getCachedBoxGeometry(1, 1, 1), []);
  const cubeEdgeGeometry = useMemo(() => getCachedScaleCubeEdgeGeometry(), []);

  const handlePointerEnter = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return;
    e.stopPropagation();
    onPointerEnter();
  };

  const handlePointerLeave = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return;
    e.stopPropagation();
    onPointerLeave();
  };

  const handleContextMenu = (e: ThreeEvent<MouseEvent>) => {
    // Prevent browser context menu on right-click
    e.stopPropagation();
    e.nativeEvent.preventDefault();
  };

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) {
      return;
    }
    if (!interactionsEnabled) {
      return;
    }
    
    e.stopPropagation();
    (e as any).stopped = true; // Mark event as handled for OrbitControls
    
    const isUniform = isUniformProp;
    setIsUniformScale(isUniform);
    
    // Store initial distance from gizmo center
    const gizmoScreenPos = gizmoPosition.clone().project(camera);
    const canvas = gl.domElement;
    const rect = canvas.getBoundingClientRect();
    const gizmoCenterX = ((gizmoScreenPos.x + 1) / 2) * rect.width + rect.left;
    const gizmoCenterY = ((-gizmoScreenPos.y + 1) / 2) * rect.height + rect.top;
    
    const deltaX = e.clientX - gizmoCenterX;
    const deltaY = e.clientY - gizmoCenterY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const safeDistance = Math.max(distance, 1e-6);
    startDistance.current = safeDistance;
    startDirectionRef.current.set(deltaX / safeDistance, deltaY / safeDistance);
    
    const allowed = onDragStart(isUniform);
    if (allowed === false) {
      return;
    }
    setIsDragging(true);
  };

  const getScaleFactor = useCallback((clientX: number, clientY: number, gizmoCenterX: number, gizmoCenterY: number): number => {
    // Scale along the original drag ray so crossing over the gizmo center does
    // not invert back into growth on the opposite side.
    const currentDeltaX = clientX - gizmoCenterX;
    const currentDeltaY = clientY - gizmoCenterY;
    const startDirection = startDirectionRef.current;
    const projectedDistance = (currentDeltaX * startDirection.x) + (currentDeltaY * startDirection.y);
    const ratio = projectedDistance / Math.max(startDistance.current, 1e-6);
    
    // Clamp to reasonable values (0.01 to 100x)
    return Math.max(0.01, Math.min(100.0, ratio));
  }, []);

  const handlePointerUp = () => {
    if (!isDragging) return;

    setIsDragging(false);
    onDragEnd();
  };

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      // Convert gizmo 3D position to screen space
      const gizmoScreenPos = gizmoPosition.clone().project(camera);
      const canvas = gl.domElement;
      const rect = canvas.getBoundingClientRect();
      const gizmoCenterX = ((gizmoScreenPos.x + 1) / 2) * rect.width + rect.left;
      const gizmoCenterY = ((-gizmoScreenPos.y + 1) / 2) * rect.height + rect.top;

      const factor = getScaleFactor(e.clientX, e.clientY, gizmoCenterX, gizmoCenterY);
      onDrag(factor, isUniformScale);
    };

    const handleGlobalPointerUp = () => {
      setIsDragging(false);
      onDragEnd();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [isDragging, isUniformScale, onDrag, onDragEnd, getScaleFactor, gizmoPosition, camera, gl]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = !suppressHover && (isPickingHovered || isHovered);
  const isHighlighted = !!(effectiveHovered || isActive);

  const baseOpacity = isHidden ? 0 : isDimmed ? 0.15 : isHighlighted ? 1.0 : 0.9;
  const opacity = baseOpacity * opacityScale;
  const highlightScale = isActive ? 1.14 : effectiveHovered ? 1.08 : 1.0;
  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  const handleColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : effectiveHovered
        ? GIZMO_COLORS.hover
        : axisColors.end;
  const edgeColor = useMemo(() => {
    const threeColor = new THREE.Color(handleColor);
    threeColor.multiplyScalar(0.3);
    return '#' + threeColor.getHexString();
  }, [handleColor]);

  // Emissive intensity based on state (uses effectiveHovered for GPU picking support)
  const emissiveIntensity = isActive
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

  return (
    <group>
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass.
          visible={false} when isHidden disables raycasting so this handle does
          not block pointer events during another gizmo's active drag. */}
      <mesh 
        ref={pickMeshRef}
        visible={!isHidden && interactionsEnabled}
        position={position}
        renderOrder={1000}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
      >
        <primitive object={pickBoxGeometry} attach="geometry" />
        <meshBasicMaterial visible={false} depthTest={false} />
      </mesh>
      {/* Connection line from center - DISABLED to avoid overlap with move arrows */}
      {/* <group rotation={lineRotation}>
        <Line
          points={[
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, GIZMO_SIZES.scaleLineLength, 0)
          ]}
          color={axisColors.end}
          lineWidth={4}
          depthTest={false}
        />
      </group> */}

      {/* Cube handle */}
      <group position={position}>
        <mesh scale={GIZMO_SIZES.scaleHexagonRadius * highlightScale}>
          <primitive object={handleBoxGeometry} attach="geometry" />
          <meshBasicMaterial
            color={handleColor}
            transparent
            opacity={opacity}
            depthTest={false}
          />
        </mesh>
        <lineSegments scale={GIZMO_SIZES.scaleHexagonRadius * highlightScale}>
          <primitive object={cubeEdgeGeometry} attach="geometry" />
          <lineBasicMaterial
            color={edgeColor}
            transparent
            opacity={opacity}
            depthTest={false}
          />
        </lineSegments>
      </group>

      {/* Point light at hexagon to cast colored light on model */}
      {!isDimmed && (
        <pointLight
          position={position}
          color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : axisColors.end}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
