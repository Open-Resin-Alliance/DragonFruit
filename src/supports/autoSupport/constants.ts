/**
 * Shared auto-support placement constants — single source of truth for the
 * radii and spans that previously existed in several inconsistent copies
 * (autoPlace.ts locals, gridPlacement.ts locals, the removed
 * AUTO_SUPPORT_HARD_RULES).
 */

/** Near-plate tips (< this Z, mm) get a minimal anchor support instead of a trunk. */
export const ANCHOR_HEIGHT_THRESHOLD_MM = 5.0;

/** Minimum spacing between anchor supports (mm) — denser than this hammers
 *  the first layer and creates blocked pillars. Larger than the generic
 *  1.0–1.2 mm floors; anchors are load-bearing but need breathing room. */
export const ANCHOR_MIN_SPACING_MM = 1.8;

/** Minimum XY extent for an anchor region to be densified (mm). Tiny slivers
 *  (e.g. 20×1–2 mm rings around a cylinder) hammer the first layer with
 *  100s of pillars but are not load-bearing feet. Both width and height must
 *  exceed this, and area must exceed ANCHOR_MIN_AREA_MM2. */
export const ANCHOR_MIN_XY_MM = 4.0;
export const ANCHOR_MIN_AREA_MM2 = 12.0;

/** Max span (mm) for a leaf cone attached to a host knot (grid path). */
export const MAX_AUTO_LEAF_SPAN_MM = 2.5;

/** Distance (mm) within which an existing support tip counts a candidate as already supported. */
export const ALREADY_SUPPORTED_RADIUS_MM = 3.0;

/** Gridless mode: merge candidates within this 3D distance of an existing trunk. */
export const GRIDLESS_MERGE_RADIUS_MM = 4.0;

/** Leaf fanning: max distance from a trunk shaft sample to an uncovered island (mm). */
export const LEAF_FAN_RADIUS_MM = 5.0;

/** Leaf fanning: max distance from a DENSITY-GRID trunk shaft (mm). Grid
 *  supports are fanning hosts only up close — a tight threshold keeps fan
 *  leaves from sweeping across the grid forest (and puncturing grid shafts). */
export const GRID_HOST_FAN_RADIUS_MM = 2.5;

/** Leaf fanning: max angle from vertical for a fan leaf (deg). 45° is
 *  shallower than it used to be (60°) but prints reliably and lets leaves
 *  reach overhangs on low-slope surfaces the old gate refused. */
export const LEAF_FAN_MAX_ANGLE_DEG = 45;

/** Self-support threshold: surfaces flatter than this angle from horizontal
 *  (deg) are flagged as overhang. Density modulation is normalized to it. */
export const OVERHANG_SELF_SUPPORT_ANGLE_DEG = 45;

/** Grid density modulation by surface angle. A flat ceiling (0° — an anchor
 *  surface like a model's feet) is the densest: spacing × 0.7 (≈2× the
 *  supports). A slope at the self-support threshold (45°) is the sparsest:
 *  spacing × 1.3 (≈0.6×). */
export const GRID_SPACING_MIN_FACTOR = 0.7;
export const GRID_SPACING_MAX_FACTOR = 1.3;
