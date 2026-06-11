"use client";

import React, { useCallback, useRef } from 'react';
import * as THREE from 'three';
import { LocalSpaceGizmo } from '@/components/gizmo/LocalSpaceGizmo';
import type { GizmoAxis } from '@/components/gizmo/types';

const UP = new THREE.Vector3(0, 1, 0);

type FrozenFrame = {
  quaternion: THREE.Quaternion;
  initialNormal: THREE.Vector3;
  accumulatedAngle: number;
};

type VisualPlacement = {
  worldPoint: THREE.Vector3;
  worldNormal: THREE.Vector3;
};

function getSafeNormal(normal: THREE.Vector3): THREE.Vector3 {
  const next = normal.clone();
  if (next.lengthSq() <= 1e-10) {
    next.set(0, 0, 1);
  } else {
    next.normalize();
  }
  return next;
}

function getDisplayNormal(normal: THREE.Vector3): THREE.Vector3 {
  return getSafeNormal(normal).negate();
}

interface HolePunchGizmoProps {
  /** The selected hole punch placement to show the gizmo for */
  placement: {
    id: string;
    worldPoint: THREE.Vector3;
    worldNormal: THREE.Vector3;
  };
  /** Called when the gizmo starts being dragged */
  onMoveStart?: () => void;
  /** Called when the gizmo is dragged. Delta is in world space. */
  onMove?: (delta: THREE.Vector3) => void;
  /** Called when the gizmo drag ends */
  onMoveEnd?: () => void;
  /** Called when the gizmo rotation starts */
  onRotateStart?: () => void;
  /** Called when the gizmo is rotated. New normal is provided. */
  onRotate?: (newNormal: THREE.Vector3) => void;
  /** Called when the gizmo rotation ends */
  onRotateEnd?: () => void;
}

/**
 * HolePunchGizmo - A positioning gizmo for hole punch cylinders
 *
 * Renders a LocalSpaceGizmo at the cylinder's position, oriented
 * along its outward display axis (opposite the cutter normal). The center XY
 * drag circle is removed so only the axis arrows remain for precise
 * positioning. When using the gizmo, snapping to surface normals is
 * disabled for that cylinder.
 *
 * Uses LocalSpaceGizmo (not ScreenSpaceGizmo) so the axes stay
 * relative to the cylinder without any camera-dependent offsets,
 * flips, or billboarding.
 */
