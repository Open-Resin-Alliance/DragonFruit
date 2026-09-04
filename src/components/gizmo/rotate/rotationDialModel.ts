import * as THREE from 'three';
import { GIZMO_SIZES } from '../constants';
import type { GizmoAxis } from '../types';

/**
 * Protractor dial for the rotation rings — the pure model.
 *
 * The dial appears while a ring handle is held and stays FIXED at the angle the
 * handle was grabbed at: every angle here is measured from that grab, so the
 * gesture is purely relative. A model sitting at 47.3 degrees that is dragged to
 * the dial's +10 mark ends at 57.3, wherever the handle happened to be parked.
 *
 * Anatomy, from the centre outwards (PrusaSlicer's dial with the rim marks
 * turned inward, which is what the maintainer asked for):
 *
 *   0.0 R .. 0.3 R    no magnet
 *   0.3 R .. 0.6 R    45-degree spokes; the magnet holds these
 *   0.6 R .. 0.9 R    no magnet
 *   0.9 R .. 1.0 R    5- and 10-degree rim marks; the magnet holds these
 *   past 1.0 R        no magnet
 *
 * The 30/30/30/10 split of the radius is measured off a top-down view of the
 * reference dial, and R is the ring the axis already draws.
 *
 * "No magnet" is not "no pointer": in those coronas the moving radius follows the
 * pointer exactly as it does everywhere else, and the rotation is free. The
 * coronas without a magnet are the point, not an oversight — they are what lets
 * the pointer sit visually close to a mark and still rotate freely, which is the
 * behaviour the maintainer demonstrated from PrusaSlicer (pointer between the
 * spokes and the rim marks, right next to a spoke, unattracted).
 */

const DEG = Math.PI / 180;

/** Tick tiers, in whole degrees. Fixed anatomy — deliberately not configurable. */
export const DIAL_STEP_DEG = {
  /** Inner spokes. Also the coarse magnet step. */
  spoke: 45,
  /** Long rim marks. */
  long: 10,
  /** Short rim marks. Also the fine magnet step, so 10s and 45s come for free. */
  short: 5,
} as const;

export type DialMarkTier = keyof typeof DIAL_STEP_DEG;

/**
 * Radii of the dial's parts, in gizmo units.
 *
 * The rim marks end ON the ring the axis already draws (`ringMajorRadius`) and
 * grow inward from there — the maintainer chose the existing axis ring as the
 * dial's circumference rather than adding a second circle. The magnet coronas
 * are derived from these same numbers, so a mark you can see is a mark you can
 * catch, and moving a radius here moves both the drawing and the magnet.
 */
export const DIAL_ANATOMY = {
  /** Outer end of every rim mark, and the outer edge of the magnet. */
  rimRadius: GIZMO_SIZES.ringMajorRadius,
  /** Inner end of the 10-degree marks — also where the rim corona starts. */
  longTickInnerRadius: GIZMO_SIZES.ringMajorRadius * 0.9,
  /** Inner end of the 5-degree marks. Half the length of a long mark. */
  shortTickInnerRadius: GIZMO_SIZES.ringMajorRadius * 0.95,
  /** Inner end of the 45-degree spokes. */
  spokeInnerRadius: GIZMO_SIZES.ringMajorRadius * 0.3,
  /** Outer end of the 45-degree spokes. */
  spokeOuterRadius: GIZMO_SIZES.ringMajorRadius * 0.6,
} as const;

/** Screen distance at which a mark grabs the moving radius. */
export const MAGNET_ENTER_PX = 10;
/**
 * Screen distance at which a held mark lets go. Kept as its own constant from
 * the start: a release radius LARGER than the enter radius is what makes the
 * magnet feel like a magnet (you have to pull harder to escape than to enter),
 * and the two values are the only knob for that feel.
 */
export const MAGNET_EXIT_PX = 10;

