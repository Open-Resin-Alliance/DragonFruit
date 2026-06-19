/**
 * useOrganicCutSession — owns ALL Cutting Mode state and the cut round-trip.
 *
 * This hook exists so the giant app shell (src/app/page.tsx) only needs three
 * additive lines: an import, a hook call, and the two JSX mounts (the in-canvas
 * <OrganicCutTool> and the out-of-canvas <OrganicCutPanel>). Every piece of
 * organic-cut logic lives here inside the feature directory, keeping the feature
 * self-contained and the seam into page.tsx as small as possible.
 *
 * MULTI-LOOP: a cut can carry several loops at once (contour mode). They live in
 * one ordered `loops` list with one ACTIVE loop (`activeLoopIndex`); the active
 * loop gets the full waypoint-editing UI, the others render as dimmed seams. The
 * user switches the active loop freely (panel chips) to go back and adjust any of
 * them. On Apply, every loop's cutter is union'd and differenced in one shot — the
 * way to free a part attached in several places (e.g. a tail joined at two posts).
 */
import React from 'react';
import type { KeyPreviewFrame, OrganicCutLoopPoint, OrganicCutResult, OrganicCutSessionStatus } from './types';
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
 * Per-loop registration-key settings — a multi-loop cut keys each loop
 * independently. Mirrors the key fields of OrganicCutPanelState: the panel's key
 * controls edit the ACTIVE loop's copy through `panelState`, which is kept in sync
 * with the active loop (the panel/gizmo stay bound to `panelState` as before).
 */
export type LoopKeySettings = Pick<
  OrganicCutPanelState,
  | 'generateKey'
  | 'keyWidthMm'
  | 'keyDepthMm'
  | 'keyShape'
  | 'keyFilletMm'
  | 'keyUniformScale'
  | 'keySwapSides'
  | 'keyTiltRad'
  | 'keyTiltAzimuthRad'
  | 'keyRollRad'
>;

/** Pull the key fields out of the panel state. */
function extractKey(ps: OrganicCutPanelState): LoopKeySettings {
  return {
    generateKey: ps.generateKey,
    keyWidthMm: ps.keyWidthMm,
    keyDepthMm: ps.keyDepthMm,
    keyShape: ps.keyShape,
    keyFilletMm: ps.keyFilletMm,
    keyUniformScale: ps.keyUniformScale,
    keySwapSides: ps.keySwapSides,
    keyTiltRad: ps.keyTiltRad,
    keyTiltAzimuthRad: ps.keyTiltAzimuthRad,
    keyRollRad: ps.keyRollRad,
  };
}

/** Overlay a loop's key settings onto the panel state (the editor buffer). */
function withKey(ps: OrganicCutPanelState, key: LoopKeySettings): OrganicCutPanelState {
  return { ...ps, ...key };
}

/** Value-equality of two key settings (to skip no-op state churn). */
function keysEqual(a: LoopKeySettings, b: LoopKeySettings): boolean {
  return (
    a.generateKey === b.generateKey &&
    a.keyWidthMm === b.keyWidthMm &&
    a.keyDepthMm === b.keyDepthMm &&
    a.keyShape === b.keyShape &&
    a.keyFilletMm === b.keyFilletMm &&
    a.keyUniformScale === b.keyUniformScale &&
    a.keySwapSides === b.keySwapSides &&
    a.keyTiltRad === b.keyTiltRad &&
    a.keyTiltAzimuthRad === b.keyTiltAzimuthRad &&
    a.keyRollRad === b.keyRollRad
  );
}

/** Wire form of a loop's key for the Rust `loopKeys` array (drops UI-only fields). */
function keyToSpec(k: LoopKeySettings) {
  return {
    generateKey: k.generateKey,
    keyWidthMm: k.keyWidthMm,
    keyDepthMm: k.keyDepthMm,
    keyShape: k.keyShape,
    keyFilletMm: k.keyFilletMm,
    keySwapSides: k.keySwapSides,
    keyTiltRad: k.keyTiltRad,
    keyTiltAzimuthRad: k.keyTiltAzimuthRad,
    keyRollRad: k.keyRollRad,
  };
}

