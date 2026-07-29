"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import {
  rayToRingLocal,
  spokeRingAngle,
  objectAngleForRingAngle,
  nearestRingTickRad,
  shortestAngleDelta,
  polarToLocal,
  parseSnapDialConfig,
  SNAP_DIAL_CONFIG_STORAGE_KEY,
  DEFAULT_SNAP_DIAL_CONFIG,
  type SnapDialConfig,
} from './snapRotation';
import { SnapTickDial } from './SnapTickDial';
import { AngleSpoke } from './AngleSpoke';
import type { GizmoAxis } from '../types';
import {
  getCachedConeGeometry,
  getCachedRotationArcGeometry,
  getCachedRotationArcPoints,
  getCachedSphereGeometry,
} from '../gizmoGeometryCache';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';


// Scratch objects for per-move zone classification; reused, never retained.
const zoneRaycaster = new THREE.Raycaster();
const zoneQuat = new THREE.Quaternion();
const zoneCenter = new THREE.Vector3();
/** Pointer travel below this is a click; above it the gesture is the camera's. */
const DIAL_CLICK_SLOP_PX = 4;

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
  /** True when this ring's dial is armed for tick selection. */
  armed: boolean;
  /** Arm/disarm this ring's dial (arming one ring disarms the others). */
  onArmedChange: (armed: boolean) => void;
  onDragStart: () => boolean | void;
  onDrag: (angle: number) => void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
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
  axisVisualFlip = 1,
  currentAngleRad,
  armed,
  onArmedChange,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoRotationProps) {

  /** Persisted dial intervals (#104). Parsed defensively — see parseSnapDialConfig. */
  const [dialConfig, setDialConfig] = useState<SnapDialConfig>(() => {
    try {
      return parseSnapDialConfig(localStorage.getItem(SNAP_DIAL_CONFIG_STORAGE_KEY));
    } catch {
      return DEFAULT_SNAP_DIAL_CONFIG;
    }
  });
  /** Mirror of dialConfig for the window-level drag listener, so config edits
   *  do not force the drag effect to resubscribe mid-gesture. */
  const dialConfigRef = useRef(dialConfig);
  /** Root of the ring-local frame — zone classification reads its world pose. */
  const ringGroupRef = useRef<THREE.Group>(null);
  /** Tick the selection spoke is on while armed. */
  const [selectedTickRad, setSelectedTickRad] = useState<number | null>(null);
  /** Start tick of the sweep — the first click while armed picks it. */
  const [referenceTickRad, setReferenceTickRad] = useState<number | null>(null);
  const referenceTickRadRef = useRef<number | null>(null);
  /** Pointer-down screen position while armed — a click commits, a drag orbits. */
  const armedPointerDownRef = useRef<{ x: number; y: number } | null>(null);
  /** Set when the grabber consumes a gesture, so the armed commit skips it. */
  const suppressCommitRef = useRef(false);
  // The grabber parks at the object's true angle in the ring frame — the
  // faithful behaviour — rather than facing the camera or sitting between the
  // positive axes. Same angle source as the spoke, so grabber and indicator
  // cannot disagree.
  const parkedAngle = spokeRingAngle(currentAngleRad, axisVisualFlip);
  const handleAngleRef = useRef<number>(parkedAngle);
  const targetHandleAngleRef = useRef<number>(parkedAngle);
  const billboardRotationRef = useRef<number>(0);
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
      let next = DEFAULT_SNAP_DIAL_CONFIG;
      try {
        next = parseSnapDialConfig(localStorage.getItem(SNAP_DIAL_CONFIG_STORAGE_KEY));
      } catch {}
      setDialConfig(next);
      dialConfigRef.current = next;
      invalidate();
    };
    window.addEventListener('dragonfruit:tick-config-change', reload);
    return () => window.removeEventListener('dragonfruit:tick-config-change', reload);
  }, [invalidate]);

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

  // Snap the grabber straight to its parked angle when animations are
  // suppressed (instant-placement contexts). The smoothed path below handles
  // the normal case.
  //
  // shouldFlip audit (dragonfruit-103-2 plan MEDIUM): the flip logic is
  // POSITION-INDEPENDENT — it signs drag deltas by which side of the ring
  // plane the camera is on (cameraOffset dot worldAxisDir), and the grabber's
  // parked position never enters that computation. Grabbing a far-side parked
  // handle therefore cannot invert the drag: the camera side, and only the
  // camera side, decides the sign, exactly as it did when the handle was
  // camera-parked.
  React.useEffect(() => {
    if (!disableRingBillboard && !suppressAxisAnimations) return;
    handleAngleRef.current = parkedAngle;
    targetHandleAngleRef.current = parkedAngle;

    if (!disableRingBillboard) {
      const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
      billboardRotationRef.current = Math.atan2(cameraDir.y, cameraDir.x);
    }
  }, [camera.position, gizmoPosition, parkedAngle, suppressAxisAnimations, disableRingBillboard]);

  // Ref-based temporal smoothing to avoid micro-shimmer from per-frame React state updates.
  useFrame(() => {
    targetHandleAngleRef.current = parkedAngle;

    let delta = targetHandleAngleRef.current - handleAngleRef.current;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    const smoothing = suppressAxisAnimations ? 1 : 0.2;
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
    Math.cos(parkedAngle) * GIZMO_SIZES.ringMajorRadius,
    Math.sin(parkedAngle) * GIZMO_SIZES.ringMajorRadius,
    0,
  ];
  
  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) return;
    if (!interactionsEnabled) return;

    e.stopPropagation();
    e.stopped = true; // Mark event as handled for OrbitControls
    // stopPropagation does not reach the armed window listeners — flag the
    // gesture so toggling the diamond never doubles as a commit click.
    suppressCommitRef.current = true;
    onArmedChange(!armed);
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: false } }));
  };

  // --- Armed tick sweep ----------------------------------------------------
  // Clicking the diamond arms this ring's dial. While armed, the selection
  // spoke follows the cursor in the ring's plane, sticking to ticks. The
  // FIRST click picks the start tick; from then on the readout and the sweep
  // arc show the SIGNED angle from that start to the current tick, and the
  // SECOND click rotates the model by exactly that sweep — rotation is
  // relative to the picked start, not to where the model happens to point.
  // A drag still belongs to the camera; Esc or the diamond again cancels.

  /** Object-space rotation for a ring-space sweep. The ring->object map is
   *  linear through zero, so it applies to deltas as well as absolutes. */
  const sweepObjectDelta = useCallback(
    (fromTickRad: number, toTickRad: number) =>
      objectAngleForRingAngle(shortestAngleDelta(fromTickRad, toTickRad), axisVisualFlip),
    [axisVisualFlip],
  );

  useEffect(() => {
    if (!armed) return;

    const readout = (detail: object) =>
      window.dispatchEvent(new CustomEvent('dragonfruit:snap-angle', { detail }));

    const trackPointer = (e: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      zoneRaycaster.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -(((e.clientY - rect.top) / rect.height) * 2 - 1),
        ),
        camera,
      );
      if (!ringGroupRef.current) return;
      ringGroupRef.current.getWorldQuaternion(zoneQuat);
      ringGroupRef.current.getWorldPosition(zoneCenter);
      const hit = rayToRingLocal(
        zoneRaycaster.ray.origin,
        zoneRaycaster.ray.direction,
        zoneQuat,
        zoneCenter,
      );
      // Grazing poses keep the previous selection rather than flickering.
      if (!hit) return;
      const next = nearestRingTickRad(hit.angleRad, dialConfigRef.current);
      setSelectedTickRad((prev) => {
        if (prev !== next) {
          const from = referenceTickRadRef.current;
          if (from !== null) {
            readout({ active: true, angle: sweepObjectDelta(from, next), axis });
          }
          invalidate();
        }
        return next;
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      armedPointerDownRef.current = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      const start = armedPointerDownRef.current;
      armedPointerDownRef.current = null;
      if (suppressCommitRef.current) {
        // The grabber consumed this gesture (arm/disarm toggle).
        suppressCommitRef.current = false;
        return;
      }
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > DIAL_CLICK_SLOP_PX) return;

      setSelectedTickRad((tick) => {
        if (tick === null) return tick;
        const from = referenceTickRadRef.current;
        if (from === null) {
          // First click: pick the sweep's start.
          referenceTickRadRef.current = tick;
          setReferenceTickRad(tick);
          readout({ active: true, angle: 0, axis });
          invalidate();
          return tick;
        }
        // Second click: rotate by the sweep from start to here.
        const delta = sweepObjectDelta(from, tick);
        if (delta !== 0 && onDragStart() !== false) {
          onDragRef.current(delta);
          onDragEndRef.current();
        }
        onArmedChange(false);
        return tick;
      });
    };

    // Raw keydown listeners are forbidden here (hotkey-restriction rule);
    // the hotkey system re-broadcasts keys on this app event instead.
    const onAppHotkey = (e: Event) => {
      if ((e as CustomEvent).detail?.key === 'Escape') onArmedChange(false);
    };

    window.addEventListener('pointermove', trackPointer);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('app-hotkey-keydown', onAppHotkey);
    return () => {
      window.removeEventListener('pointermove', trackPointer);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('app-hotkey-keydown', onAppHotkey);
      armedPointerDownRef.current = null;
      setSelectedTickRad(null);
      referenceTickRadRef.current = null;
      setReferenceTickRad(null);
      readout({ active: false });
      invalidate();
    };
  }, [armed, axis, camera, gl.domElement, invalidate, onArmedChange, onDragStart, sweepObjectDelta]);

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
      ref={ringGroupRef}
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
          <SnapTickDial
            color={ringColors.ring}
            hovered={!!effectiveHovered}
            active={armed || ringIsActive}
            opacityScale={opacityScale}
            config={dialConfig}
            highlightRad={armed ? selectedTickRad : null}
          />
          {armed && referenceTickRad !== null && (
            // Sweep start — the first-clicked tick the rotation measures from.
            <Line
              points={[
                polarToLocal(referenceTickRad, GIZMO_SIZES.spokeInnerRadius),
                polarToLocal(referenceTickRad, GIZMO_SIZES.dialRadius),
              ]}
              color="#ffffff"
              lineWidth={2.0}
              transparent
              opacity={0.95 * opacityScale}
              depthTest={false}
              toneMapped={false}
            />
          )}
          {armed && selectedTickRad !== null && (
            // Selection spoke — the sweep's end under the cursor.
            <Line
              points={[
                polarToLocal(selectedTickRad, GIZMO_SIZES.spokeInnerRadius),
                polarToLocal(selectedTickRad, GIZMO_SIZES.dialRadius),
              ]}
              color="#ffffff"
              lineWidth={1.4}
              dashed
              dashSize={0.18}
              gapSize={0.12}
              transparent
              opacity={0.85 * opacityScale}
              depthTest={false}
              toneMapped={false}
            />
          )}
          {armed &&
            referenceTickRad !== null &&
            selectedTickRad !== null &&
            referenceTickRad !== selectedTickRad && (
              // Sweep arc — the rotation a click will apply, drawn tick to tick.
              <Line
                points={(() => {
                  const sweep = shortestAngleDelta(referenceTickRad, selectedTickRad);
                  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 64)));
                  const pts: [number, number, number][] = [];
                  for (let i = 0; i <= steps; i += 1) {
                    pts.push(
                      polarToLocal(referenceTickRad + (sweep * i) / steps, GIZMO_SIZES.dialRadius),
                    );
                  }
                  return pts;
                })()}
                color="#ffffff"
                lineWidth={2.2}
                transparent
                opacity={0.9 * opacityScale}
                depthTest={false}
                toneMapped={false}
              />
            )}
          <AngleSpoke
            color={ringColors.ring}
            currentAngleRad={currentAngleRad}
            axisVisualFlip={axisVisualFlip}
            showArc={!armed}
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