export interface DialMark {
  /** Angle from the dial's zero, whole degrees in [0, 360). */
  deg: number;
  /** Same angle in radians. */
  rad: number;
  tier: DialMarkTier;
  innerRadius: number;
  outerRadius: number;
}

/**
 * Wrap an angle into (-PI, PI].
 *
 * Modular rather than the atan2 round-trip: an angle already in range comes back
 * bit-for-bit unchanged, so a mark's angle stays exactly the value the tick grid
 * produced. The atan2 form loses a bit, which is enough to make two supposedly
 * identical marks compare unequal.
 */
export function wrapAngle(rad: number): number {
  const TWO_PI = Math.PI * 2;
  let wrapped = rad % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  else if (wrapped <= -Math.PI) wrapped += TWO_PI;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Signed delta from one angle to another, the short way round. The rotation is
 * emitted to the consumer as a delta, so crossing the wrap boundary has to read
 * as a small step rather than a full turn backwards.
 */
export function shortestAngleDelta(fromRad: number, toRad: number): number {
  return wrapAngle(toRad - fromRad);
}

/**
 * The dial's sweep as the readout shows it: signed, two decimals, and wrapped
 * into one turn.
 *
 * The wrap is not cosmetic. The drag accumulates the sweep UNWRAPPED, because the
 * handle has to keep turning continuously across the +/-180 boundary and a
 * multi-turn drag has to keep applying rotation. Reporting that raw accumulator
 * would print 540 for a turn and a half, which no other angle in the app does —
 * the Transform panel's X/Y/Z fields wrap the same way, because they are read off
 * a quaternion. Same wrap here so the readout and the panel cannot disagree about
 * what a rotation is.
 */
export function formatSweepDegrees(sweepRad: number): string {
  if (!Number.isFinite(sweepRad)) return '0.00';
  const degrees = (wrapAngle(sweepRad) * 180) / Math.PI;
  const signed = degrees > 0 ? `+${degrees.toFixed(2)}` : degrees.toFixed(2);
  // toFixed rounds -0.001 to "-0.00", and a signed zero reads as a bug.
  return signed === '-0.00' ? '0.00' : signed;
}

/** Position of a dial angle in the ring's local XY plane. */
export function polarToLocal(angleRad: number, radius: number): [number, number, number] {
  return [Math.cos(angleRad) * radius, Math.sin(angleRad) * radius, 0];
}

/**
 * Euler that orients a ring's local frame onto its world axis, so that local +Z
 * is the rotation axis and a positive local angle sweep is a positive rotation
 * about that axis.
 *
 * This is the single source for the ring frame: GizmoRotation applies it to the
 * ring group and the tests measure through it, so the drawing and the sign of
 * the emitted rotation cannot drift apart.
 */
export function ringGroupEuler(axis: GizmoAxis): [number, number, number] {
  if (axis === 'x') return [0, Math.PI / 2, 0];
  if (axis === 'y') return [-Math.PI / 2, 0, 0];
  return [0, 0, 0];
}

/**
 * Radial extent of a mark of a given tier.
 *
 * One source for both the drawing and the highlight under the magnet, so a held
 * mark cannot be highlighted somewhere the mark is not drawn.
 */
export function markRadiiForTier(tier: DialMarkTier): { innerRadius: number; outerRadius: number } {
  if (tier === 'spoke') {
    return {
      innerRadius: DIAL_ANATOMY.spokeInnerRadius,
      outerRadius: DIAL_ANATOMY.spokeOuterRadius,
    };
  }
  return {
    innerRadius: tier === 'long'
      ? DIAL_ANATOMY.longTickInnerRadius
      : DIAL_ANATOMY.shortTickInnerRadius,
    outerRadius: DIAL_ANATOMY.rimRadius,
  };
}

/**
 * Every mark on the dial, for one revolution measured from the dial's zero.
 *
 * Two families that overlap by design: 72 rim marks (long where the degree
 * divides by 10, short elsewhere) plus 8 inner spokes. A multiple of 45 is
 * therefore drawn twice — a short or long mark on the rim AND a spoke inside —
 * which is exactly what the reference dial does.
 */
export function getDialMarks(): DialMark[] {
  const marks: DialMark[] = [];

  for (let deg = 0; deg < 360; deg += DIAL_STEP_DEG.short) {
    const tier: DialMarkTier = deg % DIAL_STEP_DEG.long === 0 ? 'long' : 'short';
    marks.push({ deg, rad: deg * DEG, tier, ...markRadiiForTier(tier) });
  }

  for (let deg = 0; deg < 360; deg += DIAL_STEP_DEG.spoke) {
    marks.push({ deg, rad: deg * DEG, tier: 'spoke', ...markRadiiForTier('spoke') });
  }

  return marks;
}

/** Which family of marks, if any, the magnet holds at a given distance from the centre. */
export type MagnetBand = 'none' | 'spokes' | 'rim';

/**
 * The corona the pointer is in, in gizmo units measured in the ring's plane.
 *
 * Radial, not angular: this is the gate that makes the magnet ignore a mark the
 * pointer is angularly right on top of but radially nowhere near. `none` gates
 * the MAGNET only — the pointer is still tracked there and the rotation follows
 * it freely.
 */
export function magnetBandForRadius(radius: number): MagnetBand {
  if (radius >= DIAL_ANATOMY.spokeInnerRadius && radius <= DIAL_ANATOMY.spokeOuterRadius) {
    return 'spokes';
  }
  if (radius >= DIAL_ANATOMY.longTickInnerRadius && radius <= DIAL_ANATOMY.rimRadius) {
    return 'rim';
  }
  return 'none';
}

/** True when a band holds marks of this tier. */
export function bandHoldsTier(band: MagnetBand, tier: DialMarkTier): boolean {
  if (band === 'spokes') return tier === 'spoke';
  if (band === 'rim') return tier === 'long' || tier === 'short';
  return false;
}

export interface DialSnapTarget {
  /** Angle of the mark, measured from the dial's zero, wrapped into (-PI, PI]. */
  angleRad: number;
  tier: DialMarkTier;
}

/**
 * The mark the pointer would snap to at this angle and radius, before the
 * distance test — the nearest mark of whichever family this corona holds.
 *
 * In the rim corona the candidate grid is every 5 degrees; the tier only says
 * how the mark is drawn. That is why 5, 10 and 45 all fall out of one grid: a
 * multiple of 10 or 45 is also a multiple of 5.
 */
export function dialSnapCandidate(angleRad: number, radius: number): DialSnapTarget | null {
  const band = magnetBandForRadius(radius);
  if (band === 'none') return null;

  const stepDeg = band === 'spokes' ? DIAL_STEP_DEG.spoke : DIAL_STEP_DEG.short;
  const degrees = angleRad / DEG;
  const snappedDeg = Math.round(degrees / stepDeg) * stepDeg;
  const normalisedDeg = ((snappedDeg % 360) + 360) % 360;

  const tier: DialMarkTier = band === 'spokes'
    ? 'spoke'
    : normalisedDeg % DIAL_STEP_DEG.long === 0 ? 'long' : 'short';

  return { angleRad: wrapAngle(snappedDeg * DEG), tier };
}

export interface DialAngleInput {
  /** Pointer angle in the ring's plane, measured from the dial's zero. */
  cursorAngleRad: number;
  /** Pointer distance from the gizmo centre, in gizmo units, in the ring's plane. */
  cursorRadius: number;
  /**
   * Screen distance in pixels from the pointer to a mark's radius line. Taken as
   * a callback because it needs the camera: the perpendicular gap on screen is
   * what the maintainer specified ("a few pixels"), and it is measured against
   * the line the mark sits on, so a foreshortened ring behaves like it looks.
   */
  gapPxForAngle: (markAngleRad: number) => number;
  /** Mark held on the previous sample, or null when the pointer was running free. */
  held: DialSnapTarget | null;
  enterPx?: number;
  exitPx?: number;
}

export interface DialAngleResult {
  /** Angle the moving radius (and so the model) should take, from the dial's zero. */
  angleRad: number;
  /** Mark now held, or null when running free. Feed this back in as `held`. */
  held: DialSnapTarget | null;
}

/**
 * Resolve where the moving radius sits for a pointer sample: on a mark when the
 * magnet has it, otherwise straight under the pointer.
 *
 * Hysteresis is the whole reason this takes the previous `held` mark: a mark
 * that already has the radius keeps it until the pointer pulls `exitPx` away,
 * which is what "you have to move a bit harder to get out" means. Leaving the
 * corona releases immediately, no matter how small the gap — the corona gate
 * comes first, so a pointer that has drifted radially off the marks rotates
 * freely even while it is angularly right on one.
 */
export function resolveDialAngle({
  cursorAngleRad,
  cursorRadius,
  gapPxForAngle,
  held,
  enterPx = MAGNET_ENTER_PX,
  exitPx = MAGNET_EXIT_PX,
}: DialAngleInput): DialAngleResult {
  const band = magnetBandForRadius(cursorRadius);

  if (held && bandHoldsTier(band, held.tier) && gapPxForAngle(held.angleRad) <= exitPx) {
    return { angleRad: held.angleRad, held };
  }

  const candidate = dialSnapCandidate(cursorAngleRad, cursorRadius);
  if (candidate && gapPxForAngle(candidate.angleRad) <= enterPx) {
    return { angleRad: candidate.angleRad, held: candidate };
  }

  return { angleRad: cursorAngleRad, held: null };
}

export interface Point2 {
  x: number;
  y: number;
}

/**
 * Perpendicular distance from a point to the infinite line through a and b.
 *
 * The magnet measures against the LINE a mark sits on rather than its drawn
 * segment: the corona gate already decides whether the pointer is at the right
 * distance from the centre, so the segment's own ends would only double-count
 * that test and make the magnet die near the ends of a mark.
 */
export function distancePointToLine(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  // Degenerate line (the gizmo centre projected onto the mark's own position,
  // e.g. an exactly edge-on ring): fall back to the distance to the point.
  if (length < 1e-6) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dx * (a.y - point.y) - dy * (a.x - point.x)) / length;
}

