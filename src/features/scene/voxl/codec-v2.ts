/**
 * VOXL V2 Binary Container Codec
 *
 * Binary chunk-based container that eliminates base64 overhead for mesh data
 * and enables independent compression per section.
 *
 * Layout:
 *   [16-byte header] [chunk directory] [chunk data…]
 *
 * Header (16 bytes):
 *   0..3   magic     "VOXL" (ASCII: 0x56 0x4F 0x58 0x4C)
 *   4..5   version   uint16 LE (2)
 *   6..7   flags     uint16 LE (reserved, 0)
 *   8..11  count     uint32 LE (number of chunks)
 *   12..15 reserved  uint32 LE (0)
 *
 * Chunk directory entry (20 bytes each):
 *   0..3   type        4 ASCII chars (META, SCNE, MODL, MESH, SUPP, EXTD, HSRC, CAVT, PSRC)
 *   4..5   index       uint16 LE (multi-instance ordinal, e.g. MESH per model)
 *   6..7   compression uint16 LE (0 = none, 1 = zlib)
 *   8..11  offset      uint32 LE (byte offset from file start)
 *   12..15 compSize    uint32 LE (compressed byte length)
 *   16..19 rawSize     uint32 LE (uncompressed byte length)
 *
 * Chunk data follows the directory, tightly packed.
 */

import { unzlibSync, zlib as zlibAsync } from 'fflate';
import {
  VOXL_MAGIC,
  type BuildVoxlDocumentInput,
  type ParsedVoxlResult,
  type VoxlMeshRef,
  type VoxlMeta,
  type VoxlModelEntry,
  type VoxlSceneState,
  type VoxlCompressionRef,
  type VoxlCompressedDocumentEnvelopeV1,
  type PrecompressedChunk,
} from './types';
import type { DragonfruitImportFormat } from '@/supports/types';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import { base64ToBytes, bytesToBase64 } from '@/utils/base64';
import { sha256Hex } from './meshChunkStore';
import type { VoxlChunkCache, CachedChunkPayload } from './voxlChunkCache';

type ZlibCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// Promisified async zlib — runs in fflate's worker pool, never blocks the main thread.
const compressAsync = (data: Uint8Array, level: ZlibCompressionLevel): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    zlibAsync(data, { level }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

// ─── Constants ────────────────────────────────────────────────────────────────

export const VOXL_V2 = 2;
export const VOXL_V2_SEMANTIC_REVISION = 2.2;
/**
 * Semantic revision reported for a binary V2 file that has NO modifier-snapshot
 * chunks — either a genuinely pre-2.2 ("2.1") file with inline base64, or a
 * 2.2-capable write of a scene that had no snapshots to chunk (byte-identical).
 * Save-time format preservation treats such files as "inline".
 */
export const VOXL_V2_INLINE_REVISION = 2.1;
/**
 * Container version written when identical-geometry MESH chunk dedup removed
 * at least one chunk (duplicate models share one chunk via meshRef.chunkIndex).
 * Bumped from 2 so older readers — which map MESH chunks 1:1 to model index —
 * fail the strict version check cleanly instead of silently dropping the
 * duplicate models. All-unique scenes keep writing V2 and stay old-readable.
 */
export const VOXL_V3 = 3;

const HEADER_SIZE = 16;
const DIR_ENTRY_SIZE = 20;

const MAGIC_BYTES = new Uint8Array([0x56, 0x4F, 0x58, 0x4C]); // "VOXL"

const COMPRESSION_NONE = 0;
const COMPRESSION_ZLIB = 1;

// ─── Chunk Type Tags ──────────────────────────────────────────────────────────

const CHUNK_META = 'META';
const CHUNK_SCNE = 'SCNE';
const CHUNK_MODL = 'MODL';
const CHUNK_MESH = 'MESH';
export const CHUNK_ORIG = 'ORIG';
const CHUNK_SUPP = 'SUPP';
const CHUNK_EXTD = 'EXTD';
// VOXL 2.2 modifier-snapshot chunks: the large Float32 position snapshots that
// hollowing / hole-punch bakes into meshModifiers, moved OUT of the MODL JSON
// (where they were base64 strings that summed past V8's ~512 MiB single-string
// ceiling) and into raw-bytes chunks indexed by owning model, like MESH.
const CHUNK_HSRC = 'HSRC'; // hollowing.sourcePositions (raw Float32 bytes)
const CHUNK_CAVT = 'CAVT'; // hollowing.cavityPositions (raw Float32 bytes)
const CHUNK_PSRC = 'PSRC'; // holePunchSourcePositions  (raw Float32 bytes)

// ─── Internal Types ───────────────────────────────────────────────────────────

interface ChunkDirEntry {
  type: string;
  index: number;
  compression: number;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
}

// ─── Text Encoder / Decoder ───────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ─── Size limits (Ph0.1 sub-phase D1) ─────────────────────────────────────────

/**
 * The container addresses chunk offsets, `compSize` and `rawSize` with `u32`
 * (`:290-292`). Past this, offsets wrap and the writer emits a file that parses
 * and is silently wrong. There was no writer guard at all.
 */
export const VOXL_SIZE_LIMIT_BYTES = 0xFFFF_FFFF;

/**
 * Explicit saves warn here rather than failing. The ceiling is approached fast
 * once Ph5 embeds originals — one 4M preview plus one 11.24M original is
 * ~654 MiB, so six such models reach it.
 */
export const VOXL_SIZE_SOFT_WARN_BYTES = Math.floor(3.5 * 1024 * 1024 * 1024);

export interface VoxlChunkSizeInfo {
  type: string;
  index: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface VoxlSizeBreakdownRow {
  index: number;
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

const formatGb = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;

/** Latch so the soft warning fires once per approach, not once per 30 s tick. */
let softLimitWarned = false;

/**
 * Thrown **before** any allocation. Carries the measured total and the per-model
 * breakdown so the caller can tell the user which model to remove rather than
 * reporting a bare failure.
 */
export class VoxlSizeLimitError extends Error {
  readonly totalBytes: number;

  readonly limitBytes: number;

  readonly oversizeChunks: VoxlChunkSizeInfo[];

  readonly perModelBreakdown: VoxlSizeBreakdownRow[];

  /** The sentence a modal / toast shows verbatim. */
  readonly userMessage: string;

  constructor(args: {
    totalBytes: number;
    oversizeChunks: VoxlChunkSizeInfo[];
    perModelBreakdown: VoxlSizeBreakdownRow[];
    userMessage: string;
  }) {
    super(args.userMessage);
    this.name = 'VoxlSizeLimitError';
    this.totalBytes = args.totalBytes;
    this.limitBytes = VOXL_SIZE_LIMIT_BYTES;
    this.oversizeChunks = args.oversizeChunks;
    this.perModelBreakdown = args.perModelBreakdown;
    this.userMessage = args.userMessage;
  }
}

/**
 * Pre-flight size check. Wired to the computed directory rather than to the
 * assembly step: every chunk's length is known once the layout is calculated
 * (`:246-266`), which is *before* `new ArrayBuffer` — so the failure is a clean
 * typed error, never a silent wrap and never a failed 4 GiB allocation.
 */
export function assertVoxlSizeLimits(
  entries: VoxlChunkSizeInfo[],
  totalSize: number,
  options?: { modelNames?: string[] },
): void {
  const oversizeChunks = entries.filter(
    (e) => e.compressedSize > VOXL_SIZE_LIMIT_BYTES || e.uncompressedSize > VOXL_SIZE_LIMIT_BYTES,
  );
  const totalOver = totalSize > VOXL_SIZE_LIMIT_BYTES;

  if (!totalOver && oversizeChunks.length === 0) {
    // Soft warning. The headroom below the ceiling disappears fast once Ph5
    // embeds originals — one 4M preview plus one 11.24M original is ~654 MiB, so
    // six such models reach it. Latched so a 30 s autosave tick cannot spam, and
    // reset when the scene drops back under, so it fires again next time.
    if (totalSize >= VOXL_SIZE_SOFT_WARN_BYTES) {
      if (!softLimitWarned) {
        softLimitWarned = true;
        console.warn(
          `[VOXL] This scene is ${formatGb(totalSize)} — approaching the 4 GB format limit. `
          + 'Saves will fail past it; remove a model or reduce embedded originals.',
        );
      }
    } else {
      softLimitWarned = false;
    }
    return;
  }

  const names = options?.modelNames ?? [];
  const perModelBreakdown: VoxlSizeBreakdownRow[] = entries
    .filter((e) => e.type === CHUNK_MESH)
    .map((e) => ({
      index: e.index,
      name: names[e.index] ?? `Model ${e.index + 1}`,
      compressedBytes: e.compressedSize,
      uncompressedBytes: e.uncompressedSize,
    }))
    .sort((a, b) => b.compressedBytes - a.compressedBytes);

  const remedy = 'Remove a model, or turn off “Save original model along with decimated”.';
  const userMessage = totalOver
    ? `This scene is ${formatGb(totalSize)} compressed and exceeds the VOXL 4 GB limit. ${remedy}`
    : `“${names[oversizeChunks[0].index] ?? `Model ${oversizeChunks[0].index + 1}`}” is `
      + `${formatGb(Math.max(oversizeChunks[0].compressedSize, oversizeChunks[0].uncompressedSize))} on its own, `
      + `which exceeds the VOXL 4 GB limit for a single mesh. ${remedy}`;

  throw new VoxlSizeLimitError({ totalBytes: totalSize, oversizeChunks, perModelBreakdown, userMessage });
}

// ─── Codec instrumentation ────────────────────────────────────────────────────

/**
 * Counters the perf and honesty tests assert against. `meshChunkCompressions`
 * is the one that mattered: it was N-per-tick, and post-store it must be zero
 * for an unchanged scene. `largestContiguousAllocation` pins sub-phase E's
 * claim that the streaming writer never allocates the whole document.
 */
export const voxlCodecStats = {
  meshChunkCompressions: 0,
  jsonChunkCompressions: 0,
  largestContiguousAllocation: 0,
};

export function resetVoxlCodecStats(): void {
  voxlCodecStats.meshChunkCompressions = 0;
  voxlCodecStats.jsonChunkCompressions = 0;
  voxlCodecStats.largestContiguousAllocation = 0;
}

// ─── V2 Binary Writer ─────────────────────────────────────────────────────────

/**
 * A chunk payload the caller already encoded, hashed and compressed — supplied
 * by the COW chunk store (Ph0.1 sub-phase C). `compression` uses the container's
 * own tags (0 = none, 1 = zlib), and the store applies the identical
 * `>64 bytes and only if it shrinks` policy the writer used to apply inline, so
 * the emitted bytes are unchanged.
 */

export interface VoxlSerializeOptions {
  /** Model index → already-compressed MESH payload. */
  precompressed?: Map<number, PrecompressedChunk>;
  /** Model index → already-compressed ORIG payload. */
  precompressedOriginal?: Map<number, PrecompressedChunk>;
  /** Model index → raw uncompressed ORIG payload. */
  originalMeshBytes?: Map<number, Uint8Array>;
  embedOriginalMesh?: boolean;
  /**
   * VOXL 2.2 modifier-snapshot chunking. `true` (default) moves the large
   * hollow/hole position snapshots out of MODL into HSRC/CAVT/PSRC chunks.
   * `false` keeps them inline as base64 (the pre-2.2 = "2.1" layout), used by
   * autosave to preserve the loaded file's format; the caller escalates to
   * `true` if the inline write throws (e.g. the MODL string ceiling). Scenes
   * without modifier snapshots serialize identically either way.
   */
  chunkModifierSnapshots?: boolean;
  /**
   * Cross-tick compressed-chunk cache (autosave Phase 1). When present, the
   * modifier-snapshot and SUPP chunks reuse their already-compressed bytes and
   * content digest whenever their content is unchanged (see `voxlChunkCache`),
   * and the prepared document carries a `fingerprint` for the caller's
   * write-skip. Absent ⇒ no caching, no fingerprint, byte-identical to before.
   */
  chunkCache?: VoxlChunkCache;
  /** Model index → hex SHA-256 of the ORIG (original-mesh) payload, for the fingerprint. */
  sha256Original?: Map<number, string>;
  /**
   * Small, stable identity for the SUPP chunk's content — derived by the caller
   * from the support-store snapshot references. Equal keys across ticks ⇒
   * identical support bytes ⇒ the codec reuses the cached SUPP chunk and skips
   * the `JSON.stringify` + zlib entirely.
   */
  supportsCacheKey?: string;
  /**
   * The fingerprint of the last committed write to this destination. When it
   * equals the freshly-prepared fingerprint the streaming writer emits NOTHING
   * and reports `skipped: true`, so the caller can abort the atomic commit and
   * leave the already-correct file in place. Requires `chunkCache` (no cache ⇒
   * no fingerprint ⇒ never skips).
   */
  previousFingerprint?: string;
}

/**
 * Thrown by the export path to abort an atomic streamed write when the document
 * fingerprint matches the last committed one. The atomic writer discards its
 * temp on any thrown error, so the original file is left untouched; `exportVoxl`
 * catches this and reports success. It must never escape the export layer.
 */
export class VoxlUnchangedError extends Error {
  constructor(public readonly fingerprint: string) {
    super('VOXL document unchanged since last write; skipping.');
    this.name = 'VoxlUnchangedError';
  }
}

interface ResolvedChunk {
  type: string;
  index: number;
  compression: number;
  data: Uint8Array;
  uncompressedSize: number;
  /** SHA-256 hex of the raw content; populated only when a `chunkCache` is in use. */
  digest?: string;
}

interface PreparedDocument {
  resolved: ResolvedChunk[];
  directory: ChunkDirEntry[];
  totalSize: number;
  version: number;
  /**
   * Content fingerprint of the whole document (ordered per-chunk digests).
   * Empty string when no `chunkCache` was supplied. Two prepares with equal,
   * non-empty fingerprints would emit byte-identical files.
   */
  fingerprint: string;
}

/**
 * Everything up to (but not including) assembly: chunk construction, dedup,
 * compression, layout, and the pre-flight size guard. Shared by the buffered and
 * streaming writers so they cannot drift — the byte-identity gate between them
 * is the whole point of sub-phase E.
 */
async function prepareVoxlDocumentV2(
  input: BuildVoxlDocumentInput,
  meshBytes: Map<number, Uint8Array>,
  sha256Map?: Map<number, string>,
  options?: VoxlSerializeOptions,
): Promise<PreparedDocument> {
  const precompressed = options?.precompressed;
  const precompressedOriginal = options?.precompressedOriginal;
  const originalMeshBytes = options?.originalMeshBytes;
  const embedOriginalMesh = options?.embedOriginalMesh ?? true;
  const chunkModifierSnapshots = options?.chunkModifierSnapshots ?? true;
  const nowIso = new Date().toISOString();

  // ── Build chunk payloads ──────────────────────────────────────────────

  const meta: VoxlMeta = {
    generator: input.meta?.generator ?? 'DragonFruit',
    generatorVersion: input.meta?.generatorVersion,
    createdAt: nowIso,
    updatedAt: nowIso,
    units: 'mm',
    coordinateSystem: 'right-handed-z-up',
  };

  const scene: VoxlSceneState = {
    activeModelId: input.activeModelId,
    selectedModelIds: [...input.selectedModelIds],
  };

  // ── Identical-geometry MESH chunk dedup ───────────────────────────────
  // Models with the same content SHA share ONE chunk: the first occurrence
  // owns it, later ones reference it via meshRef.chunkIndex. Only owner
  // chunks are written, so a Fill-Plate bed of N copies stores 1 mesh, not N.
  // Falls back to 1:1 when a SHA is missing (dedup is best-effort, never
  // wrong: without a hash we cannot prove two meshes are identical).
  //
  // A model's payload may arrive raw (`meshBytes`) or already baked
  // (`precompressed`, from the chunk store). Both are legitimate sources of "this
  // model has a chunk"; everything downstream goes through these two accessors
  // so the dedup, the directory, and the MODL entries cannot disagree about it.
  const hasChunkFor = (i: number): boolean => meshBytes.has(i) || (precompressed?.has(i) ?? false);
  const rawSizeFor = (i: number): number =>
    meshBytes.get(i)?.length ?? precompressed?.get(i)?.uncompressedSize ?? 0;

  const chunkOwnerByModelIndex = new Map<number, number>(); // model i → owning chunk index
  const ownerBySha = new Map<string, number>();
  const dedupedChunkIndices: number[] = [];
  let chunkCandidateCount = 0;
  for (let i = 0; i < input.models.length; i += 1) {
    if (!hasChunkFor(i)) continue;
    chunkCandidateCount += 1;
    const sha = sha256Map?.get(i);
    const existingOwner = sha !== undefined ? ownerBySha.get(sha) : undefined;
    if (existingOwner !== undefined) {
      chunkOwnerByModelIndex.set(i, existingOwner); // duplicate → share owner's chunk
    } else {
      chunkOwnerByModelIndex.set(i, i); // owner → keeps its own chunk
      if (sha !== undefined) ownerBySha.set(sha, i);
      dedupedChunkIndices.push(i);
    }
  }
  const dedupRemovedChunks = chunkCandidateCount > dedupedChunkIndices.length;

  // ── Modifier-snapshot chunks (V2.2): HSRC / CAVT / PSRC ────────────────
  // The hollowing/hole-punch bake stores three full-mesh position snapshots as
  // base64 inside meshModifiers. Summed across models these blow past V8's
  // ~512 MiB single-string ceiling when JSON.stringify(models) concatenates
  // them, throwing RangeError. Move each into a raw-bytes chunk indexed by
  // owning model, and content-dedup PER TYPE keyed by the base64 string itself:
  // identical snapshots across models share one chunk (first occurrence owns
  // it; duplicates carry a *ChunkIndex pointer in the stripped MODL entry).
  //
  // Independent of MESH dedup — a MESH-duplicate model may still own its own
  // HSRC/CAVT/PSRC, and vice-versa — and invisible to old readers, so it does
  // NOT bump the header version (only MESH dedup does).
  // Decode of the (potentially ~512 MiB) base64 is DEFERRED to `b64` so a cache
  // hit in the resolve step below can reuse the compressed bytes without ever
  // decoding. `cacheKey` is a small, stable per-model handle; the base64 string
  // itself is the cache's `===` signal.
  interface ModifierChunk { type: string; index: number; b64: string; cacheKey: string; }
  const modifierChunks: ModifierChunk[] = [];
  const strippedModifiersByModel = new Map<number, ModelMeshModifiers>();
  const hollowSourceOwner = new Map<string, number>();
  const hollowCavityOwner = new Map<string, number>();
  const holeSourceOwner = new Map<string, number>();

  // Skipped entirely when chunkModifierSnapshots is false: the base64 blobs stay
  // inline in the MODL entries (pre-2.2 "2.1" layout) and no HSRC/CAVT/PSRC
  // chunk is emitted. Autosave uses this to preserve an old file's format.
  for (let i = 0; chunkModifierSnapshots && i < input.models.length; i += 1) {
    const mm = input.models[i].meshModifiers;
    if (!mm) continue;
    const modelId = input.models[i].id ?? String(i);

    let nextHollowing = mm.hollowing;
    if (mm.hollowing) {
      const h = mm.hollowing;
      let sourceChunkIndex: number | undefined;
      let cavityChunkIndex: number | undefined;
      let hollowChanged = false;

      if (h.sourcePositionsBase64) {
        const owner = hollowSourceOwner.get(h.sourcePositionsBase64);
        if (owner === undefined) {
          hollowSourceOwner.set(h.sourcePositionsBase64, i);
          modifierChunks.push({ type: CHUNK_HSRC, index: i, b64: h.sourcePositionsBase64, cacheKey: `${modelId}:hsrc` });
        } else {
          sourceChunkIndex = owner;
        }
        hollowChanged = true;
      }
      if (h.cavityPositionsBase64) {
        const owner = hollowCavityOwner.get(h.cavityPositionsBase64);
        if (owner === undefined) {
          hollowCavityOwner.set(h.cavityPositionsBase64, i);
          modifierChunks.push({ type: CHUNK_CAVT, index: i, b64: h.cavityPositionsBase64, cacheKey: `${modelId}:cavt` });
        } else {
          cavityChunkIndex = owner;
        }
        hollowChanged = true;
      }
      if (hollowChanged) {
        nextHollowing = { ...h };
        delete nextHollowing.sourcePositionsBase64;
        delete nextHollowing.cavityPositionsBase64;
        // Owners default to their own index (no pointer) so single-owner files
        // stay byte-identical to the non-dedup case.
        if (sourceChunkIndex !== undefined) nextHollowing.sourceChunkIndex = sourceChunkIndex;
        if (cavityChunkIndex !== undefined) nextHollowing.cavityChunkIndex = cavityChunkIndex;
      }
    }

    let holePunchSourceChunkIndex: number | undefined;
    let holeSourceStripped = false;
    if (mm.holePunchSourcePositionsBase64) {
      const owner = holeSourceOwner.get(mm.holePunchSourcePositionsBase64);
      if (owner === undefined) {
        holeSourceOwner.set(mm.holePunchSourcePositionsBase64, i);
        modifierChunks.push({ type: CHUNK_PSRC, index: i, b64: mm.holePunchSourcePositionsBase64, cacheKey: `${modelId}:psrc` });
      } else {
        holePunchSourceChunkIndex = owner;
      }
      holeSourceStripped = true;
    }

    if (nextHollowing !== mm.hollowing || holeSourceStripped) {
      const stripped: ModelMeshModifiers = { ...mm, hollowing: nextHollowing };
      if (holeSourceStripped) {
        delete stripped.holePunchSourcePositionsBase64;
        if (holePunchSourceChunkIndex !== undefined) stripped.holePunchSourceChunkIndex = holePunchSourceChunkIndex;
      }
      strippedModifiersByModel.set(i, stripped);
    }
  }

  const models: VoxlModelEntry[] = input.models.map((m, i) => {
    const hasChunk = hasChunkFor(i);
    const ownerIndex = chunkOwnerByModelIndex.get(i);
    const meshRef: VoxlMeshRef = hasChunk
      ? {
          mode: 'embedded-chunk',
          fileName: m.mesh?.fileName ?? m.name,
          mimeType: m.mesh?.mimeType ?? 'model/stl',
          uncompressedSizeBytes: rawSizeFor(i),
          sha256: sha256Map?.get(i),
          // Only duplicates carry an explicit pointer; owners default to `i`,
          // keeping V2 files byte-identical to before when no dedup occurs.
          ...(ownerIndex !== undefined && ownerIndex !== i
            ? { chunkIndex: ownerIndex }
            : {}),
        }
      : m.mesh ?? { mode: 'none' };

    return {
      id: m.id,
      name: m.name,
      visible: Boolean(m.visible),
      color: m.color,
      polygonCount: Math.max(0, Math.floor(m.polygonCount || 0)),
      fileSizeBytes:
        typeof m.fileSizeBytes === 'number' && Number.isFinite(m.fileSizeBytes)
          ? Math.max(0, Math.floor(m.fileSizeBytes))
          : undefined,
      // Phase-1 full-res linkage (STL-import remediation): additive JSON
      // fields inside the MODL chunk — no container-version bump needed
      // (older readers ignore unknown fields; the versioning convention
      // reserves bumps for changes that would make old readers WRONG, like
      // the dedup chunk sharing above).
      ...(typeof m.sourcePath === 'string' && m.sourcePath.trim().length > 0
        ? { sourcePath: m.sourcePath }
        : {}),
      ...(m.nativePreview ? { nativePreview: m.nativePreview } : {}),
      ...(m.originalRef ? { originalRef: m.originalRef } : {}),
      // Written only when true (Ph0.1 D2): a scene with nothing stale must
      // serialize to exactly the bytes it did before the flag existed.
      ...(m.geometryStale === true ? { geometryStale: true } : {}),
      transform: {
        position: { x: m.transform.position.x, y: m.transform.position.y, z: m.transform.position.z },
        rotation: { x: m.transform.rotation.x, y: m.transform.rotation.y, z: m.transform.rotation.z },
        scale: { x: m.transform.scale.x, y: m.transform.scale.y, z: m.transform.scale.z },
      },
      meshModifiers: strippedModifiersByModel.get(i) ?? m.meshModifiers,
      mesh: meshRef,
      isSupportGeometry: m.isSupportGeometry,
      linkGroupId: m.linkGroupId,
    };
  });

  // ── Collect pending chunks ────────────────────────────────────────────

  type PendingChunk = {
    type: string;
    index: number;
    raw?: Uint8Array;
    /** Deferred raw builder — invoked only on a cache MISS, so a hit skips the
     *  base64 decode / `JSON.stringify` that produces the bytes. */
    rawThunk?: () => Uint8Array;
    pre?: PrecompressedChunk;
    compress: boolean;
    /** Small stable cache key; paired with `cacheSignal` compared by `===`. */
    cacheKey?: string;
    cacheSignal?: string;
    /** Known content digest (mesh/orig sha) — lets the fingerprint skip re-hashing big blobs. */
    digestHint?: string;
  };
  const pending: PendingChunk[] = [];

  pending.push({ type: CHUNK_META, index: 0, raw: textEncoder.encode(JSON.stringify(meta)), compress: false });
  pending.push({ type: CHUNK_SCNE, index: 0, raw: textEncoder.encode(JSON.stringify(scene)), compress: false });
  pending.push({ type: CHUNK_MODL, index: 0, raw: textEncoder.encode(JSON.stringify(models)), compress: true });

  // One MESH chunk per UNIQUE mesh (owner index), sorted by index. Duplicates
  // reference an owner via meshRef.chunkIndex and get no chunk of their own.
  for (const modelIndex of [...dedupedChunkIndices].sort((a, b) => a - b)) {
    const pre = precompressed?.get(modelIndex);
    if (pre) {
      pending.push({ type: CHUNK_MESH, index: modelIndex, pre, compress: true, digestHint: sha256Map?.get(modelIndex) });
    } else {
      const raw = meshBytes.get(modelIndex);
      if (raw) {
        pending.push({ type: CHUNK_MESH, index: modelIndex, raw, compress: true, digestHint: sha256Map?.get(modelIndex) });
      }
    }
  }

  // Additive ORIG chunks for full-res original mesh embedding
  if (embedOriginalMesh) {
    const sha256Original = options?.sha256Original;
    for (const modelIndex of [...dedupedChunkIndices].sort((a, b) => a - b)) {
      const preOrig = precompressedOriginal?.get(modelIndex);
      const rawOrig = originalMeshBytes?.get(modelIndex);
      if (preOrig) {
        pending.push({ type: CHUNK_ORIG, index: modelIndex, pre: preOrig, compress: true, digestHint: sha256Original?.get(modelIndex) });
      } else if (rawOrig) {
        pending.push({ type: CHUNK_ORIG, index: modelIndex, raw: rawOrig, compress: true, digestHint: sha256Original?.get(modelIndex) });
      }
    }
  }

  // V2.2 modifier-snapshot chunks (owners only; duplicates were pointer-linked
  // above). Insertion order is deterministic (models ascending, HSRC/CAVT/PSRC
  // per model), so both writers stay byte-identical. The base64 decode is
  // deferred via `rawThunk` so a cache hit (the common transform-edit case)
  // reuses the compressed bytes without decoding the up-to-512-MiB string.
  for (const chunk of modifierChunks) {
    pending.push({
      type: chunk.type,
      index: chunk.index,
      rawThunk: () => base64ToBytes(chunk.b64),
      compress: true,
      cacheKey: chunk.cacheKey,
      cacheSignal: chunk.b64,
    });
  }

  // SUPP: `JSON.stringify` of the (potentially huge) support forest is deferred
  // so a cache hit — a model transform never touches support state — skips it.
  const supportsCacheKey = options?.supportsCacheKey;
  pending.push({
    type: CHUNK_SUPP,
    index: 0,
    rawThunk: () => textEncoder.encode(JSON.stringify(input.supports)),
    compress: true,
    ...(supportsCacheKey !== undefined ? { cacheKey: 'supp', cacheSignal: supportsCacheKey } : {}),
  });

  if (input.extensions && Object.keys(input.extensions).length > 0) {
    pending.push({ type: CHUNK_EXTD, index: 0, raw: textEncoder.encode(JSON.stringify(input.extensions)), compress: false });
  }

  // ── Compress (async – does not block the main thread) ─────────────────
  //
  // A chunk that arrives pre-compressed, or that hits the cross-tick chunk
  // cache, skips zlib entirely. That is the sub-phase-C + Phase-1 win: for an
  // unchanged scene, MESH takes the `pre` branch and modifier/SUPP take the
  // cache branch, collapsing the per-tick cost to the KB-scale JSON chunks.
  //
  // `digest` (SHA-256 of the raw content) is computed only when a `chunkCache`
  // is supplied — it feeds the document fingerprint the caller uses to skip an
  // unchanged write. Big chunks reuse a `digestHint` (mesh/orig sha) or a cached
  // digest, so no large blob is re-hashed per tick.
  const cache = options?.chunkCache;
  const wantFingerprint = cache !== undefined;

  const resolved: ResolvedChunk[] = await Promise.all(pending.map(async (chunk): Promise<ResolvedChunk> => {
    if (cache && chunk.cacheKey !== undefined && chunk.cacheSignal !== undefined) {
      const hit = cache.get(chunk.cacheKey, chunk.cacheSignal);
      if (hit) {
        return {
          type: chunk.type,
          index: chunk.index,
          compression: hit.compression,
          data: hit.data,
          uncompressedSize: hit.uncompressedSize,
          digest: hit.digest,
        };
      }
    }

    if (chunk.pre) {
      const digest = wantFingerprint ? (chunk.digestHint ?? await sha256Hex(chunk.pre.data)) : undefined;
      return {
        type: chunk.type,
        index: chunk.index,
        compression: chunk.pre.compression,
        data: chunk.pre.data,
        uncompressedSize: chunk.pre.uncompressedSize,
        digest,
      };
    }

    const raw = chunk.raw ?? chunk.rawThunk!();
    let result: ResolvedChunk;
    if (chunk.compress && raw.length > 64) {
      if (chunk.type === CHUNK_MESH) voxlCodecStats.meshChunkCompressions += 1;
      else voxlCodecStats.jsonChunkCompressions += 1;

      const compressed = await compressAsync(raw, 6);
      result = compressed.length < raw.length
        ? { type: chunk.type, index: chunk.index, compression: COMPRESSION_ZLIB, data: compressed, uncompressedSize: raw.length }
        : { type: chunk.type, index: chunk.index, compression: COMPRESSION_NONE, data: raw, uncompressedSize: raw.length };
    } else {
      result = { type: chunk.type, index: chunk.index, compression: COMPRESSION_NONE, data: raw, uncompressedSize: raw.length };
    }

    if (wantFingerprint) {
      const digest = chunk.digestHint ?? await sha256Hex(raw);
      result.digest = digest;
      if (cache && chunk.cacheKey !== undefined && chunk.cacheSignal !== undefined) {
        cache.set(chunk.cacheKey, chunk.cacheSignal, {
          compression: result.compression,
          data: result.data,
          uncompressedSize: result.uncompressedSize,
          digest,
        });
      }
    }
    return result;
  }));

  // ── Calculate layout ──────────────────────────────────────────────────

  const chunkCount = resolved.length;
  const dirSize = chunkCount * DIR_ENTRY_SIZE;
  const dataStart = HEADER_SIZE + dirSize;

  let cursor = dataStart;
  const directory: ChunkDirEntry[] = resolved.map((chunk) => {
    const entry: ChunkDirEntry = {
      type: chunk.type,
      index: chunk.index,
      compression: chunk.compression,
      offset: cursor,
      compressedSize: chunk.data.length,
      uncompressedSize: chunk.uncompressedSize,
    };

    cursor += chunk.data.length;
    return entry;
  });

  const totalSize = cursor;

  // Pre-flight, before any assembly buffer exists (Ph0.1 D1). Every offset and
  // length is already known here, so a scene past the u32 ceiling fails with a
  // typed, user-readable error instead of wrapping its offsets silently.
  assertVoxlSizeLimits(directory, totalSize, { modelNames: input.models.map((m) => m.name) });

  // Version bumps to 3 only when dedup removed chunks, so old readers reject
  // deduped files cleanly rather than losing the shared-chunk models;
  // non-deduped scenes stay V2 and remain readable by older builds.
  const version = dedupRemovedChunks ? VOXL_V3 : VOXL_V2;

  // Document fingerprint (only when a chunk cache is in use): an ordered digest
  // of every chunk's identity. Equal, non-empty fingerprints across two prepares
  // guarantee byte-identical output — the signal the caller uses to skip writing
  // an unchanged file. Built from cached/hinted digests, so no big blob is
  // re-hashed here; only the small descriptor string is hashed per tick.
  let fingerprint = '';
  if (wantFingerprint) {
    const descriptor = resolved
      .map((c) => `${c.type}:${c.index}:${c.compression}:${c.uncompressedSize}:${c.digest ?? ''}`)
      .join('\n');
    fingerprint = await sha256Hex(textEncoder.encode(`v${version}\n${descriptor}`));
  }

  return {
    resolved,
    directory,
    totalSize,
    version,
    fingerprint,
  };
}

/** Header + directory. Identical in both writers; ~16 + 20N bytes, never scene-sized. */
function buildVoxlPreamble(prepared: PreparedDocument): Uint8Array {
  const { directory, version } = prepared;
  const chunkCount = directory.length;
  const preamble = new Uint8Array(HEADER_SIZE + chunkCount * DIR_ENTRY_SIZE);
  const view = new DataView(preamble.buffer);

  preamble.set(MAGIC_BYTES, 0);
  view.setUint16(4, version, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, chunkCount, true);
  view.setUint32(12, 0, true);

  for (let i = 0; i < chunkCount; i += 1) {
    const entry = directory[i];
    const base = HEADER_SIZE + i * DIR_ENTRY_SIZE;
    preamble.set(textEncoder.encode(entry.type), base);
    view.setUint16(base + 4, entry.index, true);
    view.setUint16(base + 6, entry.compression, true);
    view.setUint32(base + 8, entry.offset, true);
    view.setUint32(base + 12, entry.compressedSize, true);
    view.setUint32(base + 16, entry.uncompressedSize, true);
  }

  return preamble;
}

/**
 * Serialize a VOXL scene to the V2 binary container format.
 *
 * Buffered form: allocates the whole document contiguously. Kept for the browser
 * `<a download>` fallback, which genuinely needs a Blob, and for every existing
 * caller. Native writes should prefer `serializeVoxlDocumentV2Streaming` — see
 * its docstring for why the contiguous buffer is worth avoiding.
 *
 * @param input       - Scene data (models, supports, extensions, etc.)
 * @param meshBytes   - Map of model index → raw mesh binary (e.g. STL bytes)
 * @param sha256Map   - Optional map of model index → hex SHA-256 digest
 * @param options     - Additional serialization options (e.g. precompressed chunks)
 * @returns           - Complete VOXL V2 binary as Uint8Array
 */
export async function serializeVoxlDocumentV2(
  input: BuildVoxlDocumentInput,
  meshBytes: Map<number, Uint8Array>,
  sha256Map?: Map<number, string>,
  options?: VoxlSerializeOptions,
): Promise<Uint8Array> {
  const prepared = await prepareVoxlDocumentV2(input, meshBytes, sha256Map, options);

  const out = new Uint8Array(prepared.totalSize);
  voxlCodecStats.largestContiguousAllocation = Math.max(
    voxlCodecStats.largestContiguousAllocation,
    prepared.totalSize,
  );

  out.set(buildVoxlPreamble(prepared), 0);
  for (let i = 0; i < prepared.resolved.length; i += 1) {
    out.set(prepared.resolved[i].data, prepared.directory[i].offset);
  }

  return out;
}

/**
 * Streaming form (Ph0.1 sub-phase E).
 *
 * The buffered writer allocated ONE contiguous `ArrayBuffer` the size of the
 * whole document and memcpy'd every chunk into it on the MAIN thread —
 * 172 MiB for a single 4M-tri model, 515 MiB for a 3-model plate — on the one
 * code path that runs unattended every 30 seconds. It is both a jank source and
 * an OOM candidate, and Ph5's original-mesh embed roughly triples it.
 *
 * Removing it is cheap because the directory is computed **before** assembly:
 * every chunk's offset is known when the first byte is emitted, so the writer
 * emits the preamble and then each chunk's payload in directory order, with no
 * second pass and no copy. Peak residency per tick drops from
 * `raw + compressed + contiguous` to `compressed` (the store's own retention)
 * plus one sink chunk.
 *
 * The sink is awaited per emission, so a write failure aborts immediately rather
 * than after the whole document has been produced.
 */
export async function serializeVoxlDocumentV2Streaming(
  input: BuildVoxlDocumentInput,
  meshBytes: Map<number, Uint8Array>,
  sha256Map: Map<number, string> | undefined,
  sink: (bytes: Uint8Array) => void | Promise<void>,
  options?: VoxlSerializeOptions,
): Promise<{ totalSize: number; version: number; fingerprint: string; skipped: boolean }> {
  const prepared = await prepareVoxlDocumentV2(input, meshBytes, sha256Map, options);

  // Write-skip: identical, non-empty fingerprint ⇒ the bytes would match the
  // file already on disk. Emit nothing and let the caller abort the commit.
  const previousFingerprint = options?.previousFingerprint;
  if (
    previousFingerprint !== undefined &&
    prepared.fingerprint !== '' &&
    prepared.fingerprint === previousFingerprint
  ) {
    return { totalSize: 0, version: prepared.version, fingerprint: prepared.fingerprint, skipped: true };
  }

  await sink(buildVoxlPreamble(prepared));
  for (const chunk of prepared.resolved) {
    await sink(chunk.data);
  }

  return { totalSize: prepared.totalSize, version: prepared.version, fingerprint: prepared.fingerprint, skipped: false };
}

// ─── V2 Binary Reader ─────────────────────────────────────────────────────────

class LazyOriginalMeshBytesMap extends Map<string, Uint8Array> {
  private chunks: Map<string, PrecompressedChunk>;
  
  constructor(chunks: Map<string, PrecompressedChunk>) {
    super();
    this.chunks = chunks;
  }

  override has(key: string): boolean {
    return this.chunks.has(key);
  }

  override get(key: string): Uint8Array | undefined {
    // If we've already decompressed it, return the cached value
    const cached = super.get(key);
    if (cached) return cached;

    // Otherwise decompress on demand
    const chunk = this.chunks.get(key);
    if (chunk) {
      if (chunk.compression === COMPRESSION_ZLIB) {
        const inflated = unzlibSync(chunk.data);
        if (inflated.length !== chunk.uncompressedSize) {
          throw new Error(`VOXL V2: chunk size mismatch after lazy decompression.`);
        }
        super.set(key, inflated);
        return inflated;
      } else if (chunk.compression === COMPRESSION_NONE) {
        super.set(key, chunk.data);
        return chunk.data;
      } else {
        throw new Error(`VOXL V2: unsupported compression type ${chunk.compression}`);
      }
    }
    return undefined;
  }
}

/**
 * Parse a VOXL V2 binary container into a `ParsedVoxlResult`.
 *
 * The returned `document` uses V1 schema shape so the rest of the app can
 * consume it uniformly.  Mesh bytes for `embedded-chunk` models are provided
 * separately in `meshBytes` to avoid base64 round-trips.
 */
export function parseVoxlBinaryV2(data: Uint8Array): ParsedVoxlResult {
  if (data.length < HEADER_SIZE) {
    throw new Error('Invalid VOXL V2 file: too small.');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate magic
  if (data[0] !== 0x56 || data[1] !== 0x4F || data[2] !== 0x58 || data[3] !== 0x4C) {
    throw new Error('Invalid VOXL binary magic.');
  }

  const version = view.getUint16(4, true);
  if (version !== VOXL_V2 && version !== VOXL_V3) {
    throw new Error(
      `Unsupported VOXL binary version: ${version}. Expected ${VOXL_V2} or ${VOXL_V3}.`,
    );
  }

  const chunkCount = view.getUint32(8, true);
  if (chunkCount > 10_000) {
    throw new Error('Invalid VOXL V2 file: unreasonable chunk count.');
  }

  const dirEnd = HEADER_SIZE + chunkCount * DIR_ENTRY_SIZE;
  if (data.length < dirEnd) {
    throw new Error('Invalid VOXL V2 file: truncated directory.');
  }

  // Read directory
  const entries: ChunkDirEntry[] = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const base = HEADER_SIZE + i * DIR_ENTRY_SIZE;
    const type = textDecoder.decode(data.subarray(base, base + 4));
    const index = view.getUint16(base + 4, true);
    const compression = view.getUint16(base + 6, true);
    const offset = view.getUint32(base + 8, true);
    const compressedSize = view.getUint32(base + 12, true);
    const uncompressedSize = view.getUint32(base + 16, true);

    if (offset + compressedSize > data.length) {
      throw new Error(`VOXL V2: chunk ${type}[${index}] extends beyond file boundary.`);
    }

    entries.push({ type, index, compression, offset, compressedSize, uncompressedSize });
  }

  // ── Chunk reader helpers ──────────────────────────────────────────────

  function readChunk(entry: ChunkDirEntry): Uint8Array {
    const raw = data.subarray(entry.offset, entry.offset + entry.compressedSize);

    if (entry.compression === COMPRESSION_ZLIB) {
      const inflated = unzlibSync(raw);
      if (inflated.length !== entry.uncompressedSize) {
        throw new Error(`VOXL V2: chunk ${entry.type}[${entry.index}] size mismatch after decompression.`);
      }
      return inflated;
    }

    if (entry.compression === COMPRESSION_NONE) {
      return raw;
    }

    throw new Error(`VOXL V2: unsupported compression type ${entry.compression} for chunk ${entry.type}[${entry.index}].`);
  }

  function readJsonChunk<T>(type: string, index = 0): T | null {
    const entry = entries.find((e) => e.type === type && e.index === index);
    if (!entry) return null;
    return JSON.parse(textDecoder.decode(readChunk(entry))) as T;
  }

  // ── Parse structured chunks ───────────────────────────────────────────

  const meta = readJsonChunk<VoxlMeta>(CHUNK_META);
  if (!meta) throw new Error('VOXL V2: missing META chunk.');

  const scene = readJsonChunk<VoxlSceneState>(CHUNK_SCNE) ?? { activeModelId: null, selectedModelIds: [] };
  const models = readJsonChunk<VoxlModelEntry[]>(CHUNK_MODL) ?? [];
  const supports = readJsonChunk<DragonfruitImportFormat>(CHUNK_SUPP);
  if (!supports) throw new Error('VOXL V2: missing SUPP chunk.');

  const extensions = readJsonChunk<Record<string, unknown>>(CHUNK_EXTD) ?? {};

  // ── Resolve MESH chunks ───────────────────────────────────────────────

  const meshBytesMap = new Map<string, Uint8Array>();
  // Decompress each MESH chunk at most once even when many models share it
  // (dedup) — the shared bytes are handed to every referencing model.
  const chunkBytesByIndex = new Map<number, Uint8Array>();

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    if (model.mesh?.mode === 'embedded-chunk') {
      // V3 duplicates point at an owner chunk via chunkIndex; V2/legacy files
      // map 1:1, so a missing chunkIndex means "my own model index".
      const chunkIdx = typeof model.mesh.chunkIndex === 'number' ? model.mesh.chunkIndex : i;
      let bytes = chunkBytesByIndex.get(chunkIdx);
      if (!bytes) {
        const meshEntry = entries.find((e) => e.type === CHUNK_MESH && e.index === chunkIdx);
        if (meshEntry) {
          bytes = readChunk(meshEntry);
          chunkBytesByIndex.set(chunkIdx, bytes);
        }
      }
      if (bytes) {
        meshBytesMap.set(model.id, bytes);
      }
    }
  }

  // ── Resolve ORIG chunks (additive full-res mesh) ──────────────────────

  const originalMeshChunksMap = new Map<string, PrecompressedChunk>();
  const origEntriesByIndex = new Map<number, ChunkDirEntry>();

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const chunkIdx = typeof model.mesh?.chunkIndex === 'number' ? model.mesh.chunkIndex : i;
    let entry = origEntriesByIndex.get(chunkIdx);
    if (!entry) {
      const origEntry = entries.find((e) => e.type === CHUNK_ORIG && e.index === chunkIdx);
      if (origEntry) {
        origEntriesByIndex.set(chunkIdx, origEntry);
        entry = origEntry;
      }
    }
    if (entry) {
      // Create a PrecompressedChunk view without decompressing
      const rawData = data.subarray(entry.offset, entry.offset + entry.compressedSize);
      originalMeshChunksMap.set(model.id, {
        data: rawData,
        compression: entry.compression,
        uncompressedSize: entry.uncompressedSize,
      });
    }
  }

  // ── Re-attach V2.2 modifier-snapshot chunks (HSRC/CAVT/PSRC) ──────────
  // The writer moved these Float32 position snapshots out of the MODL JSON into
  // raw-bytes chunks (§ CHUNK_HSRC). A snapshot lives in a chunk when its
  // *PositionCount is non-zero but the matching *Base64 is absent. Resolve the
  // owning chunk at `*ChunkIndex ?? modelIndex` (dedup pointer; owners default
  // to their own index) and re-encode as base64 so downstream consumers see the
  // exact V2.1 in-memory shape. Older V2 files simply have the base64 already
  // present and skip every branch here.
  const modifierChunkCache = new Map<string, Uint8Array>();
  const readModifierChunk = (type: string, index: number): Uint8Array | undefined => {
    const key = `${type}:${index}`;
    const cached = modifierChunkCache.get(key);
    if (cached) return cached;
    const entry = entries.find((e) => e.type === type && e.index === index);
    if (!entry) return undefined;
    const bytes = readChunk(entry);
    modifierChunkCache.set(key, bytes);
    return bytes;
  };

  for (let i = 0; i < models.length; i += 1) {
    const mm = models[i].meshModifiers;
    if (!mm) continue;

    const h = mm.hollowing;
    if (h) {
      if (h.sourcePositionCount && !h.sourcePositionsBase64) {
        const bytes = readModifierChunk(CHUNK_HSRC, h.sourceChunkIndex ?? i);
        if (bytes) h.sourcePositionsBase64 = bytesToBase64(bytes);
      }
      delete h.sourceChunkIndex;
      if (h.cavityPositionCount && !h.cavityPositionsBase64) {
        const bytes = readModifierChunk(CHUNK_CAVT, h.cavityChunkIndex ?? i);
        if (bytes) h.cavityPositionsBase64 = bytesToBase64(bytes);
      }
      delete h.cavityChunkIndex;
    }
    if (mm.holePunchSourcePositionCount && !mm.holePunchSourcePositionsBase64) {
      const bytes = readModifierChunk(CHUNK_PSRC, mm.holePunchSourceChunkIndex ?? i);
      if (bytes) mm.holePunchSourcePositionsBase64 = bytesToBase64(bytes);
    }
    delete mm.holePunchSourceChunkIndex;
  }

  // A file is 2.2 iff it actually carries modifier-snapshot chunks; otherwise it
  // is the inline ("2.1") layout — including 2.2-capable writes of scenes that
  // simply had no snapshots to chunk (byte-identical either way). Save-time
  // format preservation keys off this: a 2.2 file must never be autosaved back
  // to inline.
  const hasModifierChunks = entries.some(
    (e) => e.type === CHUNK_HSRC || e.type === CHUNK_CAVT || e.type === CHUNK_PSRC,
  );

  const lazyOriginalMeshBytesMap = originalMeshChunksMap.size > 0
    ? new LazyOriginalMeshBytesMap(originalMeshChunksMap)
    : undefined;

  return {
    document: {
      magic: VOXL_MAGIC,
      version: 1,
      meta,
      scene,
      models,
      supports,
      extensions,
    },
    meshBytes: meshBytesMap,
    ...(lazyOriginalMeshBytesMap ? { originalMeshBytes: lazyOriginalMeshBytesMap } : {}),
    ...(originalMeshChunksMap.size > 0 ? { originalMeshChunks: originalMeshChunksMap } : {}),
    sourceVersion: hasModifierChunks ? VOXL_V2_SEMANTIC_REVISION : VOXL_V2_INLINE_REVISION,
  };
}

/**
 * Alias for `parseVoxlBinaryV2` for V2 container documents.
 */
export const parseVoxlDocumentV2 = parseVoxlBinaryV2;

// ─── Format Detection ─────────────────────────────────────────────────────────

/**
 * Returns `true` if the raw bytes begin with the VOXL V2+ binary magic.
 */
export function isVoxlBinaryV2(data: Uint8Array): boolean {
  if (data.length < 6) return false;
  if (data[0] !== 0x56 || data[1] !== 0x4F || data[2] !== 0x58 || data[3] !== 0x4C) return false;
  const version = data[4] | (data[5] << 8); // uint16 LE
  return version >= 2;
}

// ─── Sidecar Mesh Resolution ──────────────────────────────────────────────────

/**
 * Locate and resolve external original mesh files referenced by `originalRef`
 * relative to the `.voxl` project path.
 *
 * If `originalRef` is missing or mode is not 'external-file' (or fileName is empty), returns null.
 * If `originalRef.fileName` is an absolute path, returns it directly.
 * If `originalRef.fileName` is relative and `projectPath` is provided, returns
 * the resolved absolute path relative to the directory containing `projectPath`.
 */
export function resolveOriginalRefSidecar(
  originalRef?: VoxlMeshRef,
  projectPath?: string,
): string | null {
  if (!originalRef || originalRef.mode !== 'external-file' || !originalRef.fileName) {
    return null;
  }

  const rawFileName = originalRef.fileName.trim();
  if (!rawFileName) return null;

  const isAbsolute = /^(?:[a-zA-Z]:[/\\]|\\\\|\/)/.test(rawFileName);
  if (isAbsolute) {
    return rawFileName.replace(/\\/g, '/');
  }

  if (!projectPath) {
    return rawFileName.replace(/\\/g, '/');
  }

  const normalizedProject = projectPath.replace(/\\/g, '/');
  const lastSlashIndex = normalizedProject.lastIndexOf('/');
  const baseDir = lastSlashIndex >= 0 ? normalizedProject.slice(0, lastSlashIndex) : normalizedProject;

  const normalizedRelative = rawFileName.replace(/\\/g, '/').replace(/^\.\//, '');
  const resolved = baseDir ? `${baseDir}/${normalizedRelative}` : normalizedRelative;
  return resolved;
}

/**
 * Helper to read raw bytes from a sidecar file path across environments (Node/Tauri/Browser).
 * Returns null if the file cannot be read or is missing.
 */
export async function readSidecarFileBytes(filePath: string): Promise<Uint8Array | null> {
  try {
    if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
      try {
        // The bundlers must not follow this: codec-v2 reaches the browser
        // bundle through page.tsx, and neither Turbopack nor webpack can
        // resolve a Node builtin there. The guard above keeps the import from
        // ever running outside Node, so leaving it unresolved is safe.
        const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:fs');
        if (fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
      } catch {
        // Fall through
      }
    }

    if (typeof window !== 'undefined' && '__TAURI_IPC__' in window) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const ab = await invoke<ArrayBuffer>('read_print_file_bytes', { path: filePath });
        if (ab) return new Uint8Array(ab);
      } catch {
        // Fall through
      }
    }

    if (typeof fetch === 'function') {
      const response = await fetch(filePath);
      if (response.ok) {
        const ab = await response.arrayBuffer();
        return new Uint8Array(ab);
      }
    }
  } catch {
    // Ignore and return null
  }

  return null;
}

