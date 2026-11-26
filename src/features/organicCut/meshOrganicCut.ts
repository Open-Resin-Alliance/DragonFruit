/**
 * Organic Cut — frontend ↔ Rust bridge.
 *
 * Every call runs on an organic cut session in the native mesh store
 * (`src/utils/nativeMeshStore.ts`). The session is opened once per source geometry and keeps
 * the parsed mesh and its geodesic solver, so a seam, a preview or the cut itself names the
 * session's id instead of sending the mesh again. Every soup a command returns comes back as
 * an id, read once and dropped here. An organic cut returns N parts (≥2 — a multi-loop cut
 * frees several pieces) rather than one modified mesh, so its report carries `partIds`. See
 * `docs/dev/native-mesh-store.md`.
 */
import * as THREE from 'three';
import {
  asNativeMeshStoreError,
  dropNativeMeshes,
  putNativeSoup,
  readNativeMesh,
} from '@/utils/nativeMeshStore';
import {
  type TauriCoreModule,
  decodeF32,
  expandGeometryToTriangleSoup,
  loadTauriCore,
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

/**
 * An open organic cut session: its id in the store, and the model's scale its mesh was stored
 * at. Everything sent to the session is scaled by it and everything read back is unscaled —
 * see `cutSpace.ts`.
 */
export interface CutSource {
  readonly id: string;
  readonly scale: CutScale;
}

interface OpenCutSource {
  sourceKey: string;
  // The geometry OBJECT the session was opened on. A model's geometry can be replaced under
  // the SAME key (a cut then undo restores the original geometry reference), and that has to
  // open a new session rather than reuse the stale one.
  geometry: THREE.BufferGeometry;
  scale: CutScale;
  source: Promise<CutSource>;
}

let openSource: OpenCutSource | null = null;

/** `geometry` as a triangle soup at the model's scale, so Rust works in printed millimetres. */
function scaledSoup(geometry: THREE.BufferGeometry, scale: CutScale): Float32Array {
  const soup = expandGeometryToTriangleSoup(geometry);
  if (isIdentityCutScale(scale)) return soup;
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] *= scale[0];
    soup[i + 1] *= scale[1];
    soup[i + 2] *= scale[2];
  }
  return soup;
}

/**
 * The open session for this source: the one already open when the key, the geometry object
 * and the scale all match, otherwise a new one, and the previous session is dropped.
 *
 * `scale` is the model's scale on the plate. The cut's sizes — the tenon, its fit, the joint
 * clearance, the room a tenon has to grow — are printed millimetres, so the session holds the
 * mesh at the size it prints, not at the size it was modelled. Returns null outside the Tauri
 * runtime.
 */
export async function openCutSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
  scale: CutScale = IDENTITY_CUT_SCALE,
): Promise<CutSource | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  if (
    openSource?.sourceKey === sourceKey
    && openSource.geometry === geometry
    && sameCutScale(openSource.scale, scale)
  ) {
    return openSource.source;
  }

  const previous = openSource;
  const source = (async (): Promise<CutSource> => {
    const meshId = await putNativeSoup(core, scaledSoup(geometry, scale));
    try {
      const id = await core.invoke<string>('mesh_organic_cut_session_open', { meshId });
      return { id, scale };
    } catch (error) {
      throw asNativeMeshStoreError(error) ?? error;
    } finally {
      // The session keeps its own copy of the mesh.
      await dropNativeMeshes(core, [meshId]).catch(() => undefined);
    }
  })();
  const opened: OpenCutSource = { sourceKey, geometry, scale, source };
  openSource = opened;
  // A session that failed to open is not kept: the next call tries again.
  source.catch(() => {
    if (openSource === opened) openSource = null;
  });
  if (previous) {
    void previous.source
      .then(({ id }) => dropNativeMeshes(core, [id]))
      .catch(() => undefined);
  }
  return source;
}

/**
 * Runs a command on a session. When the store no longer has the session (released to stay in
 * its budget, or dropped), it is forgotten, so the next `openCutSource` opens a new one; the
 * error still reaches the caller.
 */
async function invokeOnSource<T>(
  core: TauriCoreModule,
  source: CutSource,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await core.invoke<T>(command, { sessionId: source.id, ...args });
  } catch (error) {
    const storeError = asNativeMeshStoreError(error);
    if (storeError && storeError.message.includes(`'${source.id}'`) && openSource) {
      const open = openSource;
      if ((await open.source.catch(() => null))?.id === source.id && openSource === open) {
        openSource = null;
      }
    }
    throw storeError ?? error;
  }
}

/**
 * Reads every stored soup a command returned, unscaled, and drops them all, including any a
 * failed read left behind.
 */
async function takeSoups(
  core: TauriCoreModule,
  ids: readonly string[],
  scale: CutScale,
): Promise<Float32Array[]> {
  try {
    const soups = await Promise.all(ids.map((id) => readNativeMesh(core, id, { release: true })));
    return soups.map((soup) => pointsFromCutSpace(soup, scale));
  } finally {
    // Ids already read with `release` are gone; dropping them again is a no-op.
    await dropNativeMeshes(core, [...ids]).catch(() => undefined);
  }
}

/**
 * Runs an organic cut on an open session, which stays as it was. Returns ALL parts + a report.
 * A multi-loop cut that frees several pieces returns >2 parts (one per piece). Returns null
 * outside the Tauri runtime.
 */
