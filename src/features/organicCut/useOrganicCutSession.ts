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
  isCutSourceStaged,
  partToGeometry,
  stageCutSource,
} from './meshOrganicCut';
import type { KeyPreviewKind } from './meshOrganicCut';
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
   * True while a waypoint is being dragged. The membrane preview (heavy Rust
   * round-trip) is suppressed during a drag and rebuilt once on release, so the
   * drop feels snappy; the seam line still tracks the surface live (debounced).
   */
  isDraggingPoint?: boolean;
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
  /**
   * Reposition an already-placed waypoint (drag-to-edit). `index` is the loop
   * slot; `point` is the new surface point (model-local) the marker was dragged
   * to. A no-op if the index is out of range. Triggers a geodesic/membrane
   * recompute through the same effects as adding a point.
   */
  updatePoint: (index: number, point: OrganicCutLoopPoint) => void;
  /**
   * Insert a new waypoint INTO the chain right after `afterIndex` (so it lands
   * between waypoints `afterIndex` and `afterIndex+1`). Used by the seam-line
   * right-click "Add waypoint here". Clamps the index into range.
   */
  insertPoint: (afterIndex: number, point: OrganicCutLoopPoint) => void;
  /** Remove the waypoint at `index` (Delete key / right-click Delete). */
  removePoint: (index: number) => void;
  /** The currently selected waypoint index, or null. Click a marker to select. */
  selectedIndex: number | null;
  /** Select a waypoint (or null to clear). Click a marker → select it. */
  selectPoint: (index: number | null) => void;
  /** Remove the most recently placed waypoint (Ctrl+Z). No-op if empty. */
  undoPoint: () => void;
  /** Re-add the last undone waypoint (Ctrl+Shift+Z / Ctrl+Y). No-op if none. */
  redoPoint: () => void;
  /** True when there is a waypoint to undo (for hotkey gating). */
  canUndoPoint: boolean;
  /** True when there is an undone waypoint to redo. */
  canRedoPoint: boolean;
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
  /**
   * Registration-key preview (peg + socket triangle soup, model-local) — the
   * exact key the cut will place. Null unless generateKey is on with a fitting
   * key. Render alongside the membrane.
   */
  keyPreview: Float32Array | null;
  /** Which key the preview placed: 'frustum', 'dome' (fallback), or 'none'. */
  keyKind: KeyPreviewKind;
  /** Reason the key shrank / fell back / was skipped (for the panel alert). */
  keyDetail: string;
}

const DEFAULT_PANEL_STATE: OrganicCutPanelState = {
  drawMode: 'waypoint',
  cutMode: 'contour',
  // 0.1mm matches the Rust default kerf (the value the contour cut used before
  // the slider was wired up) — the proven-good out-of-box thickness.
  thicknessMm: 0.1,
  // Default to full smoothing (1) on both the seam line and the cut surface —
  // the smoothest out-of-box result. The sliders go to 2 for extra rounding.
  smoothing: 1.0,
  membraneSmoothing: 1.0,
  // 4× = densest cutter + finest seam-band model refinement by default, for the
  // cleanest cut edge out of the box.
  density: 4.0,
  // Registration key off by default — the user opts in per cut.
  generateKey: false,
  // Default key size (mm) — model units are mm. Width 2 → length auto = 2.5mm
  // (1.25× ratio); depth 2.5mm. The user tunes these live.
  keyWidthMm: 2.0,
  keyDepthMm: 2.5,
};

/** Minimum points before a CONTOUR cut is possible (a real loop needs ≥3). */
const MIN_CONTOUR_POINTS = 3;

