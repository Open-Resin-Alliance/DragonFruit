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
