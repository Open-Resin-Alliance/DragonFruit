/**
 * useOrganicCutSession — owns ALL Cutting Mode state and the cut round-trip.
 *
 * This hook exists so the giant app shell (src/app/page.tsx) only needs three
 * additive lines: an import, a hook call, and the two JSX mounts (the in-canvas
 * <OrganicCutTool> and the out-of-canvas <OrganicCutPanel>). Every piece of
 * organic-cut logic lives here inside the feature directory, keeping the feature
 * self-contained and the seam into page.tsx as small as possible.
 *
 * M1: the backend cut is a no-op, so "applying" round-trips the mesh and logs
 * the two returned parts. Wiring the parts into the scene as real split models
 * is deferred to a later milestone (it needs scene-collection plumbing we are
 * intentionally not touching yet).
 */
import React from 'react';
import type { OrganicCutLoopPoint, OrganicCutResult, OrganicCutSessionStatus } from './types';
import type { OrganicCutPanelState } from './OrganicCutPanel';
import {
  computeGeodesicLoop,
  computeMembranePreview,
  cutFromCapturedSource,
  partToGeometry,
  stageCutSource,
} from './meshOrganicCut';
import { cutPlaneFromPoints } from './cutPlane';
import type * as THREE from 'three';

/** Minimum points before a cut is possible. 2 = the simplest flat plane cut. */
const MIN_LOOP_POINTS = 2;

/**
 * Convert a flat on-surface geodesic polyline (xyz triples, model-local) into
 * loop points for the contour cut. Normals are left zero — the membrane builder
 * computes its own surface normals, so only positions matter here. Rust dedupes
 * a trailing point that repeats the first, so a closed polyline is fine as-is.
 */
function geodesicPolylineToLoopPoints(poly: Float32Array): OrganicCutLoopPoint[] {
  const out: OrganicCutLoopPoint[] = [];
  for (let i = 0; i + 2 < poly.length; i += 3) {
    out.push({ position: [poly[i], poly[i + 1], poly[i + 2]], normal: [0, 0, 0] });
  }
  return out;
}

export interface UseOrganicCutSessionArgs {
  /** True when the Cut tool is the active transform mode in Prepare. */
  toolActive: boolean;
  /** The active model's geometry to cut (position-only buffer is fine). */
  activeGeometry: THREE.BufferGeometry | null | undefined;
  /** Stable key identifying the current geometry, for source-stage caching. */
  activeGeometryKey: string | null;
  /**
   * Commit the two split parts to the scene: replace the active model's geometry
   * with part A, and add part B as a new independent model. Supplied by the host
   * (page.tsx) so this hook stays decoupled from the scene-collection API.
   * Returns false if the commit could not be performed.
   */
  commitParts?: (partA: THREE.BufferGeometry, partB: THREE.BufferGeometry) => boolean;
}

export interface OrganicCutSession {
  // Panel state
  panelState: OrganicCutPanelState;
  setPanelState: (next: OrganicCutPanelState) => void;
  // Loop / session
  loop: OrganicCutLoopPoint[];
  status: OrganicCutSessionStatus;
  addPoint: (point: OrganicCutLoopPoint) => void;
  clearLoop: () => void;
  closeLoop: () => void;
  // Apply
  apply: () => void;
  isApplying: boolean;
  lastResult: OrganicCutResult | null;
  // Derived gates for the panel
  canCloseLoop: boolean;
  canApply: boolean;
  pointCount: number;
  /**
   * Surface-following loop polyline (flat xyz, model-local space) computed by the
   * Rust geodesic engine, for rendering the seam ON the surface instead of as
   * straight chords. Null until ≥2 points / outside Tauri.
   */
  geodesicPolyline: Float32Array | null;
  /**
   * Contour-cut membrane preview (flat triangle soup, model-local). The exact
   * curved cutter surface the contour cut will use. Null unless in contour mode
   * with ≥3 points / outside Tauri.
   */
  membranePreview: Float32Array | null;
}

const DEFAULT_PANEL_STATE: OrganicCutPanelState = {
  drawMode: 'waypoint',
  cutMode: 'plane',
  thicknessMm: 1.0,
  smoothing: 0.5,
};

/** Minimum points before a CONTOUR cut is possible (a real loop needs ≥3). */
const MIN_CONTOUR_POINTS = 3;

