/**
 * COW compressed-chunk store (Ph0.1 sub-phase C).
 *
 * ## The defect this replaces
 *
 * The VOXL writer memoised each model's **raw** binary STL bytes keyed on a
 * geometry signature, then threw the compressed result away. Every 30 s autosave
 * tick therefore re-ran zlib-6 over every model's entire geometry — measured at
 * **3 589 ms / 172 MiB for one 4M-tri model** and **11 125 ms / 515 MiB for a
 * 3-model plate** — even when nothing but a camera transform had changed. The
 * memo also had exactly one `.get` and one `.set` and no eviction anywhere, so a
 * deleted 4M-tri model kept ~191 MiB of raw STL resident for the rest of the
 * session.
 *
 * ## The two properties that carry the design
 *
 * **1. Dirty tracking is by geometry SIGNATURE, not by a boolean flag.**
 * `ExportManager.computeModelGeometrySignature` is promoted from a private cache
 * key to the dirty primitive. It is derived from the geometry object itself
 * (`uuid : position.version : index.version : vertexCount`), so it cannot drift
 * the way a flag missed by a future mutation path would. The consequence worth
 * stating: because the signature is the authority and the bake hooks are merely
 * *when*, a missed hook costs a lazy re-bake on the next tick — **never a stale
 * write**. That makes the hook placement an optimization, not a correctness
 * dependency.
 *
 * **2. The store is content-addressed, two levels deep.**
 *
 * ```
 *   owner (modelId + slot)  →  { signature, sha256 }
 *   sha256                  →  { data, compression, uncompressedSize, refs }
 * ```
 *
 * One mechanism buys three things: cross-tick reuse (level 1 hit), memory-side
 * dedup across instances of the same geometry (level 2 collision), and
 * refcounted eviction (level 2 `refs` reaching zero).
 *
 * ## Ph5 forward-compat (design only — not implemented here)
 *
 * The coming VOXL original-mesh embed must be written **through** this store.
 * That is why owners are keyed on `(modelId, slot)` rather than `modelId`: Ph5
 * bakes the original once at import with `slot: 'original'`, every subsequent
 * tick and explicit save references the same blob, a second import of the same
 * file collides on SHA and costs nothing, and `release(modelId)` still frees
 * both slots in one call from `deleteModels`.
 */

import { zlib as zlibAsync } from 'fflate';

/** Mirrors the codec's own chunk compression tags. */
export const CHUNK_COMPRESSION_NONE = 0;
export const CHUNK_COMPRESSION_ZLIB = 1;

/**
 * The codec's compression policy, restated here because the store now decides it
 * at bake time. Both halves matter for the byte-identity gate: payloads at or
 * below 64 bytes are never zlib-wrapped, and a payload that does not actually
 * shrink is stored raw.
 */
const MIN_COMPRESSIBLE_BYTES = 64;
const ZLIB_LEVEL = 6;

