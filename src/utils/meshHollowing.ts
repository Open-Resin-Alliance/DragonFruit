import * as THREE from 'three';

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView, opts?: { headers?: Record<string, string> }) => Promise<T>;

interface TauriCoreModule {
  invoke: TauriInvoke;
}

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;
let stagedHollowPreviewSourceKey: string | null = null;

export type HollowMode = 'cavity' | 'infill' | 'shell_open_face';
export type InfillMode = 'lattice' | 'pillar';
export type OpenFace = 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max';

export interface DrainHoleSpec {
  centerNorm: [number, number, number];
  radiusMm: number;
  direction?: [number, number, number];
  lengthMm?: number;
}

export interface HollowOptions {
  mode: HollowMode;
  voxelResolution: number;
  shellThicknessMm: number;
  blockedVoxelIndices?: number[];
  infillMode: InfillMode;
  infillCellMm: number;
  infillBeamRadiusMm: number;
  openFace: OpenFace;
  drainHoles: DrainHoleSpec[];
  previewCavityOnly?: boolean;
  smoothInternalSurfaces?: boolean;
  internalChamferPasses?: number;
  /** When true, skip the smoothed cavity mesh and render spheres at
   *  removed-voxel centers for a near-instant preview. */
  previewVoxelSpheres?: boolean;
  /** Unit quaternion [x, y, z, w] to rotate the mesh before voxelizing,
   *  so pillar infills align with the model's scene rotation. The output
   *  is inversely rotated so DragonFruit's unrotated geometry stays in sync.
   *  Default identity [0,0,0,1] means no rotation. */
  rotationQuat?: [number, number, number, number];
}

export interface HollowReport {
  mode: HollowMode;
  voxelResolution: number;
  voxelSizeMm: number;
  shellThicknessMm: number;
  sourceTriangleCount: number;
  outputTriangleCount: number;
  gridSize: [number, number, number];
  occupiedVoxels: number;
  shellVoxels: number;
  removedVoxels: number;
}

export interface HollowResult {
  report: HollowReport;
  positions: Float32Array;
  /** Interior cavity surface mesh positions (for Interior View Mode). */
  cavityPositions?: Float32Array;
  infillPositions?: Float32Array;
  removedVoxelCenters?: Float32Array;
  removedVoxelIndices?: Uint32Array;
  blockedVoxelCenters?: Float32Array;
}

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

async function readStagedPositions(invoke: TauriInvoke): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>('mesh_repair_read_positions');
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error('mesh_repair_read_positions returned unexpected type');
  }

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
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

async function readPositionsFromCommand(
  invoke: TauriInvoke,
  command:
    | 'mesh_repair_read_positions'
    | 'mesh_hollow_preview_read_positions'
    | 'mesh_hollow_preview_read_infill_positions'
    | 'mesh_hollow_preview_read_removed_voxel_centers'
    | 'mesh_hollow_preview_read_blocked_voxel_centers'
    | 'mesh_hollow_preview_read_cavity_positions'
    | 'mesh_hollow_staged_read_cavity_positions',
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

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

async function readUint32FromCommand(
  invoke: TauriInvoke,
  command: 'mesh_hollow_preview_read_removed_voxel_indices',
): Promise<Uint32Array> {
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

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Uint32Array(copy.buffer);
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

export async function hollowFromGeometry(
  geometry: THREE.BufferGeometry,
  options: HollowOptions,
): Promise<HollowResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  await stageGeometryToStagedMesh(core.invoke, geometry);
  stagedHollowPreviewSourceKey = null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_hollow_staged', { optionsJson });
  const report = JSON.parse(reportJson) as HollowReport;
  const positions = await readStagedPositions(core.invoke);
  let cavityPositions: Float32Array | undefined;
  try {
    cavityPositions = await readPositionsFromCommand(core.invoke, 'mesh_hollow_staged_read_cavity_positions');
  } catch {
    cavityPositions = undefined;
  }
  return { report, positions, cavityPositions };
}

export async function stageHollowPreviewSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) return false;

  if (stagedHollowPreviewSourceKey === sourceKey) {
    return true;
  }

  await stageGeometryToStagedMesh(core.invoke, geometry);
  await core.invoke('mesh_hollow_preview_capture_staged_source');
  stagedHollowPreviewSourceKey = sourceKey;
  return true;
}

export async function hollowPreviewFromCapturedSource(
  options: HollowOptions,
): Promise<HollowResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_hollow_preview_from_captured_source', { optionsJson });
  const report = JSON.parse(reportJson) as HollowReport;
  const positions = await readPositionsFromCommand(core.invoke, 'mesh_hollow_preview_read_positions');
  let cavityPositions: Float32Array | undefined;
  try {
    cavityPositions = await readPositionsFromCommand(core.invoke, 'mesh_hollow_preview_read_cavity_positions');
  } catch {
    cavityPositions = undefined;
  }
  let infillPositions: Float32Array | undefined;
  let removedVoxelCenters: Float32Array | undefined;
  let removedVoxelIndices: Uint32Array | undefined;
  if (options.mode === 'infill') {
    try {
      infillPositions = await readPositionsFromCommand(core.invoke, 'mesh_hollow_preview_read_infill_positions');
    } catch {
      infillPositions = undefined;
    }
  }
  try {
    removedVoxelCenters = await readPositionsFromCommand(core.invoke, 'mesh_hollow_preview_read_removed_voxel_centers');
  } catch {
    removedVoxelCenters = undefined;
  }
  try {
    removedVoxelIndices = await readUint32FromCommand(core.invoke, 'mesh_hollow_preview_read_removed_voxel_indices');
  } catch {
    removedVoxelIndices = undefined;
  }
  let blockedVoxelCenters: Float32Array | undefined;
  try {
    blockedVoxelCenters = await readPositionsFromCommand(core.invoke, 'mesh_hollow_preview_read_blocked_voxel_centers');
  } catch {
    blockedVoxelCenters = undefined;
  }
  return { report, positions, cavityPositions, infillPositions, removedVoxelCenters, removedVoxelIndices, blockedVoxelCenters };
}

export async function hollowApplyFromCapturedSource(
  options: HollowOptions,
): Promise<HollowResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_hollow_apply_from_captured_source', { optionsJson });
  const report = JSON.parse(reportJson) as HollowReport;
  const positions = await readStagedPositions(core.invoke);
  let cavityPositions: Float32Array | undefined;
  try {
    cavityPositions = await readPositionsFromCommand(core.invoke, 'mesh_hollow_staged_read_cavity_positions');
  } catch {
    cavityPositions = undefined;
  }
  return { report, positions, cavityPositions };
}

export function applyHollowedPositions(geometry: THREE.BufferGeometry, positions: Float32Array): void {
  geometry.setIndex(null);
  const attrNames = Object.keys(geometry.attributes);
  for (const name of attrNames) {
    if (name !== 'position') geometry.deleteAttribute(name);
  }
  geometry.deleteAttribute('position');
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
