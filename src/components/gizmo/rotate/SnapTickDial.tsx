"use client";

import React, { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { GIZMO_SIZES } from '../constants';
import {
  getSnapTicks,
  polarToLocal,
  DEFAULT_SNAP_TICK_CONFIG,
  type SnapTickConfig,
  type TickTier,
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
  /** Tier intervals. Defaults to 45/15/5; the settings surface supplies #104's config. */
  config?: SnapTickConfig;
  /** Ring-local angle of the tick under the cursor, drawn emphasised. */
  highlightRad?: number | null;
}

/** Tick length as a fraction of dialTickLength, longest tier first. */
const TIER_LENGTH_SCALE: Record<TickTier, number> = {
  major: 1.0,
  medium: 0.62,
  minor: 0.34,
};

/** Stroke width per tier. */
const TIER_LINE_WIDTH: Record<TickTier, number> = {
  major: 2.0,
  medium: 1.3,
  minor: 0.7,
};

const TIERS: TickTier[] = ['major', 'medium', 'minor'];

/**
 * SnapTickDial — the protractor dial.
 *
 * Ticks sit on a circle at `dialRadius`, inside the coloured drag ring, and
 * radiate OUTWARD toward it. Keeping the tick band off the ring geometry is the
 * point: overlapping the ring is what made the previous attempt hard to read.
 *
 * Rendered in the ring's local frame, deliberately NOT inside the
 * camera-following arc group. Pairing fixed angular positions with a
 * camera-following frame is what made ticks and indicator drift apart off-axis.
 *
 * No axisVisualFlip prop, and that is not an oversight: the tick set is one full
 * revolution at a fixed increment, so negating every angle maps the set onto
 * itself, and tier classification is preserved because each interval divides
 * 360. The dial is flip-invariant. The spoke and click resolution are not —
 * they carry a single angle, and both take the flip.
 */
export function SnapTickDial({
  color,
  hovered,
  active,
  opacityScale = 1,
  config = DEFAULT_SNAP_TICK_CONFIG,
  highlightRad = null,
}: SnapTickDialProps) {
  const segmentsByTier = useMemo(() => {
    const ticks = getSnapTicks(config);
    const inner = GIZMO_SIZES.dialRadius;

    return TIERS.map((tier) => {
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

  const highlightPoints = useMemo(() => {
    if (highlightRad === null) return null;
    const inner = GIZMO_SIZES.dialRadius;
    const outer = inner + GIZMO_SIZES.dialTickLength * 1.25;
    return [polarToLocal(highlightRad, inner), polarToLocal(highlightRad, outer)];
  }, [highlightRad]);

  const opacity = (active ? 0.85 : hovered ? 0.45 : 0) * opacityScale;
  if (opacity <= 0) return null;

  return (
    <group>
      {segmentsByTier.map(({ tier, points }) =>
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
      {highlightPoints && (
        // The tick the cursor would land on. With 72 targets on a dial that is
        // small at default zoom, a click with no aim feedback is a coin toss.
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
    </group>
  );
}
