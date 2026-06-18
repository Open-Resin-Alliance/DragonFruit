/**
 * Organic Cut — frontend ↔ Rust bridge.
 *
 * Mirrors the proven hole-punch bridge (src/utils/meshPunching.ts): stage the
 * geometry as a binary triangle soup, capture it as a non-mutating source, run a
 * preview/apply, then read raw little-endian f32 positions back. The only shape
 * difference is that an organic cut returns TWO parts (A and B) rather than one
 * modified mesh, so there are two read-positions commands.
 *
 * M1: the backend cut is a no-op, so both parts come back equal to the source.
 */
import * as THREE from 'three';
import type { KeyPreviewFrame, OrganicCutLoopPoint, OrganicCutOptions, OrganicMultiCutOptions, OrganicCutReport, OrganicCutResult } from './types';

type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView,
  opts?: { headers?: Record<string, string> },
) => Promise<T>;

interface TauriCoreModule {
  invoke: TauriInvoke;
}

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;
let stagedCutSourceKey: string | null = null;
// The geometry OBJECT last staged. Tracked alongside the key so that if a model's
// geometry is replaced under the SAME id (e.g. a cut then undo restores the
// original geometry reference), we detect the change and re-stage instead of
// reusing the stale captured source.
let stagedCutSourceGeometry: THREE.BufferGeometry | null = null;

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

type OrganicCutReadCommand =
  | 'mesh_organic_cut_read_part_a'
  | 'mesh_organic_cut_read_part_b'
  | 'mesh_organic_cut_read_geodesic'
  | 'mesh_organic_cut_read_membrane'
  | 'mesh_organic_cut_read_key';

async function readPositionsFromCommand(
  invoke: TauriInvoke,
  command: OrganicCutReadCommand,
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(command);
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error(`${command} returned unexpected type`);
  }

  // Copy into a fresh, aligned buffer before viewing as f32 (the IPC buffer may
  // be a non-zero byteOffset view, which Float32Array can't wrap directly).
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  const index = geometry.getIndex();

  if (!index) {
    if (positions instanceof Float32Array) return positions;
    return new Float32Array(positions as unknown as ArrayLike<number>);
  }

  const indexArr = index.array as Uint16Array | Uint32Array;
  const out = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i += 1) {
    const vi = indexArr[i] * 3;
    const oi = i * 3;
    out[oi] = positions[vi];
    out[oi + 1] = positions[vi + 1];
    out[oi + 2] = positions[vi + 2];
  }
  return out;
}

async function stageGeometryToStagedMesh(
  invoke: TauriInvoke,
  geometry: THREE.BufferGeometry,
): Promise<void> {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('stageGeometryToStagedMesh: geometry has no position attribute');

  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  await invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

async function readBothParts(invoke: TauriInvoke): Promise<{ partA: Float32Array; partB: Float32Array }> {
  const partA = await readPositionsFromCommand(invoke, 'mesh_organic_cut_read_part_a');
  const partB = await readPositionsFromCommand(invoke, 'mesh_organic_cut_read_part_b');
  return { partA, partB };
}

/**
 * Captures the given geometry as the non-mutating cut source for repeated
 * previews. Keyed so re-staging the same geometry is a cheap no-op.
 */
/**
 * True if the given source key is already staged + captured, so callers on a hot
 * path (e.g. the per-frame geodesic during a waypoint drag) can skip the
 * `stageCutSource` await entirely.
 */
export function isCutSourceStaged(sourceKey: string, geometry?: THREE.BufferGeometry): boolean {
  if (stagedCutSourceKey !== sourceKey) return false;
  // Same key but a different geometry object → the mesh was replaced (cut/undo);
  // treat as not staged so callers re-stage the current geometry.
  if (geometry && stagedCutSourceGeometry !== geometry) return false;
  return true;
}

export async function stageCutSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) return false;

  // Re-stage if either the key OR the geometry object changed (same id can carry
  // new geometry after a cut/undo).
  if (stagedCutSourceKey === sourceKey && stagedCutSourceGeometry === geometry) {
    return true;
  }

  await stageGeometryToStagedMesh(core.invoke, geometry);
  await core.invoke('mesh_organic_cut_capture_staged_source');
  stagedCutSourceKey = sourceKey;
  stagedCutSourceGeometry = geometry;
  return true;
}

/**
 * Runs an organic cut against the previously captured source without mutating
 * the staged mesh buffer. Returns both parts + a report.
 */
export async function cutFromCapturedSource(
  options: OrganicCutOptions,
): Promise<OrganicCutResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_organic_cut_from_captured_source', { optionsJson });
  const report = JSON.parse(reportJson) as OrganicCutReport;
  const { partA, partB } = await readBothParts(core.invoke);
  return { report, partA, partB };
}

