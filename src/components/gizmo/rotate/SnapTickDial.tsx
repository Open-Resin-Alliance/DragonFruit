"use client";

import React, { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { GIZMO_SIZES } from '../constants';
import {
  getRingTicks,
  getSpokeAngles,
  polarToLocal,
  DEFAULT_SNAP_DIAL_CONFIG,
  type SnapDialConfig,
  type RingTickTier,
} from './snapRotation';

interface SnapTickDialProps {
  /** Axis ring colour. Stays axis-coloured regardless of drag state. */
  color: string;
  /** True when the ring is hovered — the dial fades in. */
  hovered: boolean;
  /** True during an active drag — the dial is strongest. */
  active: boolean;
  /** Multiplies the computed opacity, mirroring the ring's opacityScale. */
  opacityScale?: number;
  /** Tier intervals. Defaults to the reference 5/10/45 anatomy. */
  config?: SnapDialConfig;
  /** Ring-local angle of the tick under the cursor, drawn emphasised. */
  highlightRad?: number | null;
}

/** Ring tick length as a fraction of dialTickLength. */
const TIER_LENGTH_SCALE: Record<RingTickTier, number> = {
  long: 1.0,
  short: 0.5,
};

/** Stroke width per ring tier. */
const TIER_LINE_WIDTH: Record<RingTickTier, number> = {
  long: 1.8,
  short: 0.9,
};

const RING_TIERS: RingTickTier[] = ['long', 'short'];

/**
 * SnapTickDial — the protractor anatomy the armed picker aims at.
 *
 * Three elements, all in the ring-local frame:
 * - Ring ticks on the circle at dialRadius, radiating outward: short every 5
 *   degrees, long every 10. While the dial is armed these are the pick
 *   targets the selection spoke sticks to.
 * - Eight spokes in the inner band from dialRadius/3 to 2*dialRadius/3 —
 *   visual anatomy marking the 45-degree positions.
 * - A reference radius at 0 degrees — the origin the sweep arc and the
 *   committed rotation are measured from.
 *
 * Deliberately NOT inside the camera-following arc group (the original
 * off-axis drift defect), and deliberately flip-agnostic: both the tick set
 * and the spoke set are full symmetric revolutions, so negating every angle
 * maps each set onto itself. The AngleSpoke, which carries a single angle, is
 * the one that takes axisVisualFlip.
 */
export function SnapTickDial({
  color,
  hovered,
  active,
  opacityScale = 1,
  config = DEFAULT_SNAP_DIAL_CONFIG,
  highlightRad = null,
}: SnapTickDialProps) {
  const ringSegmentsByTier = useMemo(() => {
    const ticks = getRingTicks(config);
    const inner = GIZMO_SIZES.dialRadius;

    return RING_TIERS.map((tier) => {
      const outer = inner + GIZMO_SIZES.dialTickLength * TIER_LENGTH_SCALE[tier];
      const points: [number, number, number][] = [];
      for (const tick of ticks) {
        if (tick.tier !== tier) continue;
        points.push(polarToLocal(tick.rad, inner));
        points.push(polarToLocal(tick.rad, outer));
      }
      return { tier, points };
    });
  }, [config]);

  const spokePoints = useMemo(() => {
    const inner = GIZMO_SIZES.dialRadius / 3;
    const outer = (2 * GIZMO_SIZES.dialRadius) / 3;
    const points: [number, number, number][] = [];
    for (const rad of getSpokeAngles(config)) {
      points.push(polarToLocal(rad, inner));
      points.push(polarToLocal(rad, outer));
    }
    return points;
  }, [config]);

  const highlightPoints = useMemo(() => {
    if (highlightRad === null) return null;
    const inner = GIZMO_SIZES.dialRadius;
    const outer = inner + GIZMO_SIZES.dialTickLength * 1.25;
    return [polarToLocal(highlightRad, inner), polarToLocal(highlightRad, outer)];
  }, [highlightRad]);

  const referencePoints = useMemo(
    () => [
      polarToLocal(0, GIZMO_SIZES.spokeInnerRadius),
      polarToLocal(0, GIZMO_SIZES.dialRadius + GIZMO_SIZES.dialTickLength),
    ],
    [],
  );

  const opacity = (active ? 0.85 : hovered ? 0.45 : 0) * opacityScale;
  if (opacity <= 0) return null;

  return (
    <group>
      {ringSegmentsByTier.map(({ tier, points }) =>
        points.length > 0 ? (
          <Line
            key={tier}
            points={points}
            segments
            color={color}
            lineWidth={TIER_LINE_WIDTH[tier]}
            transparent
            opacity={opacity}
            depthTest={false}
            toneMapped={false}
          />
        ) : null,
      )}
      {spokePoints.length > 0 && (
        <Line
          points={spokePoints}
          segments
          color={color}
          lineWidth={1.4}
          transparent
          opacity={opacity * 0.8}
          depthTest={false}
          toneMapped={false}
        />
      )}
      {highlightPoints && (
        // The tick the cursor would rotate to — selection needs aim feedback.
        <Line
          points={highlightPoints}
          color="#ffffff"
          lineWidth={2.4}
          transparent
          opacity={Math.min(1, opacity + 0.35)}
          depthTest={false}
          toneMapped={false}
        />
      )}
      {/* 0-degree reference radius — the origin the angle arc grows from. */}
      <Line
        points={referencePoints}
        color={color}
        lineWidth={2.0}
        transparent
        opacity={Math.min(1, opacity * 1.15)}
        depthTest={false}
        toneMapped={false}
      />
    </group>
  );
}
