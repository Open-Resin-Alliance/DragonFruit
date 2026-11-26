/**
 * The frontend's side of hole punching. Every punch runs on the native mesh store
 * (`nativeMeshStore.ts`): the one-shot punch on a mesh put for the length of the call, and
 * the preview on a source the store keeps, put once per source geometry and punched again by
 * id on every change. The result comes back as an id, read once and dropped here; see
 * `docs/dev/native-mesh-store.md`.
 */
import * as THREE from 'three';
import {
  asNativeMeshStoreError,
  dropNativeMeshes,
  putNativeMesh,
  takeResultPositions,
  withNativeMesh,
} from './nativeMeshStore';
import { type TauriCoreModule, loadTauriCore } from './tauriMeshBridge';

export interface PunchSpec {
  centerNorm: [number, number, number];
  radiusMm: number;
  radiusYMm?: number;
  direction?: [number, number, number];
  lengthMm?: number;
}

export interface PunchOptions {
  punches: PunchSpec[];
}

export interface PunchReport {
  sourceTriangleCount: number;
  outputTriangleCount: number;
  removedTriangleCount: number;
  punchCount: number;
}

export interface PunchResult {
  report: PunchReport;
  positions: Float32Array;
}

/** Runs `mesh_punch_staged` on a stored mesh and collects its result. */
async function punchStored(
  core: TauriCoreModule,
  meshId: string,
  options: PunchOptions,
): Promise<PunchResult> {
  const reportJson = await core.invoke<string>('mesh_punch_staged', {
    optionsJson: JSON.stringify(options),
    meshId,
  });
  const report = JSON.parse(reportJson) as PunchReport & { meshId?: string };
  const positions = await takeResultPositions(core, report, 'mesh_punch_staged');
  delete report.meshId;
  return { report, positions };
}

/** Punches a geometry once. Returns null outside the Tauri runtime. */
export async function punchFromGeometry(
  geometry: THREE.BufferGeometry,
  options: PunchOptions,
): Promise<PunchResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  return withNativeMesh(core, geometry, (meshId) => punchStored(core, meshId, options));
}

let openSource: { sourceKey: string; sourceId: Promise<string> } | null = null;

/**
 * The id of the stored source for the hole punch preview: the one already stored when
 * `sourceKey` matches, otherwise the geometry is put and the previous source dropped. A punch
 * leaves its source as it was, so each change punches the same one again. Returns null
 * outside the Tauri runtime.
 */
export async function openPunchSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
): Promise<string | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  if (openSource?.sourceKey === sourceKey) {
    return openSource.sourceId;
  }

  const previous = openSource;
  const sourceId = putNativeMesh(core, geometry);
  const opened = { sourceKey, sourceId };
  openSource = opened;
  // A source that failed to store is not kept: the next call tries again.
  sourceId.catch(() => {
    if (openSource === opened) openSource = null;
  });
  if (previous) {
    void previous.sourceId
      .then((id) => dropNativeMeshes(core, [id]))
      .catch(() => undefined);
  }
  return sourceId;
}

/**
 * Punches the stored source. When the store no longer has it (released to stay in its
 * budget, or dropped), it is forgotten, so the next `openPunchSource` stores it again; the
 * error still reaches the caller. Returns null outside the Tauri runtime.
 */
export async function punchStoredSource(
  sourceId: string,
  options: PunchOptions,
): Promise<PunchResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  try {
    return await punchStored(core, sourceId, options);
  } catch (error) {
    const storeError = asNativeMeshStoreError(error);
    if (storeError && storeError.message.includes(`'${sourceId}'`) && openSource) {
      const open = openSource;
      if (await open.sourceId.catch(() => null) === sourceId && openSource === open) {
        openSource = null;
      }
    }
    throw storeError ?? error;
  }
}
