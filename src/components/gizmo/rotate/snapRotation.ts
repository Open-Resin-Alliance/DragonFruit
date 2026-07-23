import type { GizmoAxis } from '../types';

/** Snap angle to nearest increment using Math.round quantization. */
export function snapAngle(angle: number, increment: number): number {
  return Math.round(angle / increment) * increment;
}

/** Coarse snap increment: 45 degrees */
export const SNAP_COARSE = Math.PI / 4;

/** Fine snap increment: 15 degrees */
export const SNAP_FINE = Math.PI / 12;

/** localStorage key for persistent snap toggle. Governs DRAG snapping only —
 *  tick click-to-rotate is always available regardless of this setting. */
export const SNAP_STORAGE_KEY = 'dragonfruit:rotation-snap-enabled';

/** Tick length tier. `major` is longest, `minor` shortest. */
export type TickTier = 'major' | 'medium' | 'minor';

/** Tier intervals in whole degrees. Runtime-tunable via the settings panel (#104). */
export interface SnapTickConfig {
  majorDeg: number;
  mediumDeg: number;
  minorDeg: number;
}

/** 45/15/5 — 45 divides evenly by 15, so majors and mediums stay in phase. */
export const DEFAULT_SNAP_TICK_CONFIG: SnapTickConfig = {
  majorDeg: 45,
  mediumDeg: 15,
  minorDeg: 5,
};

/** One dial tick at a fixed angular position in the ring-local frame. */
export interface SnapTick {
  deg: number;
  rad: number;
  tier: TickTier;
}

/**
 * Build the de-duplicated tick set for one full revolution.
 *
 * Every position is emitted exactly once and classified by its LARGEST
 * matching tier, so a degree that is a multiple of all three (0, 45, 90...)
 * yields a single major tick rather than three overlapping ones. Classification
 * is done in whole degrees because the float radians for 45 and 15 multiples do
 * not compare exactly.
 */
export function getSnapTicks(
  config: SnapTickConfig = DEFAULT_SNAP_TICK_CONFIG,
): SnapTick[] {
  const { majorDeg, mediumDeg, minorDeg } = config;

  if (!Number.isInteger(minorDeg) || minorDeg <= 0) {
    throw new Error(
      `getSnapTicks: minorDeg must be a positive whole number of degrees, got ${minorDeg}`,
    );
  }
  if (360 % minorDeg !== 0) {
    throw new Error(
      `getSnapTicks: minorDeg must divide 360 evenly or the last gap is uneven, got ${minorDeg}`,
    );
  }

  const ticks: SnapTick[] = [];
  for (let deg = 0; deg < 360; deg += minorDeg) {
    const isMajor = majorDeg > 0 && deg % majorDeg === 0;
    const isMedium = mediumDeg > 0 && deg % mediumDeg === 0;
    const tier: TickTier = isMajor ? 'major' : isMedium ? 'medium' : 'minor';
    ticks.push({ deg, rad: (deg * Math.PI) / 180, tier });
  }
  return ticks;
}

/**
 * Map an object rotation angle about a ring's axis into that ring's local frame.
 *
 * `axisVisualFlip` is -1 when the consumer's display axis is inverted relative
 * to its domain axis — HolePunchGizmo passes it because displayY = -cutterY.
 * Dial ticks, the angle spoke, and click-to-angle resolution must all route
 * through here, or the dial mirrors and clicking +45 rotates -45.
 */
export function ringLocalAngle(
  objectAngleRad: number,
  axisVisualFlip: number,
): number {
  const flipped = axisVisualFlip < 0 ? -objectAngleRad : objectAngleRad;
  // Negating 0 yields -0, which is not Object.is-equal to 0. That would surface
  // later as a baffling mismatch in a Map key or a strict assertion, so collapse
  // it here rather than making every caller defend against it.
  return Object.is(flipped, -0) ? 0 : flipped;
}

