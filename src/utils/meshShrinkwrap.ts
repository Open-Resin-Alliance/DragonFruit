import * as THREE from 'three';
import { takeResultPositions, withNativeMesh } from './nativeMeshStore';
import {
  loadTauriCore,
  solidRemeshStoredMesh,
  tetSurfaceStoredMesh,
  type SolidRemeshOptions,
  type SolidRemeshProgress,
  type SolidRemeshReport,
  type StoredSurfacingReport,
  type TauriCoreModule,
  type TetWrapOptions,
  type TetWrapProgress,
  type TetWrapReport,
} from './tauriMeshBridge';

export type { SolidRemeshOptions, SolidRemeshProgress, SolidRemeshReport };
export type { TetWrapOptions, TetWrapProgress, TetWrapReport };

/** A surfacing run's progress, told as the engine announces its phases. */
interface SurfacingProgressSink<P> {
  /** Called as each phase starts. */
  onProgress?: (progress: P) => void;
  /**
   * Called with the run's token before it starts, so the caller can hold onto it and cancel.
   * A cancel lands at the next phase boundary, never mid-phase.
   */
  onToken?: (token: string) => void;
}

/** The result of a tetrahedral surfacing run: the new surface and its report. */
export interface TetSurfaceResult {
  report: TetWrapReport;
  /** The rebuilt surface. A brand-new geometry: only its shape relates to the input. */
  geometry: THREE.BufferGeometry;
}

/** A tetrahedral surfacing run's progress, told as the engine announces its phases. */
export type TetSurfaceProgressSink = SurfacingProgressSink<TetWrapProgress>;

/** The result of a shrink-wrap run: the new surface and its report. */
export interface SolidRemeshResult {
  report: SolidRemeshReport;
  /** The rebuilt surface. A resolved surface, not a repaired one. */
  geometry: THREE.BufferGeometry;
}

/** A shrink-wrap run's progress, told as the engine announces its phases. */
export type SolidRemeshProgressSink = SurfacingProgressSink<SolidRemeshProgress>;

/**
 * Runs one surfacing command on a geometry: puts it into the native store, runs the command on
 * its id, collects the result by the id the command returns, and drops the input. Returns `null`
 * in the browser, where there is no native side to ask.
 */
async function surfaceGeometry<R extends object, P extends { token: string }>(
  geometry: THREE.BufferGeometry,
  command: string,
  progressEvent: string,
  sink: SurfacingProgressSink<P> | undefined,
  run: (core: TauriCoreModule, meshId: string, token: string | null) => Promise<StoredSurfacingReport<R>>,
): Promise<{ report: R; geometry: THREE.BufferGeometry } | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const wantsProgress = Boolean(sink?.onProgress || sink?.onToken);
  const token = wantsProgress ? crypto.randomUUID() : null;
  let unlisten: (() => void) | null = null;
  if (token && sink) {
    sink.onToken?.(token);
    unlisten = await core.listen<P>(progressEvent, (event) => {
      const progress = event.payload;
      if (progress && progress.token === token) sink.onProgress?.(progress);
    });
  }

  try {
    return await withNativeMesh(core, geometry, async (meshId) => {
      const report: R & { meshId?: string } = await run(core, meshId, token);
      const positions = await takeResultPositions(core, report, command);
      delete report.meshId;

      const next = new THREE.BufferGeometry();
      next.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      next.computeVertexNormals();
      next.computeBoundingBox();
      next.computeBoundingSphere();
      return { report, geometry: next };
    });
  } finally {
    unlisten?.();
  }
}

/**
 * Rebuild a geometry's surface by resolving it into a solid.
 *
 * Returns `null` in the browser, where there is no native side to ask; the caller treats that as the
 * feature being unavailable. A run takes a couple of seconds on a large model, so `sink` hears each
 * phase as it starts.
 */
export function solidRemeshFromGeometry(
  geometry: THREE.BufferGeometry,
  options: SolidRemeshOptions,
  sink?: SolidRemeshProgressSink,
): Promise<SolidRemeshResult | null> {
  return surfaceGeometry<SolidRemeshReport, SolidRemeshProgress>(
    geometry,
    'mesh_solid_remesh_staged',
    'mesh-solid-remesh-progress',
    sink,
    (core, meshId, token) => solidRemeshStoredMesh(core.invoke, meshId, options, token),
  );
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
export function tetSurfaceFromGeometry(
  geometry: THREE.BufferGeometry,
  options: TetWrapOptions,
  sink?: TetSurfaceProgressSink,
): Promise<TetSurfaceResult | null> {
  return surfaceGeometry<TetWrapReport, TetWrapProgress>(
    geometry,
    'mesh_tet_surface_staged',
    'mesh-tet-surface-progress',
    sink,
    (core, meshId, token) => tetSurfaceStoredMesh(core.invoke, meshId, options, token),
  );
}
