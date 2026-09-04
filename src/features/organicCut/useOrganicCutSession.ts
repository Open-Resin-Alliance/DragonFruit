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
import type { TenonPreviewFrame, OrganicCutLoopPoint, OrganicCutResult } from './types';
import type { OrganicCutPanelState } from './OrganicCutPanel';
import {
  computeGeodesicLoop,
  computeMembranePreview,
  computePlaneTenonPreview,
  cutFromCapturedSource,
  isCutSourceStaged,
  partToGeometry,
  stageCutSource,
} from './meshOrganicCut';
import type { TenonPreviewKind, MembranePreviewResult } from './meshOrganicCut';
import { cutPlaneFromPoints } from './cutPlane';
import { snapPointsToFeatureEdges } from './snapToEdges';
import { planeMeshIntersection, type PlaneMeshCurve } from './planeMeshIntersection';
import { createTypedHistory } from '@/history/typedHistory';
import {
  ORGANIC_CUT_EDIT,
  type OrganicCutHistoryPayloadMap,
  type OrganicCutLoopSnapshot,
} from './history/actionTypes';
import type * as THREE from 'three';

const organicCutHistory = createTypedHistory<OrganicCutHistoryPayloadMap>();

/**
 * Consecutive edits of the SAME kind within this window collapse into one undo
 * step. A number field steps once per wheel notch and the aim gizmo fires per
 * frame, so without this a few seconds of tweaking buries the stack under
 * hundreds of entries and undo crawls back one notch at a time.
 */
const EDIT_COALESCE_WINDOW_MS = 500;

/** Drop the derived polyline: it is recomputed from the points on restore. */
function toSnapshot(loops: SessionLoop[]): OrganicCutLoopSnapshot[] {
  return loops.map((l) => ({ points: l.points.slice(), tenon: { ...l.tenon } }));
}

/** Rebuild session loops from a snapshot; the seam recomputes from the points. */
function fromSnapshot(snapshot: OrganicCutLoopSnapshot[]): SessionLoop[] {
  return snapshot.map((l) => ({ points: l.points.slice(), polyline: null, tenon: { ...l.tenon } }));
}

