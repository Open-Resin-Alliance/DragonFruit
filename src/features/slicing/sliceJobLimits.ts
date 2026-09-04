/**
 * The bounds every numeric slice-job field is held to, in one place.
 *
 * These used to be written twice — once in `sliceExportOrchestrator` in
 * camelCase and again in `nativeSlicerBridge` in snake_case — with the second
 * clamp acting on the already-clamped output of the first. The pair had already
 * drifted on how they coerce a non-numeric input, so the wire value depended on
 * which of the two you read.
 *
 * Resolving *which* value to clamp (fallback chains, profile lookups) stays at
 * the call site; only the bounds live here.
 */

type SliceJobLimit = {
  min: number;
  max?: number;
  /** How a fractional input is snapped, applied before the bounds. */
  snap?: 'round' | 'floor';
  /** Substituted when the input is null, undefined, or not a finite number. */
  fallback: number;
};

export const SLICE_JOB_LIMITS = {
  blurBrushRadiusPx: { min: 0, max: 64, snap: 'round', fallback: 1 },
  blurBrushSigmaX: { min: 0.05, max: 16, fallback: 0.5 },
  blurBrushSigmaY: { min: 0.05, max: 16, fallback: 0.5 },
  zBlurRadiusLayers: { min: 0, max: 8, snap: 'round', fallback: 0 },
  zBlurSigma: { min: 0.05, max: 16, fallback: 0.5 },
  zBlendLookBack: { min: 1, snap: 'round', fallback: 2 },
  zBlendMinimumAlphaPercent: { min: 0, max: 100, fallback: 0 },
  zBlendMaxAlphaPercent: { min: 0, max: 100, fallback: 90 },
  minimumAaAlphaPercent: { min: 0, max: 100, fallback: 0 },
  modelTriangleCount: { min: 0, snap: 'floor', fallback: 0 },
  containerCompressionLevel: { min: 0, max: 9, snap: 'round', fallback: 2 },
} as const satisfies Record<string, SliceJobLimit>;

export type SliceJobNumericField = keyof typeof SLICE_JOB_LIMITS;

/**
 * Coerce `value` into the range the engine accepts for `field`.
 *
 * Order is fallback → snap → bounds, matching what the bridge did before this
 * module existed. Unlike the old expressions, a non-numeric input yields the
 * field's fallback rather than letting `NaN` reach the wire.
 */
export function clampSliceJobNumber(field: SliceJobNumericField, value: unknown): number {
  const limit: SliceJobLimit = SLICE_JOB_LIMITS[field];

  // `null` and `undefined` are checked before coercion: the call sites this
  // replaced used `??`, and `Number(null)` is 0, which would silently pass the
  // finite check and clamp to the field's minimum instead of its fallback.
  const numeric = value === null || value === undefined ? Number.NaN : Number(value);
  let result = Number.isFinite(numeric) ? numeric : limit.fallback;

  if (limit.snap === 'round') result = Math.round(result);
  else if (limit.snap === 'floor') result = Math.floor(result);

  if (limit.max !== undefined) result = Math.min(limit.max, result);
  return Math.max(limit.min, result);
}
