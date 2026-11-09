import * as THREE from 'three';
import {
  loadTauriCore,
  readPositionsFromCommand,
  solidRemeshStagedMesh,
  stageGeometryToStagedMesh,
  tetSurfaceStagedMesh,
  type SolidRemeshOptions,
  type SolidRemeshProgress,
  type SolidRemeshReport,
  type TetWrapOptions,
  type TetWrapProgress,
  type TetWrapReport,
} from './tauriMeshBridge';

export type { SolidRemeshOptions, SolidRemeshProgress, SolidRemeshReport };
export type { TetWrapOptions, TetWrapProgress, TetWrapReport };

/** A shrinkwrap run's progress, told as the engine announces its phases. */
/** The result of a tetrahedral surfacing run: the new surface and its report. */
export interface TetSurfaceResult {
  report: TetWrapReport;
  /** The rebuilt surface. A brand-new geometry: only its shape relates to the input. */
  geometry: THREE.BufferGeometry;
}

/** A tetrahedral surfacing run's progress, told as the engine announces its phases. */
export interface TetSurfaceProgressSink {
  /** Called as each phase starts. */
  onProgress?: (progress: TetWrapProgress) => void;
  /**
   * Called with the run's token before it starts, so the caller can hold onto it and cancel.
   * A cancel lands at the next phase boundary, never mid-phase.
   */
  onToken?: (token: string) => void;
}

/**
 * Rebuild a geometry by tetrahedralising its points and keeping the inside/outside boundary.
 *
 * Unlike the shrinkwrap resampler, the decomposition follows the model's own points rather than a
 * uniform lattice, so it keeps detail a voxel size would destroy, and the boundary between two
 * labels is closed by construction, so it emits no debris. Returns `null` in the browser, where
 * there is no native side to ask; the caller treats that as the feature being unavailable.
 *
 * A resample runs for tens of seconds on a large model, so `sink` hears each phase as it starts.
 */
/** The result of a shrink-wrap run: the new surface and its report. */
export interface SolidRemeshResult {
  report: SolidRemeshReport;
  /** The rebuilt surface. A resolved surface, not a repaired one. */
  geometry: THREE.BufferGeometry;
}

/** A shrink-wrap run's progress, told as the engine announces its phases. */
export interface SolidRemeshProgressSink {
  onProgress?: (progress: SolidRemeshProgress) => void;
  onToken?: (token: string) => void;
}

/**
 * Rebuild a geometry's surface by resolving it into a solid.
 *
 * Returns `null` in the browser, where there is no native side to ask; the caller treats that as the
 * feature being unavailable. A run takes a couple of seconds on a large model, so `sink` hears each
 * phase as it starts.
 */
export async function solidRemeshFromGeometry(
  geometry: THREE.BufferGeometry,
  options: SolidRemeshOptions,
  sink?: SolidRemeshProgressSink,
): Promise<SolidRemeshResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const wantsProgress = Boolean(sink?.onProgress || sink?.onToken);
  const token = wantsProgress ? crypto.randomUUID() : null;
  let unlisten: (() => void) | null = null;
  if (token && sink) {
    sink.onToken?.(token);
    unlisten = await core.listen<SolidRemeshProgress>('mesh-solid-remesh-progress', (event) => {
      const progress = event.payload;
      if (progress && progress.token === token) sink.onProgress?.(progress);
    });
  }

  try {
    await stageGeometryToStagedMesh(core.invoke, geometry);
    const report = await solidRemeshStagedMesh(core.invoke, options, token);
    const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');

    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    next.computeVertexNormals();
    next.computeBoundingBox();
    next.computeBoundingSphere();
    return { report, geometry: next };
  } finally {
    unlisten?.();
  }
}

export async function tetSurfaceFromGeometry(
  geometry: THREE.BufferGeometry,
  options: TetWrapOptions,
  sink?: TetSurfaceProgressSink,
): Promise<TetSurfaceResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const wantsProgress = Boolean(sink?.onProgress || sink?.onToken);
  const token = wantsProgress ? crypto.randomUUID() : null;
  let unlisten: (() => void) | null = null;
  if (token && sink) {
    sink.onToken?.(token);
    unlisten = await core.listen<TetWrapProgress>('mesh-tet-surface-progress', (event) => {
      const progress = event.payload;
      if (progress && progress.token === token) sink.onProgress?.(progress);
    });
  }

  try {
    await stageGeometryToStagedMesh(core.invoke, geometry);
    const report = await tetSurfaceStagedMesh(core.invoke, options, token);
    const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');

    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    next.computeVertexNormals();
    next.computeBoundingBox();
    next.computeBoundingSphere();
    return { report, geometry: next };
  } finally {
    unlisten?.();
  }
}
