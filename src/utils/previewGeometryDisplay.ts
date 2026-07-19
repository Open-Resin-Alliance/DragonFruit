import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

/**
 * Preview-honesty display helpers (STL-import decimation remediation, Phase 2b;
 * docs in `agents/Claude/STL-import-perf/`).
 *
 * A `>budget`-triangle native import is replaced at load time by a reduced
 * `meshopt::simplify` preview that BECOMES the scene BufferGeometry
 * (`GeometryWithBounds.nativePreview` records the original count, the achieved
 * decimation error and the governor budget — see useStlGeometry.ts). Until
 * Phase 2b the UI displayed `originalTriangleCount`, concealing the
 * substitution. These helpers centralise the honest resolution so every count
 * site agrees.
 */

/**
 * Actual triangle count of a scene BufferGeometry (index-aware, floored).
 * This is the number of triangles the WebView actually holds and renders — for
 * a native-preview model that is the reduced preview, NOT the original file.
 */
export function actualSceneTriangleCount(geometry: GeometryWithBounds): number {
  const buf = geometry.geometry;
  const idx = buf.getIndex();
  if (idx) return Math.floor(idx.count / 3);
  const pos = buf.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * The triangle count to DISPLAY for a model's `polygonCount`.
 *
 * Always the ACTUAL scene geometry the WebView holds — for a native-preview
 * model that is the reduced preview, not the original. The original count is
 * NOT discarded: it stays on `geometry.nativePreview.originalTriangleCount`
 * (persisted through VOXL by Phase 1) and drives the preview badge / secondary
 * "(full: N)" label. This is the single choke point every `polygonCount`
 * assignment delegates to, so the field never conceals decimation again
 * (plan Phase 2 step 1).
 */
export function resolveDisplayPolygonCount(geometry: GeometryWithBounds): number {
  return actualSceneTriangleCount(geometry);
}

/**
 * Badge-lifecycle rule (Phase 2b CP4; census finding 3).
 *
 * Every geometry write-back (hollow / hole-punch / repair) rebuilds a fresh
 * `GeometryWithBounds` and, pre-Phase-4, was DROPPING the `nativePreview`
 * marker — so the preview badge silently vanished on a model that is STILL
 * decimation-derived (those ops run on the ~2M preview until Phase 4 routes
 * them full-res). This carries the marker forward so the badge keeps firing.
 *
 * Default-safe by construction: a `prior` geometry with NO marker returns
 * `undefined` (exactly today's behavior — non-preview replaces are untouched).
 * The future full-res mutation path clears the marker legitimately by passing
 * `clearNativePreview: true`.
 *
 * Returns a fresh copy (never the prior object) so the two geometries never
 * alias one marker.
 */
export function carryPreviewMarkerForward(
  prior: GeometryWithBounds,
  options?: { clearNativePreview?: boolean },
): GeometryWithBounds['nativePreview'] | undefined {
  if (options?.clearNativePreview) return undefined;
  return prior.nativePreview ? { ...prior.nativePreview } : undefined;
}

export interface PreviewBadgeInfo {
  /** Triangles actually present in the scene geometry (the rendered preview). */
  previewTriangleCount: number;
  /** Triangles in the original on-disk mesh before import decimation. */
  originalTriangleCount: number;
  /**
   * meshopt achieved relative decimation error (fraction of mesh extents,
   * [0,1]) from the query-first decimation, when known.
   */
  achievedError?: number;
  /** The import-time governor triangle budget the preview was reduced to. */
  budgetTriangles?: number;
}

/**
 * Badge payload for a native-preview model, or `null` when the model is not a
 * preview (badge must not render). `previewTriangleCount` is the ACTUAL scene
 * count, not the marker's recorded value, so it stays truthful even if a
 * downstream op changed the buffer.
 */
export function getPreviewBadgeInfo(geometry: GeometryWithBounds): PreviewBadgeInfo | null {
  const marker = geometry.nativePreview;
  if (!marker || !Number.isFinite(marker.originalTriangleCount) || marker.originalTriangleCount <= 0) {
    return null;
  }
  return {
    previewTriangleCount: actualSceneTriangleCount(geometry),
    originalTriangleCount: marker.originalTriangleCount,
    achievedError: marker.achievedError,
    budgetTriangles: marker.budgetTriangles,
  };
}
