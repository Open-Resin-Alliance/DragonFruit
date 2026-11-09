/**
 * The grayscale LUT curves anti-aliasing maps edge coverage through, and the
 * sampling that turns a curve into the engine's 256-entry table.
 *
 * Kept free of React and Tauri so slice job assembly (and the CLI) can build a
 * LUT without loading the curve editor.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CurvePoint {
  /** 0 = outermost gradient pixel (receding from solid), 1 = innermost (adjacent to solid). */
  x: number;
  /** 0 = 0 % alpha output, 1 = 100 % alpha output. */
  y: number;
}

export interface SavedCurve {
  id: string;
  name: string;
  points: CurvePoint[];
}

// ── Built-in curves ───────────────────────────────────────────────────────────

/** Default control points — linear ramp matching the opaque preset (55 % → 90 %). */
export const DEFAULT_CUSTOM_CURVE: CurvePoint[] = [
  { x: 0, y: 0.55 },
  { x: 1, y: 0.90 },
];

export const DEFAULT_SAVED_CURVES: SavedCurve[] = [
  { id: 'default', name: 'My Curve', points: DEFAULT_CUSTOM_CURVE },
];

/**
 * Compact 10-point control curve derived from the UVTools EXP_120-230 LUT.
 *
 * Sampling indices (0-based) from the 256-entry LUT:
 * [1, 29, 57, 85, 113, 142, 170, 198, 226, 254]
 * Values:
 * [120, 125, 130, 135, 142, 151, 162, 178, 199, 230]
 */
export const DEFAULT_OPAQUE_EXP_120_230_CURVE: CurvePoint[] = [
  { x: 0 / 253, y: 120 / 255 },
  { x: 28 / 253, y: 125 / 255 },
  { x: 56 / 253, y: 130 / 255 },
  { x: 84 / 253, y: 135 / 255 },
  { x: 112 / 253, y: 142 / 255 },
  { x: 141 / 253, y: 151 / 255 },
  { x: 169 / 253, y: 162 / 255 },
  { x: 197 / 253, y: 178 / 255 },
  { x: 225 / 253, y: 199 / 255 },
  { x: 253 / 253, y: 230 / 255 },
];

/**
 * Compact 10-point control curve using the EXP-100 shape remapped for
 * clear resin windowing (roughly 100..166 PWM, i.e. ~39%..65%).
 *
 * Source EXP-100 samples at indices [1,29,57,85,113,142,170,198,226,254]:
 * [100,107,114,121,131,143,159,180,210,252]
 * Remapped to clear window:
 * [100,103,106,109,113,119,126,135,148,166]
 */
export const DEFAULT_CLEAR_EXP_100_CURVE: CurvePoint[] = [
  { x: 0 / 253, y: 100 / 255 },
  { x: 28 / 253, y: 103 / 255 },
  { x: 56 / 253, y: 106 / 255 },
  { x: 84 / 253, y: 109 / 255 },
  { x: 112 / 253, y: 113 / 255 },
  { x: 141 / 253, y: 119 / 255 },
  { x: 169 / 253, y: 126 / 255 },
  { x: 197 / 253, y: 135 / 255 },
  { x: 225 / 253, y: 148 / 255 },
  { x: 253 / 253, y: 166 / 255 },
];

// ── Sampling ──────────────────────────────────────────────────────────────────

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Monotone cubic Hermite spline (Fritsch-Carlson algorithm).
 * Guarantees no overshoot / undershoot — safe for alpha LUT usage.
 */
export function makeSpline(pts: CurvePoint[]): (x: number) => number {
  const n = pts.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => pts[0].y;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const d: number[] = [];
  const m: number[] = new Array(n);

  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);

  m[0] = d[0];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;
  m[n - 1] = d[n - 2];

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-10) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = Math.sqrt(a * a + b * b);
    if (h > 3) {
      m[i] = (3 * a / h) * d[i];
      m[i + 1] = (3 * b / h) * d[i];
    }
  }

  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const hx = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / hx;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo]
      + (t3 - 2 * t2 + t) * hx * m[lo]
      + (-2 * t3 + 3 * t2) * ys[hi]
      + (t3 - t2) * hx * m[hi]
    );
  };
}

/**
 * Sample a curve defined by control points into a 256-element LUT (u8 values
 * 0–255). Index 0 (void pixels) is always 0; index 255 (solid pixels) is
 * always 255. Indices 1–254 are sampled from the monotone cubic spline.
 */
export function sampleCurveToLut(points: CurvePoint[]): number[] {
  const spline = makeSpline(points);
  const lut = new Array<number>(256);
  lut[0] = 0;
  lut[255] = 255;
  for (let i = 1; i <= 254; i++) {
    const x = (i - 1) / 253;
    lut[i] = Math.round(clamp01(spline(x)) * 255);
  }
  return lut;
}
