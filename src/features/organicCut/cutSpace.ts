/**
 * The space the organic cut runs in: the model's own coordinates with its plate scale
 * applied.
 *
 * Every size the cut takes is a printed millimetre — the tenon's width and depth, its
 * fit, the joint clearance, the room a tenon has to grow before it breaks through —
 * and Rust measures them against the mesh it is given. Handing it the mesh as
 * modelled meant a model scaled up 50× got a tenon sized for the original, fifty
 * times too big for what prints. So the bridge scales the mesh and every point it
 * sends by the model's scale, and divides everything it reads back by it: the session
 * keeps working in model-local coordinates, and Rust sees millimetres.
 *
 * Rotation and position need nothing: they are rigid, so lengths and angles survive
 * them. Only the scale changes what a millimetre is.
 */
import type { OrganicCutLoopPoint, OrganicCutSpec, TenonPreviewFrame } from './types';

export type CutScale = readonly [number, number, number];
type Vec3 = [number, number, number];

export const IDENTITY_CUT_SCALE: CutScale = [1, 1, 1];

export function isIdentityCutScale(scale: CutScale): boolean {
  return scale[0] === 1 && scale[1] === 1 && scale[2] === 1;
}

export function sameCutScale(a: CutScale, b: CutScale): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** A model-local point (or offset) in cut space. */
export function vectorToCutSpace(v: readonly [number, number, number], s: CutScale): Vec3 {
  return [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
}

/** A cut-space point (or offset) back in model-local coordinates. */
function vectorFromCutSpace(v: readonly [number, number, number], s: CutScale): Vec3 {
  return [v[0] / s[0], v[1] / s[1], v[2] / s[2]];
}

function normalized(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : v;
}

/** A surface normal in cut space: normals take the inverse transpose, here `n / s`. */
function normalToCutSpace(n: readonly [number, number, number], s: CutScale): Vec3 {
  return normalized([n[0] / s[0], n[1] / s[1], n[2] / s[2]]);
}

/** Model-local points packed three to a vertex, divided back out of cut space in place. */
export function pointsFromCutSpace(points: Float32Array, s: CutScale): Float32Array {
  if (isIdentityCutScale(s)) return points;
  for (let i = 0; i + 2 < points.length; i += 3) {
    points[i] /= s[0];
    points[i + 1] /= s[1];
    points[i + 2] /= s[2];
  }
  return points;
}

export function loopPointToCutSpace(point: OrganicCutLoopPoint, s: CutScale): OrganicCutLoopPoint {
  return { ...point, position: vectorToCutSpace(point.position, s), normal: normalToCutSpace(point.normal, s) };
}

/**
 * The plane `normal · p = offset` in cut space. With `p' = S p` it is
 * `(S⁻¹ normal) · p' = offset`, renormalised.
 */
export function planeToCutSpace(
  plane: { normal: readonly [number, number, number]; offset: number },
  s: CutScale,
): { normal: Vec3; offset: number } {
  const n: Vec3 = [plane.normal[0] / s[0], plane.normal[1] / s[1], plane.normal[2] / s[2]];
  const length = Math.hypot(n[0], n[1], n[2]);
  if (!(length > 0)) return { normal: [...plane.normal] as Vec3, offset: plane.offset };
  return { normal: [n[0] / length, n[1] / length, n[2] / length], offset: plane.offset / length };
}

/** A cut spec's points, plane and tenon anchors in cut space; its millimetres stay as they are. */
export function specToCutSpace(spec: OrganicCutSpec, s: CutScale): OrganicCutSpec {
  if (isIdentityCutScale(s)) return spec;
  return {
    ...spec,
    loopPoints: spec.loopPoints.map((p) => loopPointToCutSpace(p, s)),
    extraLoops: spec.extraLoops?.map((loop) => loop.map((p) => loopPointToCutSpace(p, s))),
    loopTenons: spec.loopTenons?.map((tenon) => ({
      ...tenon,
      tenonAnchor: tenon.tenonAnchor && vectorToCutSpace(tenon.tenonAnchor, s),
    })),
    plane: spec.plane && planeToCutSpace(spec.plane, s),
    tenonAnchor: spec.tenonAnchor && vectorToCutSpace(spec.tenonAnchor, s),
  };
}

/**
 * The tenon's frame back in model-local coordinates.
 *
 * Its directions map by `S⁻¹` and are not renormalised: drawn inside the model's
 * scaled group, `S · S⁻¹ a` puts them back on the cut-space direction the tenon was
 * built along. Its lengths are millimetres along a direction, so they shrink by how
 * much `S⁻¹` shortens that direction.
 */
export function frameFromCutSpace(frame: TenonPreviewFrame, s: CutScale): TenonPreviewFrame {
  if (isIdentityCutScale(s)) return frame;
  const along = (direction: Vec3) => Math.hypot(...vectorFromCutSpace(normalized(direction), s));
  return {
    ...frame,
    anchor: vectorFromCutSpace(frame.anchor, s),
    tip: vectorFromCutSpace(frame.tip, s),
    axis: vectorFromCutSpace(frame.axis, s),
    u: vectorFromCutSpace(frame.u, s),
    v: vectorFromCutSpace(frame.v, s),
    depth: frame.depth * along(frame.axis),
    halfDiagMm: frame.halfDiagMm === undefined ? undefined : frame.halfDiagMm * along(frame.u),
  };
}