export function useOrganicCutSession({
  toolActive,
  activeGeometry,
  activeGeometryKey,
  commitParts,
}: UseOrganicCutSessionArgs): OrganicCutSession {
  const [panelState, setPanelState] = React.useState<OrganicCutPanelState>(DEFAULT_PANEL_STATE);
  const [loop, setLoop] = React.useState<OrganicCutLoopPoint[]>([]);
  const [status, setStatus] = React.useState<OrganicCutSessionStatus>('idle');
  const [isApplying, setIsApplying] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<OrganicCutResult | null>(null);
  const [geodesicPolyline, setGeodesicPolyline] = React.useState<Float32Array | null>(null);
  // Contour-cut membrane preview (flat triangle soup, model-local). Shows the
  // exact cutter surface so the user sees where the curved cut will land.
  const [membranePreview, setMembranePreview] = React.useState<Float32Array | null>(null);

  // Mirror loop in a ref so `apply` always reads the CURRENT points regardless of
  // whether the panel is holding a stale memoized `apply` closure. This is the
  // fix for "0 points reached the backend" — a stale closure captured loop=[].
  const loopRef = React.useRef(loop);
  React.useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  // Keep the latest commit callback in a ref so `apply` doesn't churn its deps.
  const commitPartsRef = React.useRef(commitParts);
  React.useEffect(() => {
    commitPartsRef.current = commitParts;
  }, [commitParts]);

  // Latest panel state + geometry in refs too, so `apply` can be a STABLE
  // callback (empty deps) that never goes stale.
  const panelStateRef = React.useRef(panelState);
  React.useEffect(() => { panelStateRef.current = panelState; }, [panelState]);
  const activeGeometryRef = React.useRef(activeGeometry);
  React.useEffect(() => { activeGeometryRef.current = activeGeometry; }, [activeGeometry]);
  const activeGeometryKeyRef = React.useRef(activeGeometryKey);
  React.useEffect(() => { activeGeometryKeyRef.current = activeGeometryKey; }, [activeGeometryKey]);
  // The latest on-surface geodesic polyline, so a contour cut sends the DENSE
  // surface-following loop (not just the sparse waypoints) to the membrane.
  const geodesicPolylineRef = React.useRef(geodesicPolyline);
  React.useEffect(() => { geodesicPolylineRef.current = geodesicPolyline; }, [geodesicPolyline]);

  // Reset the session whenever the tool is deactivated or the model changes,
  // so a stale loop never bleeds across tools/models.
  React.useEffect(() => {
    if (!toolActive) {
      setLoop([]);
      setStatus('idle');
      setLastResult(null);
    }
  }, [toolActive]);

  React.useEffect(() => {
    setLoop([]);
    setStatus('idle');
    setLastResult(null);
    setGeodesicPolyline(null);
  }, [activeGeometryKey]);

  // Recompute the surface-following loop whenever the points change. Stages the
  // source mesh (cheap no-op if already staged for this geometry) then asks Rust
  // for the on-surface polyline. Cancelled if points change again mid-flight.
  const cutMode = panelState.cutMode;
  React.useEffect(() => {
    if (!toolActive || loop.length < 2 || !activeGeometry || !activeGeometryKey) {
      setGeodesicPolyline(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const staged = await stageCutSource(activeGeometry, activeGeometryKey);
      if (cancelled || !staged) return;
      // Close the loop only once there are enough points to form one.
      const close = loop.length >= 3;
      const poly = await computeGeodesicLoop(loop, close);
      if (!cancelled) setGeodesicPolyline(poly);
    })();
    return () => {
      cancelled = true;
    };
  }, [toolActive, loop, activeGeometry, activeGeometryKey]);

  // Membrane preview (contour mode). Separate, DEBOUNCED effect so it doesn't
  // fight the geodesic computation or thrash on rapid clicks. It reads the
  // already-computed geodesic from state (the same dense loop the cut uses) and
  // asks Rust to build the membrane, rendered translucent in OrganicCutTool.
  React.useEffect(() => {
    if (
      cutMode !== 'contour' ||
      !toolActive ||
      loop.length < 3 ||
      !activeGeometry ||
      !activeGeometryKey
    ) {
      setMembranePreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const staged = await stageCutSource(activeGeometry, activeGeometryKey);
        if (cancelled || !staged) return;
        const poly = geodesicPolyline;
        const previewLoop =
          poly && poly.length >= 9 ? geodesicPolylineToLoopPoints(poly) : loop;
        const membrane = await computeMembranePreview(previewLoop);
        if (!cancelled) setMembranePreview(membrane);
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [toolActive, loop, activeGeometry, activeGeometryKey, cutMode, geodesicPolyline]);

  const addPoint = React.useCallback((point: OrganicCutLoopPoint) => {
    setLoop((prev) => [...prev, point]);
    setStatus('drawing');
  }, []);

  const clearLoop = React.useCallback(() => {
    setLoop([]);
    setStatus('idle');
    setLastResult(null);
  }, []);

  const closeLoop = React.useCallback(() => {
    setLoop((prev) => {
      if (prev.length < MIN_LOOP_POINTS) return prev;
      setStatus('closed');
      return prev;
    });
  }, []);

  const apply = React.useCallback(() => {
    // Read everything from refs so this callback is STABLE and never stale.
    const currentLoop = loopRef.current;
    const geom = activeGeometryRef.current;
    const geomKey = activeGeometryKeyRef.current;
    const ps = panelStateRef.current;
    const isContour = ps.cutMode === 'contour';
    const minPoints = isContour ? MIN_CONTOUR_POINTS : MIN_LOOP_POINTS;
    if (currentLoop.length < minPoints) return;
    if (!geom || !geomKey) return;
    const loopSnapshot = currentLoop.slice();
    const geodesic = geodesicPolylineRef.current;
    let cancelled = false;
    setIsApplying(true);
    void (async () => {
      try {
        const staged = await stageCutSource(geom, geomKey);
        if (!staged) {
          // Not in the Tauri runtime (e.g. browser dev) — nothing to do.
          return;
        }

        // Contour: send the DENSE on-surface geodesic polyline as the loop so the
        // membrane traces the real surface crossing (the sparse waypoints alone
        // wouldn't sever the body). Falls back to the waypoints if the geodesic
        // hasn't computed yet. No explicit plane — contour ignores it.
        // Flat: send the waypoints + the exact plane the preview showed.
        let cutSpec;
        if (isContour) {
          const contourLoop =
            geodesic && geodesic.length >= MIN_CONTOUR_POINTS * 3
              ? geodesicPolylineToLoopPoints(geodesic)
              : loopSnapshot;
          cutSpec = {
            loopPoints: contourLoop,
            thicknessMm: ps.thicknessMm,
            smoothing: ps.smoothing,
            mode: 'contour' as const,
            // Omit cutterThicknessMm so the Rust default (the single source of
            // truth for the minimum cutter thickness) governs.
          };
        } else {
          // Compute the plane from the SAME helper the preview uses, so the cut
          // is exactly the plane the user saw. Sent explicitly; Rust splits by it.
          const plane = cutPlaneFromPoints(loopSnapshot);
          cutSpec = {
            loopPoints: loopSnapshot,
            thicknessMm: ps.thicknessMm,
            smoothing: ps.smoothing,
            mode: 'plane' as const,
            plane: plane
              ? { normal: [plane.normal.x, plane.normal.y, plane.normal.z] as [number, number, number], offset: plane.offset }
              : undefined,
          };
        }
        const result = await cutFromCapturedSource({ cut: cutSpec });
        if (cancelled || !result) return;
        setLastResult(result);

        // M2: commit the two parts to the scene (replace active model with part
        // A, add part B as a new model). If the engine fell back to a no-op
        // (degenerate loop / manifold rejected the mesh), don't mutate the scene
        // — the two parts are identical to the source and committing would just
        // duplicate the model.
        const committed =
          result.report.engine !== 'noop' && commitPartsRef.current
            ? commitPartsRef.current(partToGeometry(result.partA), partToGeometry(result.partB))
            : false;

        // Flat string (not an object) so the Tauri log forwarder shows every
        // field inline instead of collapsing it to "Object".
        // eslint-disable-next-line no-console
        console.info(
          `[organicCut] cut applied | engine=${result.report.engine}` +
          ` committed=${committed}` +
          ` detail="${result.report.detail ?? ''}"` +
          ` source=${result.report.sourceTriangleCount}` +
          ` partA=${result.report.partATriangleCount}` +
          ` partB=${result.report.partBTriangleCount}`,
        );

        if (committed && !cancelled) {
          // Clear the loop after a successful cut so the tool is ready for the
          // next one and stale points don't linger on the (now replaced) model.
          setLoop([]);
          setStatus('idle');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[organicCut] cut failed', err);
      } finally {
        if (!cancelled) setIsApplying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // stable: all inputs read from refs

  const pointCount = loop.length;
  // Contour needs a real loop (≥3 points); flat works with 2.
  const minPointsForMode = panelState.cutMode === 'contour' ? MIN_CONTOUR_POINTS : MIN_LOOP_POINTS;
  const canCloseLoop = status === 'drawing' && pointCount >= MIN_LOOP_POINTS;
  const canApply = pointCount >= minPointsForMode && !isApplying;

  return {
    panelState,
    setPanelState,
    loop,
    status,
    addPoint,
    clearLoop,
    closeLoop,
    apply,
    isApplying,
    lastResult,
    canCloseLoop,
    canApply,
    pointCount,
    geodesicPolyline,
    membranePreview,
  };
}
