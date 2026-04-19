"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree } from '@react-three/fiber';
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
  suppressHover?: boolean;
  opacityScale?: number;
  enableLighting?: boolean;
  gizmoPosition: THREE.Vector3;
  handleScale?: number;
  moveHandleBidirectional?: boolean;
  moveHandleLengthScale?: number;
  moveHandleThicknessScale?: number;
  onDragStart: () => boolean | void;
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
  suppressHover = false,
  opacityScale = 1,
  enableLighting = true,
  gizmoPosition,
  handleScale = 1.0,
  moveHandleBidirectional = false,
  moveHandleLengthScale = 1.0,
  moveHandleThicknessScale = 1.0,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoMoveProps) {
  const MIN_AXIS_DELTA = 1e-10;
  const [isDragging, setIsDragging] = useState(false);
  const lastAxisParamRef = useRef<number | null>(null);
  // Axis origin captured at drag-start; kept stable for the whole drag so that
  // frame-to-frame t-values are in the same coordinate frame even as the model
  // (and therefore gizmoPosition) moves in response to onDrag calls.
  const dragAxisOriginRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const raycasterRef = useRef(new THREE.Raycaster());
  const ndcRef = useRef(new THREE.Vector2());
  const axisDeltaRef = useRef(new THREE.Vector3());
  const scratchAxisDirRef = useRef(new THREE.Vector3());
  const scratchAxisToRayRef = useRef(new THREE.Vector3());
  const { camera, gl, invalidate } = useThree();

  const pickMeshRef = useRef<THREE.Group>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();

  const handleType: GizmoHandleType = `move-${axis}` as GizmoHandleType;

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

  const isPickingHovered = !suppressHover && hit.category === 'gizmo' && 'gizmoHandle' in hit && hit.gizmoHandle === handleType;
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  const shaftLength = Math.max(0.3, GIZMO_SIZES.arrowShaftLength * moveHandleLengthScale);
  const shaftRadius = Math.max(0.008, 0.02 * moveHandleThicknessScale);
  const headRadius = Math.max(0.03, GIZMO_SIZES.arrowHeadRadius * moveHandleThicknessScale);
  const headLength = Math.max(0.08, GIZMO_SIZES.arrowHeadLength * moveHandleLengthScale);

  const shouldFlipX = axis === 'x' && (camera.position.x - gizmoPosition.x > 0);
  const shouldFlipY = axis === 'y' && (camera.position.y - gizmoPosition.y > 0);
  const shouldFlipZ = axis === 'z' && (camera.position.z - gizmoPosition.z > 0);

  const rotation: [number, number, number] =
    axis === 'x' ? [0, 0, shouldFlipX ? -Math.PI / 2 : Math.PI / 2]
    : axis === 'y' ? [0, 0, shouldFlipY ? 0 : Math.PI]
    : axis === 'z' ? (shouldFlipZ ? [Math.PI / 2, 0, 0] : [-Math.PI / 2, 0, 0])
    : [0, 0, 0];

  const getAxisParamFromMouse = useCallback((clientX: number, clientY: number): number | null => {
    const rect = gl.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const ndc = ndcRef.current;
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);

    const axisDir = scratchAxisDirRef.current;
    if (axis === 'x') axisDir.set(1, 0, 0);
    else if (axis === 'y') axisDir.set(0, 1, 0);
    else axisDir.set(0, 0, 1);

    // Closest points between the infinite drag axis line and pointer ray.
    // Uses the FIXED drag origin (captured at pointer-down) as the axis reference
    // point, so t-values are comparable across frames even as gizmoPosition
    // updates in response to onDrag calls.
    const ray = raycaster.ray;
    const origin = dragAxisOriginRef.current;
    const axisToRay = scratchAxisToRayRef.current.copy(origin).sub(ray.origin);
    const axisDotRay = axisDir.dot(ray.direction);
    const axisDotAxisToRay = axisDir.dot(axisToRay);
    const rayDotAxisToRay = ray.direction.dot(axisToRay);
    const denom = 1 - (axisDotRay * axisDotRay);

    // Degenerate case: pointer ray nearly parallel to the axis.
    if (Math.abs(denom) < 1e-6) {
      return axisDotAxisToRay;
    }

    return ((axisDotRay * rayDotAxisToRay) - axisDotAxisToRay) / denom;
  // gizmoPosition intentionally excluded — we use dragAxisOriginRef (stable).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, camera, gl]);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button === 2) return;
    if (isHidden) return;

    e.stopPropagation();
    e.stopped = true;

    // Snapshot the gizmo position as the fixed axis origin for this drag.
    // All subsequent t-values will be relative to this point.
    dragAxisOriginRef.current.copy(gizmoPosition);

    const initialAxisParam = getAxisParamFromMouse(e.clientX, e.clientY);
    if (initialAxisParam == null) return;

    const allowed = onDragStart();
    if (allowed === false) return;

    setIsDragging(true);
    lastAxisParamRef.current = initialAxisParam;
  };

  const handlePointerEnterLocal = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerEnter();
  };

  const handlePointerLeaveLocal = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onPointerLeave();
  };

  const axisDirection = useMemo(() => {
    if (axis === 'x') return new THREE.Vector3(1, 0, 0);
    if (axis === 'y') return new THREE.Vector3(0, 1, 0);
    return new THREE.Vector3(0, 0, 1);
  }, [axis]);

  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      const lastAxisParam = lastAxisParamRef.current;
      if (lastAxisParam == null) return;

      const nextAxisParam = getAxisParamFromMouse(e.clientX, e.clientY);
      if (nextAxisParam == null) return;

      const axisMagnitude = nextAxisParam - lastAxisParam;
      if (Math.abs(axisMagnitude) < MIN_AXIS_DELTA) return;

      const delta = axisDeltaRef.current.copy(axisDirection).multiplyScalar(axisMagnitude);
      onDrag(delta);
      // onDrag mutates three.js refs directly (no React state change) — in
      // demand mode nothing would render without this invalidate.
      invalidate();
      lastAxisParamRef.current = nextAxisParam;
    };

    const handleGlobalPointerUp = () => {
      setIsDragging(false);
      lastAxisParamRef.current = null;
      onDragEnd();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [axisDirection, getAxisParamFromMouse, isDragging, onDrag, onDragEnd]);

  const effectiveHovered = !suppressHover && (isPickingHovered || isHovered);
  const isHighlighted = !!isActive;

  const baseOpacity = isHidden ? 0 : isDimmed ? 0.15 : isHighlighted ? 1.0 : 0.9;
  const opacity = baseOpacity * opacityScale;
  const hoverScale = isActive ? 1.18 : effectiveHovered ? 1.1 : 1.0;
  const dimmedColor = '#cccccc';
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  const gradientGeometry = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 8, 1);
    const colors = new Float32Array(geometry.attributes.position.count * 3);

    const pureCenterColor = axis === 'x' ? '#ff0000' : axis === 'y' ? '#0ce300' : '#0000ff';
    const secondaryColor = axis === 'x' ? '#ff9900' : axis === 'y' ? '#ffcc00' : '#1596ff';

    const startColor = new THREE.Color(pureCenterColor);
    const endColor = new THREE.Color(secondaryColor);

    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const y = geometry.attributes.position.getY(i);
      const normalizedPos = (y + shaftLength / 2) / shaftLength;
      const t = Math.max(0, (normalizedPos - 0.33) / 0.67);
      const color = new THREE.Color().lerpColors(startColor, endColor, t);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [axis, shaftLength, shaftRadius]);

  const endColorHex = isActive
    ? GIZMO_COLORS.active
    : effectiveHovered
      ? GIZMO_COLORS.hover
      : axisColors.end;

  const arrowTipPosition: [number, number, number] = [0, shaftLength, 0];
  const oppositeArrowTipPosition: [number, number, number] = [0, -shaftLength, 0];
  const pickTipRadius = Math.max(0.14, headRadius * 2.35);

  return (
    <group rotation={rotation}>
      {/* Invisible sphere pick targets. visible={!isHidden} is on the MESH,
          not the parent group, so Three.js raycasting is actually suppressed
          on hidden handles (R3F registers leaf meshes in internal.interaction,
          and Three.js checks each object's OWN .visible, not its parent). */}
      <group ref={pickMeshRef}>
        <mesh
          visible={!isHidden}
          position={arrowTipPosition}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnterLocal}
          onPointerLeave={handlePointerLeaveLocal}
          scale={handleScale}
        >
          <sphereGeometry args={[pickTipRadius, 12, 12]} />
          <meshBasicMaterial visible={false} depthTest={false} />
        </mesh>

        {moveHandleBidirectional && (
          <mesh
            visible={!isHidden}
            position={oppositeArrowTipPosition}
            onPointerDown={handlePointerDown}
            onPointerEnter={handlePointerEnterLocal}
            onPointerLeave={handlePointerLeaveLocal}
            scale={handleScale}
          >
            <sphereGeometry args={[pickTipRadius, 12, 12]} />
            <meshBasicMaterial visible={false} depthTest={false} />
          </mesh>
        )}
      </group>

      <mesh position={[0, shaftLength / 2, 0]} geometry={gradientGeometry} renderOrder={-10}>
        <meshBasicMaterial
          vertexColors={!isDimmed}
          color={isDimmed ? dimmedColor : isActive ? '#ffffff' : '#f2f2f2'}
          opacity={opacity}
          transparent
          depthTest={false}
          toneMapped={false}
        />
      </mesh>

      {moveHandleBidirectional && (
        <mesh position={[0, -shaftLength / 2, 0]} geometry={gradientGeometry} rotation={[0, 0, Math.PI]} renderOrder={-10}>
          <meshBasicMaterial
            vertexColors={!isDimmed}
            color={isDimmed ? dimmedColor : isActive ? '#ffffff' : '#f2f2f2'}
            opacity={opacity}
            transparent
            depthTest={false}
            toneMapped={false}
          />
        </mesh>
      )}

      <group position={arrowTipPosition} scale={handleScale * hoverScale}>
        <mesh scale={1.15}>
          <coneGeometry args={[headRadius, headLength, 8]} />
          <meshBasicMaterial
            color={isDimmed ? new THREE.Color(dimmedColor).multiplyScalar(0.7).getHex() : new THREE.Color(endColorHex).multiplyScalar(0.3).getHex()}
            opacity={opacity}
            transparent
            depthTest={false}
          />
        </mesh>

        <mesh>
          <coneGeometry args={[headRadius, headLength, 8]} />
          <meshBasicMaterial
            color={isDimmed ? dimmedColor : endColorHex}
            opacity={opacity}
            transparent
            depthTest={false}
          />
        </mesh>
      </group>

      {moveHandleBidirectional && (
        <group position={oppositeArrowTipPosition} rotation={[Math.PI, 0, 0]} scale={handleScale * hoverScale}>
          <mesh scale={1.15}>
            <coneGeometry args={[headRadius, headLength, 8]} />
            <meshBasicMaterial
              color={isDimmed ? new THREE.Color(dimmedColor).multiplyScalar(0.7).getHex() : new THREE.Color(endColorHex).multiplyScalar(0.3).getHex()}
              opacity={opacity}
              transparent
              depthTest={false}
            />
          </mesh>

          <mesh>
            <coneGeometry args={[headRadius, headLength, 8]} />
            <meshBasicMaterial
              color={isDimmed ? dimmedColor : endColorHex}
              opacity={opacity}
              transparent
              depthTest={false}
            />
          </mesh>
        </group>
      )}

      {enableLighting && !isDimmed && (
        <pointLight
          position={arrowTipPosition}
          color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : axisColors.end}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}

      {moveHandleBidirectional && enableLighting && !isDimmed && (
        <pointLight
          position={oppositeArrowTipPosition}
          color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : axisColors.end}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
