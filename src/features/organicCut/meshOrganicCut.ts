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
import type { OrganicCutLoopPoint, OrganicCutOptions, OrganicCutReport, OrganicCutResult } from './types';

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
  | 'mesh_organic_cut_read_geodesic';

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
export async function stageCutSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) return false;

  if (stagedCutSourceKey === sourceKey) {
    return true;
  }

  await stageGeometryToStagedMesh(core.invoke, geometry);
  await core.invoke('mesh_organic_cut_capture_staged_source');
  stagedCutSourceKey = sourceKey;
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
): Promise<Float32Array | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  if (loopPoints.length < 2) return null;

  const requestJson = JSON.stringify({
    points: loopPoints.map((p) => ({ position: p.position })),
    close,
  });
  try {
    const reportJson = await core.invoke<string>('mesh_organic_cut_geodesic_loop', { requestJson });
    const report = JSON.parse(reportJson) as { pointCount: number };
    if (!report.pointCount) return null;
    return await readPositionsFromCommand(core.invoke, 'mesh_organic_cut_read_geodesic');
  } catch {
    return null;
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