export interface RingPlaneHit {
  /** Distance from the ring centre, in gizmo units. */
  radius: number;
  /** Angle in the ring's local frame, in (-PI, PI]. */
  angleRad: number;
}

/**
 * Intersect a pointer ray with a ring's plane and return the hit in ring-local
 * polar coordinates, or null when the ray is (near-)parallel to the plane or the
 * plane lies behind the pointer.
 *
 * Takes the ring group's WORLD MATRIX, not its rotation and position: the gizmo
 * root is scaled every frame to keep a constant size on screen
 * (ScreenSpaceGizmo, scale = camera distance * 0.04), so the returned radius has
 * to be divided by that scale to be comparable with DIAL_ANATOMY. Rotating the
 * world-space offset without undoing the scale returns world units, which reads
 * as "the pointer is way outside every corona" at any camera distance where the
 * scale is not 1 — the magnet then never engages, or engages in the wrong
 * corona. The full inverse matrix undoes translation, rotation and scale at once.
 *
 * Null means "no usable sample": the caller keeps the previous angle rather than
 * inventing one, so a grazing, nearly edge-on ring stalls instead of flinging
 * the model around.
 */
export function rayToRingLocal(
  rayOrigin: THREE.Vector3,
  rayDir: THREE.Vector3,
  ringMatrixWorld: THREE.Matrix4,
): RingPlaneHit | null {
  // transformDirection normalises, and the gizmo's scale is uniform, so this is
  // the plane normal without needing the inverse-transpose.
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(ringMatrixWorld);
  const denom = rayDir.dot(normal);
  if (Math.abs(denom) < 1e-6) return null;

  const center = new THREE.Vector3().setFromMatrixPosition(ringMatrixWorld);
  const t = center.sub(rayOrigin).dot(normal) / denom;
  if (t <= 0) return null;

  const local = rayOrigin
    .clone()
    .addScaledVector(rayDir, t)
    .applyMatrix4(new THREE.Matrix4().copy(ringMatrixWorld).invert());

  return { radius: Math.hypot(local.x, local.y), angleRad: wrapAngle(Math.atan2(local.y, local.x)) };
}

