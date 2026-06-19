"use client";

import React from 'react';
import { TransformGizmo } from './TransformGizmo';
import type { TransformGizmoProps } from './types';

/**
 * LocalSpaceGizmo - A transform gizmo that stays in local space
 *
 * Unlike ScreenSpaceGizmo, this wrapper does NOT apply screen-space
 * scaling, camera-facing billboarding, arrow flipping, or any other
 * view-dependent adjustments. The gizmo stays fixed to the object's
 * local frame, making it suitable for rotated gizmos where world-
 * axis translations would be incorrect.
 *
 * All view-dependent behaviors are suppressed by default:
 * - disableArrowFlip       arrows always point in the local axis direction
 * - disableRingBillboard   rotation rings/handles stay fixed on the object
 * - disableViewCull        handles stay visible at all camera angles
 * - No screen-space scale  size is constant in world units
 * - No follow-mesh         position comes directly from the prop
 */
export function LocalSpaceGizmo({
  position,
  rotation = [0, 0, 0],
  size = 1.0,
  enableMove = false,
  enableRotate = false,
  enableScale = false,
  showCenter = false,
  axisVisualFlip,
  handleScale = 1.0,
  moveHandleThicknessScale = 1.0,
  moveHandleLengthScale = 1.0,
  onMoveStart,
  onMove,
  onMoveEnd,
  onRotateStart,
  onRotate,
  onRotateEnd,
  onDragStateChange,
}: Omit<TransformGizmoProps, 'disableArrowFlip' | 'disableRingBillboard' | 'disableViewCull'>) {
  return (
    <TransformGizmo
      position={position}
      rotation={rotation}
      size={size}
      enableMove={enableMove}
      enableRotate={enableRotate}
      enableScale={enableScale}
      showCenter={showCenter}
      disableArrowFlip
      disableRingBillboard
      disableViewCull
      axisVisualFlip={axisVisualFlip}
      handleScale={handleScale}
      moveHandleThicknessScale={moveHandleThicknessScale}
      moveHandleLengthScale={moveHandleLengthScale}
      onMoveStart={onMoveStart}
      onMove={onMove}
      onMoveEnd={onMoveEnd}
      onRotateStart={onRotateStart}
      onRotate={onRotate}
      onRotateEnd={onRotateEnd}
      onDragStateChange={onDragStateChange}
    />
  );
}
