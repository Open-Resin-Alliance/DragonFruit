import * as THREE from 'three';
import type { GizmoAxis } from '../types';

/** Snap angle to nearest increment using Math.round quantization. */
export function snapAngle(angle: number, increment: number): number {
  return Math.round(angle / increment) * increment;
}

/** Coarse snap increment: 45 degrees */
export const SNAP_COARSE = Math.PI / 4;

/** Fine snap increment: 15 degrees */
export const SNAP_FINE = Math.PI / 12;

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

// ─── Faithful dial model (dragonfruit-103-2) ────────────────────────────────
// Ring ticks at short/long tiers plus a coarse spoke band. Rotation is a
// two-step pick: arm the dial from the grabber, aim at a tick (the selection
// spoke sticks to ticks), click to commit. There is no drag-to-rotate.

/** Tier intervals for the faithful dial, whole degrees. */
export interface SnapDialConfig {
  /** Short-tick spacing on the ring; also the fine snap step. Must divide 360. */
  ringShortDeg: number;
  /** Long-tick spacing on the ring. 0 disables the long tier. */
  ringLongDeg: number;
  /** Spoke spacing in the inner band; also the coarse snap step. 0 disables. */
  spokeDeg: number;
}

/** The reference anatomy: short 5, long 10, spokes 45. */
/** localStorage key for the persisted dial config (#104). Same key the legacy
 *  shape used — parseSnapDialConfig rejects old values so they reset cleanly. */
export const SNAP_DIAL_CONFIG_STORAGE_KEY = 'dragonfruit:rotation-tick-config';

export const DEFAULT_SNAP_DIAL_CONFIG: SnapDialConfig = {
  ringShortDeg: 5,
  ringLongDeg: 10,
  spokeDeg: 45,
};

export type RingTickTier = 'long' | 'short';

export interface RingTick {
  deg: number;
  rad: number;
  tier: RingTickTier;
}

function assertShortDeg(shortDeg: number): void {
  if (!Number.isInteger(shortDeg) || shortDeg <= 0 || 360 % shortDeg !== 0) {
    throw new Error(
      `ring short step must be a positive whole divisor of 360, got ${shortDeg}`,
    );
  }
}

/**
 * Ring tick set for one revolution: one tick per short increment, classified
 * long where the long interval divides the degree. Whole-degree arithmetic,
 * for the same float-comparison reason as the legacy tier builder above.
 */
export function getRingTicks(
  config: SnapDialConfig = DEFAULT_SNAP_DIAL_CONFIG,
): RingTick[] {
  const { ringShortDeg, ringLongDeg } = config;
  assertShortDeg(ringShortDeg);

  const ticks: RingTick[] = [];
  for (let deg = 0; deg < 360; deg += ringShortDeg) {
    const tier: RingTickTier =
      ringLongDeg > 0 && deg % ringLongDeg === 0 ? 'long' : 'short';
    ticks.push({ deg, rad: (deg * Math.PI) / 180, tier });
  }
  return ticks;
}

/** Spoke angles for the inner coarse band. Zero spacing disables the band. */
export function getSpokeAngles(
  config: SnapDialConfig = DEFAULT_SNAP_DIAL_CONFIG,
): number[] {
  const { spokeDeg } = config;
  if (spokeDeg === 0) return [];
  if (!Number.isInteger(spokeDeg) || spokeDeg < 0 || 360 % spokeDeg !== 0) {
    throw new Error(`spoke step must be 0 or a positive whole divisor of 360, got ${spokeDeg}`);
  }
  const spokes: number[] = [];
  for (let deg = 0; deg < 360; deg += spokeDeg) {
    spokes.push((deg * Math.PI) / 180);
  }
  return spokes;
}

/** True when a config can be rendered and snapped against without throwing. */
function isUsableDialConfig(value: unknown): value is SnapDialConfig {
  if (typeof value !== 'object' || value === null) return false;
  const { ringShortDeg, ringLongDeg, spokeDeg } = value as Record<string, unknown>;
  if (
    typeof ringShortDeg !== 'number' ||
    typeof ringLongDeg !== 'number' ||
    typeof spokeDeg !== 'number'
  ) {
    return false;
  }
  const divides = (d: number) => Number.isInteger(d) && d > 0 && 360 % d === 0;
  return (
    divides(ringShortDeg) &&
    (ringLongDeg === 0 || divides(ringLongDeg)) &&
    (spokeDeg === 0 || divides(spokeDeg))
  );
}

/**
 * Read a persisted dial config, falling back to the default on anything
 * unusable — including the LEGACY {majorDeg, mediumDeg, minorDeg} shape, which
 * must reset cleanly rather than half-apply.
 */
export function parseSnapDialConfig(raw: string | null): SnapDialConfig {
  if (!raw) return DEFAULT_SNAP_DIAL_CONFIG;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUsableDialConfig(parsed)
      ? {
          ringShortDeg: parsed.ringShortDeg,
          ringLongDeg: parsed.ringLongDeg,
          spokeDeg: parsed.spokeDeg,
        }
      : DEFAULT_SNAP_DIAL_CONFIG;
  } catch {
    return DEFAULT_SNAP_DIAL_CONFIG;
  }
}

/**
 * Intersect a pointer ray with a ring's plane and return ring-local polar
 * coordinates, or null when the ray is (near-)parallel to the plane or the
 * intersection lies behind the origin. Callers treat null as "hold the
 * previous zone" during a drag, so a grazing pose degrades gracefully instead
 * of flickering to free.
 */
export function rayToRingLocal(
  rayOrigin: THREE.Vector3,
  rayDir: THREE.Vector3,
  ringQuat: THREE.Quaternion,
  ringCenter: THREE.Vector3,
): { len: number; angleRad: number } | null {
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(ringQuat);
  const denom = rayDir.dot(normal);
  if (Math.abs(denom) < 1e-6) return null;

  const t = ringCenter.clone().sub(rayOrigin).dot(normal) / denom;
  if (t <= 0) return null;

  const local = rayOrigin
    .clone()
    .addScaledVector(rayDir, t)
    .sub(ringCenter)
    .applyQuaternion(ringQuat.clone().invert());
  return { len: Math.hypot(local.x, local.y), angleRad: Math.atan2(local.y, local.x) };
}

/**
 * Ring-local angle of the ring tick nearest a given angle, normalised into
 * [0, 2*PI). Quantisation is by the short step in whole degrees, matching
 * getRingTicks, so the result is exactly a member of that tick set.
 */
export function nearestRingTickRad(
  angleRad: number,
  config: SnapDialConfig = DEFAULT_SNAP_DIAL_CONFIG,
): number {
  const { ringShortDeg } = config;
  if (!Number.isInteger(ringShortDeg) || ringShortDeg <= 0 || 360 % ringShortDeg !== 0) {
    throw new Error(`nearestRingTickRad: short step must divide 360, got ${ringShortDeg}`);
  }
  const degrees = (angleRad * 180) / Math.PI;
  const normalised = ((degrees % 360) + 360) % 360;
  const snapped = (Math.round(normalised / ringShortDeg) * ringShortDeg) % 360;
  return (snapped * Math.PI) / 180;
}

/**
 * Signed delta from one angle to another, taking the short way round.
 * A tick selection applies as a delta through the drag callbacks, so choosing
 * 350 degrees while sitting at 10 must rotate -20, not +340.
 */
export function shortestAngleDelta(fromRad: number, toRad: number): number {
  const TWO_PI = Math.PI * 2;
  let delta = (toRad - fromRad) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return Object.is(delta, -0) ? 0 : delta;
}