export async function cutFromSource(
  source: CutSource,
  options: OrganicCutOptions,
): Promise<OrganicCutResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify({ ...options, cut: specToCutSpace(options.cut, source.scale) });
  const reportJson = await invokeOnSource<string>(core, source, 'mesh_organic_cut_session_apply', { optionsJson });
  const { partIds = [], ...raw } = JSON.parse(reportJson) as OrganicCutReport & { partIds?: string[] };
  const parts = await takeSoups(core, partIds, source.scale);
  return { report: reportFromCutSpace(raw, source.scale), parts };
}

function reportFromCutSpace(report: OrganicCutReport, scale: CutScale): OrganicCutReport {
  if (!report.leakPoints?.length) return report;
  const flat = pointsFromCutSpace(new Float32Array(report.leakPoints.flat()), scale);
  return { ...report, leakPoints: report.leakPoints.map((_, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]) };
}

/**
 * Computes a surface-following loop polyline through the given waypoints on an open session.
 * Returns the polyline as a flat Float32Array (3 per point), or null outside Tauri / on
 * failure.
 */
export async function computeGeodesicLoop(
  source: CutSource,
  loopPoints: OrganicCutLoopPoint[],
  close: boolean,
  smoothing = 0.5,
): Promise<Float32Array | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  if (loopPoints.length < 2) return null;

  const requestJson = JSON.stringify({
    points: loopPoints.map((p) => ({ position: vectorToCutSpace(p.position, source.scale) })),
    close,
    smoothing,
  });
  try {
    // Single IPC round-trip: the polyline's raw LE f32 bytes are the response body. This is
    // the hot path while dragging a waypoint — one hop per frame.
    const bytes = await invokeOnSource<ArrayBuffer | Uint8Array | number[]>(
      core,
      source,
      'mesh_organic_cut_session_geodesic_loop',
      { requestJson },
    );
    const points = decodeF32(bytes, 'mesh_organic_cut_session_geodesic_loop');
    if (points.length < 6) return null; // < 2 points
    return pointsFromCutSpace(points, source.scale);
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

const EMPTY_PREVIEW: MembranePreviewResult = {
  membrane: null,
  tenonPreview: null,
  tenonTriangleCount: 0,
  tenonKind: 'none',
  tenonFits: true,
  tenonDetail: '',
  tenonFrame: null,
};

/** What a preview command reports: its counts and tenon details, and the ids of its soups. */
interface PreviewReport {
  triangleCount: number;
  jointTriangleCount?: number;
  tenonTriangleCount?: number;
  tenonKind?: TenonPreviewKind;
  tenonFits?: boolean;
  tenonDetail?: string;
  tenonFrame?: TenonPreviewFrame | null;
  membraneId?: string;
  tenonId?: string;
}

/** Collects a preview command's result: reads its soups, drops them, and unscales it all. */
async function collectPreview(
  core: TauriCoreModule,
  source: CutSource,
  reportJson: string,
): Promise<MembranePreviewResult> {
  const report = JSON.parse(reportJson) as PreviewReport;
  const ids = [report.membraneId, report.tenonId].filter((id): id is string => !!id);
  const soups = await takeSoups(core, ids, source.scale);
  const soupFor = (id: string | undefined) => (id ? soups[ids.indexOf(id)] : null);
  return {
    membrane: soupFor(report.membraneId),
    tenonPreview: soupFor(report.tenonId),
    tenonTriangleCount: report.tenonTriangleCount ?? 0,
    tenonKind: report.tenonKind ?? 'none',
    tenonFits: report.tenonFits ?? true,
    tenonDetail: report.tenonDetail ?? '',
    tenonFrame: report.tenonFrame ? frameFromCutSpace(report.tenonFrame, source.scale) : null,
  };
}

/**
 * Builds the contour-cut MEMBRANE (and, when `generateTenon`, the registration tenon) for the
 * given loop on an open session, returning each as a flat triangle soup (9 floats per
 * triangle, model-local) for previewing in the scene. Returns a result with null soups
 * outside Tauri / on failure / <3 points.
 */
export async function computeMembranePreview(
  source: CutSource,
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
  const core = await loadTauriCore();
  if (!core) return { ...EMPTY_PREVIEW };
  if (loopPoints.length < 3) return { ...EMPTY_PREVIEW };

  const requestJson = JSON.stringify({
    points: loopPoints.map((p) => ({ position: loopPointToCutSpace(p, source.scale).position })),
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
    tenonAnchor: tenonAnchor && vectorToCutSpace(tenonAnchor, source.scale),
    tenonTiltRad,
    tenonRollRad,
  });
  try {
    const reportJson = await invokeOnSource<string>(
      core,
      source,
      'mesh_organic_cut_session_membrane_preview',
      { requestJson },
    );
    return await collectPreview(core, source, reportJson);
  } catch (err) {
    console.error('[organicCut] membrane preview command failed', err);
    return { ...EMPTY_PREVIEW };
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
  source: CutSource,
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
  const core = await loadTauriCore();
  if (!core) return { ...EMPTY_PREVIEW };

  const plane = planeToCutSpace({ normal: planeNormal, offset: planeOffset }, source.scale);
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
    tenonAnchor: tenonAnchor && vectorToCutSpace(tenonAnchor, source.scale),
  });
  try {
    const reportJson = await invokeOnSource<string>(
      core,
      source,
      'mesh_organic_cut_session_plane_tenon_preview',
      { requestJson },
    );
    return await collectPreview(core, source, reportJson);
  } catch (err) {
    console.error('[organicCut] plane tenon preview command failed', err);
    return { ...EMPTY_PREVIEW };
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
