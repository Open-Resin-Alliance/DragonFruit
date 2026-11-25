/**
 * Organic Cut — frontend ↔ Rust bridge.
 *
 * Shares the staging/read primitives in src/utils/tauriMeshBridge.ts with the
 * hollow, punch and repair bridges: stage the geometry as a binary triangle
 * soup, capture it as a non-mutating source, run a preview/apply, then read raw
 * little-endian f32 positions back. The shape
 * difference is that an organic cut returns N parts (≥2 — a multi-loop cut frees
 * several pieces) rather than one modified mesh: the report carries `partCount` and
 * each part is read back by index via `mesh_organic_cut_read_part`.
 */
import * as THREE from 'three';
import {
  type TauriInvoke,
  decodeF32,
  expandGeometryToTriangleSoup,
  loadTauriCore,
  stageGeometryToStagedMesh,
} from '@/utils/tauriMeshBridge';
import type { TenonPreviewFrame, OrganicCutLoopPoint, OrganicCutOptions, OrganicCutReport, OrganicCutResult } from './types';
import {
  IDENTITY_CUT_SCALE,
  type CutScale,
  frameFromCutSpace,
  isIdentityCutScale,
  loopPointToCutSpace,
  pointsFromCutSpace,
  planeToCutSpace,
  sameCutScale,
  specToCutSpace,
  vectorToCutSpace,
} from './cutSpace';

let stagedCutSourceKey: string | null = null;
// The geometry OBJECT last staged. Tracked alongside the tenon so that if a model's
// geometry is replaced under the SAME id (e.g. a cut then undo restores the
// original geometry reference), we detect the change and re-stage instead of
// reusing the stale captured source.
let stagedCutSourceGeometry: THREE.BufferGeometry | null = null;
// The model's scale the staged source was built at. Everything sent to Rust after the
// staging is scaled by it and everything read back is unscaled — see `cutSpace.ts`.
let stagedCutScale: CutScale = IDENTITY_CUT_SCALE;

type OrganicCutReadCommand =
  | 'mesh_organic_cut_read_geodesic'
  | 'mesh_organic_cut_read_membrane'
  | 'mesh_organic_cut_read_tenon';

async function readPositionsFromCommand(
  invoke: TauriInvoke,
  command: OrganicCutReadCommand,
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(command);
  return decodeF32(bytes, command);
}

/** Read the cut part at `index` (model-local triangle soup). */
async function readPartAtIndex(invoke: TauriInvoke, index: number): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>('mesh_organic_cut_read_part', { index });
  return pointsFromCutSpace(decodeF32(bytes, `mesh_organic_cut_read_part[${index}]`), stagedCutScale);
}

/** Stage `geometry` with the model's scale applied, so Rust works in printed millimetres. */
async function stageScaledGeometry(invoke: TauriInvoke, geometry: THREE.BufferGeometry, scale: CutScale): Promise<void> {
  if (isIdentityCutScale(scale)) {
    await stageGeometryToStagedMesh(invoke, geometry);
    return;
  }
  const soup = expandGeometryToTriangleSoup(geometry);
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] *= scale[0];
    soup[i + 1] *= scale[1];
    soup[i + 2] *= scale[2];
  }
  await invoke('stage_mesh_binary_set', new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength), {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

/** Read all `count` parts the cut produced (in order, largest first). */
async function readAllParts(invoke: TauriInvoke, count: number): Promise<Float32Array[]> {
  if (count <= 0) return [];
  return Promise.all(Array.from({ length: count }, (_, i) => readPartAtIndex(invoke, i)));
}

/**
 * Captures the given geometry as the non-mutating cut source for repeated
 * previews. Tenoned so re-staging the same geometry is a cheap no-op.
 */
/**
 * True if the given source tenon is already staged + captured, so callers on a hot
 * path (e.g. the per-frame geodesic during a waypoint drag) can skip the
 * `stageCutSource` await entirely.
 */
export function isCutSourceStaged(
  sourceKey: string,
  geometry?: THREE.BufferGeometry,
  scale: CutScale = IDENTITY_CUT_SCALE,
): boolean {
  if (stagedCutSourceKey !== sourceKey) return false;
  // Same tenon but a different geometry object → the mesh was replaced (cut/undo);
  // treat as not staged so callers re-stage the current geometry.
  if (geometry && stagedCutSourceGeometry !== geometry) return false;
  // Rescaled on the plate since: the staged mesh is the wrong size.
  return sameCutScale(stagedCutScale, scale);
}

/**
 * `scale` is the model's scale on the plate. The cut's sizes — the tenon, its fit, the
 * joint clearance, the room a tenon has to grow — are printed millimetres, so the
 * source is staged at the size it prints, not at the size it was modelled.
 */
export async function stageCutSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
  scale: CutScale = IDENTITY_CUT_SCALE,
): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) return false;

  // Re-stage if the tenon, the geometry object (same id can carry new geometry after a
  // cut/undo) or the model's scale changed.
  if (isCutSourceStaged(sourceKey, geometry, scale)) {
    return true;
  }

  await stageScaledGeometry(core.invoke, geometry, scale);
  await core.invoke('mesh_organic_cut_capture_staged_source');
  stagedCutSourceKey = sourceKey;
  stagedCutSourceGeometry = geometry;
  stagedCutScale = scale;
  return true;
}

