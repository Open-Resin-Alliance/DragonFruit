"use client";

import React, { useState } from 'react';
import * as THREE from 'three';
import { GIZMO_COLORS, GIZMO_SIZES, DEFAULT_GIZMO_CONFIG } from './constants';
import type { TransformGizmoProps, GizmoAxis } from './types';
import { GizmoCenter } from './move/GizmoCenter';
import { GizmoMove } from './move/GizmoMove';
import { GizmoRotation } from './rotate/GizmoRotation';
import { GizmoScale } from './scale/GizmoScale';

/**
 * TransformGizmo - Unified 3D transform widget
 * 
 * Modular gizmo supporting move, rotate, and scale operations.
 * Features gradient colors matching world axes and unique hexagon scale handles.
 * 
 * @example
 * // Prepare mode - full transform
 * <TransformGizmo
 *   position={modelPosition}
 *   enableMove enableRotate enableScale
 *   onMove={(delta) => updatePosition(delta)}
 *   onRotate={(axis, angle) => updateRotation(axis, angle)}
 *   onScale={(axis, factor) => updateScale(axis, factor)}
 * />
 * 
 * @example
 * // Support mode - move and scale only
 * <TransformGizmo
 *   position={supportTip}
 *   enableMove enableScale
 *   constrainToSurface
 *   onMove={(delta) => updateTip(delta)}
 *   onScale={(axis, factor) => updateDiameter(factor)}
 * />
 */