/** Value-equality of two loop sets, to skip pushing a no-op edit. */
function loopsEqual(a: SessionLoop[], b: SessionLoop[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((l, i) => l.points === b[i].points && tenonsEqual(l.tenon, b[i].tenon));
}

/** Minimum points before a cut is possible. 2 = the simplest flat plane cut. */
const MIN_LOOP_POINTS = 2;

/**
 * Per-loop registration-tenon settings — a multi-loop cut tenons each loop
 * independently. Mirrors the tenon fields of OrganicCutPanelState: the panel's tenon
 * controls edit the ACTIVE loop's copy through `panelState`, which is kept in sync
 * with the active loop (the panel/gizmo stay bound to `panelState` as before).
 */
export type LoopTenonSettings = Pick<
  OrganicCutPanelState,
  | 'generateTenon'
  | 'tenonWidthMm'
  | 'tenonDepthMm'
  | 'tenonShape'
  | 'tenonFilletMm'
  | 'tenonToleranceMm'
  | 'tenonAnchor'
  | 'tenonUniformScale'
  | 'tenonSwapSides'
  | 'tenonTiltRad'
  | 'tenonRollRad'
>;

/**
 * The cut-wide settings — everything that shapes the cut but isn't per-loop and
 * isn't per-tenon. Undo covers these too: changing the kerf is as much an edit as
 * moving a waypoint.
 */
export type CutSettings = Pick<
  OrganicCutPanelState,
  'cutMode' | 'jointClearanceMm' | 'smoothing' | 'membraneSmoothing' | 'density'
>;

/** Pull the cut-wide settings out of the panel state. */
function extractSettings(ps: OrganicCutPanelState): CutSettings {
  return {
    cutMode: ps.cutMode,
    jointClearanceMm: ps.jointClearanceMm,
    smoothing: ps.smoothing,
    membraneSmoothing: ps.membraneSmoothing,
    density: ps.density,
  };
}

/** Value-equality of two cut-setting sets (to skip no-op history churn). */
function settingsEqual(a: CutSettings, b: CutSettings): boolean {
  return (
    a.cutMode === b.cutMode &&
    a.jointClearanceMm === b.jointClearanceMm &&
    a.smoothing === b.smoothing &&
    a.membraneSmoothing === b.membraneSmoothing &&
    a.density === b.density
  );
}

/** Pull the tenon fields out of the panel state. */
function extractTenon(ps: OrganicCutPanelState): LoopTenonSettings {
  return {
    generateTenon: ps.generateTenon,
    tenonWidthMm: ps.tenonWidthMm,
    tenonDepthMm: ps.tenonDepthMm,
    tenonShape: ps.tenonShape,
    tenonFilletMm: ps.tenonFilletMm,
    tenonToleranceMm: ps.tenonToleranceMm,
    tenonAnchor: ps.tenonAnchor,
    tenonUniformScale: ps.tenonUniformScale,
    tenonSwapSides: ps.tenonSwapSides,
    tenonTiltRad: ps.tenonTiltRad,
    tenonRollRad: ps.tenonRollRad,
  };
}

/** Overlay a loop's tenon settings onto the panel state (the editor buffer). */
function withTenon(ps: OrganicCutPanelState, tenon: LoopTenonSettings): OrganicCutPanelState {
  return { ...ps, ...tenon };
}

/**
 * A reason from the engine, as a sentence. The engine's strings are written for a
 * person, but this is the last stop before the screen and a stray lowercase start
 * or missing full stop is exactly the sort of thing that survives a refactor.
 */
function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const capitalised = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** Value-equality of two anchors — a place on the cut face, or "wherever is natural". */
function sameAnchor(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Value-equality of two tenon settings (to skip no-op state churn). */
function tenonsEqual(a: LoopTenonSettings, b: LoopTenonSettings): boolean {
  return (
    a.generateTenon === b.generateTenon &&
    a.tenonWidthMm === b.tenonWidthMm &&
    a.tenonDepthMm === b.tenonDepthMm &&
    a.tenonShape === b.tenonShape &&
    a.tenonFilletMm === b.tenonFilletMm &&
    a.tenonToleranceMm === b.tenonToleranceMm &&
    sameAnchor(a.tenonAnchor, b.tenonAnchor) &&
    a.tenonUniformScale === b.tenonUniformScale &&
    a.tenonSwapSides === b.tenonSwapSides &&
    a.tenonTiltRad === b.tenonTiltRad &&
    a.tenonRollRad === b.tenonRollRad
  );
}

/** Wire form of a loop's tenon for the Rust `loopTenons` array (drops UI-only fields). */
function tenonToSpec(k: LoopTenonSettings) {
  return {
    generateTenon: k.generateTenon,
    tenonWidthMm: k.tenonWidthMm,
    tenonDepthMm: k.tenonDepthMm,
    tenonShape: k.tenonShape,
    tenonFilletMm: k.tenonFilletMm,
    tenonToleranceMm: k.tenonToleranceMm,
    tenonAnchor: k.tenonAnchor,
    tenonSwapSides: k.tenonSwapSides,
    tenonTiltRad: k.tenonTiltRad,
    tenonRollRad: k.tenonRollRad,
  };
}

/**
 * One loop in a (possibly multi-loop) cut. `points` are the editable user
 * waypoints; `polyline` is the cached DENSE on-surface geodesic for that loop —
 * kept so an INACTIVE loop can still render its seam, and so the cut traces the
 * real surface. `tenon` is this loop's own registration-tenon settings. The active
 * loop's polyline is refreshed live by the geodesic effect; an edit leaves the
 * stale polyline in place until that recompute lands.
 */
interface SessionLoop {
  points: OrganicCutLoopPoint[];
  polyline: Float32Array | null;
  tenon: LoopTenonSettings;
}

/** A fresh empty loop slot carrying the given tenon settings. */
function emptyLoop(tenon: LoopTenonSettings): SessionLoop {
  return { points: [], polyline: null, tenon };
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

/**
 * Does this session loop contribute a seam to a contour cut? Enough waypoints is
 * enough to be cuttable — the DENSE seam is fetched or recomputed when the cut is
 * applied. What the waypoints cannot do is stand in FOR the seam: a membrane spanned
 * over four of them is a flat quad nowhere near the surface they were drawn on.
 */
function loopIsCuttable(l: SessionLoop): boolean {
  return (l.polyline?.length ?? 0) >= MIN_CONTOUR_POINTS * 3 || l.points.length >= MIN_CONTOUR_POINTS;
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
   * True while the drag above is the TENON's own — its base handle or one of its
   * rings — rather than a seam waypoint. The tenon is drawn and moved locally for
   * the whole gesture and Rust is asked once, on release; only a waypoint drag
   * takes the cut face out from under it and makes the drawn tenon a lie.
   */
  isDraggingTenon?: boolean;
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
  /**
   * Nudge every waypoint of the ACTIVE loop onto the model's nearest sharp
   * feature edge (crease or boundary), preferring a corner where several edges
   * meet when the point is near one. For tidying points dropped roughly in a
   * crease or corner onto it exactly. A no-op when the model has no sharp edges
   * or the loop is empty.
   */
  snapActiveLoopToEdges: () => void;
  /** True when snapping is possible: a real geometry + at least one waypoint. */
  canSnapToEdges: boolean;
  /** Remove the waypoint at `index` (Delete key / right-click Delete). */
  removePoint: (index: number) => void;
  /**
   * Toggle the "locked" (pinned) flag of the waypoint at `index`. A locked point
   * is skipped by Snap to Edges — pin one that sits where it's needed so snap
   * can't drag it onto a nearby edge/corner. Double-click a marker to call this.
   */
  toggleLockPoint: (index: number) => void;
  /** The currently selected waypoint index, or null. Click a marker to select. */
  selectedIndex: number | null;
  /** Select a waypoint (or null to clear). Click a marker → select it. */
  selectPoint: (index: number | null) => void;
  /** Re-add the last undone waypoint (Ctrl+Shift+Z / Ctrl+Y). No-op if none. */
  /** True when there is a waypoint to undo (for hotkey gating). */
  /** True when there is an undone waypoint to redo. */
  clearLoop: () => void;
  // --- Multi-loop -----------------------------------------------------------
  /** Total loops in this cut (contour). 1 = the classic single-loop cut. */
  loopCount: number;
  /** Index of the loop currently being edited (gets markers + membrane preview). */
  activeLoopIndex: number;
  /** Per-loop summaries for the panel's loop chips (index + waypoint count). */
  loopSummaries: { index: number; pointCount: number }[];
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
  /**
   * Why the last cut refused, for the panel to show. Null when the last cut worked
   * (or none has run). A refused cut used to say so only on stderr — the user saw
   * the button do nothing, or worse, saw a fallback cut they never asked for.
   */
  cutError: string | null;
  /** Where the refused cut went wrong, model-local, for the viewport to mark. */
  cutLeakPoints: [number, number, number][];
  // Derived gates for the panel
  canApply: boolean;
  /**
   * Surface-following loop polyline (flat xyz, model-local space) computed by the
   * Rust geodesic engine, for rendering the seam ON the surface instead of as
   * straight chords. Null until ≥2 points / outside Tauri.
   */
  geodesicPolyline: Float32Array | null;
  /**
   * PLANE mode seam: every curve where the cutting plane meets the mesh (flat
   * xyz, model-local). This IS the seam a flat cut produces, so it replaces the
   * geodesic in that mode. Several curves when the plane crosses several bodies.
   * Null in contour mode.
   */
  planeCurves: PlaneMeshCurve[] | null;
  /**
   * Contour-cut membrane preview (flat triangle soup, model-local). The exact
   * curved cutter surface the contour cut will use. Null unless in contour mode
   * with ≥3 points / outside Tauri.
   */
  membranePreview: Float32Array | null;
  /**
   * Registration-tenon preview (tenon triangle soup, model-local) — the
   * exact tenon the cut will place. Null unless generateTenon is on with a fitting
   * tenon. Render alongside the membrane.
   */
  tenonPreview: Float32Array | null;
  /**
   * How many of `tenonPreview`'s triangles are the tenon — the soup is the tenon
   * followed by the mortise, and the tool splits it here to colour them apart.
   */
  tenonTriangleCount: number;
  /** Which tenon the preview placed: 'frustum', 'dome' (fallback), or 'none'. */
  tenonKind: TenonPreviewKind;
  /**
   * Whether the previewed tenon fits where it sits. False draws it in the won't-fit
   * colour and blocks the cut — the cut would refuse it in Rust anyway, and finding
   * that out after committing is no way to learn it.
   */
  tenonFits: boolean;
  /** Reason the tenon shrank / fell back / was skipped (for the panel alert). */
  tenonDetail: string;
  /**
   * Placement frame of the previewed tenon (model-local), for the in-viewport aim+
   * roll gizmo. Null when no tenon was placed. Drives where the tip/roll handles sit.
   */
  tenonFrame: TenonPreviewFrame | null;
  /** The tenon offset (mm along u/v) the current preview soup was built with. */
}

const DEFAULT_PANEL_STATE: OrganicCutPanelState = {
  cutMode: 'contour',
  // Zero: the surface cut's two halves share their cut face, so nothing is removed
  // and there is nothing to make up for. Slack is the user's to ask for.
  // the slider was wired up) — the proven-good out-of-box thickness.
  jointClearanceMm: 0.0,
  // Default to full smoothing (1) on both the seam line and the cut surface —
  // the smoothest out-of-box result. The sliders go to 2 for extra rounding.
  smoothing: 1.0,
  membraneSmoothing: 1.0,
  // 4× = densest cutter + finest seam-band model refinement by default, for the
  // cleanest cut edge out of the box.
  density: 4.0,
  // Registration tenon off by default — the user opts in per cut.
  generateTenon: false,
  // Default tenon size (mm) — model units are mm. Width 2 → length auto = 2.5mm
  // (1.25× ratio); depth 2.5mm. The user tunes these live.
  tenonWidthMm: 2.0,
  tenonDepthMm: 2.5,
  // Default tenon shape — the rotation-locking tapered frustum.
  tenonShape: 'frustum',
  // Edge fillet 0.2mm by default (lightly rounded corners + tip); user tunes live.
  tenonFilletMm: 0.2,
  // Tenon/mortise fit tolerance: the mortise is carved this much larger than the tenon
  // on every face. 0.1mm is a print-scale slide fit; 0 is a press fit.
  tenonToleranceMm: 0.1,
  // Tenon centred on the cut by default; the blue base handle slides it.
  tenonAnchor: null,
  // Dome Uniform Scale on by default — width/depth move together (round dome)
  // until the user unlocks it for an oblong shape.
  tenonUniformScale: true,
  // Tenon on the +normal side (part A) by default; the Flip button swaps it.
  tenonSwapSides: false,
  // Tenon points straight out of the cut by default; the in-viewport aim gizmo
  // (drag the tip) leans it, the roll ring spins it. All measured in radians.
  tenonTiltRad: 0,
  tenonRollRad: 0,
  // Cut-plan preview on by default — the user sees where the cut lands; the eye
  // button in the panel header hides it for an unobscured view while drawing.
  showPreview: true,
};

/** Minimum points before a CONTOUR cut is possible (a real loop needs ≥3). */
const MIN_CONTOUR_POINTS = 3;

/**
 * How long the cut preview waits before asking Rust to rebuild (ms).
 *
 * Long enough for a just-finished drag's debounced geodesic to land, so the
 * membrane is built from the final seam instead of a stale one and doesn't
 * rebuild twice in a row.
 */
const PREVIEW_SETTLE_MS = 80;

/**
 * How many settled cut-preview results to keep around. The preview is a heavy Rust
 * round-trip, so revisiting the same loop/model (switch A → B → back to A) should
 * hit this cache instead of rebuilding. Bounded because the inputs (loop, geodesic,
 * settings) can vary a lot across a session; old entries just fall out FIFO.
 */
const PREVIEW_CACHE_MAX = 8;

/** Default per-loop tenon settings — the panel defaults, used for fresh loops. */
const DEFAULT_LOOP_TENON: LoopTenonSettings = extractTenon(DEFAULT_PANEL_STATE);

/** The tenon's factory settings, so the panel's Reset doesn't restate them. */
export const DEFAULT_TENON_SETTINGS: LoopTenonSettings = DEFAULT_LOOP_TENON;

/** The cut's factory settings (mode, kerf, smoothing, resolution) — same idea. */
export const DEFAULT_CUT_SETTINGS: CutSettings = extractSettings(DEFAULT_PANEL_STATE);

export function useOrganicCutSession({
  toolActive,
  activeGeometry,
  activeGeometryKey,
  isDraggingPoint = false,
  isDraggingTenon = false,
  commitParts,
}: UseOrganicCutSessionArgs): OrganicCutSession {
  const [panelState, setPanelState] = React.useState<OrganicCutPanelState>(DEFAULT_PANEL_STATE);
  // All loops of the current cut, plus which one is active (editable). The active
  // loop gets the full waypoint UI + membrane preview; the rest render as dimmed
  // seams the user can switch to and edit. There is always ≥1 loop.
  const [loops, setLoops] = React.useState<SessionLoop[]>([emptyLoop(DEFAULT_LOOP_TENON)]);
  const [activeLoopIndex, setActiveLoopIndex] = React.useState(0);
  const [isApplying, setIsApplying] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<OrganicCutResult | null>(null);
  const [cutError, setCutError] = React.useState<string | null>(null);
  // The spots a refused cut points at, drawn in the viewport. Cleared with the error
  // they belong to, so a marker can never outlive its message.
  const [cutLeakPoints, setCutLeakPoints] = React.useState<[number, number, number][]>([]);
  const [geodesicPolyline, setGeodesicPolyline] = React.useState<Float32Array | null>(null);
  // Plane-mode seam: every curve where the cutting plane meets the mesh — the
  // exact seam a flat cut produces. Null in contour mode.
  const [planeCurves, setPlaneCurves] = React.useState<PlaneMeshCurve[] | null>(null);
  // Contour-cut membrane preview (flat triangle soup, model-local). Shows the
  // exact cutter surface so the user sees where the curved cut will land.
  const [membranePreview, setMembranePreview] = React.useState<Float32Array | null>(null);
  // Registration-tenon preview (tenon soup) + the chosen rung and reason, so
  // the scene can render the tenon and the panel can alert on a fallback. Built in
  // the same preview round-trip as the membrane, only when generateTenon is on.
  const [tenonPreview, setTenonPreview] = React.useState<Float32Array | null>(null);
  const [tenonTriangleCount, setTenonTriangleCount] = React.useState(0);
  const [tenonKind, setTenonKind] = React.useState<TenonPreviewKind>('none');
  const [tenonFits, setTenonFits] = React.useState<boolean>(true);
  const [tenonDetail, setTenonDetail] = React.useState<string>('');
  // Placement frame of the previewed tenon (anchor/axis/u/v/tip), for the aim+roll
  // gizmo. Null when no tenon is previewed.
  const [tenonFrame, setTenonFrame] = React.useState<TenonPreviewFrame | null>(null);

  // Settled-preview cache: a bounded map from the exact preview inputs to the
  // result, so re-entering an identical state (switch models/loops and come back)
  // skips the Rust round-trip. The geometry is stored per entry and identity-checked
  // on hit, because the same model id can carry a fresh geometry object after a cut.
  const previewCacheRef = React.useRef<
    Map<string, { geometry: THREE.BufferGeometry; result: MembranePreviewResult }>
  >(new Map());
  const applyPreviewResult = React.useCallback((result: MembranePreviewResult) => {
    setMembranePreview(result.membrane);
    setTenonPreview(result.tenonPreview);
    setTenonTriangleCount(result.tenonTriangleCount);
    setTenonKind(result.tenonKind);
    setTenonFits(result.tenonFits);
    setTenonDetail(result.tenonDetail);
    setTenonFrame(result.tenonFrame);
  }, [setMembranePreview, setTenonPreview, setTenonTriangleCount, setTenonKind, setTenonFits, setTenonDetail, setTenonFrame]);
  const setPreviewCache = React.useCallback((key: string, geometry: THREE.BufferGeometry, result: MembranePreviewResult) => {
    const cache = previewCacheRef.current;
    if (!cache.has(key) && cache.size >= PREVIEW_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { geometry, result });
  }, []);
  /**
   * The tenon offset the CURRENT preview soup was built with. Dragging the base
   * handle is deliberately not round-tripped through Rust (same reason as the aim
   * gizmo), so the view offsets the built tenon by the difference — without this
   * reference the tenon would sit still until the drag ended, which is blind work.
   */
  // Selected waypoint index (click a marker to select; Delete removes it).
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);

  // The active loop's points (the "loop" the rest of the tool edits/renders). A
  // stable reference until that slot's points actually change, so it's safe in
  // effect deps (caching a polyline into the slot keeps this reference intact).
  const loop = (loops[activeLoopIndex] ?? loops[0] ?? emptyLoop(DEFAULT_LOOP_TENON)).points;

  // Mirror loops + active index in refs so the stable `apply` / callbacks read the
  // CURRENT values regardless of any stale memoized closures (this is the fix for
  // "0 points reached the backend" — a stale closure captured an empty loop).
  const loopsRef = React.useRef(loops);
  React.useEffect(() => { loopsRef.current = loops; }, [loops]);
  const activeLoopIndexRef = React.useRef(activeLoopIndex);
  React.useEffect(() => { activeLoopIndexRef.current = activeLoopIndex; }, [activeLoopIndex]);
  const loopRef = React.useRef(loop);
  React.useEffect(() => { loopRef.current = loop; }, [loop]);
  // The cut-wide settings, mirrored for the same reason — and written SYNCHRONOUSLY
  // by the panel setter before it records, since `setPanelState` hasn't landed yet
  // at the moment the entry is pushed.
  const settingsRef = React.useRef<CutSettings>(extractSettings(DEFAULT_PANEL_STATE));

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
  // the in-progress loops instead of losing them. Tenoned by the model id.
  //
  // SESSION-ONLY: this Map dies with the page. Cut paths are NOT written to the
  // scene file — `ModelMeshModifiers` (src/features/mesh-modifiers/types.ts)
  // persists hollowing and hole punches but has no organic-cut field, so a
  // half-drawn seam is lost on save/reload. Persisting it means adding a field
  // there and serializing SessionLoop (points + per-loop tenon settings).
  const savedLoopsRef = React.useRef<Map<string, { loops: SessionLoop[]; activeIndex: number }>>(new Map());

  // Retired seams, by model: ALL the loops a model had, and the exact geometry
  // object they were drawn on. Scene history restores geometry BY REFERENCE
  // (cloneLoadedModel is a shallow clone), so when the active model's geometry
  // turns out to be one of these again — undoing a cut, undoing a repair — those
  // are its seams and they come back, and the user tweaks and re-cuts instead of
  // starting over.
  //
  // A MAP, not one slot: two models can each have a retired seam waiting (cut one
  // piece, select another, cut that too, then undo both), and a single slot lost
  // the first the moment the second was written.
  const undoRestoreRef = React.useRef<
    Map<string, { geometry: THREE.BufferGeometry; loops: SessionLoop[]; activeIndex: number }>
  >(new Map());

  // Redo stack for waypoint undo (Ctrl+Z / Ctrl+Shift+Z). Holds points popped by
  // undo so they can be re-added; cleared whenever a NEW point is placed (standard
  // undo/redo semantics). State (not a ref) so the panel/hotkey gates re-render.
  // Per the ACTIVE loop — switching loops clears it (a switch is not an edit).
  // The latest on-surface geodesic polyline, so a contour cut sends the DENSE
  // surface-following loop (not just the sparse waypoints) to the membrane.
  const geodesicPolylineRef = React.useRef(geodesicPolyline);
  React.useEffect(() => { geodesicPolylineRef.current = geodesicPolyline; }, [geodesicPolyline]);

  // Mutate the ACTIVE loop's points. `updater` gets the current active points and
  // returns the next set; returning the same reference is a no-op. The slot's
  // cached polyline is preserved (the geodesic effect refreshes it).
  // Inverse of every Cut-tool edit. Registered here because page.tsx calls this
  // hook unconditionally, so the handler lives as long as the app does — gating it
  // on the tool being open would make Ctrl+Z silently stop working when it isn't.
  React.useEffect(
    () =>
      organicCutHistory.register(ORGANIC_CUT_EDIT, (payload, direction) => {
        const snapshot = direction === 'undo' ? payload.before : payload.after;
        const wanted = direction === 'undo' ? payload.beforeActive : payload.afterActive;
        const restored = fromSnapshot(snapshot);
        const active = Math.min(Math.max(wanted, 0), Math.max(restored.length - 1, 0));

        // Write the stash unconditionally: the edit may belong to a model the user
        // has since switched away from, and it must still be correct when they
        // come back.
        savedLoopsRef.current.set(payload.modelId, { loops: restored, activeIndex: active });

        // The cut-wide settings ride with the snapshot, so undo puts the kerf /
        // smoothing / resolution back exactly as they were for this edit. Unlike
        // the loops they are NOT stashed per model — they live in the panel, which
        // shows one model at a time — so they only apply when this edit is the
        // active model's; otherwise the ref would drift from what the panel shows.
        const settings = direction === 'undo' ? payload.beforeSettings : payload.afterSettings;

        if (activeGeometryKeyRef.current === payload.modelId) {
          settingsRef.current = settings;
          setLoops(restored);
          setActiveLoopIndex(active);
          setPanelState((ps) => ({ ...withTenon(ps, restored[active]?.tenon ?? DEFAULT_LOOP_TENON), ...settings }));
          setSelectedIndex(null);
        }
        return true;
      }),
    [],
  );

  // An open coalescing run: the loops as they were when this burst of same-kind
  // edits began. Closed by the window expiring, by a different edit, or by the
  // tool/model going away — whichever comes first.
  const pendingRunRef = React.useRef<{
    description: string;
    modelId: string;
    before: OrganicCutLoopSnapshot[];
    beforeActive: number;
    beforeSettings: CutSettings;
    timer: number;
  } | null>(null);

  const flushEditRun = React.useCallback(() => {
    const run = pendingRunRef.current;
    if (!run) return;
    window.clearTimeout(run.timer);
    pendingRunRef.current = null;

    const after = toSnapshot(loopsRef.current);
    const afterActive = activeLoopIndexRef.current;
    organicCutHistory.push({
      type: ORGANIC_CUT_EDIT,
      description: run.description,
      payload: {
        modelId: run.modelId,
        before: run.before,
        beforeActive: run.beforeActive,
        after,
        afterActive,
        beforeSettings: run.beforeSettings,
        afterSettings: settingsRef.current,
      },
    });
  }, []);

  // Never leave a run open: an unflushed burst would be missing from undo.
  React.useEffect(() => () => flushEditRun(), [flushEditRun]);

  // Drag coalescing: the loops at the moment a drag began, so the whole gesture
  // (waypoint drag or tenon gizmo) collapses into a single undo step.
  const isDraggingRef = React.useRef(isDraggingPoint);
  const dragBaselineRef = React.useRef<{ loops: SessionLoop[]; active: number } | null>(null);

  React.useEffect(() => {
    const wasDragging = isDraggingRef.current;
    isDraggingRef.current = isDraggingPoint;

    if (!wasDragging && isDraggingPoint) {
      flushEditRun();
      dragBaselineRef.current = { loops: loopsRef.current, active: activeLoopIndexRef.current };
      // The preview is too heavy to rebuild on every pointer move, so the last one
      // stays up for the drag. A WAYPOINT drag moves the seam, and the cut face
      // goes out from under the tenon: it would be left standing in mid-air, so it
      // goes. Dragging the TENON does not move the face — the anchor and the lean
      // are carried on the built soup, client-side — so it stays on screen for the
      // whole gesture and Rust is asked once, when the handle is let go. It used to
      // be dropped for both, which is why the tenon vanished the moment you took
      // hold of it.
      if (!isDraggingTenon) setTenonPreview(null);
      return;
    }
    if (!wasDragging || isDraggingPoint) return;

    const baseline = dragBaselineRef.current;
    dragBaselineRef.current = null;
    const after = loopsRef.current;
    const afterActive = activeLoopIndexRef.current;
    const modelId = activeGeometryKeyRef.current;
    if (!baseline || !modelId) return;
    if (loopsEqual(baseline.loops, after) && baseline.active === afterActive) return;

    organicCutHistory.push({
      type: ORGANIC_CUT_EDIT,
      description: 'cut:drag',
      payload: {
        modelId,
        before: toSnapshot(baseline.loops),
        beforeActive: baseline.active,
        after: toSnapshot(after),
        afterActive,
        // A drag never touches the cut-wide settings, so both sides are today's.
        beforeSettings: settingsRef.current,
        afterSettings: settingsRef.current,
      },
    });
  }, [isDraggingPoint, isDraggingTenon, flushEditRun]);

  /**
   * The ONE path every user edit to the loops takes: apply it and record it on the
   * app history. Anything that mutates loops outside this — caching a recomputed
   * seam, restoring on a model switch — is not a user edit and must keep using
   * setLoops directly, or undo would step through machine-made changes.
   */
  const commitLoops = React.useCallback(
    (
      description: string,
      updater: (prev: SessionLoop[]) => SessionLoop[],
      nextActiveIndex?: number,
      coalesce = false,
      nextSettings?: CutSettings,
    ) => {
      const before = loopsRef.current;
      const beforeActive = activeLoopIndexRef.current;
      const beforeSettings = settingsRef.current;
      const after = updater(before);
      const afterActive = nextActiveIndex ?? beforeActive;
      // The cut-wide settings are applied by the caller (they live in panelState);
      // this records them. Passing none means "unchanged by this edit".
      const afterSettings = nextSettings ?? beforeSettings;
      if (
        loopsEqual(before, after)
        && afterActive === beforeActive
        && settingsEqual(beforeSettings, afterSettings)
      ) {
        return;
      }
      settingsRef.current = afterSettings;

      setLoops(after);
      if (afterActive !== beforeActive) setActiveLoopIndex(afterActive);

      // Mid-drag: apply but don't record. A pointermove fires per frame, so
      // pushing here would bury the stack under hundreds of entries and make
      // undo step pixel by pixel. The whole drag lands as ONE entry on release.
      if (isDraggingRef.current) return;

      const modelId = activeGeometryKeyRef.current;
      if (!modelId) return; // nothing to attribute the edit to

      if (coalesce) {
        const run = pendingRunRef.current;
        // Same kind of edit, same model, still inside the window → keep extending
        // the open run instead of opening a second entry.
        if (run && run.description === description && run.modelId === modelId) {
          window.clearTimeout(run.timer);
          run.timer = window.setTimeout(flushEditRun, EDIT_COALESCE_WINDOW_MS);
          return;
        }
        flushEditRun(); // a different edit ends the previous run
        pendingRunRef.current = {
          description,
          modelId,
          before: toSnapshot(before),
          beforeActive,
          beforeSettings,
          timer: window.setTimeout(flushEditRun, EDIT_COALESCE_WINDOW_MS),
        };
        return;
      }

      flushEditRun(); // a discrete edit ends any open run before recording itself
      organicCutHistory.push({
        type: ORGANIC_CUT_EDIT,
        description,
        payload: {
          modelId,
          before: toSnapshot(before),
          beforeActive,
          after: toSnapshot(after),
          afterActive,
          beforeSettings,
          afterSettings,
        },
      });
    },
    [flushEditRun],
  );

  const setActiveLoopPoints = React.useCallback(
    (description: string, updater: (prev: OrganicCutLoopPoint[]) => OrganicCutLoopPoint[]) => {
      commitLoops(description, (prev) => {
        const idx = activeLoopIndexRef.current;
        if (idx < 0 || idx >= prev.length) return prev;
        const cur = prev[idx];
        const nextPoints = updater(cur.points);
        if (nextPoints === cur.points) return prev;
        const next = prev.slice();
        next[idx] = { points: nextPoints, polyline: cur.polyline, tenon: cur.tenon };
        return next;
      });
    },
    [commitLoops],
  );

  // Panel state setter exposed to the UI. Besides updating `panelState`, it mirrors
  // the panel's tenon fields into the ACTIVE loop, so each loop keeps its OWN tenon
  // settings. The panel + gizmo stay bound to `panelState` (no change there); this
  // wrapper is what makes those edits land on the active loop. Non-tenon panel
  // changes (thickness, smoothing, …) leave the loops untouched (tenonsEqual guard).
  const handleSetPanelState = React.useCallback((next: OrganicCutPanelState) => {
    setPanelState(next);
    // Cut-wide settings (kerf, smoothing, resolution, mode) are recorded too — they
    // change the cut as much as the seam does. They aren't per-loop, so this rides
    // on an entry whose loops are unchanged; coalesced, since these are number
    // fields that step once per wheel notch.
    const settings = extractSettings(next);
    if (!settingsEqual(settingsRef.current, settings)) {
      commitLoops('cut:settings', (prev) => prev, undefined, true, settings);
    }
    const tenon = extractTenon(next);
    // Tenon settings are part of the loop, so changing them — width, shape, or the
    // gizmo's aim — is an edit and goes through the same recorded path.
    commitLoops('cut:tenon settings', (prev) => {
      const idx = activeLoopIndexRef.current;
      if (idx < 0 || idx >= prev.length) return prev;
      if (tenonsEqual(prev[idx].tenon, tenon)) return prev;
      const nextLoops = prev.slice();
      nextLoops[idx] = { ...nextLoops[idx], tenon };
      return nextLoops;
    }, undefined, true);
  }, [commitLoops]);

  // Everything derived from the ACTIVE model's geometry. These are all computed
  // asynchronously, so leaving any of them set across a model change paints the
  // previous model's seam/membrane/tenon onto the new one until the recompute lands
  // — which is what made two identical models show the tenon facing opposite ways
  // for a moment. Clear them together, from one place.
  /** Drop the cut preview: the membrane/cutter and everything about the tenon. */
  const clearCutPreview = React.useCallback(() => {
    setMembranePreview(null);
    setTenonPreview(null);
    setTenonTriangleCount(0);
    setTenonKind('none');
    setTenonFits(true);
    setTenonDetail('');
    setTenonFrame(null);
  }, []);

  const clearModelDerivedPreviews = React.useCallback(() => {
    setGeodesicPolyline(null);
    setPlaneCurves(null);
    clearCutPreview();
  }, [clearCutPreview]);

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
      // Reset to one empty loop carrying the current panel tenon, so panelState and
      // the (now sole) active loop's tenon stay consistent.
      setLoops([emptyLoop(extractTenon(panelStateRef.current))]);
      setActiveLoopIndex(0);
      setLastResult(null);
      setCutError(null);
    setCutLeakPoints([]);
      setSelectedIndex(null);
      clearModelDerivedPreviews();
    }
  }, [toolActive, clearModelDerivedPreviews]);

  // On model change: stash the OUTGOING model's loops, then restore the INCOMING
  // model's saved loops (if any). Clicking away sets the tenon to null and stashes;
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
    // carrying the current panel tenon.
    const restored = activeGeometryKey ? savedLoopsRef.current.get(activeGeometryKey) : undefined;
    const restoredLoops = restored?.loops ?? [emptyLoop(extractTenon(panelStateRef.current))];
    const nextActive = restored ? Math.min(restored.activeIndex, restoredLoops.length - 1) : 0;
    setLoops(restoredLoops);
    setActiveLoopIndex(nextActive);
    // Sync the panel's tenon editor to the now-active loop's tenon.
    setPanelState((ps) => withTenon(ps, restoredLoops[nextActive]?.tenon ?? DEFAULT_LOOP_TENON));
    setLastResult(null);
    setCutError(null);
    setCutLeakPoints([]);
    clearModelDerivedPreviews();
    flushEditRun();
    // Redo history + selection don't carry across models.
    setSelectedIndex(null);
  }, [activeGeometryKey, clearModelDerivedPreviews, flushEditRun]);

  // A seam belongs to the MESH it was drawn on, and this is the one effect that
  // enforces it. When the mesh under the loops is replaced — the cut itself, a
  // REDO of the cut, a repair, a decimation — the seam describes a surface that no
  // longer exists, so it is retired and remembered against the mesh it belonged to;
  // when that exact mesh comes back, so does it. Undo and redo are then symmetric
  // by construction rather than by two lists of cases kept in step by hand.
  //
  // Getting the redo half wrong was visible: the loops stayed on screen, the
  // geodesic recomputed against the CUT surface, and the membrane came back
  // smaller — following the cut face instead of the skin. Tracked by the geometry
  // REFERENCE, not the model id: a cut and its undo keep the same id and only swap
  // the geometry object.
  const loopsGeometryRef = React.useRef<THREE.BufferGeometry | null | undefined>(activeGeometry);
  const loopsGeometryKeyRef = React.useRef<string | null>(activeGeometryKey);
  React.useEffect(() => {
    const previousGeometry = loopsGeometryRef.current;
    const previousKey = loopsGeometryKeyRef.current;
    loopsGeometryRef.current = activeGeometry;
    loopsGeometryKeyRef.current = activeGeometryKey;

    if (previousGeometry === activeGeometry) return;

    const pending = activeGeometryKey ? undoRestoreRef.current.get(activeGeometryKey) : undefined;
    if (
      toolActive &&
      activeGeometryKey &&
      pending &&
      activeGeometry === pending.geometry &&
      pending.loops.some((l) => l.points.length > 0)
    ) {
      // The mesh the loops were drawn on is back → so are they. Checked BEFORE the
      // "is this a different model" question below, because it answers a stronger
      // one: this is not merely the same model, it is the same mesh. The per-model
      // stash runs in its own effect declared above this one, so writing the loops
      // here lands last and wins — which is the right way round.
      undoRestoreRef.current.delete(activeGeometryKey);
      savedLoopsRef.current.set(activeGeometryKey, { loops: pending.loops, activeIndex: pending.activeIndex });
      const nextActive = Math.min(pending.activeIndex, pending.loops.length - 1);
      setLoops(pending.loops);
      setActiveLoopIndex(nextActive);
      setPanelState((ps) => withTenon(ps, pending.loops[nextActive]?.tenon ?? DEFAULT_LOOP_TENON));
      setSelectedIndex(null);
      return;
    }

    // Retiring a seam is a different question from restoring one, and only this
    // half belongs to the model that is LEAVING. A plain model switch is the other
    // effect's business — it stashes per model and restores per model, and both of
    // us writing the loops in the same commit would fight. (Restoring above is
    // exempt: it is keyed on the mesh, and an exact mesh match is the stronger
    // answer, so it is allowed to land even across a switch.)
    if (previousKey !== activeGeometryKey) return;

    // The mesh was replaced under the loops. Remember them against the mesh they
    // belonged to — but only if there is something to remember: the cut clears the
    // loops itself before this runs, and overwriting its entry with an empty one
    // would cost the user their seam on undo.
    const retiring = loopsRef.current;
    if (previousGeometry && previousKey && retiring.some((l) => l.points.length > 0)) {
      undoRestoreRef.current.set(previousKey, {
        geometry: previousGeometry,
        loops: retiring,
        activeIndex: activeLoopIndexRef.current,
      });
      savedLoopsRef.current.delete(previousKey);
      setLoops([emptyLoop(extractTenon(panelStateRef.current))]);
      setActiveLoopIndex(0);
      setSelectedIndex(null);
      clearModelDerivedPreviews();
    }
  }, [toolActive, activeGeometry, activeGeometryKey, clearModelDerivedPreviews]);

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
      setPlaneCurves(null);
      return;
    }
    // PLANE MODE: the cut follows the plane the points define, not the points
    // themselves, so a surface-following geodesic through them says nothing about
    // where the cut lands. The honest preview is the plane ∩ mesh curve — which is
    // literally the seam the cut produces. Computed locally (no Rust round-trip):
    // it's a single pass over the triangles and the plane only moves when a point
    // does.
    if (cutMode === 'plane') {
      setGeodesicPolyline(null);
      const plane = cutPlaneFromPoints(loop);
      setPlaneCurves(plane ? planeMeshIntersection(activeGeometry, plane) : null);
      return;
    }
    setPlaneCurves(null);
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
  }, [toolActive, loop, activeGeometry, activeGeometryKey, panelState.smoothing, cutMode]);

  // THE cut preview: one effect for both modes.
  //
  // It used to be two, one per mode, structurally identical and sharing most of
  // their dependencies — so every panel edit ran BOTH, and the one whose mode was
  // idle cleared what the other had just drawn. That was the flicker (#38): the
  // tenon blinked out and came back 80ms later, taking the gizmo with it because
  // tenonFrame passed through null. Two effects that must never both act is a
  // shape that invites the bug back; one effect that picks a mode cannot have it.
  //
  // The build is a heavy Rust round-trip, so it is SUPPRESSED while a waypoint is
  // being dragged and rebuilt once the user drops it. The settle timer lets the
  // just-finished drag's debounced geodesic land first, so the membrane is built
  // from the final seam rather than a stale one.
  React.useEffect(() => {
    // What this mode asks Rust for, or null when there is nothing to preview yet.
    // Contour previews the cutter membrane with or without a tenon; the flat cut has
    // no membrane of its own (the seam is drawn locally), so it only has something
    // to ask for when a tenon is wanted.
    const request = ((): (() => Promise<MembranePreviewResult>) | null => {
      if (!toolActive || isDraggingPoint || isDraggingTenon || !activeGeometry || !activeGeometryKey) return null;
      const ps = panelState;
      if (cutMode === 'contour') {
        if (loop.length < MIN_CONTOUR_POINTS) return null;
        // Prefer the surface-following geodesic — the same dense loop the cut uses.
        const previewLoop =
          geodesicPolyline && geodesicPolyline.length >= 9
            ? geodesicPolylineToLoopPoints(geodesicPolyline)
            : loop;
        return () =>
          computeMembranePreview(
            previewLoop,
            ps.membraneSmoothing,
            ps.density,
            ps.jointClearanceMm,
            ps.generateTenon,
            ps.tenonWidthMm,
            ps.tenonDepthMm,
            ps.tenonShape,
            ps.tenonFilletMm,
            ps.tenonToleranceMm,
            ps.tenonSwapSides,
            ps.tenonAnchor,
            ps.tenonTiltRad,
            ps.tenonRollRad,
          );
      }
      if (!ps.generateTenon || loop.length < MIN_LOOP_POINTS) return null;
      const plane = cutPlaneFromPoints(loop);
      if (!plane) return null;
      return () =>
        computePlaneTenonPreview(
          [plane.normal.x, plane.normal.y, plane.normal.z],
          plane.offset,
          ps.generateTenon,
          ps.tenonWidthMm,
          ps.tenonDepthMm,
          ps.tenonShape,
          ps.tenonFilletMm,
          ps.tenonToleranceMm,
          ps.tenonSwapSides,
          ps.tenonAnchor,
        );
    })();

    if (!request) {
      // Don't clear just because a drag started — keep the last preview up for the
      // duration of the drag (the lean is client-side, so no rebuild is needed until
      // the tenon/waypoint drag ends); only clear when there is truly nothing to show.
      if (!isDraggingPoint && !isDraggingTenon) clearCutPreview();
      return;
    }
    // Both mode branches above already required these; naming them keeps the async
    // body below free of nullable captures.
    const geometry = activeGeometry;
    const geometryKey = activeGeometryKey;
    if (!geometry || !geometryKey) return;

    // Revisits are free: the same inputs produce the same preview, so check the
    // bounded cache before spending another Rust round-trip on it. The key captures
    // exactly what `request()` consumes (the contour branch reads the dense geodesic,
    // the flat branch only the loop + plane).
    const cacheKey = JSON.stringify([
      geometryKey,
      cutMode,
      loop,
      cutMode === 'contour' ? (geodesicPolyline ? Array.from(geodesicPolyline) : null) : undefined,
      panelState.membraneSmoothing,
      panelState.density,
      panelState.jointClearanceMm,
      panelState.generateTenon,
      panelState.tenonWidthMm,
      panelState.tenonDepthMm,
      panelState.tenonShape,
      panelState.tenonFilletMm,
      panelState.tenonToleranceMm,
      panelState.tenonSwapSides,
      panelState.tenonAnchor,
      panelState.tenonTiltRad,
      panelState.tenonRollRad,
    ]);
    const cached = previewCacheRef.current.get(cacheKey);
    if (cached && cached.geometry === geometry) {
      applyPreviewResult(cached.result);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const staged = await stageCutSource(geometry, geometryKey);
        if (cancelled || !staged) return;
        const result = await request();
        if (cancelled) return;
        setPreviewCache(cacheKey, geometry, result);
        // Every field, every time: the flat cut reports a null membrane, which is
        // what clears the contour's membrane when the user switches modes.
        applyPreviewResult(result);
      })();
    }, PREVIEW_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The aim IS a dep, deliberately — but it costs nothing while you drag.
    //
    // Whether a LEANED tenon still fits is Rust's answer, and leaving the angle out
    // of here meant that answer was always computed on an upright tenon: you could
    // lean one clean out of the model and it stayed green. The angle is in now, and
    // the guard above (`isDraggingPoint`, which the aim gizmo raises like every other
    // drag) means no request goes out while the ring is turning — the client-side
    // lean carries the visuals. One rebuild lands when you let go, which is when
    // the verdict matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    toolActive,
    loop,
    activeGeometry,
    activeGeometryKey,
    cutMode,
    geodesicPolyline,
    isDraggingPoint,
    isDraggingTenon,
    clearCutPreview,
    panelState.membraneSmoothing,
    panelState.density,
    panelState.jointClearanceMm,
    panelState.generateTenon,
    panelState.tenonWidthMm,
    panelState.tenonDepthMm,
    panelState.tenonShape,
    panelState.tenonFilletMm,
    panelState.tenonToleranceMm,
    panelState.tenonSwapSides,
    panelState.tenonAnchor,
    panelState.tenonTiltRad,
    panelState.tenonRollRad,
  ]);

  const addPoint = React.useCallback((point: OrganicCutLoopPoint) => {
    setActiveLoopPoints('cut:place point', (prev) => [...prev, point]);
    // A freshly placed point invalidates any redo history.
  }, [setActiveLoopPoints]);

  const insertPoint = React.useCallback((afterIndex: number, point: OrganicCutLoopPoint) => {
    setActiveLoopPoints('cut:delete point', (prev) => {
      // Insert AFTER afterIndex → at array position afterIndex+1. Clamp so a bad
      // index can't throw; a negative index prepends, an over-large one appends.
      const at = Math.max(0, Math.min(prev.length, afterIndex + 1));
      const next = prev.slice();
      next.splice(at, 0, point);
      return next;
    });
  }, [setActiveLoopPoints]);

  const selectPoint = React.useCallback((index: number | null) => {
    setSelectedIndex(index);
  }, []);

  const removePoint = React.useCallback((index: number) => {
    setActiveLoopPoints('cut:move point', (prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next.splice(index, 1);
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
  }, [setActiveLoopPoints]);

  const updatePoint = React.useCallback((index: number, point: OrganicCutLoopPoint) => {
    setActiveLoopPoints('cut:lock point', (prev) => {
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
      // The drag handler builds a bare {position, normal}; carry the pin flag
      // across so dragging a locked point doesn't silently un-pin it.
      next[index] = { ...point, locked: prevPoint.locked };
      return next;
    });
  }, [setActiveLoopPoints]);

  // Toggle a waypoint's "locked" (pinned) flag. A locked point is left untouched
  // by Snap to Edges — for a point sitting exactly where it's needed that snap
  // would otherwise drag onto a nearby edge/corner. Double-click a marker to flip
  // it. A no-op if the index is out of range.
  const toggleLockPoint = React.useCallback((index: number) => {
    setActiveLoopPoints('cut:lock waypoint', (prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next[index] = { ...next[index], locked: !next[index].locked };
      return next;
    });
  }, [setActiveLoopPoints]);

  // Snap the active loop's waypoints onto the model's nearest sharp feature edges.
  // Repositions points in place (like a batch drag) — the geodesic/membrane
  // effects recompute from the new positions through the same path as a drag.
  const snapActiveLoopToEdges = React.useCallback(() => {
    const geometry = activeGeometryRef.current;
    if (!geometry) return;
    setActiveLoopPoints('cut:snap to edges', (prev) => {
      if (prev.length === 0) return prev;
      const { points, movedCount } = snapPointsToFeatureEdges(prev, geometry);
      // Nothing moved (no feature edges, or all points already on one) → keep the
      // same array reference so no recompute is triggered.
      return movedCount > 0 ? points : prev;
    });
  }, [setActiveLoopPoints]);

  const clearLoop = React.useCallback(() => {
    // Clear truly clears — also drop the persisted copy so it doesn't spring back
    // on deselect/reselect, and discard ALL loops (multi-loop included).
    const key = activeGeometryKeyRef.current;
    if (key) savedLoopsRef.current.delete(key);
    // Keep the panel's current tenon on the fresh loop (don't reset the user's prefs).
    commitLoops('cut:clear all', () => [emptyLoop(extractTenon(panelStateRef.current))], 0);
    setLastResult(null);
    setCutError(null);
    setCutLeakPoints([]);
    setSelectedIndex(null);
    setGeodesicPolyline(null);
  }, [commitLoops]);

  // Switch the active (editable) loop. The geodesic + membrane effects recompute
  // for the new active loop; we show its cached seam immediately for snappiness,
  // and load that loop's tenon into the panel editor so the tenon controls follow it.
  const selectLoop = React.useCallback((index: number) => {
    const all = loopsRef.current;
    if (index < 0 || index >= all.length) return;
    setActiveLoopIndex(index);
    setSelectedIndex(null);
    setGeodesicPolyline(all[index].polyline ?? null);
    setPanelState((ps) => withTenon(ps, all[index].tenon));
  }, []);

  // Append a fresh empty loop and make it active (multi-loop cut). The new loop
  // inherits the current loop's tenon as a starting point (the panel already shows
  // it, so no panel change needed). On Apply, every loop's cutter is union'd
  // together. Gated by `canAddLoop` so we don't stack empty loops; a stray empty
  // loop is pruned at cut time regardless.
  const addLoop = React.useCallback(() => {
    const all = loopsRef.current;
    const newIndex = all.length; // index of the appended loop
    const inheritTenon = all[activeLoopIndexRef.current]?.tenon ?? extractTenon(panelStateRef.current);
    commitLoops('cut:add loop', (prev) => [...prev, emptyLoop(inheritTenon)], newIndex);
    setSelectedIndex(null);
    setGeodesicPolyline(null);
    setMembranePreview(null);
    setTenonPreview(null);
    setTenonTriangleCount(0);
    setTenonKind('none');
    setTenonFits(true);
    setTenonDetail('');
    setTenonFrame(null);
  }, [commitLoops]);

  // Remove a loop. Never removes the last remaining one (Clear does that). The
  // active index is fixed up so it keeps pointing at a valid loop.
  const removeLoop = React.useCallback((index: number) => {
    const before = loopsRef.current;
    if (before.length <= 1 || index < 0 || index >= before.length) return;
    const lastIndexAfter = before.length - 2; // length-1 (removed) - 1
    const curActive = activeLoopIndexRef.current;
    const newActive =
      index < curActive
        ? curActive - 1
        : index === curActive
          ? Math.max(0, Math.min(curActive, lastIndexAfter))
          : curActive;
    commitLoops('cut:remove loop', (prev) => {
      if (prev.length <= 1 || index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next.splice(index, 1);
      return next;
    }, newActive);
    // Load the new active loop's tenon into the panel editor (compute from the
    // pre-removal snapshot minus the removed loop).
    const remaining = before.filter((_, i) => i !== index);
    setPanelState((ps) => withTenon(ps, remaining[newActive]?.tenon ?? DEFAULT_LOOP_TENON));
    setSelectedIndex(null);
    setGeodesicPolyline(null);
  }, [commitLoops]);

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
    const contourReady = isContour ? allLoopsState.filter(loopIsCuttable).length : 0;
    if (isContour ? contourReady === 0 : currentLoop.length < minPoints) return;
    if (!geom || !geomKey) return;
    const loopSnapshot = currentLoop.slice();
    // Snapshot all loops (for the undo-restore after a successful cut).
    const loopsSnapshot: SessionLoop[] = allLoopsState.map((l) => ({
      points: l.points.slice(),
      polyline: l.polyline,
      tenon: l.tenon,
    }));
    const geodesic = geodesicPolylineRef.current;
    let cancelled = false;
    setIsApplying(true);
    // Clear the last refusal BEFORE the cut runs, not after it comes back. A cut on
    // this model takes seconds, and a message left on screen through all of it cannot
    // be told apart from the one this press is about to produce.
    setCutError(null);
    setCutLeakPoints([]);
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
          // Each kept loop carries its OWN tenon, kept aligned with its points so the
          // backend places per-loop tenons (loopTenons[i] ↔ the i-th loop).
          const kept: { points: OrganicCutLoopPoint[]; tenon: LoopTenonSettings }[] = [];
          for (const [i, l] of allLoopsState.entries()) {
            let pts: OrganicCutLoopPoint[] | null = null;
            if (i === activeIdx && geodesic && geodesic.length >= MIN_CONTOUR_POINTS * 3) {
              pts = geodesicPolylineToLoopPoints(geodesic);
            } else if (l.polyline && l.polyline.length >= MIN_CONTOUR_POINTS * 3) {
              pts = geodesicPolylineToLoopPoints(l.polyline);
            } else if (l.points.length >= MIN_CONTOUR_POINTS) {
              // No cached seam for this loop: restoring the loops after a cut or an
              // undo drops the derived polyline, and only the ACTIVE loop's geodesic
              // effect puts one back. Recompute it here rather than falling back to
              // the bare waypoints — four waypoints spanned by a membrane is a flat
              // quad metres away from the surface the user drew on, and it cuts
              // exactly like that.
              const poly = await computeGeodesicLoop(l.points, l.points.length >= 3, ps.smoothing);
              if (cancelled) return;
              if (poly && poly.length >= MIN_CONTOUR_POINTS * 3) {
                pts = geodesicPolylineToLoopPoints(poly);
              }
            }
            if (pts) kept.push({ points: pts, tenon: l.tenon });
          }
          if (kept.length === 0) return; // nothing to cut
          const allLoops = kept.map((k) => k.points);
          cutSpec = {
            loopPoints: allLoops[0],
            extraLoops: allLoops.length > 1 ? allLoops.slice(1) : undefined,
            // Per-loop tenon settings, aligned with the loops above (loopPoints +
            // extraLoops). The backend tenons each seam with its own tenon/mortise.
            loopTenons: kept.map((k) => tenonToSpec(k.tenon)),
            // `smoothing` = seam-line smoothing (the geodesic was already computed
            // with it, but send it so the cut's loop matches). `membraneSmoothing`
            // = cutter-surface relaxation. Both 0..1.
            smoothing: ps.smoothing,
            membraneSmoothing: ps.membraneSmoothing,
            mode: 'contour' as const,
            // Slack for the joint, not for the cut: the surface cut's halves share
            // their cut face, so the number is spent on the tenon's fit.
            jointClearanceMm: ps.jointClearanceMm,
            // Cut resolution multiplier — raises the cutter poly count. The live
            // preview reflects this too (so what you see is what gets cut).
            density: ps.density,
            // When on, the cut builds a registration tenon (tenon union'd onto one
            // half, mortise carved from the other) at EVERY loop's seam — one tenon
            // per cut. The preview shows the active loop's tenon; the others use the
            // same width/depth/shape/tilt. A tenon too thin to fit at one seam is
            // skipped there without affecting the rest.
            generateTenon: ps.generateTenon,
            tenonWidthMm: ps.tenonWidthMm,
            tenonDepthMm: ps.tenonDepthMm,
            tenonShape: ps.tenonShape,
            tenonFilletMm: ps.tenonFilletMm,
            tenonToleranceMm: ps.tenonToleranceMm,
            tenonAnchor: ps.tenonAnchor,
            tenonSwapSides: ps.tenonSwapSides,
            // Aim/roll: the base-glued lean + spin set by the in-viewport gizmo. The
            // preview already showed exactly this tenon (same angles, same shear).
            tenonTiltRad: ps.tenonTiltRad,
            tenonRollRad: ps.tenonRollRad,
          };
        } else {
          // Compute the plane from the SAME helper the preview uses, so the cut
          // is exactly the plane the user saw. Sent explicitly; Rust splits by it.
          const plane = cutPlaneFromPoints(loopSnapshot);
          cutSpec = {
            loopPoints: loopSnapshot,
            jointClearanceMm: ps.jointClearanceMm,
            smoothing: ps.smoothing,
            mode: 'plane' as const,
            plane: plane
              ? { normal: [plane.normal.x, plane.normal.y, plane.normal.z] as [number, number, number], offset: plane.offset }
              : undefined,
            // The tenon rides on the spec-level fields: a flat cut is single-loop, so
            // there is no `loopTenons` array to align with. Rust frames it on the
            // plane's own cross-section.
            generateTenon: ps.generateTenon,
            tenonWidthMm: ps.tenonWidthMm,
            tenonDepthMm: ps.tenonDepthMm,
            tenonShape: ps.tenonShape,
            tenonFilletMm: ps.tenonFilletMm,
            tenonToleranceMm: ps.tenonToleranceMm,
            tenonSwapSides: ps.tenonSwapSides,
            tenonTiltRad: ps.tenonTiltRad,
            tenonRollRad: ps.tenonRollRad,
          };
        }
        const result = await cutFromCapturedSource({ cut: cutSpec });
        if (cancelled || !result) return;
        setLastResult(result);
        // A cut that refused says why, on screen. `noop` is the engine's way of
        // saying "I did not touch your model, and here is what stopped me".
        setCutError(
          result.report.engine === 'noop'
            ? asSentence(result.report.detail || 'The cut could not be made')
            : null,
        );
        setCutLeakPoints(result.report.engine === 'noop' ? (result.report.leakPoints ?? []) : []);

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
        console.info(
          `[organicCut] cut applied | engine=${result.report.engine}` +
          ` committed=${committed}` +
          ` parts=${result.parts.length}` +
          ` detail="${result.report.detail ?? ''}"` +
          ` tenonKind=${result.report.tenonKind ?? 'n/a'}` +
          ` tenonDetail="${result.report.tenonDetail ?? ''}"` +
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
            undoRestoreRef.current.set(geomKey, {
              geometry: geom,
              loops: loopsSnapshot,
              activeIndex: activeIdx,
            });
          }
          // A cut retires EVERY seam in the session, not just the live one. The
          // parts that come back are new bodies, and the stash is tenoned by model
          // id — so a half-drawn seam left on another model (or on this one, from
          // before the tool was last closed) would spring back the moment the
          // user selected it, drawing geodesics and a tenon onto a body that no
          // longer has that surface. Wipe the whole stash; the undo entry above
          // is what puts this model's loops back if the cut is undone.
          savedLoopsRef.current.clear();
          // Reset to one empty loop carrying the current panel tenon.
          setLoops([emptyLoop(extractTenon(panelStateRef.current))]);
          setActiveLoopIndex(0);
          setSelectedIndex(null);
          clearModelDerivedPreviews();
        }
      } catch (err) {
        console.error('[organicCut] cut failed', err);
      } finally {
        if (!cancelled) setIsApplying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Stable: every input is read from a ref, and `clearModelDerivedPreviews` is
    // itself a []-dep callback.
  }, [clearModelDerivedPreviews]);

  const pointCount = loop.length;
  // Contour needs a real loop (≥3 points); flat works with 2.
  const minPointsForMode = panelState.cutMode === 'contour' ? MIN_CONTOUR_POINTS : MIN_LOOP_POINTS;
  const isContourMode = panelState.cutMode === 'contour';
  const activeLoopReady = pointCount >= MIN_CONTOUR_POINTS;
  const loopCount = loops.length;
  const loopSummaries = React.useMemo(
    () => loops.map((l, i) => ({ index: i, pointCount: l.points.length })),
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
  const canSnapToEdges = !!activeGeometry && pointCount > 0 && !isApplying;

  return {
    panelState,
    setPanelState: handleSetPanelState,
    loop,
    addPoint,
    updatePoint,
    insertPoint,
    snapActiveLoopToEdges,
    canSnapToEdges,
    removePoint,
    toggleLockPoint,
    selectedIndex,
    selectPoint,
    clearLoop,
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
    cutError,
    cutLeakPoints,
    canApply,
    geodesicPolyline,
    planeCurves,
    membranePreview,
    tenonPreview,
    tenonTriangleCount,
    tenonKind,
    tenonFits,
    tenonDetail,
    tenonFrame,
  };
}
