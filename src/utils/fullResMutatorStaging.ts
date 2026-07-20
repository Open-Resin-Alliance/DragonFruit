/**
 * Full-resolution staging for the permanent geometry mutators
 * (STL-import decimation remediation, Phase 4; docs in
 * `agents/Claude/STL-import-perf/`).
 *
 * hollowing apply/preview, manual repair-in-place, and hole-punch apply
 * PERMANENTLY replace the scene geometry with an output built from whatever
 * they are handed. For a `_isNativePreview` model that input is the ~2M
 * decimated preview — so mutating a >budget import bakes the decimation
 * forever (unlike slicing, which re-reads per job). These helpers route those
 * mutators through the same Rust-side full-res splice Phase 1 built for
 * slicing, but in the frame + encoding the mutators consume:
 *
 * - FRAME: the mutators stage the model's centered LOCAL geometry soup
 *   (`stageGeometryToStagedMesh` → the un-transformed `model.geometry.geometry`
 *   position buffer, `v_raw − C_pre` at import); the Rust command reprojects
 *   with an identity matrix, so `v_local = v_raw − C_pre`.
 * - ENCODING: the mutators read `STAGED_MESH` as raw f32 LE (the
 *   `stage_mesh_binary_set` encoding), not the slicing u16 transport — so the
 *   command writes raw f32 and REPLACES the staged buffer.
 *
 * Full-res bytes never enter the WebView (plan §C.2); only the mutation output
 * returns as the new scene geometry.
 */
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { resolveFullResSourceForModel } from '@/features/mesh-modifiers/prepareModelGeometry';

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView, opts?: { headers?: Record<string, string> }) => Promise<T>;

/** A resolved full-res source for a permanent mutator. */
export interface FullResMutatorSource {
  sourcePath: string;
  /**
   * The vector subtracted from each raw source vertex to reach the model's
   * LOCAL centered frame — the frame the mutators stage
   * (`stageGeometryToStagedMesh` uploads the un-transformed
   * `model.geometry.geometry`).
   *
   * This is NOT the stored `C_pre` (the full pre-centering bbox center). Import
   * centers X/Z on the bbox center but sets Y bottom-to-zero — it translates by
   * `T_center = (cx, minY, cz)`, not `C_pre = (cx, cy, cz)`
   * (useStlGeometry.ts). The stored post-centering `model.geometry.center`
   * equals `C_pre − T_center` exactly (both preview-derived), so
   * `T_center = C_pre − model.geometry.center`. Using `C_pre` directly would
   * shift the spliced full-res soup up in Y by half the model height — a frame
   * jump. Slicing (P1) subtracts `model.geometry.center` on top of the local
   * frame, so IT correctly uses `C_pre`; the mutators do not, so they use
   * `T_center`.
   */
  localCenteringVector: [number, number, number];
  /** Import-time staleness fingerprint; `null` skips the stat compare. */
  fingerprint: { sizeBytes: number; mtimeMs: number } | null;
  originalTriangleCount: number;
}

/**
 * Full-res staging plan for a permanent mutator. Returns a descriptor when the
 * model is a native preview with a retained `sourcePath` AND a stored `cPre`
 * frame datum; else `null` (the caller stages the scene geometry exactly as
 * before). A missing `cPre` disqualifies full-res — never guess a center.
 */
export function planMutatorFullResStaging(model: LoadedModel): FullResMutatorSource | null {
  const source = resolveFullResSourceForModel(model);
  if (!source) return null;
  if (!source.cPre) return null;
  const geomCenter = model.geometry.center;
  // Local mutator frame vector: T_center = C_pre − model.geometry.center
  // (see FullResMutatorSource.localCenteringVector).
  const localCenteringVector: [number, number, number] = [
    source.cPre[0] - geomCenter.x,
    source.cPre[1] - geomCenter.y,
    source.cPre[2] - geomCenter.z,
  ];
  return {
    sourcePath: source.sourcePath,
    localCenteringVector,
    fingerprint: source.fingerprint,
    originalTriangleCount: source.originalTriangleCount,
  };
}

/** Summary returned by the Rust `stage_fullres_mesh_into_staged` command. */
export interface FullResSpliceSummary {
  stagedTriangleCount: number;
  worldMin: [number, number, number];
  worldMax: [number, number, number];
  spliceMs: number;
}

/**
 * Splices the ORIGINAL file into `STAGED_MESH` in the local frame (raw f32),
 * replacing the staged buffer. Throws a `FULLRES_SOURCE_MISSING` /
 * `FULLRES_SOURCE_STALE`-prefixed error when the source is gone or changed —
 * callers degrade to staging the preview geometry (never silently).
 */
export async function stageFullResMutatorSource(
  invoke: TauriInvoke,
  source: FullResMutatorSource,
): Promise<FullResSpliceSummary> {
  return invoke<FullResSpliceSummary>('stage_fullres_mesh_into_staged', {
    // The Rust command reprojects `v_local = v_raw − cPre` (identity matrix);
    // for the mutators that datum is the local centering vector T_center.
    sourcePath: source.sourcePath,
    cPre: source.localCenteringVector,
    expectedSizeBytes: source.fingerprint?.sizeBytes ?? null,
    expectedMtimeMs: source.fingerprint?.mtimeMs ?? null,
  });
}

/**
 * Maps a full-res splice error message to a human-readable degrade reason
 * (mirrors the slicing/export mapping in sliceExportOrchestrator.ts /
 * ExportManager.ts).
 */
export function describeFullResMutatorSpliceError(raw: string): string {
  if (raw.includes('FULLRES_SOURCE_MISSING')) return 'the original file is missing or unreadable';
  if (raw.includes('FULLRES_SOURCE_STALE')) return 'the original file changed since import';
  return raw;
}