/**
 * One loop in a (possibly multi-loop) cut. `points` are the editable user
 * waypoints; `polyline` is the cached DENSE on-surface geodesic for that loop —
 * kept so an INACTIVE loop can still render its seam, and so the cut traces the
 * real surface. `key` is this loop's own registration-key settings. The active
 * loop's polyline is refreshed live by the geodesic effect; an edit leaves the
 * stale polyline in place until that recompute lands.
 */
interface SessionLoop {
  points: OrganicCutLoopPoint[];
  polyline: Float32Array | null;
  key: LoopKeySettings;
}

/** A fresh empty loop slot carrying the given key settings. */
function emptyLoop(key: LoopKeySettings): SessionLoop {
  return { points: [], polyline: null, key };
}

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

/** The cut loop a given session loop contributes, or null if it's not a real loop. */
function loopCutPoints(l: SessionLoop): OrganicCutLoopPoint[] | null {
  if (l.polyline && l.polyline.length >= MIN_CONTOUR_POINTS * 3) {
    return geodesicPolylineToLoopPoints(l.polyline);
  }
  if (l.points.length >= MIN_CONTOUR_POINTS) {
    return l.points.slice();
  }
  return null;
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
   * Commit the split parts to the scene: replace the active model's geometry with
   * `parts[0]` and add `parts[1..]` as new independent models. A multi-loop cut may
   * pass more than two parts (one per freed piece). Supplied by the host (page.tsx)
   * so this hook stays decoupled from the scene-collection API. Returns false if
   * the commit could not be performed.
   */
  commitParts?: (parts: THREE.BufferGeometry[]) => boolean;
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
  // --- Multi-loop -----------------------------------------------------------
  /** Total loops in this cut (contour). 1 = the classic single-loop cut. */
  loopCount: number;
  /** Index of the loop currently being edited (gets markers + membrane preview). */
  activeLoopIndex: number;
  /** Per-loop summaries for the panel's loop chips (index + waypoint count). */
  loopSummaries: { index: number; pointCount: number; hasKey: boolean }[];
  /** Make loop `index` the active (editable) one. Out-of-range is a no-op. */
  selectLoop: (index: number) => void;
  /**
   * Append a fresh empty loop and make it active (multi-loop cut). On Apply, every
   * loop's cutter is union'd — used to free a part attached in several places.
   */
  addLoop: () => void;
  /** True when a new loop can be added (contour mode, active loop already a loop). */
  canAddLoop: boolean;
  /** Remove loop `index`. Never removes the last remaining loop (use Clear). */
  removeLoop: (index: number) => void;
  /** True when there's more than one loop, so removing one is allowed. */
  canRemoveLoop: boolean;
  /** Seam polylines of the INACTIVE loops (flat xyz, model-local) for the tool. */
  inactiveLoopPolylines: Float32Array[];
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
  /**
   * Placement frame of the previewed key (model-local), for the in-viewport aim+
   * roll gizmo. Null when no key was placed. Drives where the tip/roll handles sit.
   */
  keyFrame: KeyPreviewFrame | null;
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
  // Default key shape — the rotation-locking tapered frustum.
  keyShape: 'frustum',
  // Edge fillet 0.2mm by default (lightly rounded corners + tip); user tunes live.
  keyFilletMm: 0.2,
  // Dome Uniform Scale on by default — width/depth move together (round dome)
  // until the user unlocks it for an oblong shape.
  keyUniformScale: true,
  // Peg on the +normal side (part A) by default; the Flip button swaps it.
  keySwapSides: false,
  // Key points straight out of the cut by default; the in-viewport aim gizmo
  // (drag the tip) leans it, the roll ring spins it. All measured in radians.
  keyTiltRad: 0,
  keyTiltAzimuthRad: 0,
  keyRollRad: 0,
  // Cut-plan preview on by default — the user sees where the cut lands; the
  // toggle hides it for an unobscured view of the model while drawing.
  showPreview: true,
};

/** Minimum points before a CONTOUR cut is possible (a real loop needs ≥3). */
const MIN_CONTOUR_POINTS = 3;

/** Default per-loop key settings — the panel defaults, used for fresh loops. */
const DEFAULT_LOOP_KEY: LoopKeySettings = extractKey(DEFAULT_PANEL_STATE);

