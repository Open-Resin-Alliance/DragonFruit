/**
 * Organic Cut — shared types.
 *
 * This feature lets the user draw a closed loop on a model's surface, from which
 * the Rust backend builds a consistent-thickness "wafer" cutter and splits the
 * model into two printable parts.
 *
 * MILESTONE M1 (current): the wafer/boolean is a no-op — the backend echoes the
 * source mesh back as both parts. These types already describe the full intended
 * contract so the plumbing doesn't change shape as the geometry is filled in.
 *
 * Everything in src/features/organicCut/ is self-contained. The only edits to
 * existing app files are four small additive seams (TransformMode union, the
 * CUT toolbar button, the page.tsx mount point, and the Rust command registry).
 */

/** A single point on the loop the user draws on the model surface (local space). */
export interface OrganicCutLoopPoint {
  /** Surface point in the model's local coordinate space. */
  position: [number, number, number];
  /** Surface normal at the point (unit length, local space). */
  normal: [number, number, number];
}

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
  /** Wafer thickness in mm ("consistent thickness"). Unused by the M1 no-op. */
  thicknessMm: number;
  /** Path-fairing strength 0..1. Unused by the M1 no-op. */
  smoothing: number;
  /**
   * Explicit cutting plane in model-local space. When present, Rust splits by
   * THIS plane directly (it's the exact plane the preview showed), instead of
   * re-deriving one from the points. Guarantees preview == cut.
   */
  plane?: {
    normal: [number, number, number];
    offset: number;
  };
}

export interface OrganicCutOptions {
  cut: OrganicCutSpec;
}

export interface OrganicCutReport {
  sourceTriangleCount: number;
  partATriangleCount: number;
  partBTriangleCount: number;
  /** Which backend produced the result. */
  engine: 'noop' | 'plane' | 'manifold' | 'voxel';
  /** Why we fell back to no-op, if we did (diagnostics). Empty on success. */
  detail?: string;
}

export interface OrganicCutResult {
  report: OrganicCutReport;
  /** Part A positions as a flat triangle soup (9 floats per triangle). */
  partA: Float32Array;
  /** Part B positions as a flat triangle soup (9 floats per triangle). */
  partB: Float32Array;
}

/** Which drawing mode the Cutting Mode tool session is in. */
export type OrganicCutDrawMode = 'waypoint' | 'freeDraw';

/** Lifecycle of the persistent Cutting Mode tool session (frontend-only state). */
export type OrganicCutSessionStatus = 'idle' | 'drawing' | 'closed';