/**
 * Rotation delta to emit for a sweep of the moving radius.
 *
 * A positive sweep in the ring's local frame IS a positive rotation about that
 * ring's axis (that is what `ringGroupEuler` buys us), but the consumer applies
 * emitted deltas NEGATED — SceneCanvas does `setFromAxisAngle(axis, -angle)` —
 * so the emission has to negate the sweep or the model turns against the dial.
 * `axisVisualFlip` is -1 for consumers whose displayed axis is inverted relative
 * to their domain axis (HolePunchGizmo's displayY = -cutterY).
 */
export function emittedDeltaForSweep(sweepRad: number, axisVisualFlip: number): number {
  const emitted = -sweepRad * axisVisualFlip;
  return Object.is(emitted, -0) ? 0 : emitted;
}

/** How far the dial has turned the object, and where it measures the next move from. */
export interface DialSweep {
  /** Sweep the object has actually taken since the grab. Drives handle and radius. */
  sweepRad: number;
  /** Dial angle the next pointer reading is measured against. */
  targetRad: number;
}

export interface DialSweepStep {
  /** Where the pointer is now, magnetised, relative to the grab. */
  cursorAngleRad: number;
  /** Sign mapping between the dial's sweep and the consumer's rotation. */
  axisVisualFlip: number;
  /** True when the consumer turns the ring itself by the rotation it applies. */
  frameCarriesRotation?: boolean;
  /**
   * Hands the consumer the rotation to apply and returns how much it took. Less
   * than it was asked for means a hard end (the tenon's lean clamps at 45); a
   * consumer with nothing to refuse can return nothing and take it all.
   */
  emit: (deltaRad: number) => number | void;
}

