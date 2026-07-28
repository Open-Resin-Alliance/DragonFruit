"use client";

import React, { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { GIZMO_SIZES } from '../constants';
import { polarToLocal, spokeRingAngle } from './snapRotation';

/** Angular resolution of the drag arc. */
const ARC_STEP_RAD = Math.PI / 64;

interface AngleSpokeProps {
  /** Axis ring colour. */
  color: string;
  /** The object's current rotation about this ring's axis, in radians. */
  currentAngleRad: number;
  /** -1 when the consumer's display axis is inverted (HolePunchGizmo's y). */
  axisVisualFlip: number;
  /** True when the ring is hovered — the spoke fades in. */
  hovered: boolean;
  /** True during an active drag — the spoke is strongest. */
  active: boolean;
  /** Multiplies the computed opacity, mirroring the ring's opacityScale. */
  opacityScale?: number;
}

/**
 * AngleSpoke — a radial line from near the gizmo centre out to the dial,
 * sitting at the object's true rotation angle about this ring's axis.
 *
 * This is the element the maintainer asked for ("add that line from the gizmo
 * to the centre"), and it is what actually indicates the angle. The diamond
 * handle deliberately does not do that job: the handle parks itself facing the
 * camera so it stays grabbable, which means its position is a camera artifact,
 * not an angle. Reading it as an angle is what made the readout and the ticks
 * appear to disagree off-axis.
 *
 * Drawn in the ring's local frame from the same polarToLocal the dial uses, so
 * the spoke and the ticks cannot disagree about where an angle sits.
 */
export function AngleSpoke({
  color,
  currentAngleRad,
  axisVisualFlip,
  hovered,
  active,
  opacityScale = 1,
}: AngleSpokeProps) {
  const angle = spokeRingAngle(currentAngleRad, axisVisualFlip);

  const points = useMemo(
    () => [
      polarToLocal(angle, GIZMO_SIZES.spokeInnerRadius),
      polarToLocal(angle, GIZMO_SIZES.dialRadius),
    ],
    [angle],
  );

  // Arc from the 0-degree reference to the current angle, hugging the tick
  // circle — rendered only during a drag, when continuous invalidation is
  // already active, so it adds no idle-loop pressure.
  const arcPoints = useMemo(() => {
    if (!active || Math.abs(angle) < 1e-6) return null;
    const steps = Math.max(2, Math.ceil(Math.abs(angle) / ARC_STEP_RAD));
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= steps; i += 1) {
      pts.push(polarToLocal((angle * i) / steps, GIZMO_SIZES.dialRadius));
    }
    return pts;
  }, [active, angle]);

  const opacity = (active ? 0.9 : hovered ? 0.5 : 0) * opacityScale;
  if (opacity <= 0) return null;

  return (
    <group>
      <Line
        points={points}
        color={color}
        lineWidth={active ? 1.6 : 1.2}
        transparent
        opacity={opacity}
        depthTest={false}
        toneMapped={false}
      />
      {arcPoints && (
        <Line
          points={arcPoints}
          color={color}
          lineWidth={2.2}
          transparent
          opacity={Math.min(1, opacity * 1.1)}
          depthTest={false}
          toneMapped={false}
        />
      )}
    </group>
  );
}
