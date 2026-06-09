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
import { cutFromCapturedSource, partToGeometry, stageCutSource } from './meshOrganicCut';
import { cutPlaneFromPoints } from './cutPlane';
import type * as THREE from 'three';

/** Minimum points before a cut is possible. 2 = the simplest flat plane cut. */
const MIN_LOOP_POINTS = 2;

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
}

const DEFAULT_PANEL_STATE: OrganicCutPanelState = {
  drawMode: 'waypoint',
  thicknessMm: 1.0,
  smoothing: 0.5,
};

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
  }, [activeGeometryKey]);

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
    // eslint-disable-next-line no-console
    console.info(`[organicCut] apply() entry | loop.length=${currentLoop.length} key=${geomKey} hasGeom=${!!geom}`);
    if (currentLoop.length < MIN_LOOP_POINTS) return;
    if (!geom || !geomKey) return;
    const loopSnapshot = currentLoop.slice();
    let cancelled = false;
    setIsApplying(true);
    void (async () => {
      try {
        const staged = await stageCutSource(geom, geomKey);
        // eslint-disable-next-line no-console
        console.info(`[organicCut] after stage | staged=${staged} loopSnapshot=${loopSnapshot.length}`);
        if (!staged) {
          // Not in the Tauri runtime (e.g. browser dev) — nothing to do.
          return;
        }
        // Compute the plane from the SAME helper the preview uses, so the cut is
        // exactly the plane the user saw. Sent explicitly; Rust splits by it.
        const plane = cutPlaneFromPoints(loopSnapshot);
        const result = await cutFromCapturedSource({
          cut: {
            loopPoints: loopSnapshot,
            thicknessMm: ps.thicknessMm,
            smoothing: ps.smoothing,
            plane: plane
              ? { normal: [plane.normal.x, plane.normal.y, plane.normal.z], offset: plane.offset }
              : undefined,
          },
        });
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
  const canCloseLoop = status === 'drawing' && pointCount >= MIN_LOOP_POINTS;
  const canApply = pointCount >= MIN_LOOP_POINTS && !isApplying;

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
  };
}
