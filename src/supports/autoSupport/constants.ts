/** Shared auto-support placement constants: the radii and spans placement reads. */

/** Near-plate tips (< this Z, mm) get a minimal anchor support instead of a trunk. */
export const ANCHOR_HEIGHT_THRESHOLD_MM = 5.0;

/** Max span (mm) for a leaf cone attached to a host knot (grid path). */
export const MAX_AUTO_LEAF_SPAN_MM = 2.5;

/** Islands below this area (mm²) get a shrunk per-point tip (detail band)
 *  instead of the active band contact — matches the detail preset boundary. */
export const SMALL_ISLAND_TIP_AREA_MM2 = 0.15;

/** Tangent-plane reach (mm) each side of the free-width probe looks out to.
 *  The cap only binds while the free width is under
 *  `bandTip / autoSupport.tipContactMarginScale` (at the widest band,
 *  0.4 / 0.9 ≈ 0.44 mm), so a 0.5 mm reach — above the
 *  widest width the cap can act on — covers it with headroom while staying
 *  short of the ~1 mm tooth/gap pitch a scalloped surface repeats at. A probe
 *  that reached across a whole pitch would read the next tooth as solid ground
 *  and miss the gap between them entirely. The reach is also a floor on the
 *  reported width — a contact on a silhouette edge reads its inward side in
 *  full — and that floor must stay above the 0.67 mm threshold or every
 *  boundary contact would cap. Past the reach the width reads full and the cap
 *  is a no-op, which is the correct answer for a feature wider than the tip. */
export const CONTACT_WIDTH_PROBE_MM = 0.5;

/** Islands with bbox extent at/below this (mm) get a single tip at the bbox
 *  center — robust for specks where centroid/medial math is noise. */
export const ISLAND_SUB_HEAD_MM = 0.5;
/** Islands this long (mm) or longer with narrow width split into a symmetric
 *  tip pair instead of one center tip. */
export const ISLAND_TWO_POINT_MIN_MM = 1.5;
export const ISLAND_TWO_POINT_MAX_MM = 6.0;
/** Two-point split only when the minor bbox axis is below this (mm); wide
 *  blobs keep one candidate (the grid path covers their area). */
export const ISLAND_TWO_POINT_MAX_WIDTH_MM = 2.5;

/** Leaf spans above this (mm) route to branches with real shafts instead of
 *  long tapered leaf cones — an 8–11 mm leaf reads as a spindly spike next
 *  to its trunk. Applies to merge + fan paths (island origins; overhang
 *  fanning stays leaves by rule). */
export const MAX_LEAF_SPAN_BEFORE_BRANCH_MM = 6.0;
/** Support influence growth with height (mm): a tip's coverage disc widens
 *  the higher above it you go — Prusa's SLA support curve, adapted to our
 *  3.0 mm birth radius. Piecewise-linear through (diffZ, radius):
 *  (0, 3.0) → (3.9, 4.0) → (15, 5.0) → (40, 6.0), capped at 6.0.
 *  Fresh supports stop spawning once existing cones cover the contour. */
const INFLUENCE_RADIUS_KNOTS: ReadonlyArray<readonly [number, number]> = [
    [0, 3.0],
    [3.9, 4.0],
    [15, 5.0],
    [40, 6.0],
];

export function influenceRadiusMm(diffZMm: number): number {
    const z = Math.max(0, diffZMm);
    const knots = INFLUENCE_RADIUS_KNOTS;
    if (z <= knots[0][0]) return knots[0][1];
    for (let i = 1; i < knots.length; i++) {
        if (z <= knots[i][0]) {
            const [z0, r0] = knots[i - 1];
            const [z1, r1] = knots[i];
            return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
        }
    }
    return knots[knots.length - 1][1];
}

/** Vertical restack allowance (mm): candidates farther apart in Z than this
 *  never dedup each other (staircase shelves keep their own supports),
 *  mirroring Prusa's removing_delta. */
export const SUPPORT_RESTSTACK_DELTA_MM = 5.0;
/**
 * Longest cavity bridge auto-placement will keep.
 *
 * Currently inert -- the span it is compared against measures ~0. See the
 * note at the comparison in `autoPlace.ts`.
 */
export const MAX_CAVITY_BRIDGE_MM = 12;

/**
 * Reach of the cavity fallback's fan search, in plan. A tip with no plate route
 * has exactly two outcomes: carried by a neighbouring trunk, or bridged
 * model-to-model as a stick whose second contact scar is on the model. The
 * bridge is strictly worse, so this is the widest host search in the pipeline —
 * including for grid hosts, whose 2.5 mm limit exists to keep ordinary fan
 * leaves from sweeping across the grid forest, a reason that does not apply to
 * a tip with nothing else. The branch-angle gate still governs the link, so a
 * host this far out has to be tall enough to offer a sample steep enough to be
 * legal; that is what keeps a long rescue member honest.
 */
export const CAVITY_FAN_RADIUS_MM = 12;

/** Distance (mm) within which an existing support tip counts a candidate as already supported. */
export const ALREADY_SUPPORTED_RADIUS_MM = 3.0;

/** Minima reinforcement: radius (mm) of the ring of contacts drawn around a mesh
 *  minima's own contact. Close enough to land on the feature it reinforces (a
 *  minima is a sharp local low point, not a broad face) and outside the contact
 *  cone's own body, so the ring never collides with the tip support it rings. */