/**
 * One pointer move, from the resolved cursor angle to the sweep the object holds.
 *
 * The target advances by what the object TOOK, not by where the pointer went.
 * Past a hard end the refused travel stays as a gap between the two, so backing
 * off the end holds the object at the limit until the pointer comes back to it,
 * and from there the mark under the pointer is the angle again. Tracking the
 * pointer instead re-engages the rotation the instant the drag reverses, from the
 * limit, and the dial reads the whole overshoot short for the rest of the gesture
 * (the lean's 45-degree ceiling, backed off, landing on 15).
 *
 * When the frame carries the rotation the ring turns by whatever was applied, so
 * the next reading already comes back short by that much: there the pointer's own
 * angle is the new target and folding the sweep in would count it twice.
 */
export function stepDialSweep(previous: DialSweep, step: DialSweepStep): DialSweep {
  const { cursorAngleRad, axisVisualFlip, frameCarriesRotation = false, emit } = step;
  const delta = shortestAngleDelta(previous.targetRad, cursorAngleRad);
  if (delta === 0) return previous;

  const asked = emittedDeltaForSweep(delta, axisVisualFlip);
  const answer = emit(asked);
  const applied = typeof answer === 'number' ? answer : asked;
  // Back into dial units, the same mapping run backwards.
  const appliedSweep =
    axisVisualFlip === 0 || applied === asked ? delta : -applied / axisVisualFlip;

  return {
    sweepRad: previous.sweepRad + appliedSweep,
    targetRad: frameCarriesRotation ? cursorAngleRad : previous.targetRad + appliedSweep,
  };
}
