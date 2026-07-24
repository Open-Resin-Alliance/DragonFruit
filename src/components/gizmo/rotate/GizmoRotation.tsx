"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import {
  snapAngle,
  SNAP_COARSE,
  SNAP_FINE,
  SNAP_STORAGE_KEY,
  nearestTickRad,
  shortestAngleDelta,
  objectAngleForRingAngle,
  parseSnapTickConfig,
  SNAP_TICK_CONFIG_STORAGE_KEY,
  DEFAULT_SNAP_TICK_CONFIG,
  type SnapTickConfig,
} from './snapRotation';
import { SnapTickDial } from './SnapTickDial';
import { AngleSpoke } from './AngleSpoke';
import type { GizmoAxis } from '../types';
import {
  getCachedConeGeometry,
  getCachedRotationArcGeometry,
  getCachedRotationArcPoints,
  getCachedRingGeometry,
  getCachedSphereGeometry,
} from '../gizmoGeometryCache';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

const ROTATION_CENTER_DEADZONE_PX = 24;
const ROTATION_NEAR_CENTER_JUMP_GUARD_PX = 56;
const ROTATION_NEAR_CENTER_MAX_DELTA = Math.PI / 2;

interface GizmoRotationProps {
  axis: GizmoAxis;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  suppressHover?: boolean;
  opacityScale?: number;
  interactionsEnabled?: boolean;
  suppressAxisAnimations?: boolean;
  enableLighting?: boolean;
  gizmoPosition: THREE.Vector3;
  disableRingBillboard?: boolean;
  /** Scale factor for the rotation handle (diamond cones and pick sphere) relative to gizmo size */
  handleScale?: number;
  /**
   * World-space direction of this ring's rotation axis.
   * When the gizmo parent group is rotated, the hardcoded world-axis
   * comparison in computeShouldFlip no longer matches the visual axis.
   * Pass the world-space direction so flip detection is correct.
   */
  worldAxisDir?: THREE.Vector3;
  /**
   * Optional override for the visual animation sign.
   * Set to -1 to invert the ring handle animation direction relative to the
   * object rotation (e.g. when the gizmo local frame has an inverted axis
   * convention like displayY = -cutterY in HolePunchGizmo).
   */
  axisVisualFlip?: number;
  /**
   * The object's current rotation about this ring's axis, in radians.
   *
   * Required, not optional: the dial and angle spoke render against it, and an
   * omitted value would silently draw a spoke at 0 degrees — which still lands
   * on a real tick and so reads as correct rather than missing.
   */
  currentAngleRad: number;
  onDragStart: () => boolean | void;
  onDrag: (angle: number) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

function getPositiveAxisMidpointAngle(axis: GizmoAxis): number {
  if (axis === 'x') {
    // X rotation lives in the Y/Z plane. In X-ring local space,
    // +Y is local +Y and +Z is local -X.
    return (3 * Math.PI) / 4;
  }
  if (axis === 'y') {
    // Y rotation lives in the X/Z plane. With the +Y ring orientation,
    // +X is local +X and +Z is local -Y.
    return -Math.PI / 4;
  }
  // Z rotation lives in the X/Y plane, directly between local +X and +Y.
  return Math.PI / 4;
}

/**
 * GizmoRotation - Ring with diamond handle for rotation
 */
export function GizmoRotation({
  axis,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  suppressHover = false,
  opacityScale = 1,
  interactionsEnabled = true,
  suppressAxisAnimations = false,
  enableLighting = true,
  gizmoPosition,
  disableRingBillboard = false,
  handleScale = 1.0,
  worldAxisDir,
  axisVisualFlip = 1,
  currentAngleRad,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoRotationProps) {
  const [isDragging, setIsDragging] = useState(false);
  /** Pointer-down screen position on the dial, used to tell a click from a drag. */
  const dialPointerDownRef = useRef<{ x: number; y: number } | null>(null);
  /** Ring-local angle of the tick under the cursor, for hover highlighting. */
  const [hoveredTickRad, setHoveredTickRad] = useState<number | null>(null);
  /** Persisted tier intervals (#104). Parsed defensively — see parseSnapTickConfig. */
  const [tickConfig, setTickConfig] = useState<SnapTickConfig>(() => {
    try {
      return parseSnapTickConfig(localStorage.getItem(SNAP_TICK_CONFIG_STORAGE_KEY));
    } catch {
      return DEFAULT_SNAP_TICK_CONFIG;
    }
  });
  const positiveAxisMidpointAngle = getPositiveAxisMidpointAngle(axis);
  const handleAngleRef = useRef<number>(positiveAxisMidpointAngle);
  const targetHandleAngleRef = useRef<number>(positiveAxisMidpointAngle);
  const billboardRotationRef = useRef<number>(0);
  const lastMouseAngle = useRef<number>(0);
  const shouldFlipRef = useRef(false);
  // Snap rotation refs (object-space)
  const rawAccumulatedAngleRef = useRef<number>(0);
  const lastSnappedAngleRef = useRef<number>(0);
  const prevSnapIncrementRef = useRef<number | null>(null);
  // Callback refs to stabilize useEffect deps (prevents effect churn during drag)
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const rotatingArcRef = useRef<THREE.Group>(null);
  const handleRootRef = useRef<THREE.Group>(null);
  const billboardGroupRef = useRef<THREE.Group>(null);
  const pointLightRef = useRef<THREE.PointLight>(null);
  const { camera, gl, invalidate } = useThree();

  useEffect(() => {
    onDragRef.current = onDrag;
    onDragEndRef.current = onDragEnd;
  }, [onDrag, onDragEnd]);

  // Follow live edits from the settings panel, mirroring how the snap toggle
  // broadcasts. invalidate() because under demand mode nothing else would draw.
  useEffect(() => {
    const reload = () => {
      try {
        setTickConfig(parseSnapTickConfig(localStorage.getItem(SNAP_TICK_CONFIG_STORAGE_KEY)));
      } catch {
        setTickConfig(DEFAULT_SNAP_TICK_CONFIG);
      }
      invalidate();
    };
    window.addEventListener('dragonfruit:tick-config-change', reload);
    return () => window.removeEventListener('dragonfruit:tick-config-change', reload);
  }, [invalidate]);

  const computeShouldFlip = useCallback(() => {
    if (worldAxisDir) {
      // Use the gizmo's actual local axis direction for flip detection.
      // This ensures correct sign regardless of gizmo rotation.
      const cameraOffset = new THREE.Vector3().subVectors(camera.position, gizmoPosition);
      return cameraOffset.dot(worldAxisDir) > 0;
    }
    // Fall back to world-axis comparison when no worldAxisDir is given
    // (existing behavior for non-rotated gizmos).
    if (axis === 'x') {
      return camera.position.x - gizmoPosition.x > 0;
    }
    if (axis === 'y') {
      return camera.position.y - gizmoPosition.y > 0;
    }
    return camera.position.z - gizmoPosition.z > 0;
  }, [axis, camera.position, gizmoPosition, worldAxisDir]);

  const getGizmoScreenCenter = useCallback(() => {
    const rect = gl.domElement.getBoundingClientRect();
    const projected = gizmoPosition.clone().project(camera);
    return {
      x: rect.left + ((projected.x + 1) * 0.5) * rect.width,
      y: rect.top + ((1 - projected.y) * 0.5) * rect.height,
    };
  }, [camera, gl, gizmoPosition]);
  
  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();
  
  // Map axis to gizmo handle type
  const handleType: GizmoHandleType = `rotate-${axis}` as GizmoHandleType;
  
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
  const ringColors = axis === 'x' ? GIZMO_COLORS.xRing : axis === 'y' ? GIZMO_COLORS.yRing : GIZMO_COLORS.zRing;
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  const getCameraAlignedAngle = useCallback(() => {
    const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();

    if (axis === 'x') {
      return Math.atan2(cameraDir.z, cameraDir.y) + Math.PI / 2;
    }
    if (axis === 'y') {
      // The Y ring is rotated into the X/Z plane with local +Y mapped to
      // world -Z, so project camera Z with the matching sign.
      return Math.atan2(-cameraDir.z, cameraDir.x);
    }
    return Math.atan2(cameraDir.y, cameraDir.x);
  }, [axis, camera.position, gizmoPosition]);

  React.useEffect(() => {
    if (disableRingBillboard) {
      if (isDragging) return;
      // Center the active arc between the two positive arrow axes after
      // the drag completes so the handle stays aligned with the new frame.
      handleAngleRef.current = positiveAxisMidpointAngle;
      targetHandleAngleRef.current = positiveAxisMidpointAngle;
      return;
    }
    if (!suppressAxisAnimations || isDragging) return;
    shouldFlipRef.current = computeShouldFlip();
    const aligned = getCameraAlignedAngle();
    handleAngleRef.current = aligned;
    targetHandleAngleRef.current = aligned;

    const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
    billboardRotationRef.current = Math.atan2(cameraDir.y, cameraDir.x);
  }, [camera.position, computeShouldFlip, getCameraAlignedAngle, gizmoPosition, isDragging, positiveAxisMidpointAngle, suppressAxisAnimations, disableRingBillboard]);

  // Ref-based temporal smoothing to avoid micro-shimmer from per-frame React state updates.
  useFrame(() => {
    if (!isDragging && !disableRingBillboard) {
      shouldFlipRef.current = computeShouldFlip();
      targetHandleAngleRef.current = getCameraAlignedAngle();
    }

    let delta = targetHandleAngleRef.current - handleAngleRef.current;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    const smoothing = isDragging || suppressAxisAnimations ? 1 : 0.2;
    handleAngleRef.current += delta * smoothing;

    const handleAngle = handleAngleRef.current;
    const radius = GIZMO_SIZES.ringMajorRadius;
    const hx = Math.cos(handleAngle) * radius;
    const hy = Math.sin(handleAngle) * radius;

    if (rotatingArcRef.current) {
      rotatingArcRef.current.rotation.z = handleAngle;
    }

    if (handleRootRef.current) {
      handleRootRef.current.position.set(hx, hy, 0);
      handleRootRef.current.rotation.set(0, 0, handleAngle + Math.PI / 2);
    }

    if (pickMeshRef.current) {
      pickMeshRef.current.position.set(hx, hy, 0);
    }

    if (pointLightRef.current) {
      pointLightRef.current.position.set(hx, hy, 0);
    }

    if (!disableRingBillboard) {
      const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
      const billboardTarget = Math.atan2(cameraDir.y, cameraDir.x);
      if (suppressAxisAnimations) {
        billboardRotationRef.current = billboardTarget;
      } else {
        billboardRotationRef.current += (billboardTarget - billboardRotationRef.current) * 0.2;
      }
      if (billboardGroupRef.current) {
        billboardGroupRef.current.rotation.x = billboardRotationRef.current;
      }
    }
  }, -1);

  // Rotation for each axis
  const rotation: [number, number, number] =
    axis === 'x' ? [0, Math.PI / 2, 0] : axis === 'y' ? [-Math.PI / 2, 0, 0] : [0, 0, 0];

  const initialHandlePos: [number, number, number] = [
    Math.cos(positiveAxisMidpointAngle) * GIZMO_SIZES.ringMajorRadius,
    Math.sin(positiveAxisMidpointAngle) * GIZMO_SIZES.ringMajorRadius,
    0,
  ];
  
  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) {
      return;
    }
    if (!interactionsEnabled) {
      return;
    }
    
    e.stopPropagation();
    e.stopped = true; // Mark event as handled for OrbitControls

    shouldFlipRef.current = computeShouldFlip();
    
    // Calculate initial mouse angle
    lastMouseAngle.current = getMousePolar(e.clientX, e.clientY).angle;
    
    const allowed = onDragStart();
    if (allowed === false) {
      return;
    }
    // Initialize snap refs at drag start to avoid spurious first-frame transition
    rawAccumulatedAngleRef.current = 0;
    lastSnappedAngleRef.current = 0;
    prevSnapIncrementRef.current = null;
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: false } }));
    setIsDragging(true);
  };

  // --- Dial click-to-rotate -------------------------------------------------
  // A click on a tick rotates to that absolute angle. This is ALWAYS available
  // and deliberately does not consult SNAP_STORAGE_KEY: that toggle governs
  // drag snapping only. Ticks being inert unless a mode was first enabled is
  // what made them read as decoration.

  /** Pointer travel below this is a click; above it the gesture belongs to the camera. */
  const DIAL_CLICK_SLOP_PX = 4;

  /** Ring-local angle of a pointer hit on the dial band, or null at the centre. */
  const dialHitAngle = useCallback((e: ThreeEvent<PointerEvent>): number | null => {
    const local = e.object.worldToLocal(e.point.clone());
    if (local.x === 0 && local.y === 0) return null;
    return Math.atan2(local.y, local.x);
  }, []);

  const handleDialPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled || isHidden) return;
    // Deliberately NOT stopPropagation. A drag that begins on the dial still
    // belongs to the camera — only a click rotates. Swallowing the gesture here
    // would make the dial a second, undocumented drag surface.
    dialPointerDownRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleDialPointerUp = (e: ThreeEvent<PointerEvent>) => {
    const start = dialPointerDownRef.current;
    dialPointerDownRef.current = null;
    if (!start || !interactionsEnabled || isHidden) return;
    // If the handle claimed this gesture as a drag, do not also fire a click.
    // The dial does not stopPropagation on pointerdown (so a camera drag started
    // on it is preserved), which means a ray through both the dial band and the
    // handle sphere can arm both. isDragging tells us the handle won.
    if (isDragging) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > DIAL_CLICK_SLOP_PX) return;

    const hit = dialHitAngle(e);
    if (hit === null) return;

    const targetObjectAngle = objectAngleForRingAngle(
      nearestTickRad(hit, tickConfig),
      axisVisualFlip,
    );
    const delta = shortestAngleDelta(currentAngleRad, targetObjectAngle);
    if (delta === 0) return;

    // Emit the full gesture triad through the existing drag callbacks so a click
    // produces exactly one undo entry, shaped identically to a drag.
    if (onDragStart() === false) return;
    onDrag(delta);
    onDragEnd();
  };

  const handleDialPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled || isHidden) return;
    const hit = dialHitAngle(e);
    const next = hit === null ? null : nearestTickRad(hit, tickConfig);
    if (next !== hoveredTickRad) {
      setHoveredTickRad(next);
      invalidate();
    }
  };

  const handleDialPointerLeave = () => {
    dialPointerDownRef.current = null;
    if (hoveredTickRad !== null) {
      setHoveredTickRad(null);
      invalidate();
    }
  };

  const handlePointerEnterLocal = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return;
    e.stopPropagation();
    onPointerEnter();
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: true, axis } }));
  };

  const handlePointerLeaveLocal = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return;
    e.stopPropagation();
    onPointerLeave();
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: false } }));
  };

  const getMousePolar = useCallback((clientX: number, clientY: number): { angle: number; distance: number } => {
    const center = getGizmoScreenCenter();
    const dx = clientX - center.x;
    const dy = clientY - center.y;
    return {
      angle: Math.atan2(dy, dx),
      distance: Math.hypot(dx, dy),
    };
  }, [getGizmoScreenCenter]);

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      const mousePolar = getMousePolar(e.clientX, e.clientY);
      const currentMouseAngle = mousePolar.angle;
      let deltaAngle = currentMouseAngle - lastMouseAngle.current;

      // Handle angle wrapping (crossing -π/π boundary)
      if (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
      if (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;

      if (
        mousePolar.distance < ROTATION_CENTER_DEADZONE_PX
        || (
          mousePolar.distance < ROTATION_NEAR_CENTER_JUMP_GUARD_PX
          && Math.abs(deltaAngle) > ROTATION_NEAR_CENTER_MAX_DELTA
        )
      ) {
        lastMouseAngle.current = currentMouseAngle;
        return;
      }

      // Compute sign factors for axis inversion and camera flip
      const flipMult = shouldFlipRef.current ? -1 : 1;
      const objectSignFactor = -flipMult;
      const axisSign = -1;

      const rawObjectDelta = deltaAngle * objectSignFactor;
      rawAccumulatedAngleRef.current += rawObjectDelta;

      // Determine snap state from modifier keys or persistent toggle
      let snapToggled = false;
      try { snapToggled = localStorage.getItem(SNAP_STORAGE_KEY) === 'true'; } catch {}
      const isSnapActive = e.metaKey || e.ctrlKey || snapToggled;
      const currentIncrement = isSnapActive
        ? (e.shiftKey ? SNAP_FINE : SNAP_COARSE)
        : null;

      // Reset accumulated on any transition (free↔snap, coarse↔fine)
      // to prevent grid-misalignment jumps
      if (currentIncrement !== prevSnapIncrementRef.current) {
        rawAccumulatedAngleRef.current = lastSnappedAngleRef.current;
      }
      prevSnapIncrementRef.current = currentIncrement;

      let emittedObjectDelta: number;
      if (currentIncrement !== null) {
        // Snap mode: quantize accumulated angle, emit difference
        const snappedAngle = snapAngle(rawAccumulatedAngleRef.current, currentIncrement);
        emittedObjectDelta = snappedAngle - lastSnappedAngleRef.current;
        lastSnappedAngleRef.current = snappedAngle;
      } else {
        // Free rotation: emit raw delta
        emittedObjectDelta = rawObjectDelta;
        lastSnappedAngleRef.current += rawObjectDelta;
      }

      // Visual delta = objectDelta * axisSign. The model applies emitted
      // object deltas with the opposite sign, so the handle arc mirrors that
      // application step to move with the visible rotation.
      // axisVisualFlip allows the parent to invert the visual animation direction
      // (e.g. when the gizmo's local frame has an inverted axis convention such
      // as displayY = -cutterY in HolePunchGizmo).
      const visualDelta = emittedObjectDelta * axisSign * axisVisualFlip;

      // Update handle angle for visual feedback (ref-based)
      handleAngleRef.current += visualDelta;
      targetHandleAngleRef.current = handleAngleRef.current;

      // Send rotation delta to parent (object rotation)
      onDragRef.current(emittedObjectDelta);

      // Dispatch snap readout event for DOM overlay (always active while dragging)
      // Parent applies object rotation with -angle, so mirror that sign here so
      // the readout matches Transform panel values and perceived rotation direction.
      window.dispatchEvent(new CustomEvent('dragonfruit:snap-angle', {
        detail: { active: true, angle: -lastSnappedAngleRef.current, axis },
      }));

      lastMouseAngle.current = currentMouseAngle;
    };

    const handleGlobalPointerUp = () => {
      // Remove pointermove synchronously so it can't re-fire active:true before React re-renders
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      setIsDragging(false);
      onDragEndRef.current();
      window.dispatchEvent(new CustomEvent('dragonfruit:snap-angle', { detail: { active: false } }));
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [isDragging, getMousePolar, axis, axisVisualFlip]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = !suppressHover && (isPickingHovered || isHovered);
  const isHighlighted = !!(effectiveHovered || isActive);
  const ringIsActive = !!isActive;

  const baseOpacity = isHidden ? 0 : isDimmed ? 0.15 : ringIsActive ? 0.95 : 0.72;
  const opacity = baseOpacity * opacityScale;
  // The dial fades in on hover and is strongest during a drag. While it shows,
  // damp the arc gradient so the ring carries one dominant read rather than
  // four competing layers — the reported problem was that the ring is already
  // hard to read, so the dial has to displace something, not just pile on.
  const dialVisible = !isHidden && !isDimmed && (effectiveHovered || ringIsActive);
  const arcOpacity = dialVisible ? opacity * 0.4 : opacity;
  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  const diamondPrimaryColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : effectiveHovered
        ? GIZMO_COLORS.hover
        : axisColors.end;
  const diamondSecondaryColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : effectiveHovered
        ? new THREE.Color(GIZMO_COLORS.hover).lerp(new THREE.Color(axisColors.start), 0.35).getStyle()
        : axisColors.start;
  const ringColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : ringColors.ring;

  // Point light intensity based on state (uses effectiveHovered for GPU picking support)
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  const frontArcPoints = useMemo(() => getCachedRotationArcPoints('front'), []);
  const backArcPoints = useMemo(() => getCachedRotationArcPoints('back'), []);

  // Ring rotation uses same logic as handle position
  // (The handleAngle already calculated above is what we need)

  const arcGeometry = useMemo(() => getCachedRotationArcGeometry(axis), [axis]);
  /** One merged pick surface for the whole dial band. 72 separate tick meshes
   *  would multiply the pick surface count per ring and undo ADR-0002's
   *  off-loop picking cache; the angle is resolved from the hit point instead. */
  const dialPickGeometry = useMemo(
    () =>
      getCachedRingGeometry(
        GIZMO_SIZES.dialRadius - GIZMO_SIZES.dialTickLength * 0.6,
        GIZMO_SIZES.dialRadius + GIZMO_SIZES.dialTickLength * 1.6,
        72,
      ),
    [],
  );

  const pickGeometry = useMemo(
    () => getCachedSphereGeometry(Math.max(0.18, GIZMO_SIZES.ringDiamondRadius * 0.9 * handleScale), 16, 16),
    [handleScale],
  );
  const diamondConeGeometry = useMemo(
    () => getCachedConeGeometry(GIZMO_SIZES.ringDiamondRadius * 0.36, GIZMO_SIZES.ringDiamondRadius, 16),
    [],
  );

  return (
    <group
      rotation={rotation}
    >
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass.
          visible={false} when isHidden disables raycasting so this handle does
          not block pointer events during another gizmo's active drag. */}
      <mesh
        ref={pickMeshRef}
        visible={!isHidden && interactionsEnabled}
        position={initialHandlePos}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnterLocal}
        onPointerLeave={handlePointerLeaveLocal}
      >
        <primitive object={pickGeometry} attach="geometry" />
        <meshBasicMaterial visible={false} />
      </mesh>

      <Line
        points={backArcPoints}
        color={isDimmed ? dimmedColor : ringColor}
        lineWidth={0.8}
        transparent
        opacity={Math.max(0, opacity * 0.26)}
        depthTest={false}
      />
      
      {/* Protractor dial and true-angle spoke. Mounted in the ring's local frame,
          NOT inside the camera-following arc group below — pairing fixed angular
          positions with a camera-following frame is what made ticks and the
          indicator drift apart off-axis. */}
      {!isHidden && !isDimmed && (
        <>
          {interactionsEnabled && (
            <mesh
              geometry={dialPickGeometry}
              onPointerDown={handleDialPointerDown}
              onPointerUp={handleDialPointerUp}
              onPointerMove={handleDialPointerMove}
              onPointerLeave={handleDialPointerLeave}
              onPointerCancel={handleDialPointerLeave}
            >
              <meshBasicMaterial visible={false} side={THREE.DoubleSide} />
            </mesh>
          )}
          <SnapTickDial
            color={ringColors.ring}
            hovered={!!effectiveHovered}
            active={ringIsActive}
            opacityScale={opacityScale}
            config={tickConfig}
            highlightRad={hoveredTickRad}
          />
          <AngleSpoke
            color={ringColors.ring}
            currentAngleRad={currentAngleRad}
            axisVisualFlip={axisVisualFlip}
            hovered={!!effectiveHovered}
            active={ringIsActive}
            opacityScale={opacityScale}
          />
        </>
      )}

      {/* Rotating group to keep colored arc facing camera - uses same angle as handle */}
      <group ref={rotatingArcRef}>
        {/* Front arc with gradient - pure color at center, lighter at ends */}
        <mesh geometry={arcGeometry} scale={ringIsActive ? 1.02 : 1.0}>
          <meshBasicMaterial
            vertexColors={!isDimmed}
            color={isDimmed ? dimmedColor : ringColor}
            opacity={arcOpacity}
            transparent
            depthTest={false} 
            toneMapped={false} 
          />
        </mesh>

        <Line
          points={frontArcPoints}
          color={isDimmed ? dimmedColor : ringColor}
          lineWidth={0.92}
          transparent
          opacity={Math.max(0, arcOpacity * 0.38)}
          depthTest={false}
        />

        {ringIsActive && !isDimmed && !isHidden && (
          <Line
            points={frontArcPoints}
            color={new THREE.Color(ringColor).lerp(new THREE.Color('#ffffff'), 0.35).getStyle()}
            lineWidth={1.34}
            transparent
            opacity={0.22}
            depthTest={false}
          />
        )}
      </group>

      {/* Double-pointed arrow handle (two cones) */}
      <group
        ref={handleRootRef}
        position={initialHandlePos}
        scale={(isHighlighted ? 1.08 : 1.0) * handleScale}
        onPointerDown={interactionsEnabled ? handlePointerDown : undefined}
        onPointerEnter={interactionsEnabled ? handlePointerEnterLocal : undefined}
        onPointerLeave={interactionsEnabled ? handlePointerLeaveLocal : undefined}
      >
        {/* Billboard group to improve arrow readability relative to camera */}
        <group ref={billboardGroupRef}>
          {/* Clockwise-pointing cone along tangent */}
          <group position={[GIZMO_SIZES.ringDiamondRadius * 0.52, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
            {/* Outline - slightly larger with darker color */}
            <mesh scale={1.08}>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={new THREE.Color(diamondPrimaryColor).multiplyScalar(0.3).getHex()}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
            {/* Main colored cone */}
            <mesh>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={diamondPrimaryColor}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
          </group>
          
          {/* Counter-clockwise-pointing cone along tangent */}
          <group position={[-GIZMO_SIZES.ringDiamondRadius * 0.52, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            {/* Outline - slightly larger with darker color */}
            <mesh scale={1.08}>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={new THREE.Color(diamondSecondaryColor).multiplyScalar(0.32).getHex()}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
            {/* Main colored cone */}
            <mesh>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={diamondSecondaryColor}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
          </group>
        </group>
      </group>

      {/* Point light at diamond handle to cast colored light on model */}
      {enableLighting && !isDimmed && (
        <pointLight
          ref={pointLightRef}
          position={initialHandlePos}
          color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : diamondPrimaryColor}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