/**
 * Runs an organic cut against the previously captured source without mutating
 * the staged mesh buffer. Returns ALL parts + a report. A multi-loop cut that
 * frees several pieces returns >2 parts (one per piece).
 */
export async function cutFromCapturedSource(
  options: OrganicCutOptions,
): Promise<OrganicCutResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify({ ...options, cut: specToCutSpace(options.cut, stagedCutScale) });
  const reportJson = await core.invoke<string>('mesh_organic_cut_from_captured_source', { optionsJson });
  const report = reportFromCutSpace(JSON.parse(reportJson) as OrganicCutReport);
  const parts = await readAllParts(core.invoke, report.partCount ?? 0);
  return { report, parts };
}

function reportFromCutSpace(report: OrganicCutReport): OrganicCutReport {
  if (!report.leakPoints?.length) return report;
  const flat = pointsFromCutSpace(new Float32Array(report.leakPoints.flat()), stagedCutScale);
  return { ...report, leakPoints: report.leakPoints.map((_, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]) };
}

/**
 * One-shot: stage the geometry and run the cut, returning all parts.
 * Convenience for the non-preview "Apply" path.
 */
export async function cutFromGeometry(
  geometry: THREE.BufferGeometry,
  options: OrganicCutOptions,
): Promise<OrganicCutResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  await stageGeometryToStagedMesh(core.invoke, geometry);
  stagedCutSourceKey = null;
  stagedCutSourceGeometry = null;
  stagedCutScale = IDENTITY_CUT_SCALE;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_organic_cut_staged', { optionsJson });
  const report = JSON.parse(reportJson) as OrganicCutReport;
  const parts = await readAllParts(core.invoke, report.partCount ?? 0);
  return { report, parts };
}

/**
 * Computes a surface-following (Stage-1 edge-path) loop polyline through the
 * given waypoints, against the captured cut source. Requires that the source has
 * already been staged + captured (via stageCutSource). Returns the polyline as a
 * flat Float32Array (3 per point), or null outside Tauri / on failure.
 */
export async function computeGeodesicLoop(
  loopPoints: OrganicCutLoopPoint[],
  close: boolean,
  smoothing = 0.5,
): Promise<Float32Array | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  if (loopPoints.length < 2) return null;

  const requestJson = JSON.stringify({
    points: loopPoints.map((p) => ({ position: vectorToCutSpace(p.position, stagedCutScale) })),
    close,
    smoothing,
  });
  try {
    // Single IPC round-trip: the command computes the loop AND returns the raw
    // LE f32 polyline bytes as the response body (no separate read-back call).
    // This is the hot path while dragging a waypoint — one hop per frame.
    const bytes = await core.invoke<ArrayBuffer | Uint8Array | number[]>(
      'mesh_organic_cut_geodesic_loop_bytes',
      { requestJson },
    );
    let u8: Uint8Array;
    if (bytes instanceof ArrayBuffer) u8 = new Uint8Array(bytes);
    else if (bytes instanceof Uint8Array) u8 = bytes;
    else if (Array.isArray(bytes)) u8 = new Uint8Array(bytes);
    else return null;
    if (u8.byteLength < 24) return null; // < 2 points (3 floats each = 24 bytes)
    // Copy into an aligned buffer before viewing as f32 (the IPC buffer may be a
    // non-zero byteOffset view, which Float32Array can't wrap directly).
    const copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    return pointsFromCutSpace(new Float32Array(copy.buffer), stagedCutScale);
  } catch {
    return null;
  }
}

