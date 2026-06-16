"use client";

import React, { useCallback, useRef } from 'react';
import * as THREE from 'three';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import type { GizmoAxis } from '@/components/gizmo/types';

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

type FrozenFrame = {
  cutterFrame: HolePunchWorldFrame;
  accumulatedAngle: number;
};

type HolePunchWorldFrame = {
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
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

function createCutterFrameFromNormal(normal: THREE.Vector3): HolePunchWorldFrame {
  const yAxis = getSafeNormal(normal);
  const displayY = yAxis.clone().negate();
  const upReference = Math.abs(displayY.dot(WORLD_Z)) < 0.92
    ? WORLD_Z.clone()
    : WORLD_X.clone();
  const displayZ = upReference
    .sub(displayY.clone().multiplyScalar(upReference.dot(displayY)))
    .normalize();
  const xAxis = displayY.clone().cross(displayZ).normalize();
  const zAxis = displayZ.negate();
  return { xAxis, yAxis, zAxis };
}

function cloneFrame(frame: HolePunchWorldFrame): HolePunchWorldFrame {
  return {
    xAxis: frame.xAxis.clone().normalize(),
    yAxis: frame.yAxis.clone().normalize(),
    zAxis: frame.zAxis.clone().normalize(),
  };
}

function getDisplayFrameFromCutterFrame(cutterFrame: HolePunchWorldFrame): HolePunchWorldFrame {
  return {
    xAxis: cutterFrame.xAxis.clone().normalize(),
    yAxis: cutterFrame.yAxis.clone().negate().normalize(),
    zAxis: cutterFrame.zAxis.clone().negate().normalize(),
  };
}

function getQuaternionFromFrame(frame: HolePunchWorldFrame): THREE.Quaternion {
  const matrix = new THREE.Matrix4().makeBasis(
    frame.xAxis.clone().normalize(),
    frame.yAxis.clone().normalize(),
    frame.zAxis.clone().normalize(),
  );
  return new THREE.Quaternion().setFromRotationMatrix(matrix).normalize();
}

function getDisplayQuaternionFromCutterFrame(cutterFrame: HolePunchWorldFrame): THREE.Quaternion {
  return getQuaternionFromFrame(getDisplayFrameFromCutterFrame(cutterFrame));
}

function rotateFrame(frame: HolePunchWorldFrame, quaternion: THREE.Quaternion): HolePunchWorldFrame {
  return {
    xAxis: frame.xAxis.clone().applyQuaternion(quaternion).normalize(),
    yAxis: frame.yAxis.clone().applyQuaternion(quaternion).normalize(),
    zAxis: frame.zAxis.clone().applyQuaternion(quaternion).normalize(),
  };
}

function getFrameAxis(frame: HolePunchWorldFrame, axis: GizmoAxis): THREE.Vector3 {
  if (axis === 'x') return frame.xAxis.clone();
  if (axis === 'y') return frame.yAxis.clone();
  return frame.zAxis.clone();
}

interface HolePunchGizmoProps {
  /** The selected hole punch placement to show the gizmo for */
  placement: {
    id: string;
    worldPoint: THREE.Vector3;
    worldNormal: THREE.Vector3;
    worldFrame?: HolePunchWorldFrame;
  };
  /** Called when the gizmo starts being dragged */
  onMoveStart?: () => void;
  /** Called when the gizmo is dragged. Delta is in world space. */
  onMove?: (delta: THREE.Vector3) => void;
  /** Called when the gizmo drag ends */
  onMoveEnd?: () => void;
  /** Called when the gizmo rotation starts */
  onRotateStart?: () => void;
  /** Called when the gizmo is rotated. New normal and full cutter frame are provided. */
  onRotate?: (newNormal: THREE.Vector3, worldFrame: HolePunchWorldFrame) => void;
  /** Called when the gizmo rotation ends */
  onRotateEnd?: () => void;
}

function getPlacementDisplayFrame(placement: HolePunchGizmoProps['placement']): THREE.Quaternion {
  const cutterFrame = placement.worldFrame ?? createCutterFrameFromNormal(placement.worldNormal);
  return getDisplayQuaternionFromCutterFrame(cutterFrame);
}

function getPlacementCutterFrame(placement: HolePunchGizmoProps['placement']): HolePunchWorldFrame {
  return cloneFrame(placement.worldFrame ?? createCutterFrameFromNormal(placement.worldNormal));
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
  const [displayFrameQuaternion, setDisplayFrameQuaternion] = React.useState<THREE.Quaternion>(() => (
    getPlacementDisplayFrame(placement)
  ));
  const frozenFrameRef = useRef<FrozenFrame | null>(null);
  const cutterFrameRef = useRef(getPlacementCutterFrame(placement));
  const isRotatingRef = useRef(false);

  React.useEffect(() => {
    if (isRotatingRef.current) return;

    const nextCutterFrame = getPlacementCutterFrame(placement);
    const nextDisplayFrame = getDisplayQuaternionFromCutterFrame(nextCutterFrame);
    cutterFrameRef.current = nextCutterFrame;
    setDisplayFrameQuaternion(nextDisplayFrame);
  }, [placement]);

  // Compute the gizmo rotation so Y points outward from the surface while the
  // stored cutter normal can continue pointing inward through the model.
  // Frozen during rotation to keep axes stable.
  const gizmoEuler = React.useMemo((): THREE.Euler => {
    if (frozenFrame) {
      return new THREE.Euler().setFromQuaternion(getDisplayQuaternionFromCutterFrame(frozenFrame.cutterFrame));
    }
    return new THREE.Euler().setFromQuaternion(displayFrameQuaternion);
  }, [displayFrameQuaternion, frozenFrame]);

  const handleMoveStart = useCallback(() => {
    onMoveStart?.();
  }, [onMoveStart]);

  const handleMove = useCallback((delta: THREE.Vector3) => {
    onMove?.(delta);
  }, [onMove]);

  const handleMoveEnd = useCallback(() => {
    onMoveEnd?.();
  }, [onMoveEnd]);

  const handleRotateStart = useCallback(() => {
    // Capture the current gizmo frame so the axes stay fixed for the
    // whole rotation stroke, preventing axis-drift as the normal changes.
    const frame = {
      cutterFrame: cloneFrame(cutterFrameRef.current),
      accumulatedAngle: 0,
    };
    isRotatingRef.current = true;
    frozenFrameRef.current = frame;
    setFrozenFrame(frame);
    onRotateStart?.();
  }, [onRotateStart]);

  const handleRotate = useCallback((axis: GizmoAxis, angleDelta: number) => {
    // Use the frozen frame's quaternion for a stable world-axis direction.
    const frame = frozenFrameRef.current;
    if (!frame) return;

    const displayFrame = getDisplayFrameFromCutterFrame(frame.cutterFrame);
    const worldAxis = getFrameAxis(displayFrame, axis);

    // Accumulate against the drag-start normal instead of repeatedly rotating
    // the already-updated normal. This keeps the reference axis fixed for the
    // whole stroke and avoids direction flips around the midpoint.
    frame.accumulatedAngle += angleDelta;
    const deltaQuat = new THREE.Quaternion().setFromAxisAngle(worldAxis, -frame.accumulatedAngle);
    const nextCutterFrame = rotateFrame(frame.cutterFrame, deltaQuat);
    const nextDisplayFrame = getDisplayQuaternionFromCutterFrame(nextCutterFrame);
    const newNormal = nextCutterFrame.yAxis.clone();
    newNormal.normalize();
    cutterFrameRef.current = nextCutterFrame;
    setDisplayFrameQuaternion(nextDisplayFrame);

    onRotate?.(newNormal, nextCutterFrame);
  }, [onRotate]);

  const handleRotateEnd = useCallback(() => {
    isRotatingRef.current = false;
    frozenFrameRef.current = null;
    setFrozenFrame(null);
    onRotateEnd?.();
  }, [onRotateEnd]);

  return (
    <ScreenSpaceGizmo
      position={[placement.worldPoint.x, placement.worldPoint.y, placement.worldPoint.z]}
      rotation={gizmoEuler}
      enableMove
      enableRotate
      showCenter={false}
      handleScale={1.5}
      moveHandleThicknessScale={1}
      scaleFactor={0.04}
      followMeshRef={false}
      disableArrowFlip
      disableRingBillboard
      disableViewCull
      axisVisualFlip={{ y: -1 }}
      onMoveStart={handleMoveStart}
      onMove={handleMove}
      onMoveEnd={handleMoveEnd}
      onRotateStart={handleRotateStart}
      onRotate={handleRotate}
      onRotateEnd={handleRotateEnd}
      enableLighting={false}
    />
  );
}
