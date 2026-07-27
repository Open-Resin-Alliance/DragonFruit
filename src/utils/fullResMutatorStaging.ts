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
import {
  resolveFullResSourceForModel,
  type FullResSourceSection,
} from '@/features/mesh-modifiers/prepareModelGeometry';

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
  /**
   * Ph3d — WHICH PART of `sourcePath` this model is, carried through from the
   * chokepoint. `whole` for every ordinary import; `model`/`support` for a
   * Split-to-Bodies half.
   *
   * Every mutator gets this for free: {@link sectionArgs} falls back to it, so a
   * call site that passes no explicit section still stages the RIGHT SECTION for
   * a half instead of the whole file. That defaulting is the point — requiring
   * five mutators to remember Ph3d exists is how the supports quietly come back.
   */
  section: FullResSourceSection;
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
    section: source.section,
  };
}

/** Summary returned by the Rust `stage_fullres_mesh_into_staged` command. */
export interface FullResSpliceSummary {
  stagedTriangleCount: number;
  /** Triangles in the source file as its own header numbers them (Ph3b). */
  sourceTriangleCount: number;
  /** Triangles the section filter excluded — what the other pass owes (Ph3b). */
  skippedTriangleCount: number;
  /** `all` | `model` | `support` (Ph3b). */
  section: string;
  /** `not-required` | `provided` | `recomputed` | `no-split` (Ph3b). */
  runMapSource: string;
  worldMin: [number, number, number];
  worldMax: [number, number, number];
  spliceMs: number;
}

/**
 * Ph3b — which half of a classified import a mutator pass touches, and the map
 * that defines the halves. Omitted (or `all`) reproduces the pre-Ph3b whole-file
 * pass exactly.
 *
 * `runs` is flat `[start0, len0, …]` in SOURCE-FILE indices. `null` tells Rust
 * to re-derive the map from the file (`resolveImportRunMap`'s four recompute
 * reasons all land there); the recomputed map deliberately never comes back into
 * the WebView, because the 64 KiB cap exists precisely to refuse it.
 */
export interface FullResMutatorSectionRequest {
  section: 'all' | 'model' | 'support';
  runs: Uint32Array | null;
  recomputeReason: string | null;
}

/**
 * The section a command actually asks Rust for.
 *
 * Precedence, and the reason for it:
 *
 * 1. **An explicit request wins.** Ph3b's hollow asks for `'model'` on a
 *    WHOLE-file classified import so the voxel grid skips the supports. That is
 *    a statement about this operation, and it must not be overridden.
 * 2. **Otherwise the SOURCE's own section.** Ph3d: a Split-to-Bodies half IS one
 *    section of its file, so re-reading "all" of that file would hand the mutator
 *    the other half as well — putting the supports back into a hollow, a repair
 *    or a punch. Defaulting here means a call site that has never heard of Ph3d
 *    is still correct; the alternative is five call sites that each have to
 *    remember, which is the failure mode this arc keeps finding.
 * 3. **Otherwise whole-file**, byte-identical to the pre-Ph3b pass.
 */
function sectionArgs(
  source: FullResMutatorSource,
  request?: FullResMutatorSectionRequest | null,
) {
  if (request) {
    return {
      section: request.section,
      modelRuns: request.runs ? Array.from(request.runs) : null,
      runMapRecomputeReason: request.recomputeReason ?? null,
    };
  }
  if (source.section.kind !== 'whole') {
    return {
      section: source.section.kind,
      modelRuns: source.section.runs ? Array.from(source.section.runs) : null,
      runMapRecomputeReason: source.section.recomputeReason ?? null,
    };
  }
  return { section: null, modelRuns: null, runMapRecomputeReason: null };
}

/**
 * Splices the ORIGINAL file into `STAGED_MESH` in the local frame (raw f32),
 * replacing the staged buffer. Throws a `FULLRES_SOURCE_MISSING` /
 * `FULLRES_SOURCE_STALE`-prefixed error when the source is gone or changed —
 * callers degrade to staging the preview geometry (never silently).
 *
 * Ph3b: pass `section: 'model'` to stage the model body alone, so a mutator that
 * rebuilds its input (hollowing) does not rebuild the supports with it. The
 * complement is retrieved by {@link readFullResMutatorSection}; the caller
 * re-appends it and must verify the two passes partition the file first.
 */
export async function stageFullResMutatorSource(
  invoke: TauriInvoke,
  source: FullResMutatorSource,
  section?: FullResMutatorSectionRequest | null,
): Promise<FullResSpliceSummary> {
  return invoke<FullResSpliceSummary>('stage_fullres_mesh_into_staged', {
    // The Rust command reprojects `v_local = v_raw − cPre` (identity matrix);
    // for the mutators that datum is the local centering vector T_center.
    sourcePath: source.sourcePath,
    cPre: source.localCenteringVector,
    expectedSizeBytes: source.fingerprint?.sizeBytes ?? null,
    expectedMtimeMs: source.fingerprint?.mtimeMs ?? null,
    ...sectionArgs(source, section),
  });
}

/**
 * Ph3b — reads ONE section of the original file back into the WebView as raw f32
 * LE triangle soup, in the SAME local frame the mutators stage and their output
 * returns in.
 *
 * This is the only place full-resolution source bytes cross into the WebView,
 * and it is inherent rather than an oversight: Ph3b's whole point is that the
 * support section survives the mutation verbatim, and the mutation's output IS
 * the model's new scene geometry, so those triangles were always going to land
 * here — before Ph3b they arrived voxelised.
 */
export async function readFullResMutatorSection(
  invoke: TauriInvoke,
  source: FullResMutatorSource,
  section: FullResMutatorSectionRequest,
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(
    'read_fullres_mesh_section_positions',
    {
      sourcePath: source.sourcePath,
      cPre: source.localCenteringVector,
      expectedSizeBytes: source.fingerprint?.sizeBytes ?? null,
      expectedMtimeMs: source.fingerprint?.mtimeMs ?? null,
      ...sectionArgs(source, section),
    },
  );

  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error('read_fullres_mesh_section_positions returned unexpected type');
  }
  // Copy onto a fresh, offset-zero buffer: the IPC view may be a subarray of a
  // larger allocation, and `new Float32Array(buffer)` would then read past it.
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
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
