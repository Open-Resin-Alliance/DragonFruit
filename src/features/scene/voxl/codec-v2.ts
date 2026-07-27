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
 *   0..3   type        4 ASCII chars (META, SCNE, MODL, MESH, SUPP, EXTD)
 *   4..5   index       uint16 LE (multi-instance ordinal, e.g. MESH per model)
 *   6..7   compression uint16 LE (0 = none, 1 = zlib)
 *   8..11  offset      uint32 LE (byte offset from file start)
 *   12..15 compSize    uint32 LE (compressed byte length)
 *   16..19 rawSize     uint32 LE (uncompressed byte length)
 *
 * Chunk data follows the directory, tightly packed.
 */

import { unzlibSync, zlib as zlibAsync } from 'fflate';

type ZlibCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// Promisified async zlib — runs in fflate's worker pool, never blocks the main thread.
const compressAsync = (data: Uint8Array, level: ZlibCompressionLevel): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    zlibAsync(data, { level }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
import {
  VOXL_MAGIC,
  type BuildVoxlDocumentInput,
  type ParsedVoxlResult,
  type VoxlMeshRef,
  type VoxlMeta,
  type VoxlModelEntry,
  type VoxlSceneState,
} from './types';
import type { DragonfruitImportFormat } from '@/supports/types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VOXL_V2 = 2;
export const VOXL_V2_SEMANTIC_REVISION = 2.1;
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
const CHUNK_SUPP = 'SUPP';
const CHUNK_EXTD = 'EXTD';

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
export interface PrecompressedChunk {
  data: Uint8Array;
  compression: number;
  uncompressedSize: number;
}

export interface VoxlSerializeOptions {
  /** Model index → already-compressed MESH payload. */
  precompressed?: Map<number, PrecompressedChunk>;
}

interface ResolvedChunk {
  type: string;
  index: number;
  compression: number;
  data: Uint8Array;
  uncompressedSize: number;
}

interface PreparedDocument {
  resolved: ResolvedChunk[];
  directory: ChunkDirEntry[];
  totalSize: number;
  version: number;
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
      // Written only when true (Ph0.1 D2): a scene with nothing stale must
      // serialize to exactly the bytes it did before the flag existed.
      ...(m.geometryStale === true ? { geometryStale: true } : {}),
      transform: {
        position: { x: m.transform.position.x, y: m.transform.position.y, z: m.transform.position.z },
        rotation: { x: m.transform.rotation.x, y: m.transform.rotation.y, z: m.transform.rotation.z },
        scale: { x: m.transform.scale.x, y: m.transform.scale.y, z: m.transform.scale.z },
      },
      meshModifiers: m.meshModifiers,
      mesh: meshRef,
    };
  });

  // ── Collect pending chunks ────────────────────────────────────────────

  type PendingChunk = {
    type: string;
    index: number;
    raw?: Uint8Array;
    pre?: PrecompressedChunk;
    compress: boolean;
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
      pending.push({ type: CHUNK_MESH, index: modelIndex, pre, compress: true });
    } else {
      pending.push({ type: CHUNK_MESH, index: modelIndex, raw: meshBytes.get(modelIndex)!, compress: true });
    }
  }

  pending.push({ type: CHUNK_SUPP, index: 0, raw: textEncoder.encode(JSON.stringify(input.supports)), compress: true });

  if (input.extensions && Object.keys(input.extensions).length > 0) {
    pending.push({ type: CHUNK_EXTD, index: 0, raw: textEncoder.encode(JSON.stringify(input.extensions)), compress: false });
  }

  // ── Compress (async – does not block the main thread) ─────────────────
  //
  // A chunk that arrives pre-compressed skips this entirely. That is the whole
  // sub-phase-C win: for an unchanged scene, every MESH chunk takes this branch
  // and the per-tick zlib cost collapses to the KB-scale JSON chunks.

  const resolved: ResolvedChunk[] = await Promise.all(pending.map(async (chunk): Promise<ResolvedChunk> => {
    if (chunk.pre) {
      return {
        type: chunk.type,
        index: chunk.index,
        compression: chunk.pre.compression,
        data: chunk.pre.data,
        uncompressedSize: chunk.pre.uncompressedSize,
      };
    }

    const raw = chunk.raw!;
    if (chunk.compress && raw.length > 64) {
      if (chunk.type === CHUNK_MESH) voxlCodecStats.meshChunkCompressions += 1;
      else voxlCodecStats.jsonChunkCompressions += 1;

      const compressed = await compressAsync(raw, 6);
      if (compressed.length < raw.length) {
        return {
          type: chunk.type,
          index: chunk.index,
          compression: COMPRESSION_ZLIB,
          data: compressed,
          uncompressedSize: raw.length,
        };
      }
    }
    return {
      type: chunk.type,
      index: chunk.index,
      compression: COMPRESSION_NONE,
      data: raw,
      uncompressedSize: raw.length,
    };
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

  return {
    resolved,
    directory,
    totalSize,
    // Version bumps to 3 only when dedup removed chunks, so old readers reject
    // deduped files cleanly rather than losing the shared-chunk models;
    // non-deduped scenes stay V2 and remain readable by older builds.
    version: dedupRemovedChunks ? VOXL_V3 : VOXL_V2,
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
 * @param options     - Optional pre-compressed payloads from the chunk store
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
): Promise<{ totalSize: number; version: number }> {
  const prepared = await prepareVoxlDocumentV2(input, meshBytes, sha256Map, options);

  await sink(buildVoxlPreamble(prepared));
  for (const chunk of prepared.resolved) {
    await sink(chunk.data);
  }

  return { totalSize: prepared.totalSize, version: prepared.version };
}

// ─── V2 Binary Reader ─────────────────────────────────────────────────────────

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
    sourceVersion: VOXL_V2_SEMANTIC_REVISION,
  };
}

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
