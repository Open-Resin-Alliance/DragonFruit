"use client";

import React, { useState } from 'react';
import * as THREE from 'three';
import { DEFAULT_GIZMO_CONFIG } from './constants';
import type { TransformGizmoProps, GizmoAxis } from './types';
import { GizmoCenter } from './move/GizmoCenter';
import { GizmoMove } from './move/GizmoMove';
import { GizmoRotation } from './rotate/GizmoRotation';
import { GizmoScale } from './scale/GizmoScale';
import { usePicking } from '@/components/picking';

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
  handleScale = 1.0,
  moveHandleBidirectional = false,
  moveHandleLengthScale = 1.0,
  moveHandleThicknessScale = 1.0,
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
  const { isDragging: isGlobalDragging } = usePicking();
  const gizmoRootRef = React.useRef<THREE.Group | null>(null);
  const [hoveredPart, setHoveredPart] = useState<string | null>(null);
  const [activePart, setActivePart] = useState<string | null>(null);
  const [isUniformScale, setIsUniformScale] = useState(false);
  const activePartRef = React.useRef<string | null>(null);
  const hoverClearRafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!gizmoRootRef.current) return;

    gizmoRootRef.current.traverse((obj) => {
      obj.frustumCulled = false;
      // Cross-section stencil cap renders at ~9800. Gizmo must be above
      // that so handles are never obscured by the cap fill.
      obj.renderOrder = 9900;
      // Mark only renderable gizmo handle geometry so pointer handlers can detect
      // gizmo involvement from intersections. Do NOT tag lights/targets; those
      // should not be hidden during thumbnail capture because it changes lighting.
      if (
        obj instanceof THREE.Mesh
        || obj instanceof THREE.Line
        || obj instanceof THREE.LineSegments
        || obj instanceof THREE.Points
      ) {
        obj.userData.isGizmoHandle = true;
      }

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

  React.useEffect(() => {
    return () => {
      if (hoverClearRafRef.current !== null) {
        window.cancelAnimationFrame(hoverClearRafRef.current);
        hoverClearRafRef.current = null;
      }
    };
  }, []);

  const setGizmoRootRef = React.useCallback((node: THREE.Group | null) => {
    gizmoRootRef.current = node;
    if (rootRef) {
      rootRef.current = node;
    }
  }, [rootRef]);

  if (!visible) return null;

  const posArray: [number, number, number] = Array.isArray(position)
    ? position
    : [position.x, position.y, position.z];

  const posVec = Array.isArray(position)
    ? new THREE.Vector3(...position)
    : position;

  const rotArray: [number, number, number] = Array.isArray(rotation)
    ? rotation
    : [rotation.x, rotation.y, rotation.z];

  const handlePointerEnter = (part: string) => {
    if (isGlobalDragging) return;
    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }

    if (!activePartRef.current) {
      setHoveredPart(part);
    }
  };

  const handlePointerLeave = () => {
    if (isGlobalDragging) return;
    if (activePartRef.current) return;

    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
    }

    hoverClearRafRef.current = window.requestAnimationFrame(() => {
      hoverClearRafRef.current = null;
      if (!activePartRef.current) {
        setHoveredPart(null);
      }
    });
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
    activePartRef.current = part;
    setHoveredPart(null);

    if (part.startsWith('scale-') && isUniform !== undefined) {
      setIsUniformScale(isUniform);
    }

    if (onDragStateChange) onDragStateChange(true);

    return true;
  };

  const handleDragEnd = () => {
    const part = activePart;
    setActivePart(null);
    activePartRef.current = null;

    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }

    if (onDragStateChange) onDragStateChange(false);

    if (part === 'center' && onMoveEnd) onMoveEnd();
    if (part?.startsWith('axis-') && onMoveEnd) onMoveEnd();
    if (part?.startsWith('ring-') && onRotateEnd) onRotateEnd();
    if (part?.startsWith('scale-') && onScaleEnd) onScaleEnd();
  };

  const handleAxisMove = (axis: GizmoAxis, delta: THREE.Vector3) => {
    if (onMove) {
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
      if (isUniform) {
        onScale('uniform', factor);
      } else {
        onScale(axis, factor);
      }
    }
  };

  const isDimmed = (part: string) => {
    const focusedPart = activePart;
    return focusedPart !== null && focusedPart !== part;
  };

  const isHidden = (part: string) => {
    return activePart !== null && activePart !== part;
  };

  const isAxisAllowed = (axis: GizmoAxis) => !axisLock || axisLock === axis;
  const suppressHover = isGlobalDragging;
  const dragOpacityScale = isGlobalDragging ? 0.6 : 1;

  React.useEffect(() => {
    if (!suppressHover) return;
    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    setHoveredPart(null);
  }, [suppressHover]);

  return (
    <group ref={setGizmoRootRef} position={posArray} rotation={rotArray} scale={size} renderOrder={9900}>
      {enableMove && showCenter && (
        <GizmoCenter
          isHovered={!suppressHover && hoveredPart === 'center'}
          isActive={activePart === 'center'}
          isDimmed={isDimmed('center')}
          isHidden={isHidden('center')}
          suppressHover={suppressHover}
          opacityScale={dragOpacityScale}
          gizmoPosition={posVec}
          onDragStart={() => handleDragStart('center')}
          onDrag={handleCenterMove}
          onDragEnd={handleDragEnd}
          onPointerEnter={() => handlePointerEnter('center')}
          onPointerLeave={handlePointerLeave}
        />
      )}

      {enableMove && (
        <>
          {isAxisAllowed('x') && (
            <GizmoMove
              axis="x"
              isHovered={!suppressHover && hoveredPart === 'axis-x'}
              isActive={activePart === 'axis-x'}
              isDimmed={isDimmed('axis-x')}
              isHidden={isHidden('axis-x')}
              suppressHover={suppressHover}
              opacityScale={dragOpacityScale}
              enableLighting={enableLighting}
              gizmoPosition={posVec}
              handleScale={handleScale}
              moveHandleBidirectional={moveHandleBidirectional}
              moveHandleLengthScale={moveHandleLengthScale}
              moveHandleThicknessScale={moveHandleThicknessScale}
              onDragStart={() => handleDragStart('axis-x')}
              onDrag={(delta: THREE.Vector3) => handleAxisMove('x', delta)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('axis-x')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {isAxisAllowed('y') && (
            <GizmoMove
              axis="y"
              isHovered={!suppressHover && hoveredPart === 'axis-y'}
              isActive={activePart === 'axis-y'}
              isDimmed={isDimmed('axis-y')}
              isHidden={isHidden('axis-y')}
              suppressHover={suppressHover}
              opacityScale={dragOpacityScale}
              enableLighting={enableLighting}
              gizmoPosition={posVec}
              handleScale={handleScale}
              moveHandleBidirectional={moveHandleBidirectional}
              moveHandleLengthScale={moveHandleLengthScale}
              moveHandleThicknessScale={moveHandleThicknessScale}
              onDragStart={() => handleDragStart('axis-y')}
              onDrag={(delta: THREE.Vector3) => handleAxisMove('y', delta)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('axis-y')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {isAxisAllowed('z') && (
            <GizmoMove
              axis="z"
              isHovered={!suppressHover && hoveredPart === 'axis-z'}
              isActive={activePart === 'axis-z'}
              isDimmed={isDimmed('axis-z')}
              isHidden={isHidden('axis-z')}
              suppressHover={suppressHover}
              opacityScale={dragOpacityScale}
              enableLighting={enableLighting}
              gizmoPosition={posVec}
              handleScale={handleScale}
              moveHandleBidirectional={moveHandleBidirectional}
              moveHandleLengthScale={moveHandleLengthScale}
              moveHandleThicknessScale={moveHandleThicknessScale}
              onDragStart={() => handleDragStart('axis-z')}
              onDrag={(delta: THREE.Vector3) => handleAxisMove('z', delta)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('axis-z')}
              onPointerLeave={handlePointerLeave}
            />
          )}
        </>
      )}

      {enableRotate && (
        <>
          <GizmoRotation
            axis="x"
            isHovered={!suppressHover && hoveredPart === 'ring-x'}
            isActive={activePart === 'ring-x'}
            isDimmed={isDimmed('ring-x')}
            isHidden={isHidden('ring-x')}
            suppressHover={suppressHover}
            opacityScale={dragOpacityScale}
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
            isHovered={!suppressHover && hoveredPart === 'ring-y'}
            isActive={activePart === 'ring-y'}
            isDimmed={isDimmed('ring-y')}
            isHidden={isHidden('ring-y')}
            suppressHover={suppressHover}
            opacityScale={dragOpacityScale}
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
            isHovered={!suppressHover && hoveredPart === 'ring-z'}
            isActive={activePart === 'ring-z'}
            isDimmed={isDimmed('ring-z')}
            isHidden={isHidden('ring-z')}
            suppressHover={suppressHover}
            opacityScale={dragOpacityScale}
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

      {enableScale && (
        <>
          <GizmoScale
            axis="x"
            isHovered={!suppressHover && hoveredPart === 'scale-x'}
            isActive={activePart === 'scale-x'}
            isDimmed={isDimmed('scale-x')}
            isHidden={isHidden('scale-x')}
            suppressHover={suppressHover}
            opacityScale={dragOpacityScale}
            gizmoPosition={posVec}
            onDragStart={(isUniform: boolean) => handleDragStart('scale-x', isUniform)}
            onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('x', factor, isUniform)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('scale-x')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoScale
            axis="y"
            isHovered={!suppressHover && hoveredPart === 'scale-y'}
            isActive={activePart === 'scale-y'}
            isDimmed={isDimmed('scale-y')}
            isHidden={isHidden('scale-y')}
            suppressHover={suppressHover}
            opacityScale={dragOpacityScale}
            gizmoPosition={posVec}
            onDragStart={(isUniform: boolean) => handleDragStart('scale-y', isUniform)}
            onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('y', factor, isUniform)}
            onDragEnd={handleDragEnd}
            onPointerEnter={() => handlePointerEnter('scale-y')}
            onPointerLeave={handlePointerLeave}
          />
          <GizmoScale
            axis="z"
            isHovered={!suppressHover && hoveredPart === 'scale-z'}
            isActive={activePart === 'scale-z'}
            isDimmed={isDimmed('scale-z')}
            isHidden={isHidden('scale-z')}
            suppressHover={suppressHover}
            opacityScale={dragOpacityScale}
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