/** Which tenon the preview placed: a frustum, a half-sphere dome, or none. */
export type TenonPreviewKind = 'frustum' | 'dome' | 'none';

/**
 * Result of the contour-cut preview round-trip: the membrane cutter soup plus,
 * when a tenon was requested, the tenon (tenon + mortise) soup and the chosen-rung kind
 * + a human-readable reason (for the fell-back/no-tenon alert).
 */
export interface MembranePreviewResult {
  /** The cutter membrane/slab soup (9 floats per triangle), or null. */
  membrane: Float32Array | null;
  /** The tenon (tenon + mortise) soup, or null when no tenon / not requested. */
  tenonPreview: Float32Array | null;
  /**
   * How many of `tenonPreview`'s triangles are the TENON — the soup is the tenon
   * followed by the mortise. The two are drawn in different colours, which is what
   * makes Fit Tolerance legible: it grows the mortise and never moves the tenon.
   */
  tenonTriangleCount: number;
  /** Which shape is drawn. 'none' when no tenon was requested. */
  tenonKind: TenonPreviewKind;
  /**
   * Whether the previewed tenon can actually be placed where it sits. False means
   * "draw it in the won't-fit colour and refuse the cut" — the soup is still a
   * full tenon at the requested size, so the user can see and move it.
   */
  tenonFits: boolean;
  /** Why it doesn't fit, for the panel's alert. Empty when it does. */
  tenonDetail: string;
  /**
   * Placement frame of the previewed tenon (model-local), for the aim+roll gizmo.
   * Null when no tenon was placed.
   */
  tenonFrame: TenonPreviewFrame | null;
}

/**
 * Builds the contour-cut MEMBRANE (and, when `generateTenon`, the registration tenon)
 * for the given loop, returning each as a flat triangle soup (9 floats per
 * triangle, model-local) for previewing in the scene. Requires the source already
 * staged + captured. Returns a result with null soups outside Tauri / on failure /
 * <3 points.
 */
export async function computeMembranePreview(
  loopPoints: OrganicCutLoopPoint[],
  membraneSmoothing = 0.5,
  density = 1.0,
  jointClearanceMm = 0.0,
  generateTenon = false,
  tenonWidthMm = 2.0,
  tenonDepthMm = 2.5,
  tenonShape: 'frustum' | 'dome' = 'frustum',
  tenonFilletMm = 0.0,
  tenonToleranceMm = 0.1,
  tenonSwapSides = false,
  tenonAnchor: [number, number, number] | null = null,
  tenonTiltRad = 0.0,
  tenonRollRad = 0.0,
): Promise<MembranePreviewResult> {
  const empty: MembranePreviewResult = {
    membrane: null,
    tenonPreview: null,
    tenonTriangleCount: 0,
    tenonKind: 'none',
    tenonFits: true,
    tenonDetail: '',
    tenonFrame: null,
  };
  const core = await loadTauriCore();
  if (!core) return empty;
  if (loopPoints.length < 3) return empty;

  const requestJson = JSON.stringify({
    points: loopPoints.map((p) => ({ position: loopPointToCutSpace(p, stagedCutScale).position })),
    close: true,
    membraneSmoothing,
    density,
    jointClearanceMm,
    generateTenon,
    tenonWidthMm,
    tenonDepthMm,
    tenonShape,
    tenonFilletMm,
    tenonToleranceMm,
    tenonSwapSides,
    tenonAnchor: tenonAnchor && vectorToCutSpace(tenonAnchor, stagedCutScale),
    tenonTiltRad,
    tenonRollRad,
  });
  try {
    const reportJson = await core.invoke<string>('mesh_organic_cut_membrane_preview', { requestJson });
    const report = JSON.parse(reportJson) as {
      triangleCount: number;
      jointTriangleCount?: number;
      tenonTriangleCount?: number;
      tenonKind?: TenonPreviewKind;
      tenonFits?: boolean;
      tenonDetail?: string;
      tenonFrame?: TenonPreviewFrame | null;
    };
    const membrane = report.triangleCount
      ? pointsFromCutSpace(await readPositionsFromCommand(core.invoke, 'mesh_organic_cut_read_membrane'), stagedCutScale)
      : null;
    const tenonPreview = report.jointTriangleCount
      ? pointsFromCutSpace(await readPositionsFromCommand(core.invoke, 'mesh_organic_cut_read_tenon'), stagedCutScale)
      : null;
    return {
      membrane,
      tenonPreview,
      tenonTriangleCount: report.tenonTriangleCount ?? 0,
      tenonKind: report.tenonKind ?? 'none',
      tenonFits: report.tenonFits ?? true,
      tenonDetail: report.tenonDetail ?? '',
      tenonFrame: report.tenonFrame ? frameFromCutSpace(report.tenonFrame, stagedCutScale) : null,
    };
  } catch (err) {
    console.error('[organicCut] membrane preview command failed', err);
    return empty;
  }
}

