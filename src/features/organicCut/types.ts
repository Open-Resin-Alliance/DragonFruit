/**
 * Organic Cut — shared types.
 *
 * This feature lets the user draw one or more closed loops on a model's surface,
 * from which the Rust backend builds a contour "wafer" cutter (optionally with a
 * registration tenon per loop) and splits the model into its separate parts — two
 * for a single loop, more when a multi-loop cut frees several pieces at once.
 *
 * Everything in src/features/organicCut/ is self-contained.
 */

/** A single point on the loop the user draws on the model surface (local space). */
export interface OrganicCutLoopPoint {
  /** Surface point in the model's local coordinate space. */
  position: [number, number, number];
  /** Surface normal at the point (unit length, local space). */
  normal: [number, number, number];
  /**
   * When true, "Snap to Edges" leaves this point exactly where it is — the user
   * pinned it (double-click a marker) because it sits where it's needed and snap
   * would drag it off. Manual drag still moves it. FRONTEND-ONLY: it's serialized
   * to Rust but the backend has no such field, so serde silently ignores it.
   */
  locked?: boolean;
}

/**
 * Which kind of cut to perform.
 * - `plane`: the flat planar cut (slices along a single plane).
 * - `contour`: the curved "wafer" cut — a soap-film membrane that follows the
 *   drawn loop, splitting along the contoured seam.
 *
 * MUST match the Rust `CutMode` serde names (lowercase): `plane` | `contour`.
 */
export type OrganicCutMode = 'plane' | 'contour';

/** One organic cut: a closed loop plus the parameters that drive the wafer. */
export interface OrganicCutSpec {
  /**
   * Closed loop of surface points. The last point implicitly connects back to
   * the first; callers should NOT duplicate the first point at the end.
   *
   * NOTE: must be named `loopPoints` (NOT `loop`) — it is serialized to JSON and
   * deserialized by the Rust `OrganicCutSpec.loop_points` field (camelCase =
   * `loopPoints`). A mismatched name silently drops every point via serde default.
   */
  loopPoints: OrganicCutLoopPoint[];
  /**
   * Additional closed loops cut in the SAME operation (contour mode only). Each
   * loop becomes its own membrane+slab; all slabs (plus `loopPoints`) are union'd
   * into ONE cutter and differenced once, so a body joined in several places —
   * e.g. a tail attached to the body at two posts with an air tunnel between — is
   * freed in a single cut. Omitted/empty → the classic single-loop cut. Serde
   * field: `extraLoops`.
   */
  extraLoops?: OrganicCutLoopPoint[][];
  /**
   * Per-loop registration-tenon settings, aligned with the cut's loops in order
   * (`loopPoints` is index 0, then `extraLoops`). When present, each entry
   * OVERRIDES the spec-level `tenon*` fields for that loop — so every cut gets its
   * own tenon/mortise (shape, size, tilt, swap) or none (`generateTenon: false`).
   * Serde field: `loopTenons`.
   */
  loopTenons?: {
    generateTenon: boolean;
    tenonWidthMm: number;
    tenonDepthMm: number;
    tenonShape: 'frustum' | 'dome';
    tenonFilletMm: number;
    tenonToleranceMm: number;
    tenonAnchor: [number, number, number] | null;
    tenonSwapSides: boolean;
    tenonTiltRad: number;
    tenonRollRad: number;
  }[];
  /** Seam-line smoothing 0..1 (how much the cut line rounds through waypoints). */
  smoothing: number;
  /** Membrane smoothing 0..1 (how smooth/taut the curved cutter surface is). */
  membraneSmoothing?: number;
  /**
   * Wafer density multiplier (1..4) — cutter poly count. Sent only with the CUT
   * (not the preview), so editing stays light. Serde field: `density`.
   */
  density?: number;
  /**
   * Explicit cutting plane in model-local space. When present, Rust splits by
   * THIS plane directly (it's the exact plane the preview showed), instead of
   * re-deriving one from the points. Guarantees preview == cut.
   */
  plane?: {
    normal: [number, number, number];
    offset: number;
  };
  /**
   * Flat (`plane`) vs curved (`contour`). Omitted/`plane` → the flat cut.
   * Serialized to the Rust `OrganicCutSpec.mode` field (camelCase `mode`).
   */
  mode?: OrganicCutMode;
  /**
   * Extra clearance in mm for the mortise-and-tenon joint, on top of the tenon's
   * own tolerance. Omitted/0 — the default — means the two halves meet exactly,
   * which is what the surface cut gives; raise it if a print needs slack to
   * assemble. Serde field: `jointClearanceMm`.
   *
   * This was the wafer's thickness, back when the cut was a wafer and the number
   * was structural. It is neither now. (There was also a legacy `thicknessMm` on
   * this spec that Rust never read — the reason the old slider was a no-op. Gone.)
   */
  jointClearanceMm?: number;
  /**
   * When true (contour mode), the cut also generates a registration tenon: a tenon
   * union'd onto one half and a matching mortise carved from the other. Omitted/
   * false → no tenon. Serde field: `generateTenon`.
   */
  generateTenon?: boolean;
  /** Tenon base width in mm (model units are mm). Serde field: `tenonWidthMm`. */
  tenonWidthMm?: number;
  /** Tenon depth in mm (how far the tenon pokes in). Serde field: `tenonDepthMm`. */
  tenonDepthMm?: number;
  /** Tenon shape: 'frustum' (default) or 'dome'. Serde field: `tenonShape`. */
  tenonShape?: 'frustum' | 'dome';
  /** Edge fillet radius in mm (rounds frustum corners + tip). Serde: `tenonFilletMm`. */
  tenonFilletMm?: number;
  /**
   * Tenon/mortise fit tolerance in mm: the mortise is carved this much larger than the
   * tenon on every face, so the halves slide together. 0 = press fit. Omitted → Rust
   * uses 0.1. Serde field: `tenonToleranceMm`.
   */
  tenonToleranceMm?: number;
  /**
   * Where the tenon sits on the cut face: the model-local POINT the user put it on.
   * Omitted/null = the natural middle of the cut. Serde: `tenonAnchor`.
   */
  tenonAnchor?: [number, number, number] | null;
  /** Flip which half gets the tenon vs the mortise. Serde field: `tenonSwapSides`. */
  tenonSwapSides?: boolean;
  /**
   * Tenon tilt (radians): polar lean off the cut normal. The base stays glued flat to
   * the cut face; the body shears to lean. 0 = straight out. Serde: `tenonTiltRad`.
   */
  tenonTiltRad?: number;
  /** Tenon roll (radians): spin about the tenon's own axis. Serde: `tenonRollRad`. */
  tenonRollRad?: number;
}

