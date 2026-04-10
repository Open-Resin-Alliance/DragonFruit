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
  type VoxlDocumentV1,
  type VoxlMeshRef,
  type VoxlMeta,
  type VoxlModelEntry,
  type VoxlSceneState,
} from './types';
import type { DragonfruitImportFormat } from '@/supports/types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VOXL_V2 = 2;

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

// ─── V2 Binary Writer ─────────────────────────────────────────────────────────

/**
 * Serialize a VOXL scene to the V2 binary container format.
 *
 * @param input       - Scene data (models, supports, extensions, etc.)
 * @param meshBytes   - Map of model index → raw mesh binary (e.g. STL bytes)
 * @param sha256Map   - Optional map of model index → hex SHA-256 digest
 * @returns           - Complete VOXL V2 binary as Uint8Array
 */
export async function serializeVoxlDocumentV2(
  input: BuildVoxlDocumentInput,
  meshBytes: Map<number, Uint8Array>,
  sha256Map?: Map<number, string>,
): Promise<Uint8Array> {
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

  const models: VoxlModelEntry[] = input.models.map((m, i) => {
    const hasChunk = meshBytes.has(i);
    const meshRef: VoxlMeshRef = hasChunk
      ? {
          mode: 'embedded-chunk',
          fileName: m.mesh?.fileName ?? m.name,
          mimeType: m.mesh?.mimeType ?? 'model/stl',
          uncompressedSizeBytes: meshBytes.get(i)!.length,
          sha256: sha256Map?.get(i),
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
      transform: {
        position: { x: m.transform.position.x, y: m.transform.position.y, z: m.transform.position.z },
        rotation: { x: m.transform.rotation.x, y: m.transform.rotation.y, z: m.transform.rotation.z },
        scale: { x: m.transform.scale.x, y: m.transform.scale.y, z: m.transform.scale.z },
      },
      mesh: meshRef,
    };
  });

  // ── Collect pending chunks ────────────────────────────────────────────

  type PendingChunk = { type: string; index: number; raw: Uint8Array; compress: boolean };
  const pending: PendingChunk[] = [];

  pending.push({ type: CHUNK_META, index: 0, raw: textEncoder.encode(JSON.stringify(meta)), compress: false });
  pending.push({ type: CHUNK_SCNE, index: 0, raw: textEncoder.encode(JSON.stringify(scene)), compress: false });
  pending.push({ type: CHUNK_MODL, index: 0, raw: textEncoder.encode(JSON.stringify(models)), compress: true });

  // One MESH chunk per model with embedded data, sorted by index
  const sortedMeshEntries = [...meshBytes.entries()].sort((a, b) => a[0] - b[0]);
  for (const [modelIndex, bytes] of sortedMeshEntries) {
    pending.push({ type: CHUNK_MESH, index: modelIndex, raw: bytes, compress: true });
  }

  pending.push({ type: CHUNK_SUPP, index: 0, raw: textEncoder.encode(JSON.stringify(input.supports)), compress: true });

  if (input.extensions && Object.keys(input.extensions).length > 0) {
    pending.push({ type: CHUNK_EXTD, index: 0, raw: textEncoder.encode(JSON.stringify(input.extensions)), compress: false });
  }

  // ── Compress (async – does not block the main thread) ─────────────────

  const resolved = await Promise.all(pending.map(async (chunk) => {
    if (chunk.compress && chunk.raw.length > 64) {
      const compressed = await compressAsync(chunk.raw, 6);
      if (compressed.length < chunk.raw.length) {
        return {
          type: chunk.type,
          index: chunk.index,
          compression: COMPRESSION_ZLIB,
          data: compressed,
          uncompressedSize: chunk.raw.length,
        };
      }
    }
    return {
      type: chunk.type,
      index: chunk.index,
      compression: COMPRESSION_NONE,
      data: chunk.raw,
      uncompressedSize: chunk.raw.length,
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

  // ── Assemble binary ───────────────────────────────────────────────────

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // Header
  out.set(MAGIC_BYTES, 0);
  view.setUint16(4, VOXL_V2, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, chunkCount, true);
  view.setUint32(12, 0, true);

  // Directory
  for (let i = 0; i < chunkCount; i += 1) {
    const entry = directory[i];
    const base = HEADER_SIZE + i * DIR_ENTRY_SIZE;
    out.set(textEncoder.encode(entry.type), base);
    view.setUint16(base + 4, entry.index, true);
    view.setUint16(base + 6, entry.compression, true);
    view.setUint32(base + 8, entry.offset, true);
    view.setUint32(base + 12, entry.compressedSize, true);
    view.setUint32(base + 16, entry.uncompressedSize, true);
  }

  // Chunk data
  for (let i = 0; i < resolved.length; i += 1) {
    out.set(resolved[i].data, directory[i].offset);
  }

  return out;
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
  if (version !== VOXL_V2) {
    throw new Error(`Unsupported VOXL binary version: ${version}. Expected ${VOXL_V2}.`);
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

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    if (model.mesh?.mode === 'embedded-chunk') {
      const meshEntry = entries.find((e) => e.type === CHUNK_MESH && e.index === i);
      if (meshEntry) {
        meshBytesMap.set(model.id, readChunk(meshEntry));
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
    sourceVersion: 2,
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