export function TransformGizmo({
  position,
  rotation = [0, 0, 0],
  visible = true,
  enableMove = DEFAULT_GIZMO_CONFIG.enableMove,
  enableRotate = DEFAULT_GIZMO_CONFIG.enableRotate,
  enableScale = DEFAULT_GIZMO_CONFIG.enableScale,
  showMovePlanes = DEFAULT_GIZMO_CONFIG.showMovePlanes,
  showCenter = DEFAULT_GIZMO_CONFIG.showCenter,
  size = DEFAULT_GIZMO_CONFIG.size,
  opacity = DEFAULT_GIZMO_CONFIG.opacity,
  enableLighting = DEFAULT_GIZMO_CONFIG.enableLighting,
  constrainToSurface = DEFAULT_GIZMO_CONFIG.constrainToSurface,
  constrainToPlane = DEFAULT_GIZMO_CONFIG.constrainToPlane,
  axisLock = DEFAULT_GIZMO_CONFIG.axisLock,
  handleScale = 1.0, // New prop
  suppressAxisAnimations = false,
  onMoveStart,
  onMove,
  onMoveEnd,
  onRotateStart,
  onRotate,
  onRotateEnd,
  onScaleStart,
  onScale,
  onScaleEnd,
  onDragStateChange,
  rootRef,
}: TransformGizmoProps) {
  const gizmoRootRef = React.useRef<THREE.Group | null>(null);
  const [hoveredPart, setHoveredPart] = useState<string | null>(null);
  const [activePart, setActivePart] = useState<string | null>(null);
  const [isUniformScale, setIsUniformScale] = useState(false);

  React.useEffect(() => {
    if (!gizmoRootRef.current) return;

    gizmoRootRef.current.traverse((obj) => {
      obj.frustumCulled = false;
      obj.renderOrder = 2500;

      const material = (obj as THREE.Mesh).material;
      if (!material) return;

      const applyOverlayMaterial = (m: THREE.Material) => {
        if ('depthTest' in m) (m as THREE.Material & { depthTest: boolean }).depthTest = false;
        if ('depthWrite' in m) (m as THREE.Material & { depthWrite: boolean }).depthWrite = false;
      };

      if (Array.isArray(material)) {
        material.forEach(applyOverlayMaterial);
      } else {
        applyOverlayMaterial(material);
      }
    });
  }, []);

  const setGizmoRootRef = React.useCallback((node: THREE.Group | null) => {
    gizmoRootRef.current = node;
    if (rootRef) {
      rootRef.current = node;
    }
  }, [rootRef]);

  if (!visible) return null;

  // Convert position to array if it's a Vector3
  const posArray: [number, number, number] = Array.isArray(position)
    ? position
    : [position.x, position.y, position.z];

  // Convert position to Vector3 for passing to child components
  const posVec = Array.isArray(position) 
    ? new THREE.Vector3(...position)
    : position;

  // Convert rotation to array if it's an Euler
  const rotArray: [number, number, number] = Array.isArray(rotation)
    ? rotation
    : [rotation.x, rotation.y, rotation.z];

  const handlePointerEnter = (part: string) => {
    if (!activePart) {
      setHoveredPart(part);
    }
  };

  const handlePointerLeave = () => {
    if (!activePart) {
      setHoveredPart(null);
    }
  };

  const handleDragStart = (part: string, isUniform?: boolean): boolean => {
    const axisFromPart = part.endsWith('-x')
      ? 'x'
      : part.endsWith('-y')
        ? 'y'
        : part.endsWith('-z')
          ? 'z'
          : undefined;

    if ((part === 'center' || part.startsWith('axis-')) && onMoveStart) {
      const allowed = onMoveStart(axisFromPart);
      if (allowed === false) return false;
    }

    if (part.startsWith('ring-') && onRotateStart) {
      if (!axisFromPart) return false;
      const allowed = onRotateStart(axisFromPart);
      if (allowed === false) return false;
    }

    if (part.startsWith('scale-') && onScaleStart) {
      if (!axisFromPart) return false;
      const allowed = onScaleStart(axisFromPart, Boolean(isUniform));
      if (allowed === false) return false;
    }

    setActivePart(part);
    setHoveredPart(null);
    
    // Store uniform scale mode for scale operations
    if (part.startsWith('scale-') && isUniform !== undefined) {
      setIsUniformScale(isUniform);
    }
    
    // Notify parent that dragging started (to disable OrbitControls)
    if (onDragStateChange) onDragStateChange(true);

    return true;
  };

  const handleDragEnd = () => {
    const part = activePart;
    setActivePart(null);
    
    // Notify parent that dragging ended (to re-enable OrbitControls)
    if (onDragStateChange) onDragStateChange(false);
    
    if (part === 'center' && onMoveEnd) onMoveEnd();
    if (part?.startsWith('axis-') && onMoveEnd) onMoveEnd();
    if (part?.startsWith('ring-') && onRotateEnd) onRotateEnd();
    if (part?.startsWith('scale-') && onScaleEnd) onScaleEnd();
  };

  const handleAxisMove = (axis: GizmoAxis, delta: THREE.Vector3) => {
    if (onMove) {
      // Delta is already axis-constrained in GizmoMove.
      onMove(delta, axis);
    }
  };

  const handleCenterMove = (delta: THREE.Vector3) => {
    if (onMove) {
      onMove(delta);
    }
  };

  const handleRotate = (axis: GizmoAxis, angle: number) => {
    if (onRotate) {
      onRotate(axis, angle);
    }
  };

  const handleScaleDrag = (axis: GizmoAxis, factor: number, isUniform: boolean) => {
    if (onScale) {
      // If uniform scaling, apply to all axes. Otherwise, apply to specific axis.
      if (isUniform) {
        onScale('uniform', factor);
      } else {
        onScale(axis, factor);
      }
    }
  };

  const isDimmed = (part: string) => {
    // Only dim while actively dragging; do not dim on hover.
    const focusedPart = activePart;
    return focusedPart !== null && focusedPart !== part;
  };

  const isHidden = (part: string) => {
    // Hide all parts except the active one during drag
    return activePart !== null && activePart !== part;
  };

  return (
    <group ref={setGizmoRootRef} position={posArray} rotation={rotArray} scale={size} renderOrder={2500}>
      {/* Center plane - XY movement only */}
      {enableMove && showCenter && (
        <GizmoCenter
          isHovered={hoveredPart === 'center'}
          isActive={activePart === 'center'}
          isDimmed={isDimmed('center')}
          isHidden={isHidden('center')}
          gizmoPosition={posVec}
          onDragStart={() => handleDragStart('center')}
          onDrag={handleCenterMove}
          onDragEnd={handleDragEnd}
          onPointerEnter={() => handlePointerEnter('center')}
          onPointerLeave={handlePointerLeave}
        />
      )}

      {/* Axis arrows - constrained movement */}
      {enableMove && (
        <>
          <GizmoMove
            axis="x"
            isHovered={hoveredPart === 'axis-x'}
            isActive={activePart === 'axis-x'}
            isDimmed={isDimmed('axis-x')}
            isHidden={isHidden('axis-x')}
            enableLighting={enableLighting}
            gizmoPosition={posVec}
            handleScale={handleScale}
            onDragStart={() => handleDragStart('axis-x')}
            onDrag={(delta: THREE.Vector3) => handleAxisMove('x', delta)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('axis-x')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoMove
            axis="y"
            isHovered={hoveredPart === 'axis-y'}
            isActive={activePart === 'axis-y'}
            isDimmed={isDimmed('axis-y')}
            isHidden={isHidden('axis-y')}
            enableLighting={enableLighting}
            gizmoPosition={posVec}
            handleScale={handleScale}
            onDragStart={() => handleDragStart('axis-y')}
            onDrag={(delta: THREE.Vector3) => handleAxisMove('y', delta)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('axis-y')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoMove
            axis="z"
            isHovered={hoveredPart === 'axis-z'}
            isActive={activePart === 'axis-z'}
            isDimmed={isDimmed('axis-z')}
            isHidden={isHidden('axis-z')}
            enableLighting={enableLighting}
            gizmoPosition={posVec}
            handleScale={handleScale}
            onDragStart={() => handleDragStart('axis-z')}
            onDrag={(delta: THREE.Vector3) => handleAxisMove('z', delta)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('axis-z')}
            onPointerLeave={handlePointerLeave}
          />
        </>
      )}

      {/* Rotation rings with diamond handles */}
      {enableRotate && (
        <>
          <GizmoRotation
            axis="x"
            isHovered={hoveredPart === 'ring-x'}
            isActive={activePart === 'ring-x'}
            isDimmed={isDimmed('ring-x')}
            isHidden={isHidden('ring-x')}
            suppressAxisAnimations={suppressAxisAnimations}
            gizmoPosition={posVec}
            onDragStart={() => handleDragStart('ring-x')}
            onDrag={(angle: number) => handleRotate('x', angle)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('ring-x')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoRotation
            axis="y"
            isHovered={hoveredPart === 'ring-y'}
            isActive={activePart === 'ring-y'}
            isDimmed={isDimmed('ring-y')}
            isHidden={isHidden('ring-y')}
            suppressAxisAnimations={suppressAxisAnimations}
            gizmoPosition={posVec}
            onDragStart={() => handleDragStart('ring-y')}
            onDrag={(angle: number) => handleRotate('y', angle)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('ring-y')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoRotation
            axis="z"
            isHovered={hoveredPart === 'ring-z'}
            isActive={activePart === 'ring-z'}
            isDimmed={isDimmed('ring-z')}
            isHidden={isHidden('ring-z')}
            suppressAxisAnimations={suppressAxisAnimations}
            gizmoPosition={posVec}
            onDragStart={() => handleDragStart('ring-z')}
            onDrag={(angle: number) => handleRotate('z', angle)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('ring-z')}
            onPointerLeave={handlePointerLeave}
          />
        </>
      )}

      {/* Scale hexagons */}
      {enableScale && (
        <>
          <GizmoScale
            axis="x"
            isHovered={hoveredPart === 'scale-x'}
            isActive={activePart === 'scale-x'}
            isDimmed={isDimmed('scale-x')}
            isHidden={isHidden('scale-x')}
            gizmoPosition={posVec}
            onDragStart={(isUniform: boolean) => handleDragStart('scale-x', isUniform)}
            onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('x', factor, isUniform)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('scale-x')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoScale
            axis="y"
            isHovered={hoveredPart === 'scale-y'}
            isActive={activePart === 'scale-y'}
            isDimmed={isDimmed('scale-y')}
            isHidden={isHidden('scale-y')}
            gizmoPosition={posVec}
            onDragStart={(isUniform: boolean) => handleDragStart('scale-y', isUniform)}
            onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('y', factor, isUniform)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('scale-y')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoScale
            axis="z"
            isHovered={hoveredPart === 'scale-z'}
            isActive={activePart === 'scale-z'}
            isDimmed={isDimmed('scale-z')}
            isHidden={isHidden('scale-z')}
            gizmoPosition={posVec}
            onDragStart={(isUniform: boolean) => handleDragStart('scale-z', isUniform)}
            onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('z', factor, isUniform)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('scale-z')}
            onPointerLeave={handlePointerLeave}
          />
        </>
      )}
    </group>
  );
}
