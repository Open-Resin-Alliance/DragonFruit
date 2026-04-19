"use client";

import React from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TransformGizmo } from './TransformGizmo';
import type { TransformGizmoProps } from './types';

function toPositionArray(position: TransformGizmoProps['position']): [number, number, number] {
  return Array.isArray(position)
    ? position
    : [position.x, position.y, position.z];
}

function computeScreenSpaceScale(
  camera: THREE.Camera,
  position: [number, number, number],
  scaleFactor: number,
  scratchPoint: THREE.Vector3,
): number {
  const point = scratchPoint.set(position[0], position[1], position[2]);
  if ((camera as any).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    const worldHeight = (ortho.top - ortho.bottom) / Math.max(1e-6, ortho.zoom);
    return worldHeight * scaleFactor;
  }

  const perspective = camera as THREE.PerspectiveCamera;
  const distance = perspective.position.distanceTo(point);
  return distance * scaleFactor;
}

/**
 * ScreenSpaceGizmo - Wrapper that makes the gizmo maintain constant screen size
 * 
 * Calculates scale based on camera distance so the gizmo appears the same size
 * regardless of zoom level, like standard 3D software gizmos.
 */
export function ScreenSpaceGizmo(props: Omit<TransformGizmoProps, 'size'> & { 
  meshRef?: React.RefObject<THREE.Group | THREE.Mesh | null>;
  scaleFactor?: number;
  followMeshRef?: boolean;
  onRetargetingChange?: (isRetargeting: boolean) => void;
}) {
  const SWITCH_DAMP_LAMBDA = 30;
  const SWITCH_SNAP_EPSILON = 0.003;
  const AXIS_SUPPRESS_MS = 72;

  const { camera, invalidate } = useThree();
  const scaleFactor = props.scaleFactor ?? 0.04;
  const followMeshRef = props.followMeshRef ?? true;
  const gizmoRootRef = React.useRef<THREE.Group | null>(null);
  const scratchPointRef = React.useRef(new THREE.Vector3());
  const targetObject = followMeshRef ? props.meshRef?.current : null;
  const [suppressAxisAnimations, setSuppressAxisAnimations] = React.useState(false);
  const switchAnimationTimeoutRef = React.useRef<number | null>(null);
  const prevTargetObjectRef = React.useRef<THREE.Group | THREE.Mesh | null>(targetObject ?? null);
  const isDraggingRef = React.useRef(false);

  const transitionRef = React.useRef<{
    active: boolean;
    target: [number, number, number];
  }>({
    active: false,
    target: [0, 0, 0],
  });
  const retargetingActiveRef = React.useRef(false);

  const setRetargetingActive = React.useCallback((next: boolean) => {
    if (retargetingActiveRef.current === next) return;
    retargetingActiveRef.current = next;
    props.onRetargetingChange?.(next);
  }, [props]);

  const resolveCurrentPosition = React.useCallback((): [number, number, number] => {
    const meshPos = followMeshRef ? props.meshRef?.current?.position : null;
    if (meshPos) {
      return [meshPos.x, meshPos.y, meshPos.z];
    }
    return toPositionArray(props.position);
  }, [followMeshRef, props.meshRef, props.position]);

  const initialPosition = React.useMemo(() => resolveCurrentPosition(), [resolveCurrentPosition]);
  const initialScale = React.useMemo(
    () => computeScreenSpaceScale(camera, initialPosition, scaleFactor, scratchPointRef.current),
    [camera, initialPosition, scaleFactor],
  );
  const lastPositionRef = React.useRef<[number, number, number]>(initialPosition);
  const lastScaleRef = React.useRef<number>(initialScale);

  const stopTransition = React.useCallback((snapTo?: [number, number, number]) => {
    transitionRef.current.active = false;
    setRetargetingActive(false);
    if (!snapTo) return;

    lastPositionRef.current = snapTo;

    const root = gizmoRootRef.current;
    if (root) {
      root.position.set(snapTo[0], snapTo[1], snapTo[2]);
    }
  }, [setRetargetingActive]);

  React.useLayoutEffect(() => {
    const targetChanged = prevTargetObjectRef.current !== targetObject;
    prevTargetObjectRef.current = targetObject ?? null;

    if (!targetChanged) return;

    setSuppressAxisAnimations(true);
    if (switchAnimationTimeoutRef.current !== null) {
      window.clearTimeout(switchAnimationTimeoutRef.current);
      switchAnimationTimeoutRef.current = null;
    }

    switchAnimationTimeoutRef.current = window.setTimeout(() => {
      setSuppressAxisAnimations(false);
      switchAnimationTimeoutRef.current = null;
    }, AXIS_SUPPRESS_MS);

    const nextTarget = resolveCurrentPosition();
    const current = lastPositionRef.current;
    const dx = nextTarget[0] - current[0];
    const dy = nextTarget[1] - current[1];
    const dz = nextTarget[2] - current[2];
    const distanceSq = (dx * dx) + (dy * dy) + (dz * dz);

    if (!isDraggingRef.current && distanceSq > 1e-6) {
      transitionRef.current = {
        active: true,
        target: nextTarget,
      };
      setRetargetingActive(true);
    } else {
      stopTransition(nextTarget);
    }

    return () => {
      if (switchAnimationTimeoutRef.current !== null) {
        window.clearTimeout(switchAnimationTimeoutRef.current);
        switchAnimationTimeoutRef.current = null;
      }
    };
  }, [AXIS_SUPPRESS_MS, resolveCurrentPosition, setRetargetingActive, stopTransition, targetObject]);

  React.useLayoutEffect(() => {
    const root = gizmoRootRef.current;
    if (!root) return;

    const nextPosition = resolveCurrentPosition();
    if (!transitionRef.current.active) {
      const prev = lastPositionRef.current;
      if (prev[0] !== nextPosition[0] || prev[1] !== nextPosition[1] || prev[2] !== nextPosition[2]) {
        lastPositionRef.current = nextPosition;
        root.position.set(nextPosition[0], nextPosition[1], nextPosition[2]);
      }
    }

    const effectiveScalePosition = transitionRef.current.active ? lastPositionRef.current : nextPosition;
    const nextScale = computeScreenSpaceScale(camera, effectiveScalePosition, scaleFactor, scratchPointRef.current);
    if (Math.abs(nextScale - lastScaleRef.current) > 1e-4) {
      lastScaleRef.current = nextScale;
      root.scale.setScalar(nextScale);
    }
  }, [camera, resolveCurrentPosition, scaleFactor, targetObject]);

  React.useEffect(() => {
    return () => {
      setRetargetingActive(false);
    };
  }, [setRetargetingActive]);
  
  // Imperative per-frame sync keeps gizmo visually glued to the target
  // without React state scheduling overhead.
  useFrame((_, delta) => {
    const root = gizmoRootRef.current;
    if (!root) return;

    let mutated = false;
    let effectivePosition: [number, number, number];

    if (transitionRef.current.active && !isDraggingRef.current) {
      const { target } = transitionRef.current;
      const current = lastPositionRef.current;

      const damped: [number, number, number] = [
        THREE.MathUtils.damp(current[0], target[0], SWITCH_DAMP_LAMBDA, delta),
        THREE.MathUtils.damp(current[1], target[1], SWITCH_DAMP_LAMBDA, delta),
        THREE.MathUtils.damp(current[2], target[2], SWITCH_DAMP_LAMBDA, delta),
      ];

      lastPositionRef.current = damped;
      root.position.set(damped[0], damped[1], damped[2]);
      effectivePosition = damped;
      mutated = true;

      const rx = target[0] - damped[0];
      const ry = target[1] - damped[1];
      const rz = target[2] - damped[2];
      const remainingSq = (rx * rx) + (ry * ry) + (rz * rz);

      if (remainingSq <= (SWITCH_SNAP_EPSILON * SWITCH_SNAP_EPSILON)) {
        stopTransition(target);
        effectivePosition = target;
      }
    } else {
      const nextPosition = resolveCurrentPosition();
      const prevPosition = lastPositionRef.current;
      if (
        prevPosition[0] !== nextPosition[0]
        || prevPosition[1] !== nextPosition[1]
        || prevPosition[2] !== nextPosition[2]
      ) {
        lastPositionRef.current = nextPosition;
        root.position.set(nextPosition[0], nextPosition[1], nextPosition[2]);
        mutated = true;
      }
      effectivePosition = lastPositionRef.current;
    }

    const newScale = computeScreenSpaceScale(camera, effectivePosition, scaleFactor, scratchPointRef.current);
    if (Math.abs(newScale - lastScaleRef.current) > 1e-4) {
      lastScaleRef.current = newScale;
      root.scale.setScalar(newScale);
      mutated = true;
    }

    if (mutated) invalidate();
  });

  const handleDragStateChange = React.useCallback((isDragging: boolean) => {
    isDraggingRef.current = isDragging;
    if (isDragging) {
      const snap = resolveCurrentPosition();
      stopTransition(snap);
    }
    props.onDragStateChange?.(isDragging);
  }, [props, resolveCurrentPosition, stopTransition]);

  const renderPosition = lastPositionRef.current;

  return (
    <TransformGizmo
      {...props}
      position={renderPosition}
      size={initialScale}
      suppressAxisAnimations={suppressAxisAnimations}
      onDragStateChange={handleDragStateChange}
      rootRef={gizmoRootRef}
    />
  );
}
