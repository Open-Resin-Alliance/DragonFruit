/** Snap angle to nearest increment using Math.round quantization. */
export function snapAngle(angle: number, increment: number): number {
  return Math.round(angle / increment) * increment;
}

/** Coarse snap increment: 45 degrees */
export const SNAP_COARSE = Math.PI / 4;

/** Fine snap increment: 15 degrees */
export const SNAP_FINE = Math.PI / 12;

/** localStorage key for persistent snap toggle */
export const SNAP_STORAGE_KEY = 'dragonfruit:rotation-snap-enabled';