const compressAsync = (data: Uint8Array): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    zlibAsync(data, { level: ZLIB_LEVEL }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

/**
 * Which payload a chunk holds for a model. `preview` is the live scene geometry
 * the writer embeds today; `original` is reserved for Ph5's full-resolution
 * embed and is already routable so the embed does not have to retrofit the key.
 */
export type ChunkSlot = 'preview' | 'original';

export interface BakedChunk {
  readonly sha256: string;
  /** Compressed bytes, or the raw bytes when `compression === 0`. */
  readonly data: Uint8Array;
  readonly compression: number;
  readonly uncompressedSize: number;
}

export interface BakeRequest {
  modelId: string;
  /** Defaults to `'preview'`. */
  slot?: ChunkSlot;
  /** The geometry signature this payload corresponds to. */
  signature: string;
  /** Produces the raw bytes. Called only on a miss. */
  encode: () => Uint8Array | Promise<Uint8Array>;
}

export interface MeshChunkStoreStats {
  /** Payloads encoded + hashed + compressed (i.e. real work performed). */
  compressions: number;
  /** Ticks served from level 1 without touching the encoder. */
  hits: number;
  /** Blobs dropped because their refcount reached zero. */
  evictions: number;
  /** Distinct SHAs currently held. */
  blobs: number;
  /** Distinct (modelId, slot) owners currently mapped. */
  owners: number;
  /** Bytes currently retained across all blobs. */
  retainedBytes: number;
}

interface BlobEntry {
  data: Uint8Array;
  compression: number;
  uncompressedSize: number;
  refs: number;
}

interface OwnerEntry {
  signature: string;
  sha256: string;
}

const ownerKey = (modelId: string, slot: ChunkSlot): string => `${slot}:${modelId}`;

export class MeshChunkStore {
  private readonly contentByOwner = new Map<string, OwnerEntry>();

  private readonly chunkStore = new Map<string, BlobEntry>();

  /**
   * In-flight bakes keyed on owner+signature. Two ticks racing the same model —
   * an explicit save landing on top of an autosave, say — must produce one
   * compression, not two.
   */
  private readonly inFlight = new Map<string, Promise<BakedChunk>>();

  private compressions = 0;

  private hits = 0;

  private evictions = 0;

  /**
   * Returns the baked chunk for this owner **iff** its recorded signature still
   * matches. A mismatch reads as dirty; that is the whole dirty-tracking
   * mechanism.
   */
  lookup(modelId: string, signature: string, slot: ChunkSlot = 'preview'): BakedChunk | null {
    const owner = this.contentByOwner.get(ownerKey(modelId, slot));
    if (!owner || owner.signature !== signature) return null;
    const blob = this.chunkStore.get(owner.sha256);
    if (!blob) return null;
    return {
      sha256: owner.sha256,
      data: blob.data,
      compression: blob.compression,
      uncompressedSize: blob.uncompressedSize,
    };
  }

  /**
   * The in-flight bake for this exact owner+signature, if one is running.
   *
   * Exposed so a tick can *wait* on a bake that a finalization hook already
   * started rather than starting a second one — which is what makes the bounded
   * wait and the `geometryStale` fallback (D2) possible without a second
   * coalescing mechanism living outside the store.
   */
  pending(modelId: string, signature: string, slot: ChunkSlot = 'preview'): Promise<BakedChunk> | null {
    return this.inFlight.get(`${ownerKey(modelId, slot)}@${signature}`) ?? null;
  }

  /**
   * The chunk this owner last committed, **whatever its signature**. Used only
   * by the stale-geometry fallback (D2): a tick whose bounded wait expired
   * writes these bytes and flags the model rather than losing the tick.
   */
  lastCommitted(modelId: string, slot: ChunkSlot = 'preview'): BakedChunk | null {
    const owner = this.contentByOwner.get(ownerKey(modelId, slot));
    if (!owner) return null;
    const blob = this.chunkStore.get(owner.sha256);
    if (!blob) return null;
    return {
      sha256: owner.sha256,
      data: blob.data,
      compression: blob.compression,
      uncompressedSize: blob.uncompressedSize,
    };
  }

  /**
   * Resolve this owner's chunk, encoding + hashing + compressing only if the
   * signature has moved. Safe to call on every tick and from every finalization
   * hook — a hit is a map lookup.
   */
  async bake(request: BakeRequest): Promise<BakedChunk> {
    const slot = request.slot ?? 'preview';
    const key = ownerKey(request.modelId, slot);

    const cached = this.lookup(request.modelId, request.signature, slot);
    if (cached) {
      this.hits += 1;
      return cached;
    }

    const flightKey = `${key}@${request.signature}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;

    const flight = (async (): Promise<BakedChunk> => {
      const raw = await request.encode();
      const sha256 = await sha256Hex(raw);

      let blob = this.chunkStore.get(sha256);
      if (!blob) {
        // Level-2 miss: this content has never been seen. This is the only place
        // zlib runs.
        let data = raw;
        let compression = CHUNK_COMPRESSION_NONE;
        if (raw.length > MIN_COMPRESSIBLE_BYTES) {
          const compressed = await compressAsync(raw);
          if (compressed.length < raw.length) {
            data = compressed;
            compression = CHUNK_COMPRESSION_ZLIB;
          }
        }
        blob = { data, compression, uncompressedSize: raw.length, refs: 0 };
        this.chunkStore.set(sha256, blob);
        this.compressions += 1;
      }

      this.adopt(key, request.signature, sha256);

      return { sha256, data: blob.data, compression: blob.compression, uncompressedSize: blob.uncompressedSize };
    })();

    this.inFlight.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  /**
   * Drops this model's chunks. With no `slot`, every slot the model owns is
   * released — which is what `deleteModels` wants, and what keeps Ph5's embed
   * from leaking when a model is deleted.
   */
  release(modelId: string, slot?: ChunkSlot): void {
    if (slot) {
      this.releaseOwner(ownerKey(modelId, slot));
      return;
    }
    for (const candidate of ['preview', 'original'] as const) {
      this.releaseOwner(ownerKey(modelId, candidate));
    }
  }

  /**
   * Releases every owner whose model is no longer in the scene. A backstop for
   * paths that remove models without going through `deleteModels`; cheap enough
   * to call on a tick.
   */
  retainOnly(modelIds: Iterable<string>): void {
    const keep = new Set(modelIds);
    for (const key of [...this.contentByOwner.keys()]) {
      const modelId = key.slice(key.indexOf(':') + 1);
      if (!keep.has(modelId)) this.releaseOwner(key);
    }
  }

  clear(): void {
    this.contentByOwner.clear();
    this.chunkStore.clear();
    this.inFlight.clear();
    this.compressions = 0;
    this.hits = 0;
    this.evictions = 0;
  }

  stats(): MeshChunkStoreStats {
    let retainedBytes = 0;
    for (const blob of this.chunkStore.values()) retainedBytes += blob.data.length;
    return {
      compressions: this.compressions,
      hits: this.hits,
      evictions: this.evictions,
      blobs: this.chunkStore.size,
      owners: this.contentByOwner.size,
      retainedBytes,
    };
  }

  private adopt(key: string, signature: string, sha256: string): void {
    const previous = this.contentByOwner.get(key);
    if (previous?.sha256 === sha256) {
      // Same content under a new signature (e.g. a mutation that happened to be
      // a no-op). Re-point without disturbing the refcount.
      this.contentByOwner.set(key, { signature, sha256 });
      return;
    }

    this.chunkStore.get(sha256)!.refs += 1;
    this.contentByOwner.set(key, { signature, sha256 });
    if (previous) this.decRef(previous.sha256);
  }

  private releaseOwner(key: string): void {
    const owner = this.contentByOwner.get(key);
    if (!owner) return;
    this.contentByOwner.delete(key);
    this.decRef(owner.sha256);
  }

  private decRef(sha256: string): void {
    const blob = this.chunkStore.get(sha256);
    if (!blob) return;
    blob.refs -= 1;
    if (blob.refs <= 0) {
      this.chunkStore.delete(sha256);
      this.evictions += 1;
    }
  }
}

/**
 * Hex SHA-256. Kept here rather than in `ExportManager` because the store is now
 * the only steady-state caller: post-bake the raw bytes are dropped, so the
 * transient full-buffer copy this makes no longer happens on every tick.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 hashing is unavailable in this environment.');
  }
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
  const digestBytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < digestBytes.length; i += 1) {
    hex += digestBytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * The process-wide store. A single instance is correct here: the webview runs
 * one scene, and content addressing means a second scene's identical geometry is
 * a free hit rather than a collision.
 */
export const meshChunkStore = new MeshChunkStore();
