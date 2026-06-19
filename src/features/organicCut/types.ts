/**
 * Organic Cut — shared types.
 *
 * This feature lets the user draw one or more closed loops on a model's surface,
 * from which the Rust backend builds a contour "wafer" cutter (optionally with a
 * registration key per loop) and splits the model into its separate parts — two
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
   * Per-loop registration-key settings, aligned with the cut's loops in order
   * (`loopPoints` is index 0, then `extraLoops`). When present, each entry
   * OVERRIDES the spec-level `key*` fields for that loop — so every cut gets its
   * own peg/socket (shape, size, tilt, swap) or none (`generateKey: false`).
   * Serde field: `loopKeys`.
   */
  loopKeys?: {
    generateKey: boolean;
    keyWidthMm: number;
    keyDepthMm: number;
    keyShape: 'frustum' | 'dome';
    keyFilletMm: number;
    keySwapSides: boolean;
    keyTiltRad: number;
    keyTiltAzimuthRad: number;
    keyRollRad: number;
  }[];
  /** Wafer thickness in mm ("consistent thickness") — the kerf the cut removes. */
  thicknessMm: number;
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
   * Contour cutter thickness in mm. <=0 / omitted → Rust uses its default
   * (~0.01 mm = physically zero). Serde field: `cutterThicknessMm`.
   */
  cutterThicknessMm?: number;
  /**
   * When true (contour mode), the cut also generates a registration key: a peg
   * union'd onto one half and a matching socket carved from the other. Omitted/
   * false → no key. Serde field: `generateKey`.
   */
  generateKey?: boolean;
  /** Key base width in mm (model units are mm). Serde field: `keyWidthMm`. */
  keyWidthMm?: number;
  /** Key depth in mm (how far the peg pokes in). Serde field: `keyDepthMm`. */
  keyDepthMm?: number;
  /** Key shape: 'frustum' (default) or 'dome'. Serde field: `keyShape`. */
  keyShape?: 'frustum' | 'dome';
  /** Edge fillet radius in mm (rounds frustum corners + tip). Serde: `keyFilletMm`. */
  keyFilletMm?: number;
  /** Flip which half gets the peg vs the socket. Serde field: `keySwapSides`. */
  keySwapSides?: boolean;
  /**
   * Key tilt (radians): polar lean off the cut normal. The base stays glued flat to
   * the cut face; the body shears to lean. 0 = straight out. Serde: `keyTiltRad`.
   */
  keyTiltRad?: number;
  /**
   * Key tilt azimuth (radians): which in-plane direction the lean points toward.
   * Irrelevant when keyTiltRad === 0. Serde: `keyTiltAzimuthRad`.
   */
  keyTiltAzimuthRad?: number;
  /** Key roll (radians): spin about the key's own axis. Serde: `keyRollRad`. */
  keyRollRad?: number;
}

/**
 * Placement frame of the previewed key (model-local coords), returned by the
 * membrane/key preview so the aim+roll gizmo can sit exactly on the key. `anchor`
 * is the base center (the tilt/roll pivot); `axis` is the un-tilted cut normal the
 * key roots against; `u`/`v` are the in-plane basis; `tip` is the leaned apex where
 * the aim handle is drawn; `depth` is the peg height (for handle scaling).
 */
export interface KeyPreviewFrame {
  anchor: [number, number, number];
  axis: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  tip: [number, number, number];
  depth: number;
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
   * Which registration key the cut placed: 'frustum', 'dome' (thin-part
   * fallback), or 'none' (not requested / too thin). Always present on a
   * contour cut.
   */
  keyKind?: 'frustum' | 'dome' | 'none';
  /** Reason the key shrank / fell back / was skipped (for an after-cut alert). */
  keyDetail?: string;
  /**
   * How many separate parts the cut produced. 2 for a plane/single-loop cut; more
   * when a multi-loop cut frees several pieces (e.g. both of Squirtle's arms); 0 on
   * a no-op. The frontend reads exactly this many parts back.
   */
  partCount?: number;
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

/** Which drawing mode the Cutting Mode tool session is in. */
export type OrganicCutDrawMode = 'waypoint' | 'freeDraw';

/** Lifecycle of the persistent Cutting Mode tool session (frontend-only state). */
export type OrganicCutSessionStatus = 'idle' | 'drawing' | 'closed';