/**
 * Placement frame of the previewed tenon (model-local coords), returned by the
 * membrane/tenon preview so the aim+roll gizmo can sit exactly on the tenon. `anchor`
 * is the base center (the tilt/roll pivot); `axis` is the un-tilted cut normal the
 * tenon roots against; `u`/`v` are the in-plane basis; `tip` is the leaned apex where
 * the aim handle is drawn; `depth` is the tenon height (for handle scaling).
 */
/**
 * Hard ceiling on the tenon's lean (radians), mirroring Rust's `TENON_MAX_TILT_RAD`.
 * Past ~60° the tenon skims the cut face and can't realistically mortise. The real
 * cap is usually lower and comes from the part — see `TenonPreviewFrame.maxTiltRad`.
 */
export const TENON_MAX_TILT_RAD = Math.PI / 4;

export interface TenonPreviewFrame {
  anchor: [number, number, number];
  axis: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  tip: [number, number, number];
  depth: number;
  /**
   * The hard ceiling on the lean (radians). Leaning further than the part allows is
   * reported as a won't-fit verdict, not prevented — a cap that fell to 0 near an
   * edge meant the ring turned and the tenon didn't move.
   */
  maxTiltRad?: number;
  /**
   * Base half-diagonal (mm) Rust sank and lengthened the tenon by. The live lean is
   * applied here on a soup built straight, so the preview reuses this to match.
   */
  halfDiagMm?: number;
}

export interface OrganicCutOptions {
  cut: OrganicCutSpec;
}

export interface OrganicCutReport {
  sourceTriangleCount: number;
  partATriangleCount: number;
  partBTriangleCount: number;
  /** Which backend produced the result. */
  engine: 'noop' | 'plane' | 'membrane' | 'manifold' | 'voxel';
  /** Why we fell back to no-op, if we did (diagnostics). Empty on success. */
  detail?: string;
  /**
   * Which registration tenon the cut placed: 'frustum', 'dome' (thin-part
   * fallback), or 'none' (not requested / too thin). Always present on a
   * contour cut.
   */
  tenonKind?: 'frustum' | 'dome' | 'none';
  /** Reason the tenon shrank / fell back / was skipped (for an after-cut alert). */
  tenonDetail?: string;
  /**
   * How many separate parts the cut produced. 2 for a plane/single-loop cut; more
   * when a multi-loop cut frees several pieces (e.g. both of Squirtle's arms); 0 on
   * a no-op. The frontend reads exactly this many parts back.
   */
  partCount?: number;
  /**
   * Where the cut went wrong, in model-local coordinates. Empty on success, and on
   * failures that have no one place (a rim nothing can span is a whole ring, not a
   * point). These are for DRAWING: a coordinate in a sentence is no use to someone
   * looking at a model, so the tool puts a marker on each one.
   */
  leakPoints?: [number, number, number][];
}

export interface OrganicCutResult {
  report: OrganicCutReport;
  /**
   * Every part the cut produced, in order (largest first) — each a flat triangle
   * soup (9 floats per triangle), model-local. 2 for a normal cut; more when a
   * multi-loop cut frees several pieces. Each is committed as its own model.
   */
  parts: Float32Array[];
}