/**
 * Preview the tenon a FLAT cut would place, framed on the cut plane.
 *
 * The membrane preview above is contour-only — it builds a membrane from the loop
 * and frames the tenon on it. A flat cut has no membrane, so this hands Rust the
 * plane the preview drew and lets it frame the tenon on the cross-section that plane
 * carves. Returns the same shape, with a null membrane.
 */
export async function computePlaneTenonPreview(
  planeNormal: [number, number, number],
  planeOffset: number,
  generateTenon: boolean,
  tenonWidthMm = 2.0,
  tenonDepthMm = 2.5,
  tenonShape: 'frustum' | 'dome' = 'frustum',
  tenonFilletMm = 0.0,
  tenonToleranceMm = 0.1,
  tenonSwapSides = false,
  tenonAnchor: [number, number, number] | null = null,
): Promise<MembranePreviewResult> {
  const empty: MembranePreviewResult = {
    membrane: null,
    tenonPreview: null,
    tenonTriangleCount: 0,
    tenonKind: 'none',
    tenonFits: true,
    tenonDetail: '',
    tenonFrame: null,
  };
  const core = await loadTauriCore();
  if (!core) return empty;

  const plane = planeToCutSpace({ normal: planeNormal, offset: planeOffset }, stagedCutScale);
  const requestJson = JSON.stringify({
    planeNormal: plane.normal,
    planeOffset: plane.offset,
    generateTenon,
    tenonWidthMm,
    tenonDepthMm,
    tenonShape,
    tenonFilletMm,
    tenonToleranceMm,
    tenonSwapSides,
    tenonAnchor: tenonAnchor && vectorToCutSpace(tenonAnchor, stagedCutScale),
  });
  try {
    const reportJson = await core.invoke<string>('mesh_organic_cut_plane_tenon_preview', { requestJson });
    const report = JSON.parse(reportJson) as {
      jointTriangleCount?: number;
      tenonTriangleCount?: number;
      tenonKind?: TenonPreviewKind;
      tenonFits?: boolean;
      tenonDetail?: string;
      tenonFrame?: TenonPreviewFrame | null;
    };
    const tenonPreview = report.jointTriangleCount
      ? pointsFromCutSpace(await readPositionsFromCommand(core.invoke, 'mesh_organic_cut_read_tenon'), stagedCutScale)
      : null;
    return {
      membrane: null,
      tenonPreview,
      tenonTriangleCount: report.tenonTriangleCount ?? 0,
      tenonKind: report.tenonKind ?? 'none',
      tenonFits: report.tenonFits ?? true,
      tenonDetail: report.tenonDetail ?? '',
      tenonFrame: report.tenonFrame ? frameFromCutSpace(report.tenonFrame, stagedCutScale) : null,
    };
  } catch (err) {
    console.error('[organicCut] plane tenon preview command failed', err);
    return empty;
  }
}

/** Builds a position-only BufferGeometry from a returned triangle-soup part. */
export function partToGeometry(part: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