export function useOrganicCutSession({
  toolActive,
  activeGeometry,
  activeGeometryKey,
  isDraggingPoint = false,
  commitParts,
}: UseOrganicCutSessionArgs): OrganicCutSession {
  const [panelState, setPanelState] = React.useState<OrganicCutPanelState>(DEFAULT_PANEL_STATE);
  // All loops of the current cut, plus which one is active (editable). The active
  // loop gets the full waypoint UI + membrane preview; the rest render as dimmed
  // seams the user can switch to and edit. There is always ≥1 loop.
  const [loops, setLoops] = React.useState<SessionLoop[]>([emptyLoop(DEFAULT_LOOP_KEY)]);
  const [activeLoopIndex, setActiveLoopIndex] = React.useState(0);
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
  // Placement frame of the previewed key (anchor/axis/u/v/tip), for the aim+roll
  // gizmo. Null when no key is previewed.
  const [keyFrame, setKeyFrame] = React.useState<KeyPreviewFrame | null>(null);
  // Selected waypoint index (click a marker to select; Delete removes it).
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);

  // The active loop's points (the "loop" the rest of the tool edits/renders). A
  // stable reference until that slot's points actually change, so it's safe in
  // effect deps (caching a polyline into the slot keeps this reference intact).
  const loop = (loops[activeLoopIndex] ?? loops[0] ?? emptyLoop(DEFAULT_LOOP_KEY)).points;

  // Mirror loops + active index in refs so the stable `apply` / callbacks read the
  // CURRENT values regardless of any stale memoized closures (this is the fix for
  // "0 points reached the backend" — a stale closure captured an empty loop).
  const loopsRef = React.useRef(loops);
  React.useEffect(() => { loopsRef.current = loops; }, [loops]);
  const activeLoopIndexRef = React.useRef(activeLoopIndex);
  React.useEffect(() => { activeLoopIndexRef.current = activeLoopIndex; }, [activeLoopIndex]);
  const loopRef = React.useRef(loop);
  React.useEffect(() => { loopRef.current = loop; }, [loop]);

  // Seam polylines for the INACTIVE loops, for the tool to render dimmed (the
  // active loop draws its own live seam + markers). Only loops that are real loops
  // (≥3 points) with a cached seam show.
  const inactiveLoopPolylines = React.useMemo(
    () =>
      loops
        .map((l, i) => (i !== activeLoopIndex && l.polyline && l.points.length >= MIN_CONTOUR_POINTS ? l.polyline : null))
        .filter((p): p is Float32Array => !!p),
    [loops, activeLoopIndex],
  );

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

  // Per-model loop persistence. The cut path (all loops + which is active) is
  // retained for the model it was drawn on, so deselecting (clicking away) and
  // reselecting that model — or leaving and returning to the Cut tool — restores
  // the in-progress loops instead of losing them. Keyed by the model id.
  const savedLoopsRef = React.useRef<Map<string, { loops: SessionLoop[]; activeIndex: number }>>(new Map());

  // Undo-restore: when a cut commits we remember the model id, ALL the loops, and
  // the PRE-CUT geometry object reference. If the user undoes the cut, scene
  // history restores that exact geometry reference (cloneLoadedModel keeps
  // geometry by reference), so when we see the active model's geometry revert to
  // it we restore the loops — letting the user tweak and re-cut instead of
  // starting over. Cleared once consumed or superseded.
  const undoRestoreRef = React.useRef<{
    modelId: string;
    geometry: THREE.BufferGeometry;
    loops: SessionLoop[];
    activeIndex: number;
  } | null>(null);

  // Redo stack for waypoint undo (Ctrl+Z / Ctrl+Shift+Z). Holds points popped by
  // undo so they can be re-added; cleared whenever a NEW point is placed (standard
  // undo/redo semantics). State (not a ref) so the panel/hotkey gates re-render.
  // Per the ACTIVE loop — switching loops clears it (a switch is not an edit).
  const [redoStack, setRedoStack] = React.useState<OrganicCutLoopPoint[]>([]);
  // The latest on-surface geodesic polyline, so a contour cut sends the DENSE
  // surface-following loop (not just the sparse waypoints) to the membrane.
  const geodesicPolylineRef = React.useRef(geodesicPolyline);
  React.useEffect(() => { geodesicPolylineRef.current = geodesicPolyline; }, [geodesicPolyline]);

  // Mutate the ACTIVE loop's points. `updater` gets the current active points and
  // returns the next set; returning the same reference is a no-op. The slot's
  // cached polyline is preserved (the geodesic effect refreshes it).
  const setActiveLoopPoints = React.useCallback(
    (updater: (prev: OrganicCutLoopPoint[]) => OrganicCutLoopPoint[]) => {
      setLoops((prev) => {
        const idx = activeLoopIndexRef.current;
        if (idx < 0 || idx >= prev.length) return prev;
        const cur = prev[idx];
        const nextPoints = updater(cur.points);
        if (nextPoints === cur.points) return prev;
        const next = prev.slice();
        next[idx] = { points: nextPoints, polyline: cur.polyline, key: cur.key };
        return next;
      });
    },
    [],
  );

  // Panel state setter exposed to the UI. Besides updating `panelState`, it mirrors
  // the panel's key fields into the ACTIVE loop, so each loop keeps its OWN key
  // settings. The panel + gizmo stay bound to `panelState` (no change there); this
  // wrapper is what makes those edits land on the active loop. Non-key panel
  // changes (thickness, smoothing, …) leave the loops untouched (keysEqual guard).
  const handleSetPanelState = React.useCallback((next: OrganicCutPanelState) => {
    setPanelState(next);
    const key = extractKey(next);
    setLoops((prev) => {
      const idx = activeLoopIndexRef.current;
      if (idx < 0 || idx >= prev.length) return prev;
      if (keysEqual(prev[idx].key, key)) return prev;
      const nextLoops = prev.slice();
      nextLoops[idx] = { ...nextLoops[idx], key };
      return nextLoops;
    });
  }, []);

  // When the tool is deactivated, stash the current loops under their model so
  // they can be restored on re-entry, then clear the live view. We DON'T drop the
  // saved copy — re-entering the tool (or reselecting the model) brings it back.
  React.useEffect(() => {
    if (!toolActive) {
      const key = activeGeometryKeyRef.current;
      const current = loopsRef.current;
      if (key && current.some((l) => l.points.length > 0)) {
        savedLoopsRef.current.set(key, { loops: current, activeIndex: activeLoopIndexRef.current });
      }
      // Reset to one empty loop carrying the current panel key, so panelState and
      // the (now sole) active loop's key stay consistent.
      setLoops([emptyLoop(extractKey(panelStateRef.current))]);
      setActiveLoopIndex(0);
      setStatus('idle');
      setLastResult(null);
      setSelectedIndex(null);
    }
  }, [toolActive]);

  // On model change: stash the OUTGOING model's loops, then restore the INCOMING
  // model's saved loops (if any). Clicking away sets the key to null and stashes;
  // reselecting restores. Switching to a different model loads ITS path, not a
  // bleed-over from the previous one.
  const prevGeometryKeyRef = React.useRef<string | null>(activeGeometryKey);
  React.useEffect(() => {
    const prevKey = prevGeometryKeyRef.current;
    // Stash the loops we're leaving (read the live value via ref).
    if (prevKey && prevKey !== activeGeometryKey) {
      const leaving = loopsRef.current;
      if (leaving.some((l) => l.points.length > 0)) {
        savedLoopsRef.current.set(prevKey, { loops: leaving, activeIndex: activeLoopIndexRef.current });
      }
    }
    prevGeometryKeyRef.current = activeGeometryKey;

    // Restore the incoming model's saved loops, or start with one empty loop
    // carrying the current panel key.
    const restored = activeGeometryKey ? savedLoopsRef.current.get(activeGeometryKey) : undefined;
    const restoredLoops = restored?.loops ?? [emptyLoop(extractKey(panelStateRef.current))];
    const nextActive = restored ? Math.min(restored.activeIndex, restoredLoops.length - 1) : 0;
    setLoops(restoredLoops);
    setActiveLoopIndex(nextActive);
    // Sync the panel's key editor to the now-active loop's key.
    setPanelState((ps) => withKey(ps, restoredLoops[nextActive]?.key ?? DEFAULT_LOOP_KEY));
    setStatus(restoredLoops.some((l) => l.points.length > 0) ? 'drawing' : 'idle');
    setLastResult(null);
    setGeodesicPolyline(null);
    // Redo history + selection don't carry across models.
    setRedoStack([]);
    setSelectedIndex(null);
  }, [activeGeometryKey]);

  // Undo-restore: when the active model's geometry REVERTS to the exact pre-cut
  // reference we stashed at cut time (scene-history undo restores geometry by
  // reference), bring the loops/membrane back so the user can tweak and re-cut.
  // Keyed on the geometry REFERENCE (not the id) because a cut+undo keeps the
  // same model id — only the geometry object changes.
  React.useEffect(() => {
    if (!toolActive) return;
    const pending = undoRestoreRef.current;
    if (!pending) return;
    if (
      activeGeometryKey === pending.modelId &&
      activeGeometry === pending.geometry &&
      pending.loops.some((l) => l.points.length > 0)
    ) {
      // Geometry reverted to the pre-cut state → restore the loops. Consume the
      // entry so a later unrelated geometry change doesn't re-trigger it.
      undoRestoreRef.current = null;
      savedLoopsRef.current.set(pending.modelId, { loops: pending.loops, activeIndex: pending.activeIndex });
      const nextActive = Math.min(pending.activeIndex, pending.loops.length - 1);
      setLoops(pending.loops);
      setActiveLoopIndex(nextActive);
      setPanelState((ps) => withKey(ps, pending.loops[nextActive]?.key ?? DEFAULT_LOOP_KEY));
      setStatus('drawing');
      setSelectedIndex(null);
      setRedoStack([]);
    }
  }, [toolActive, activeGeometry, activeGeometryKey]);

  // Recompute the surface-following loop whenever the active loop's points change.
  // Stages the source mesh (cheap no-op if already staged for this geometry) then
  // asks Rust for the on-surface polyline, caching it into the active loop slot.
  // Cancelled if points change again mid-flight.
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
      if (cancelled) return;
      setGeodesicPolyline(poly);
      // Cache the dense seam into the active loop slot — for rendering this loop
      // once it's inactive, and for the cut. Keeps the active points reference
      // intact (spread copy), so this doesn't re-fire the effect.
      if (poly) {
        const idx = activeLoopIndexRef.current;
        setLoops((prev) => {
          if (idx < 0 || idx >= prev.length) return prev;
          const next = prev.slice();
          next[idx] = { ...next[idx], polyline: poly };
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toolActive, loop, activeGeometry, activeGeometryKey, panelState.smoothing]);

  // Membrane preview (contour mode) for the ACTIVE loop. The membrane build is the
  // heavy Rust round-trip, so it is SUPPRESSED while a waypoint is being dragged
  // and rebuilt once the user drops it (isDraggingPoint flips false) — the drop
  // then costs a single build, not a backlog. It reads the already-computed
  // geodesic from state (the same dense loop the cut uses) and renders translucent
  // in the tool.
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
        setKeyFrame(null);
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
        // The key SOUP is built STRAIGHT (tilt = 0): the live tilt is applied as a
        // client-side rigid rotation of the key mesh (OrganicCutTool), so dragging
        // the aim gizmo never triggers this heavy Rust round-trip. Hence tilt is NOT
        // passed here and NOT in the deps below — only width/depth/shape/etc. rebuild
        // the soup. (The real cut still bakes the tilt in Rust via apply_key.)
        const result = await computeMembranePreview(
          previewLoop,
          panelState.membraneSmoothing,
          panelState.density,
          panelState.thicknessMm,
          panelState.generateKey,
          panelState.keyWidthMm,
          panelState.keyDepthMm,
          panelState.keyShape,
          panelState.keyFilletMm,
          panelState.keySwapSides,
          0,
          0,
          0,
        );
        if (cancelled) return;
        setMembranePreview(result.membrane);
        setKeyPreview(result.keyPreview);
        setKeyKind(result.keyKind);
        setKeyDetail(result.keyDetail);
        setKeyFrame(result.keyFrame);
      })();
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // NOTE: keyTilt/azimuth/roll are intentionally NOT deps — tilt is applied live
    // on the client (see OrganicCutTool's keyTiltMatrix), so changing it must NOT
    // rebuild the soup. Keeping them out is what makes the aim gizmo smooth.
  }, [toolActive, loop, activeGeometry, activeGeometryKey, cutMode, geodesicPolyline, isDraggingPoint, panelState.membraneSmoothing, panelState.density, panelState.thicknessMm, panelState.generateKey, panelState.keyWidthMm, panelState.keyDepthMm, panelState.keyShape, panelState.keyFilletMm, panelState.keySwapSides]);

  const addPoint = React.useCallback((point: OrganicCutLoopPoint) => {
    setActiveLoopPoints((prev) => [...prev, point]);
    setStatus('drawing');
    // A freshly placed point invalidates any redo history.
    setRedoStack([]);
  }, [setActiveLoopPoints]);

  const insertPoint = React.useCallback((afterIndex: number, point: OrganicCutLoopPoint) => {
    setActiveLoopPoints((prev) => {
      // Insert AFTER afterIndex → at array position afterIndex+1. Clamp so a bad
      // index can't throw; a negative index prepends, an over-large one appends.
      const at = Math.max(0, Math.min(prev.length, afterIndex + 1));
      const next = prev.slice();
      next.splice(at, 0, point);
      return next;
    });
    setStatus('drawing');
    setRedoStack([]);
  }, [setActiveLoopPoints]);

  const selectPoint = React.useCallback((index: number | null) => {
    setSelectedIndex(index);
  }, []);

  const removePoint = React.useCallback((index: number) => {
    setActiveLoopPoints((prev) => {
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
  }, [setActiveLoopPoints]);

  const undoPoint = React.useCallback(() => {
    setActiveLoopPoints((prev) => {
      if (prev.length === 0) return prev;
      const removed = prev[prev.length - 1];
      // Push to the redo stack from inside the updater (it runs at commit time, not
      // synchronously) so the popped point is captured reliably.
      setRedoStack((r) => [...r, removed]);
      const next = prev.slice(0, -1);
      setStatus(next.length > 0 ? 'drawing' : 'idle');
      // Clear selection if it pointed at (or past) the removed last point.
      setSelectedIndex((sel) => (sel !== null && sel >= next.length ? null : sel));
      return next;
    });
  }, [setActiveLoopPoints]);

  const redoPoint = React.useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const restored = r[r.length - 1];
      setActiveLoopPoints((prev) => [...prev, restored]);
      setStatus('drawing');
      return r.slice(0, -1);
    });
  }, [setActiveLoopPoints]);

  const updatePoint = React.useCallback((index: number, point: OrganicCutLoopPoint) => {
    setActiveLoopPoints((prev) => {
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
  }, [setActiveLoopPoints]);

  const clearLoop = React.useCallback(() => {
    // Clear truly clears — also drop the persisted copy so it doesn't spring back
    // on deselect/reselect, and discard ALL loops (multi-loop included).
    const key = activeGeometryKeyRef.current;
    if (key) savedLoopsRef.current.delete(key);
    // Keep the panel's current key on the fresh loop (don't reset the user's prefs).
    setLoops([emptyLoop(extractKey(panelStateRef.current))]);
    setActiveLoopIndex(0);
    setStatus('idle');
    setLastResult(null);
    setRedoStack([]);
    setSelectedIndex(null);
    setGeodesicPolyline(null);
  }, []);

  // Switch the active (editable) loop. The geodesic + membrane effects recompute
  // for the new active loop; we show its cached seam immediately for snappiness,
  // and load that loop's key into the panel editor so the key controls follow it.
  const selectLoop = React.useCallback((index: number) => {
    const all = loopsRef.current;
    if (index < 0 || index >= all.length) return;
    setActiveLoopIndex(index);
    setSelectedIndex(null);
    setRedoStack([]);
    setGeodesicPolyline(all[index].polyline ?? null);
    setPanelState((ps) => withKey(ps, all[index].key));
    setStatus(all[index].points.length > 0 ? 'drawing' : 'idle');
  }, []);

  // Append a fresh empty loop and make it active (multi-loop cut). The new loop
  // inherits the current loop's key as a starting point (the panel already shows
  // it, so no panel change needed). On Apply, every loop's cutter is union'd
  // together. Gated by `canAddLoop` so we don't stack empty loops; a stray empty
  // loop is pruned at cut time regardless.
  const addLoop = React.useCallback(() => {
    const all = loopsRef.current;
    const newIndex = all.length; // index of the appended loop
    const inheritKey = all[activeLoopIndexRef.current]?.key ?? extractKey(panelStateRef.current);
    setLoops((prev) => [...prev, emptyLoop(inheritKey)]);
    setActiveLoopIndex(newIndex);
    setSelectedIndex(null);
    setRedoStack([]);
    setGeodesicPolyline(null);
    setMembranePreview(null);
    setKeyPreview(null);
    setKeyKind('none');
    setKeyDetail('');
    setKeyFrame(null);
    setStatus('drawing');
  }, []);

  // Remove a loop. Never removes the last remaining one (Clear does that). The
  // active index is fixed up so it keeps pointing at a valid loop.
  const removeLoop = React.useCallback((index: number) => {
    const before = loopsRef.current;
    if (before.length <= 1 || index < 0 || index >= before.length) return;
    setLoops((prev) => {
      if (prev.length <= 1 || index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next.splice(index, 1);
      return next;
    });
    const lastIndexAfter = before.length - 2; // length-1 (removed) - 1
    const curActive = activeLoopIndexRef.current;
    const newActive =
      index < curActive
        ? curActive - 1
        : index === curActive
          ? Math.max(0, Math.min(curActive, lastIndexAfter))
          : curActive;
    setActiveLoopIndex(newActive);
    // Load the new active loop's key into the panel editor (compute from the
    // pre-removal snapshot minus the removed loop).
    const remaining = before.filter((_, i) => i !== index);
    setPanelState((ps) => withKey(ps, remaining[newActive]?.key ?? DEFAULT_LOOP_KEY));
    setSelectedIndex(null);
    setRedoStack([]);
    setGeodesicPolyline(null);
  }, []);

  const closeLoop = React.useCallback(() => {
    setActiveLoopPoints((prev) => {
      if (prev.length < MIN_LOOP_POINTS) return prev;
      setStatus('closed');
      return prev;
    });
  }, [setActiveLoopPoints]);

  const apply = React.useCallback(() => {
    // Read everything from refs so this callback is STABLE and never stale.
    const allLoopsState = loopsRef.current;
    const activeIdx = activeLoopIndexRef.current;
    const currentLoop = loopRef.current;
    const geom = activeGeometryRef.current;
    const geomKey = activeGeometryKeyRef.current;
    const ps = panelStateRef.current;
    const isContour = ps.cutMode === 'contour';
    const minPoints = isContour ? MIN_CONTOUR_POINTS : MIN_LOOP_POINTS;
    // Contour cuts every loop with enough points; flat is always single-loop (the
    // active one). Bail if there's nothing real to cut.
    const contourReady = isContour ? allLoopsState.filter((l) => loopCutPoints(l) !== null).length : 0;
    if (isContour ? contourReady === 0 : currentLoop.length < minPoints) return;
    if (!geom || !geomKey) return;
    const loopSnapshot = currentLoop.slice();
    // Snapshot all loops (for the undo-restore after a successful cut).
    const loopsSnapshot: SessionLoop[] = allLoopsState.map((l) => ({
      points: l.points.slice(),
      polyline: l.polyline,
      key: l.key,
    }));
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

        // Contour: send each loop's DENSE on-surface geodesic so the membrane
        // traces the real surface crossing (sparse waypoints alone wouldn't sever
        // the body). The ACTIVE loop prefers the freshest live geodesic; the others
        // use their cached seam (falling back to waypoints). The first loop becomes
        // `loopPoints`; the rest go in `extraLoops` (Rust union's a cutter each).
        // Flat: send the waypoints + the exact plane the preview showed.
        let cutSpec;
        if (isContour) {
          // Each kept loop carries its OWN key, kept aligned with its points so the
          // backend places per-loop keys (loopKeys[i] ↔ the i-th loop).
          const kept: { points: OrganicCutLoopPoint[]; key: LoopKeySettings }[] = [];
          allLoopsState.forEach((l, i) => {
            let pts: OrganicCutLoopPoint[] | null = null;
            if (i === activeIdx && geodesic && geodesic.length >= MIN_CONTOUR_POINTS * 3) {
              pts = geodesicPolylineToLoopPoints(geodesic);
            } else {
              pts = loopCutPoints(l);
            }
            if (pts) kept.push({ points: pts, key: l.key });
          });
          if (kept.length === 0) return; // nothing to cut
          const allLoops = kept.map((k) => k.points);
          cutSpec = {
            loopPoints: allLoops[0],
            extraLoops: allLoops.length > 1 ? allLoops.slice(1) : undefined,
            // Per-loop key settings, aligned with the loops above (loopPoints +
            // extraLoops). The backend keys each seam with its own peg/socket.
            loopKeys: kept.map((k) => keyToSpec(k.key)),
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
            // When on, the cut builds a registration key (peg union'd onto one
            // half, socket carved from the other) at EVERY loop's seam — one key
            // per cut. The preview shows the active loop's key; the others use the
            // same width/depth/shape/tilt. A key too thin to fit at one seam is
            // skipped there without affecting the rest.
            generateKey: ps.generateKey,
            keyWidthMm: ps.keyWidthMm,
            keyDepthMm: ps.keyDepthMm,
            keyShape: ps.keyShape,
            keyFilletMm: ps.keyFilletMm,
            keySwapSides: ps.keySwapSides,
            // Aim/roll: the base-glued lean + spin set by the in-viewport gizmo. The
            // preview already showed exactly this key (same angles, same shear).
            keyTiltRad: ps.keyTiltRad,
            keyTiltAzimuthRad: ps.keyTiltAzimuthRad,
            keyRollRad: ps.keyRollRad,
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

        // Commit every part to the scene (replace the active model with the first,
        // add the rest as new models — a multi-loop cut can free several pieces). If
        // the engine fell back to a no-op (degenerate loop / manifold rejected the
        // mesh) there are no parts, so don't mutate the scene.
        const committed =
          result.report.engine !== 'noop' && result.parts.length > 0 && commitPartsRef.current
            ? commitPartsRef.current(result.parts.map((p) => partToGeometry(p)))
            : false;

        // Flat string (not an object) so the Tauri log forwarder shows every
        // field inline instead of collapsing it to "Object".
        // eslint-disable-next-line no-console
        console.info(
          `[organicCut] cut applied | engine=${result.report.engine}` +
          ` committed=${committed}` +
          ` parts=${result.parts.length}` +
          ` detail="${result.report.detail ?? ''}"` +
          ` keyKind=${result.report.keyKind ?? 'n/a'}` +
          ` keyDetail="${result.report.keyDetail ?? ''}"` +
          ` source=${result.report.sourceTriangleCount}` +
          ` partA=${result.report.partATriangleCount}` +
          ` partB=${result.report.partBTriangleCount}`,
        );

        if (committed && !cancelled) {
          // Clear the loops after a successful cut so the tool is ready for the
          // next one and stale points don't linger on the (now replaced) model.
          // Remember the loops + the PRE-CUT geometry reference so that an UNDO
          // (which restores that exact geometry) brings the membrane/loops back.
          if (geomKey && geom) {
            undoRestoreRef.current = {
              modelId: geomKey,
              geometry: geom,
              loops: loopsSnapshot,
              activeIndex: activeIdx,
            };
          }
          // Reset to one empty loop carrying the current panel key.
          setLoops([emptyLoop(extractKey(panelStateRef.current))]);
          setActiveLoopIndex(0);
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
  const isContourMode = panelState.cutMode === 'contour';
  const activeLoopReady = pointCount >= MIN_CONTOUR_POINTS;
  const loopCount = loops.length;
  const loopSummaries = React.useMemo(
    () => loops.map((l, i) => ({ index: i, pointCount: l.points.length, hasKey: l.key.generateKey })),
    [loops],
  );
  // How many loops are real loops (would actually cut), for the Cut gate.
  const readyContourLoops = loops.filter((l) => l.points.length >= MIN_CONTOUR_POINTS).length;
  // Can cut: contour needs ≥1 real loop; flat needs 2 points.
  const canApply =
    !isApplying &&
    (isContourMode ? readyContourLoops >= 1 : pointCount >= minPointsForMode);
  // Can add a loop: contour mode with the active loop already a real loop.
  const canAddLoop = isContourMode && activeLoopReady && !isApplying;
  const canRemoveLoop = loops.length > 1 && !isApplying;
  const canUndoPoint = pointCount > 0;
  const canRedoPoint = redoStack.length > 0;

  return {
    panelState,
    setPanelState: handleSetPanelState,
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
    loopCount,
    activeLoopIndex,
    loopSummaries,
    selectLoop,
    addLoop,
    canAddLoop,
    removeLoop,
    canRemoveLoop,
    inactiveLoopPolylines,
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
    keyFrame,
  };
}
