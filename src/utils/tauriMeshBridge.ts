import * as THREE from 'three';
import { isTauriRuntime } from './tauriRuntime';

export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView,
  opts?: { headers?: Record<string, string> },
) => Promise<T>;

export interface TauriCoreModule {
  invoke: TauriInvoke;
}

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;

/** Resolve the Tauri `invoke` binding, or null in the browser. Cached. */
export async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

/**
 * Flatten a geometry into a non-indexed f32 triangle soup, expanding the index
 * buffer when present. Returns the existing array when already flat.
 */
export function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('expandGeometryToTriangleSoup: geometry has no position attribute');

  const positions = posAttr.array as ArrayLike<number>;
  const index = geometry.getIndex();
  if (!index) {
    if (positions instanceof Float32Array) return positions;
    return Float32Array.from(positions);
  }

  const indexArr = index.array as ArrayLike<number>;
  const soup = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i += 1) {
    const src = indexArr[i] * 3;
    const dst = i * 3;
    soup[dst] = positions[src];
    soup[dst + 1] = positions[src + 1];
    soup[dst + 2] = positions[src + 2];
  }
  return soup;
}

/** Upload a geometry to the shared Rust staging buffer as a binary triangle soup. */
export async function stageGeometryToStagedMesh(
  invoke: TauriInvoke,
  geometry: THREE.BufferGeometry,
): Promise<void> {
  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  await invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

/**
 * Decode raw little-endian f32 bytes returned over IPC. `label` names the source
 * in the error message. The bytes are copied into an aligned buffer so the
 * result is self-contained.
 */
export function decodeF32(bytes: ArrayBuffer | Uint8Array | number[], label: string): Float32Array {
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error(`${label} returned unexpected type`);
  }

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

/** Commands that return a raw little-endian f32 position payload. */
export type MeshPositionReadCommand =
  | 'mesh_repair_read_positions'
  | 'mesh_punch_read_positions'
  | 'mesh_hollow_preview_read_positions'
  | 'mesh_hollow_preview_read_infill_positions'
  | 'mesh_hollow_preview_read_removed_voxel_centers'
  | 'mesh_hollow_preview_read_blocked_voxel_centers'
  | 'mesh_hollow_preview_read_cavity_positions'
  | 'mesh_hollow_staged_read_cavity_positions'
  | 'mesh_organic_cut_read_geodesic'
  | 'mesh_organic_cut_read_membrane'
  | 'mesh_organic_cut_read_tenon';

/** Invoke a position-reading command and decode its f32 payload. */
export async function readPositionsFromCommand(
  invoke: TauriInvoke,
  command: MeshPositionReadCommand,
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(command);
  return decodeF32(bytes, command);
}