/**
 * Position on the dial circle for a ring-local angle.
 *
 * Every ring is drawn in its own local XY plane and oriented by the group euler
 * from `ringGroupEuler`, so this mapping is the same for all three axes — the
 * per-axis difference lives in the group transform, not here. Dial ticks, the
 * angle spoke and click resolution all route through this one function so they
 * cannot disagree.
 */
export function polarToLocal(
  angleRad: number,
  radius: number,
): [number, number, number] {
  return [Math.cos(angleRad) * radius, Math.sin(angleRad) * radius, 0];
}

/**
 * Euler orienting a ring's local frame onto its world axis.
 *
 * Mirrors the rotation GizmoRotation already applies to each ring, so dial and
 * spoke land in the same frame as the ring they annotate.
 */
export function ringGroupEuler(axis: GizmoAxis): [number, number, number] {
  if (axis === 'x') return [0, Math.PI / 2, 0];
  if (axis === 'y') return [-Math.PI / 2, 0, 0];
  return [0, 0, 0];
}

const TWO_PI = Math.PI * 2;

/**
 * Ring-local angle of the tick nearest a given angle.
 *
 * Resolves a pointer hit on the dial to the tick it landed on. Quantisation is
 * done in whole degrees, matching getSnapTicks, so the result is exactly a
 * member of that tick set rather than a float that merely rounds to one.
 * Normalised into one revolution, so 358 degrees resolves forward to 0 rather
 * than backwards to 355.
 */
export function nearestTickRad(
  angleRad: number,
  config: SnapTickConfig = DEFAULT_SNAP_TICK_CONFIG,
): number {
  const { minorDeg } = config;
  if (!Number.isInteger(minorDeg) || minorDeg <= 0 || 360 % minorDeg !== 0) {
    throw new Error(
      `nearestTickRad: minorDeg must be a positive whole divisor of 360, got ${minorDeg}`,
    );
  }

  const degrees = (angleRad * 180) / Math.PI;
  const normalised = ((degrees % 360) + 360) % 360;
  const snapped = (Math.round(normalised / minorDeg) * minorDeg) % 360;
  return (snapped * Math.PI) / 180;
}

/**
 * Signed delta from one angle to another, taking the short way round.
 *
 * A tick click is applied as a delta through the existing drag callbacks, so
 * clicking 350 degrees while sitting at 10 must rotate -20, not +340.
 */
export function shortestAngleDelta(fromRad: number, toRad: number): number {
  let delta = (toRad - fromRad) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return Object.is(delta, -0) ? 0 : delta;
}

/**
 * Sign relating an object-space rotation to its ring-local visual angle.
 *
 * This is +1: a point fixed to the object, rotated by the object's Euler about
 * this ring's axis, lands at that same angle in the ring's local frame. Verified
 * against THREE's own rotation in the registration suite rather than reasoned
 * from the surrounding code.
 *
 * It is tempting to borrow the -1 `axisSign` from the drag path, which computes
 * `visualDelta = objectDelta * axisSign * axisVisualFlip`. Don't. That -1
 * compensates for the model applying an EMITTED DELTA with the opposite sign, so
 * it converts emitted-delta space into actual-rotation space. `currentAngleRad`
 * is already the object's actual rotation, so applying it again mirrors the
 * whole dial — which is exactly the bug the fiducial test now catches.
 */
const RING_VISUAL_AXIS_SIGN = 1;

/** Ring-local angle at which the spoke sits for a given object rotation. */
export function spokeRingAngle(
  objectAngleRad: number,
  axisVisualFlip: number,
): number {
  return ringLocalAngle(RING_VISUAL_AXIS_SIGN * objectAngleRad, axisVisualFlip);
}

/**
 * Object-space angle that puts the spoke on a given ring-local angle.
 *
 * Exact inverse of `spokeRingAngle`, which is what makes clicking a tick land
 * the spoke on that tick.
 */
export function objectAngleForRingAngle(
  ringAngleRad: number,
  axisVisualFlip: number,
): number {
  return RING_VISUAL_AXIS_SIGN * ringLocalAngle(ringAngleRad, axisVisualFlip);
}