export function useOrganicCutSession({
  toolActive,
  activeGeometry,
  activeGeometryKey,
  isDraggingPoint = false,
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
  // Registration-key preview (peg + socket soup) + the chosen rung and reason, so
  // the scene can render the key and the panel can alert on a fallback. Built in
  // the same preview round-trip as the membrane, only when generateKey is on.
  const [keyPreview, setKeyPreview] = React.useState<Float32Array | null>(null);
  const [keyKind, setKeyKind] = React.useState<KeyPreviewKind>('none');
  const [keyDetail, setKeyDetail] = React.useState<string>('');
  // Selected waypoint index (click a marker to select; Delete removes it).
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);

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

  // Per-model loop persistence. The cut path is retained for the model it was
  // drawn on, so deselecting (clicking away) and reselecting that model — or
  // leaving and returning to the Cut tool — restores the in-progress loop instead
  // of losing it. Keyed by the model's geometry key (its id).
  const savedLoopsRef = React.useRef<Map<string, OrganicCutLoopPoint[]>>(new Map());

  // Undo-restore: when a cut commits we remember the model id, the loop, and the
  // PRE-CUT geometry object reference. If the user undoes the cut, scene history
  // restores that exact geometry reference (cloneLoadedModel keeps geometry by
  // reference), so when we see the active model's geometry revert to it we
  // restore the loop — letting the user tweak a waypoint and re-cut instead of
  // starting over. Cleared once consumed or superseded.
  const undoRestoreRef = React.useRef<{
    modelId: string;
    geometry: THREE.BufferGeometry;
    loop: OrganicCutLoopPoint[];
  } | null>(null);

  // Redo stack for waypoint undo (Ctrl+Z / Ctrl+Shift+Z). Holds points popped by
  // undo so they can be re-added; cleared whenever a NEW point is placed (standard
  // undo/redo semantics). State (not a ref) so the panel/hotkey gates re-render.
  const [redoStack, setRedoStack] = React.useState<OrganicCutLoopPoint[]>([]);
  // The latest on-surface geodesic polyline, so a contour cut sends the DENSE
  // surface-following loop (not just the sparse waypoints) to the membrane.
  const geodesicPolylineRef = React.useRef(geodesicPolyline);
  React.useEffect(() => { geodesicPolylineRef.current = geodesicPolyline; }, [geodesicPolyline]);

  // When the tool is deactivated, stash the current loop under its model so it can
  // be restored on re-entry, then clear the live view. We DON'T drop the saved
  // copy — re-entering the tool (or reselecting the model) brings the path back.
  React.useEffect(() => {
    if (!toolActive) {
      const key = activeGeometryKeyRef.current;
      const current = loopRef.current;
      if (key && current.length > 0) {
        savedLoopsRef.current.set(key, current);
      }
      setLoop([]);
      setStatus('idle');
      setLastResult(null);
      setSelectedIndex(null);
    }
  }, [toolActive]);

  // On model change: stash the OUTGOING model's loop, then restore the INCOMING
  // model's saved loop (if any). Clicking away sets the key to null and stashes;
  // reselecting restores. Switching to a different model loads ITS path, not a
  // bleed-over from the previous one.
  const prevGeometryKeyRef = React.useRef<string | null>(activeGeometryKey);
  React.useEffect(() => {
    const prevKey = prevGeometryKeyRef.current;
    // Stash the loop we're leaving (read the live value via ref).
    if (prevKey && prevKey !== activeGeometryKey) {
      const leaving = loopRef.current;
      if (leaving.length > 0) {
        savedLoopsRef.current.set(prevKey, leaving);
      }
    }
    prevGeometryKeyRef.current = activeGeometryKey;

    // Restore the incoming model's saved loop, or start empty.
    const restored = activeGeometryKey
      ? savedLoopsRef.current.get(activeGeometryKey) ?? []
      : [];
    setLoop(restored);
    setStatus(restored.length > 0 ? 'drawing' : 'idle');
    setLastResult(null);
    setGeodesicPolyline(null);
    // Redo history + selection don't carry across models.
    setRedoStack([]);
    setSelectedIndex(null);
  }, [activeGeometryKey]);

  // Undo-restore: when the active model's geometry REVERTS to the exact pre-cut
  // reference we stashed at cut time (scene-history undo restores geometry by
  // reference), bring the loop/membrane back so the user can tweak and re-cut.
  // Keyed on the geometry REFERENCE (not the id) because a cut+undo keeps the
  // same model id — only the geometry object changes.
  React.useEffect(() => {
    if (!toolActive) return;
    const pending = undoRestoreRef.current;
    if (!pending) return;
    if (
      activeGeometryKey === pending.modelId &&
      activeGeometry === pending.geometry &&
      pending.loop.length > 0
    ) {
      // Geometry reverted to the pre-cut state → restore the loop. Consume the
      // entry so a later unrelated geometry change doesn't re-trigger it.
      undoRestoreRef.current = null;
      savedLoopsRef.current.set(pending.modelId, pending.loop);
      setLoop(pending.loop);
      setStatus('drawing');
      setSelectedIndex(null);
      setRedoStack([]);
    }
  }, [toolActive, activeGeometry, activeGeometryKey]);

  // Recompute the surface-following loop whenever the points change. Stages the
  // source mesh (cheap no-op if already staged for this geometry) then asks Rust
  // for the on-surface polyline. Cancelled if points change again mid-flight.
  //
  // No debounce: with the Rust solver cached, each query is cheap, so the seam
  // recomputes on every point change for maximum responsiveness. In-flight calls
  // are cancelled (the `cancelled` guard) when points change again, so a fast
  // drag never lets a stale result overwrite a newer one.
  const cutMode = panelState.cutMode;
  React.useEffect(() => {
    if (!toolActive || loop.length < 2 || !activeGeometry || !activeGeometryKey) {
      setGeodesicPolyline(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Skip the staging await on the hot path: if the source is already staged
      // for this geometry (always true after the first call / during a drag), go
      // straight to the single-hop geodesic call.
      if (!isCutSourceStaged(activeGeometryKey, activeGeometry)) {
        const staged = await stageCutSource(activeGeometry, activeGeometryKey);
        if (cancelled || !staged) return;
      }
      // Close the loop only once there are enough points to form one.
      const close = loop.length >= 3;
      const poly = await computeGeodesicLoop(loop, close, panelState.smoothing);
      if (!cancelled) setGeodesicPolyline(poly);
    })();
    return () => {
      cancelled = true;
    };
  }, [toolActive, loop, activeGeometry, activeGeometryKey, panelState.smoothing]);

  // Membrane preview (contour mode). The membrane build is the heavy Rust
  // round-trip, so it is SUPPRESSED while a waypoint is being dragged and rebuilt
  // once the user drops it (isDraggingPoint flips false) — the drop then costs a
  // single build, not a backlog. It reads the already-computed geodesic from
  // state (the same dense loop the cut uses) and renders translucent in the tool.
  //
  // A small settle timer (80ms) lets the just-finished drag's debounced geodesic
  // land first, so the membrane is built from the final seam rather than a stale
  // one (which would otherwise trigger a second rebuild a moment later).
  React.useEffect(() => {
    if (
      cutMode !== 'contour' ||
      !toolActive ||
      isDraggingPoint ||
      loop.length < 3 ||
      !activeGeometry ||
      !activeGeometryKey
    ) {
      // Don't clear the preview just because a drag started — keep the last
      // membrane visible during the drag; only clear when truly not previewable.
      if (!isDraggingPoint) {
        setMembranePreview(null);
        setKeyPreview(null);
        setKeyKind('none');
        setKeyDetail('');
      }
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
        const result = await computeMembranePreview(
          previewLoop,
          panelState.membraneSmoothing,
          panelState.density,
          panelState.thicknessMm,
          panelState.generateKey,
          panelState.keyWidthMm,
          panelState.keyDepthMm,
        );
        if (cancelled) return;
        setMembranePreview(result.membrane);
        setKeyPreview(result.keyPreview);
        setKeyKind(result.keyKind);
        setKeyDetail(result.keyDetail);
      })();
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [toolActive, loop, activeGeometry, activeGeometryKey, cutMode, geodesicPolyline, isDraggingPoint, panelState.membraneSmoothing, panelState.density, panelState.thicknessMm, panelState.generateKey, panelState.keyWidthMm, panelState.keyDepthMm]);

  const addPoint = React.useCallback((point: OrganicCutLoopPoint) => {
    setLoop((prev) => [...prev, point]);
    setStatus('drawing');
    // A freshly placed point invalidates any redo history.
    setRedoStack([]);
  }, []);

  const insertPoint = React.useCallback((afterIndex: number, point: OrganicCutLoopPoint) => {
    setLoop((prev) => {
      // Insert AFTER afterIndex → at array position afterIndex+1. Clamp so a bad
      // index can't throw; a negative index prepends, an over-large one appends.
      const at = Math.max(0, Math.min(prev.length, afterIndex + 1));
      const next = prev.slice();
      next.splice(at, 0, point);
      return next;
    });
    setStatus('drawing');
    setRedoStack([]);
  }, []);

  const selectPoint = React.useCallback((index: number | null) => {
    setSelectedIndex(index);
  }, []);

  const removePoint = React.useCallback((index: number) => {
    setLoop((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next.splice(index, 1);
      setStatus(next.length > 0 ? 'drawing' : 'idle');
      return next;
    });
    // Clear/adjust the selection: deleting the selected point deselects; deleting
    // one before it shifts the selection index down by one.
    setSelectedIndex((sel) => {
      if (sel === null) return null;
      if (sel === index) return null;
      return sel > index ? sel - 1 : sel;
    });
    // A delete is a fresh edit — it invalidates the redo history.
    setRedoStack([]);
  }, []);

  const undoPoint = React.useCallback(() => {
    setLoop((prev) => {
      if (prev.length === 0) return prev;
      const removed = prev[prev.length - 1];
      setRedoStack((r) => [...r, removed]);
      const next = prev.slice(0, -1);
      setStatus(next.length > 0 ? 'drawing' : 'idle');
      // Clear selection if it pointed at (or past) the removed last point.
      setSelectedIndex((sel) => (sel !== null && sel >= next.length ? null : sel));
      return next;
    });
  }, []);

  const redoPoint = React.useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const restored = r[r.length - 1];
      setLoop((prev) => [...prev, restored]);
      setStatus('drawing');
      return r.slice(0, -1);
    });
  }, []);

  const updatePoint = React.useCallback((index: number, point: OrganicCutLoopPoint) => {
    setLoop((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const prevPoint = prev[index];
      // Skip a state churn if the point didn't actually move (drag with no delta).
      if (
        prevPoint.position[0] === point.position[0] &&
        prevPoint.position[1] === point.position[1] &&
        prevPoint.position[2] === point.position[2]
      ) {
        return prev;
      }
      const next = prev.slice();
      next[index] = point;
      return next;
    });
  }, []);

  const clearLoop = React.useCallback(() => {
    // Clear truly clears — also drop the persisted copy so it doesn't spring back
    // on deselect/reselect.
    const key = activeGeometryKeyRef.current;
    if (key) savedLoopsRef.current.delete(key);
    setLoop([]);
    setStatus('idle');
    setLastResult(null);
    setRedoStack([]);
    setSelectedIndex(null);
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
            // `smoothing` = seam-line smoothing (the geodesic was already computed
            // with it, but send it so the cut's loop matches). `membraneSmoothing`
            // = cutter-surface relaxation. Both 0..1.
            smoothing: ps.smoothing,
            membraneSmoothing: ps.membraneSmoothing,
            mode: 'contour' as const,
            // The "Wafer Thickness" slider drives the actual kerf. Rust reads
            // `cutterThicknessMm` for the contour cut (falling back to its default
            // only when this is <= 0), so send the slider value here — sending it
            // as `thicknessMm` (a separate field) is what made the slider a no-op.
            cutterThicknessMm: ps.thicknessMm,
            // Cut resolution multiplier — raises the cutter poly count. The live
            // preview reflects this too (so what you see is what gets cut).
            density: ps.density,
            // When on, the cut also builds the registration key (peg union'd onto
            // one half, socket carved from the other). The preview already showed
            // the exact key this produces.
            generateKey: ps.generateKey,
            keyWidthMm: ps.keyWidthMm,
            keyDepthMm: ps.keyDepthMm,
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
          ` keyKind=${result.report.keyKind ?? 'n/a'}` +
          ` keyDetail="${result.report.keyDetail ?? ''}"` +
          ` source=${result.report.sourceTriangleCount}` +
          ` partA=${result.report.partATriangleCount}` +
          ` partB=${result.report.partBTriangleCount}`,
        );

        if (committed && !cancelled) {
          // Clear the loop after a successful cut so the tool is ready for the
          // next one and stale points don't linger on the (now replaced) model.
          // Remember the loop + the PRE-CUT geometry reference so that an UNDO
          // (which restores that exact geometry) brings the membrane/loop back.
          if (geomKey && geom) {
            undoRestoreRef.current = {
              modelId: geomKey,
              geometry: geom,
              loop: loopSnapshot,
            };
          }
          setLoop([]);
          setStatus('idle');
          setSelectedIndex(null);
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
  const canUndoPoint = pointCount > 0;
  const canRedoPoint = redoStack.length > 0;

  return {
    panelState,
    setPanelState,
    loop,
    status,
    addPoint,
    updatePoint,
    insertPoint,
    removePoint,
    selectedIndex,
    selectPoint,
    undoPoint,
    redoPoint,
    canUndoPoint,
    canRedoPoint,
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
    keyPreview,
    keyKind,
    keyDetail,
  };
}
