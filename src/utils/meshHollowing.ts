/**
 * The frontend's side of voxel hollowing. Every pass runs on the native mesh store
 * (`nativeMeshStore.ts`): the one-shot hollow on a mesh put for the length of the call, and
 * the preview on a session the store holds, opened once per source geometry and named by id
 * in each call. Each output comes back as an id, read once and dropped here; see
 * `docs/dev/native-mesh-store.md`.
 */
import * as THREE from 'three';
import {
  asNativeMeshStoreError,
  dropNativeMeshes,
  readNativeBuffer,
  readNativeMesh,
  resultMeshId,
  withNativeMesh,
} from './nativeMeshStore';
import { type TauriCoreModule, loadTauriCore } from './tauriMeshBridge';

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
  blockedVoxelIndices?: Uint32Array;
}

/** Request for the Rust-side lasso voxel selection. Mirrors the model
 *  transform + camera projection the frontend lasso resolver used before the
 *  per-voxel projection moved into Rust. */
export interface SelectRemovedVoxelsInPolygonRequest {
  /** Lasso polygon in container-pixel space (same space as the resolver's
   *  projectWorldPoint output): [[px, py], ...]. */
  polygon: Array<[number, number]>;
  /** Column-major camera.projectionMatrix * matrixWorldInverse (16 floats). */
  viewProj: number[];
  rectWidth: number;
  rectHeight: number;
  geometryCenter: [number, number, number];
  scale: [number, number, number];
  rotationQuat: [number, number, number, number];
  position: [number, number, number];
  options: HollowOptions;
}

/** The ids a hollow command reports beside its report fields, one per output it stored. */
const HOLLOW_OUTPUT_ID_KEYS = [
  'meshId',
  'cavityId',
  'infillId',
  'removedVoxelCentersId',
  'removedVoxelIndicesId',
  'blockedVoxelCentersId',
  'blockedVoxelIndicesId',
] as const;

type HollowOutputIds = Partial<Record<(typeof HOLLOW_OUTPUT_ID_KEYS)[number], string>>;

/**
 * Reads a hollow command's outputs and drops every id it returned, read or not, so an output
 * the caller has no use for (the infill of a cavity preview, say) is not left in the store.
 */
async function collectHollowOutputs(
  core: TauriCoreModule,
  reportJson: string,
  command: string,
  { infill = false }: { infill?: boolean } = {},
): Promise<HollowResult> {
  const raw = JSON.parse(reportJson) as HollowReport & HollowOutputIds;
  const ids = HOLLOW_OUTPUT_ID_KEYS.flatMap((key) => (raw[key] ? [raw[key]] : []));
  const report = { ...raw };
  for (const key of HOLLOW_OUTPUT_ID_KEYS) delete report[key];

  const take = (id: string | undefined) => (id ? readNativeMesh(core, id, { release: true }) : undefined);
  const takeU32 = async (id: string | undefined) => (
    id ? new Uint32Array(await readNativeBuffer(core, id, { release: true })) : undefined
  );
  try {
    const [
      positions,
      cavityPositions,
      infillPositions,
      removedVoxelCenters,
      removedVoxelIndices,
      blockedVoxelCenters,
      blockedVoxelIndices,
    ] = await Promise.all([
      readNativeMesh(core, resultMeshId(raw, command), { release: true }),
      take(raw.cavityId),
      infill ? take(raw.infillId) : undefined,
      take(raw.removedVoxelCentersId),
      takeU32(raw.removedVoxelIndicesId),
      take(raw.blockedVoxelCentersId),
      takeU32(raw.blockedVoxelIndicesId),
    ]);
    return {
      report,
      positions,
      cavityPositions,
      infillPositions,
      removedVoxelCenters,
      removedVoxelIndices,
      blockedVoxelCenters,
      blockedVoxelIndices,
    };
  } finally {
    // Ids already read with `release` are gone; dropping them again is a no-op.
    await dropNativeMeshes(core, ids).catch(() => undefined);
  }
}