export function HolePunchGizmo({
  placement,
  onMoveStart,
  onMove,
  onMoveEnd,
  onRotateStart,
  onRotate,
  onRotateEnd,
}: HolePunchGizmoProps) {
  // Freeze the gizmo rotation and axis frame during a rotation stroke
  // so the axes don't drift as the normal changes.
  const [frozenFrame, setFrozenFrame] = React.useState<FrozenFrame | null>(null);
  const [visualPlacement, setVisualPlacement] = React.useState<VisualPlacement>(() => ({
    worldPoint: placement.worldPoint.clone(),
    worldNormal: getSafeNormal(placement.worldNormal),
  }));
  const frozenFrameRef = useRef<FrozenFrame | null>(null);
  const livePointRef = useRef(placement.worldPoint.clone());
  const liveNormalRef = useRef(getSafeNormal(placement.worldNormal));
  const isMovingRef = useRef(false);
  const isRotatingRef = useRef(false);

  React.useEffect(() => {
    if (isMovingRef.current || isRotatingRef.current) return;

    const nextPoint = placement.worldPoint.clone();
    const nextNormal = getSafeNormal(placement.worldNormal);
    livePointRef.current.copy(nextPoint);
    liveNormalRef.current.copy(nextNormal);
    setVisualPlacement({
      worldPoint: nextPoint,
      worldNormal: nextNormal,
    });
  }, [placement.worldPoint, placement.worldNormal]);

  // Compute the gizmo rotation so Y points outward from the surface while the
  // stored cutter normal can continue pointing inward through the model.
  // Frozen during rotation to keep axes stable.
  const gizmoEuler = React.useMemo((): THREE.Euler => {
    if (frozenFrame) {
      return new THREE.Euler().setFromQuaternion(frozenFrame.quaternion);
    }
    const normal = getDisplayNormal(visualPlacement.worldNormal);
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(UP, normal);
    return new THREE.Euler().setFromQuaternion(q);
  }, [frozenFrame, visualPlacement.worldNormal]);

  const handleMoveStart = useCallback(() => {
    isMovingRef.current = true;
    livePointRef.current.copy(visualPlacement.worldPoint);
    onMoveStart?.();
  }, [onMoveStart, visualPlacement.worldPoint]);

  const handleMove = useCallback((delta: THREE.Vector3) => {
    livePointRef.current.add(delta);
    const nextPoint = livePointRef.current.clone();
    setVisualPlacement((previous) => ({
      ...previous,
      worldPoint: nextPoint,
    }));
    onMove?.(delta);
  }, [onMove]);

  const handleMoveEnd = useCallback(() => {
    isMovingRef.current = false;
    onMoveEnd?.();
  }, [onMoveEnd]);

  const handleRotateStart = useCallback(() => {
    // Capture the current gizmo frame so the axes stay fixed for the
    // whole rotation stroke, preventing axis-drift as the normal changes.
    const initialNormal = getSafeNormal(visualPlacement.worldNormal);
    const displayNormal = initialNormal.clone().negate();
    liveNormalRef.current.copy(initialNormal);
    const q = new THREE.Quaternion().setFromUnitVectors(
      UP,
      displayNormal,
    );
    const frame = {
      quaternion: q,
      initialNormal,
      accumulatedAngle: 0,
    };
    isRotatingRef.current = true;
    frozenFrameRef.current = frame;
    setFrozenFrame(frame);
    onRotateStart?.();
  }, [onRotateStart, visualPlacement.worldNormal]);

  const handleRotate = useCallback((axis: GizmoAxis, angleDelta: number) => {
    // Use the frozen frame's quaternion for a stable world-axis direction.
    const frame = frozenFrameRef.current;
    if (!frame) return;

    const basis = axis === 'x' ? new THREE.Vector3(1, 0, 0)
      : axis === 'z' ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
    const worldAxis = basis.applyQuaternion(frame.quaternion);

    // Accumulate against the drag-start normal instead of repeatedly rotating
    // the already-updated normal. This keeps the reference axis fixed for the
    // whole stroke and avoids direction flips around the midpoint.
    frame.accumulatedAngle += angleDelta;
    const deltaQuat = new THREE.Quaternion().setFromAxisAngle(worldAxis, -frame.accumulatedAngle);
    const newNormal = frame.initialNormal.clone().applyQuaternion(deltaQuat);
    newNormal.normalize();
    liveNormalRef.current.copy(newNormal);
    setVisualPlacement((previous) => ({
      ...previous,
      worldNormal: newNormal.clone(),
    }));

    onRotate?.(newNormal);
  }, [onRotate]);

  const handleRotateEnd = useCallback(() => {
    isRotatingRef.current = false;
    frozenFrameRef.current = null;
    setFrozenFrame(null);
    onRotateEnd?.();
  }, [onRotateEnd]);

  return (
    <LocalSpaceGizmo
      position={[visualPlacement.worldPoint.x, visualPlacement.worldPoint.y, visualPlacement.worldPoint.z]}
      rotation={gizmoEuler}
      size={1.0}
      enableMove
      enableRotate
      showCenter={false}
      handleScale={1.5}
      moveHandleThicknessScale={1}
      onMoveStart={handleMoveStart}
      onMove={handleMove}
      onMoveEnd={handleMoveEnd}
      onRotateStart={handleRotateStart}
      onRotate={handleRotate}
      onRotateEnd={handleRotateEnd}
    />
  );
}
