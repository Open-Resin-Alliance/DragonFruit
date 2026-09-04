"use client";

import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import {
  DIAL_ANATOMY,
  getDialMarks,
  markRadiiForTier,
  polarToLocal,
  type DialMarkTier,
  type DialSnapTarget,
} from './rotationDialModel';

/** Stroke width per tier. Long marks and spokes carry the read; shorts are hairlines. */
const TIER_LINE_WIDTH: Record<DialMarkTier, number> = {
  spoke: 1.3,
  long: 1.7,
  short: 0.9,
};

const TIER_ORDER: DialMarkTier[] = ['spoke', 'long', 'short'];

interface RotationDialProps {
  /** Axis ring colour — the dial is drawn in the gizmo's own colour. */
  color: string;
  /** Final opacity for the dial's marks. */
  opacity: number;
  /**
   * Group carrying the moving radius. Its `rotation.z` is set imperatively by
   * the drag, once per pointer sample: the radius follows the pointer at pointer
   * rate, which is no place for a React state update.
   */
  sweepGroupRef: React.RefObject<THREE.Group | null>;
  /** Mark the magnet is holding, drawn emphasised. Null while rotating freely. */
  held: DialSnapTarget | null;
}

/**
 * RotationDial — the protractor that appears while a ring handle is held.
 *
 * Mounted inside a group that the caller rotates to the angle the handle was
 * grabbed at, so everything here is drawn in dial-relative angles with zero
 * pointing at the grab. The dial does not move for the rest of the gesture: it
 * is the fixed reference the sweep is read against, which is the whole point of
 * measuring rotation relative to where you grabbed.
 *
 * Marks grow INWARD from the ring the axis already draws (see DIAL_ANATOMY), and
 * the magnet coronas are derived from the same radii, so what you can see is
 * what you can catch.
 */
export function RotationDial({ color, opacity, sweepGroupRef, held }: RotationDialProps) {
  const segmentsByTier = useMemo(() => {
    const marks = getDialMarks();
    return TIER_ORDER.map((tier) => {
      const points: [number, number, number][] = [];
      for (const mark of marks) {
        if (mark.tier !== tier) continue;
        points.push(polarToLocal(mark.rad, mark.innerRadius));
        points.push(polarToLocal(mark.rad, mark.outerRadius));
      }
      return { tier, points };
    });
  }, []);

  const radiusPoints = useMemo(
    () => [polarToLocal(0, 0), polarToLocal(0, DIAL_ANATOMY.rimRadius)],
    [],
  );

  const heldPoints = useMemo(() => {
    if (!held) return null;
    const { innerRadius, outerRadius } = markRadiiForTier(held.tier);
    return [polarToLocal(held.angleRad, innerRadius), polarToLocal(held.angleRad, outerRadius)];
  }, [held]);

  // The live radius and the held mark are the two elements that have to win the
  // read against the marks behind them, so they get the same hue lifted toward
  // white rather than a second colour.
  const liveColor = useMemo(
    () => new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.55).getStyle(),
    [color],
  );

  return (
    <group>
      {segmentsByTier.map(({ tier, points }) => (
        <Line
          key={tier}
          points={points}
          segments
          color={color}
          lineWidth={TIER_LINE_WIDTH[tier]}
          transparent
          opacity={tier === 'short' ? opacity * 0.75 : opacity}
          depthTest={false}
          toneMapped={false}
        />
      ))}

      {/* Zero reference: where the handle was grabbed. Dashed so it reads as the
          origin of the sweep rather than as another mark. */}
      <Line
        points={radiusPoints}
        color={color}
        lineWidth={1.0}
        dashed
        dashSize={0.22}
        gapSize={0.16}
        transparent
        opacity={opacity * 0.7}
        depthTest={false}
        toneMapped={false}
      />

      {heldPoints && (
        <Line
          points={heldPoints}
          color={liveColor}
          lineWidth={2.8}
          transparent
          opacity={Math.min(1, opacity + 0.1)}
          depthTest={false}
          toneMapped={false}
        />
      )}

      {/* Moving radius — centre to the ring, under the pointer (or stuck on the
          mark the magnet holds). This is the element the magnet acts on. */}
      <group ref={sweepGroupRef}>
        <Line
          points={radiusPoints}
          color={liveColor}
          lineWidth={2.2}
          transparent
          opacity={Math.min(1, opacity + 0.1)}
          depthTest={false}
          toneMapped={false}
        />
      </group>
    </group>
  );
}