/**
 * Runs a simultaneous multi-cut against the previously captured source.
 * Returns both parts + a report.
 */
export async function multiCutFromCapturedSource(
  options: OrganicMultiCutOptions,
): Promise<OrganicCutResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_organic_multi_cut_from_captured_source', { optionsJson });
  const report = JSON.parse(reportJson) as OrganicCutReport;
  const { partA, partB } = await readBothParts(core.invoke);
  return { report, partA, partB };
}

/**
 * One-shot: stage the geometry and run the cut, returning both parts.
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

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_organic_cut_staged', { optionsJson });
  const report = JSON.parse(reportJson) as OrganicCutReport;
  const { partA, partB } = await readBothParts(core.invoke);
  return { report, partA, partB };
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
    points: loopPoints.map((p) => ({ position: p.position })),
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
    return new Float32Array(copy.buffer);
  } catch {
    return null;
  }
}

/** Which key the preview placed: a frustum, a half-sphere dome, or none. */
export type KeyPreviewKind = 'frustum' | 'dome' | 'none';

/**
 * Result of the contour-cut preview round-trip: the membrane cutter soup plus,
 * when a key was requested, the key (peg + socket) soup and the chosen-rung kind
 * + a human-readable reason (for the fell-back/no-key alert).
 */
export interface MembranePreviewResult {
  /** The cutter membrane/slab soup (9 floats per triangle), or null. */
  membrane: Float32Array | null;
  /** The key (peg + socket) soup, or null when no key / not requested. */
  keyPreview: Float32Array | null;
  /** Which key rung was chosen. 'none' when not requested or too thin. */
  keyKind: KeyPreviewKind;
  /** Reason the key shrank / fell back / was skipped. Empty when nominal/off. */
  keyDetail: string;
  /**
   * Placement frame of the previewed key (model-local), for the aim+roll gizmo.
   * Null when no key was placed.
   */
  keyFrame: KeyPreviewFrame | null;
}

/**
 * Builds the contour-cut MEMBRANE (and, when `generateKey`, the registration key)
 * for the given loop, returning each as a flat triangle soup (9 floats per
 * triangle, model-local) for previewing in the scene. Requires the source already
 * staged + captured. Returns a result with null soups outside Tauri / on failure /
 * <3 points.
 */
export async function computeMembranePreview(
  loopPoints: OrganicCutLoopPoint[],
  membraneSmoothing = 0.5,
  density = 1.0,
  thicknessMm = 0.1,
  generateKey = false,
  keyWidthMm = 2.0,
  keyDepthMm = 2.5,
  keyShape: 'frustum' | 'dome' | (string & {}) = 'frustum',
  keyFilletMm = 0.0,
  keySwapSides = false,
  keyTiltRad = 0.0,
  keyTiltAzimuthRad = 0.0,
  keyRollRad = 0.0,
  mode: 'plane' | 'contour' | 'bounded_plane' = 'plane',
  sides = 4,
  radius = 20.0,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  keyFlatMm = 1.0,
  keyToleranceMm = 0.1,
): Promise<MembranePreviewResult> {
  const empty: MembranePreviewResult = {
    membrane: null,
    keyPreview: null,
    keyKind: 'none',
    keyDetail: '',
    keyFrame: null,
  };
  const core = await loadTauriCore();
  if (!core) return empty;
  if (mode !== 'bounded_plane' && loopPoints.length < 3) return empty;

  const requestJson = JSON.stringify({
    points: loopPoints.map((p) => ({ position: p.position })),
    close: true,
    membraneSmoothing,
    density,
    thicknessMm,
    generateKey,
    keyWidthMm,
    keyDepthMm,
    keyShape,
    keyFilletMm,
    keySwapSides,
    keyTiltRad,
    keyTiltAzimuthRad,
    keyRollRad,
    mode,
    sides,
    radius,
    position,
    rotation,
    keyFlatMm,
    keyToleranceMm,
  });
  try {
    const reportJson = await core.invoke<string>('mesh_organic_cut_membrane_preview', { requestJson });
    const report = JSON.parse(reportJson) as {
      triangleCount: number;
      keyTriangleCount?: number;
      keyKind?: KeyPreviewKind;
      keyDetail?: string;
      keyFrame?: KeyPreviewFrame | null;
    };
    const membrane = report.triangleCount
      ? await readPositionsFromCommand(core.invoke, 'mesh_organic_cut_read_membrane')
      : null;
    const keyPreview = report.keyTriangleCount
      ? await readPositionsFromCommand(core.invoke, 'mesh_organic_cut_read_key')
      : null;
    return {
      membrane,
      keyPreview,
      keyKind: report.keyKind ?? 'none',
      keyDetail: report.keyDetail ?? '',
      keyFrame: report.keyFrame ?? null,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[organicCut] membrane preview command failed', err);
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