/** Hollows a geometry once, with no session: the output path, where nothing is previewed. */
export async function hollowFromGeometry(
  geometry: THREE.BufferGeometry,
  options: HollowOptions,
): Promise<HollowResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify(options);
  return withNativeMesh(core, geometry, async (meshId) => {
    const reportJson = await core.invoke<string>('mesh_hollow_staged', { optionsJson, meshId });
    return collectHollowOutputs(core, reportJson, 'mesh_hollow_staged');
  });
}

/** The hollow session open for the geometry being previewed, keyed by the caller's source key. */
let openSession: { sourceKey: string; sessionId: Promise<string> } | null = null;

/**
 * The id of a hollow session on this geometry: the one already open when `sourceKey` matches,
 * otherwise a new one, and the previous session is dropped. The native side keeps the session's
 * voxel grid between calls, so previews that only change the shell or infill do not rebuild it.
 * Returns null outside the Tauri runtime.
 */
export async function openHollowSession(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
): Promise<string | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  if (openSession?.sourceKey === sourceKey) {
    return openSession.sessionId;
  }

  const previous = openSession;
  const sessionId = withNativeMesh(core, geometry, (meshId) => (
    core.invoke<string>('mesh_hollow_session_open', { meshId })
  ));
  const opened = { sourceKey, sessionId };
  openSession = opened;
  // A session that failed to open is not kept: the next call tries again.
  sessionId.catch(() => {
    if (openSession === opened) openSession = null;
  });
  if (previous) {
    void previous.sessionId
      .then((id) => dropNativeMeshes(core, [id]))
      .catch(() => undefined);
  }
  return sessionId;
}

/**
 * Runs a command on a session. When the store no longer has the session (released to stay in
 * its budget, or dropped), it is forgotten, so the next `openHollowSession` opens a new one;
 * the error still reaches the caller.
 */
async function invokeOnSession<T>(
  core: TauriCoreModule,
  sessionId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await core.invoke<T>(command, { sessionId, ...args });
  } catch (error) {
    const storeError = asNativeMeshStoreError(error);
    if (storeError && storeError.message.includes(`'${sessionId}'`) && openSession) {
      const open = openSession;
      if (await open.sessionId.catch(() => null) === sessionId && openSession === open) {
        openSession = null;
      }
    }
    throw storeError ?? error;
  }
}

/** Previews a hollow on an open session. Returns null outside the Tauri runtime. */
export async function previewHollowSession(
  sessionId: string,
  options: HollowOptions,
): Promise<HollowResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const reportJson = await invokeOnSession<string>(core, sessionId, 'mesh_hollow_session_preview', {
    optionsJson: JSON.stringify(options),
  });
  return collectHollowOutputs(core, reportJson, 'mesh_hollow_session_preview', {
    infill: options.mode === 'infill',
  });
}

/** Runs the hollow an open session previews, for real. Returns null outside the Tauri runtime. */
export async function applyHollowSession(
  sessionId: string,
  options: HollowOptions,
): Promise<HollowResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const reportJson = await invokeOnSession<string>(core, sessionId, 'mesh_hollow_session_apply', {
    optionsJson: JSON.stringify(options),
  });
  return collectHollowOutputs(core, reportJson, 'mesh_hollow_session_apply');
}

/** Rust-side lasso selection of the FULL through-depth cavity voxel column
 *  under the polygon, on the session's voxel grid. Returns the selected grid
 *  indices, or null outside the Tauri runtime. Decoupled from the
 *  boundary-filtered / capped rendered set, which is why selection can no
 *  longer only reach the surface layer. */
export async function selectRemovedVoxelsInPolygon(
  sessionId: string,
  request: SelectRemovedVoxelsInPolygonRequest,
): Promise<Uint32Array | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const bytes = await invokeOnSession<ArrayBuffer | Uint8Array | number[]>(
    core,
    sessionId,
    'mesh_hollow_session_select_removed_voxels',
    { requestJson: JSON.stringify(request) },
  );
  const u8 = bytes instanceof ArrayBuffer || Array.isArray(bytes)
    ? new Uint8Array(bytes)
    : bytes instanceof Uint8Array
      ? bytes
      : null;
  if (!u8) {
    throw new Error('mesh_hollow_session_select_removed_voxels returned unexpected type');
  }
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Uint32Array(copy.buffer);
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