export const MINIMA_RING_RADIUS_MM = 2.5;

/** Minima reinforcement: contact directions sampled on the ring (mm apart at
 *  the default radius ≈ the default density-grid spacing). Directions whose
 *  ray finds no valid flank are dropped, so this is an upper bound. */
export const MINIMA_RING_COUNT = 6;

/** Minima reinforcement: least rise (mm) at the ring radius for a contact to
 *  count as the feature's flank. Below it the surface around the minima is flat
 *  as far as detection is concerned (the voxel mask is 0.25 mm) — a flat is the
 *  density grid's job, and a sub-voxel dip is served by its single tip. */
export const MINIMA_RING_MIN_RISE_MM = 0.2;

/** Gridless mode: merge candidates within this 3D distance of an existing trunk. */
export const GRIDLESS_MERGE_RADIUS_MM = 4.0;

/** Merge host choice weights longest already-hosted member span this much
 *  (mm-equivalent per mm) against raw distance — Dumas Score = Gain − k·lmax
 *  shape with k explicit. Zero hosted members → pure nearest-first. */
/**
 * How far short of a tip a fan's pre-test stops walking. The contact disk stands
 * the cone off the surface, so a member is never asked to reach inside the
 * surface's keep-out; the same reasoning the orphan validator applies when it
 * checks a member at build time.
 */
export const FAN_LINK_TIP_INSET_MM = 0.5;

export const MERGE_HOST_LOAD_WEIGHT = 0.5;
/** Leaf fanning: the least reach the fan is allowed (mm). Every path floors here. */
export const MIN_LEAF_FAN_RADIUS_MM = 8;

/** Leaf fanning: max distance from a trunk shaft sample to an uncovered island (mm). */
export const LEAF_FAN_RADIUS_MM = MIN_LEAF_FAN_RADIUS_MM;

/** Leaf fanning: max distance from a DENSITY-GRID trunk shaft (mm). Grid
 *  supports are fanning hosts only up close — a tight threshold keeps fan
 *  leaves from sweeping across the grid forest (and puncturing grid shafts). */
export const GRID_HOST_FAN_RADIUS_MM = 2.5;

/** Leaf fanning: max angle from vertical for a fan leaf (deg). 45° is
 *  shallower than it used to be (60°) but prints reliably and lets leaves
 *  reach overhangs on low-slope surfaces the old gate refused. */
export const LEAF_FAN_MAX_ANGLE_DEG = 45;

/** Chunk consolidation: MAX distance from a bare overhang pillar's tip to the
 *  host shaft sample it fans onto (mm) — a ceiling, not a target: the pass
 *  takes the nearest eligible host, so real links are usually much shorter.
 *  Wider than {@link LEAF_FAN_RADIUS_MM} so overhang pillars 5–8mm from a host
 *  can still join the same chunk. */
export const CONSOLIDATION_FAN_RADIUS_MM = 8;

/** Chunk consolidation: max angle from vertical for a chunk link (deg).
 *  Relaxed past {@link LEAF_FAN_MAX_ANGLE_DEG} because on a surface sloped
 *  <45° from horizontal neighbouring pillars can never satisfy the placement
 *  fan gate — the link angle is always 90° − surface slope — so chunking
 *  would be geometrically impossible there. The chunk's interior hosts carry
 *  the load; shallow links are connective tissue. */
export const CONSOLIDATION_MAX_ANGLE_DEG = 75;

/** Chunk consolidation: routed fallback branches only above this height (mm).
 *  Near the plate they read as a zig-zag spiderweb; high up they read as
 *  trees. */
export const CONSOLIDATION_BRANCH_MIN_HEIGHT_MM = 10;

/** Self-support threshold: surfaces flatter than this angle from horizontal
 *  (deg) are flagged as overhang. Density modulation is normalized to it. */
export const OVERHANG_SELF_SUPPORT_ANGLE_DEG = 45;

/** Grid density modulation by surface angle. A flat ceiling (0° — an anchor
 *  surface like a model's feet) is the densest: spacing × 0.7 (≈2× the
 *  supports). A slope at the self-support threshold (45°) is the sparsest:
 *  spacing × 1.3 (≈0.6×). */
export const GRID_SPACING_MIN_FACTOR = 0.7;

/** Interior (cavity) ceilings are bridged, not pillared: the short strut carries
 *  less peel than a full-height shaft, and the cavity forest is hard to see and
 *  remove. Grid spacing is multiplied by this; 3 costs one ninth the supports. */
export const INTERIOR_CAVITY_SPACING_SCALE = 3;
export const GRID_SPACING_MAX_FACTOR = 1.3;

/**
 * Where the relaxation toward the slope spacing *starts*, as a fraction of the
 * self-support angle (0.6 ⇒ 27° at the 45° default).
 *
 * Relaxation is for a surface that prints by itself, and only the end of the band
 * is that: a 25° underside peels and needs the density exactly as a flat ceiling
 * does. Blending linearly from 0° put that underside more than half way to the
 * slope spacing, which starves a part's shallow rims and ledges — the sections a
 * cauldron's lip is made of — and is what made dropping `slopeRelaxFactor` and
 * boosting `flatDensityBoost` by hand visibly help.
 *
 * Below the start the region keeps the flat spacing; from there to the threshold it
 * ramps, so the spacing stays continuous and the knob keeps its meaning at the end
 * of the band it describes.
 */
export const SLOPE_RELAX_RAMP_START = 0.6;
