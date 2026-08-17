/**
 * Cross-tick compressed-chunk cache for VOXL autosave (per-chunk hashing, Phase 1).
 *
 * Autosave re-serializes the whole scene every tick. Geometry (MESH/ORIG) is
 * already content-addressed by `meshChunkStore`, but the modifier-snapshot and
 * support chunks were decoded + zlib'd from scratch every time. This cache lets
 * the codec reuse a chunk's already-compressed bytes (and its content digest)
 * across ticks when the chunk's content is unchanged.
 *
 * Design note — why we do NOT key by the payload itself:
 *   The modifier snapshots are base64 strings up to ~512 MiB. A `Map` keyed by
 *   that string would hash the whole string on every lookup, which is exactly
 *   the per-tick cost we are trying to remove. Instead the key is a SMALL,
 *   stable handle (`${modelId}:hsrc`, `supp`, …) and the large payload is kept
 *   as a `signal` compared with `===`. String `===` is content equality but V8
 *   fast-paths it on pointer identity, and the base64 reference is preserved
 *   across object spreads while the snapshot is unchanged — so the hot path is
 *   an O(1) pointer compare and a genuine content change is still caught
 *   (different string ⇒ `===` false ⇒ recompute). No false "unchanged".
 */

export interface CachedChunkPayload {
  /** Container compression tag (0 = none, 1 = zlib) of `data`. */
  compression: number;
  /** The emitted (already-compressed, or stored-raw) chunk bytes. */
  data: Uint8Array;
  /** Uncompressed byte length — the directory's rawSize field. */
  uncompressedSize: number;
  /** SHA-256 hex of the RAW (uncompressed) content, for the document fingerprint. */
  digest: string;
}

interface CacheEntry {
  signal: string;
  payload: CachedChunkPayload;
}

/**
 * A bounded, caller-owned cache. One instance lives for the lifetime of a loaded
 * scene (owned by the autosave hook) and is passed into the serializer via
 * `VoxlSerializeOptions.chunkCache`. Manual/one-off saves pass none, so they
 * behave exactly as before.
 */
export class VoxlChunkCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /**
   * Returns the cached payload for `key` only when its stored `signal` is `===`
   * the one supplied — i.e. the content is provably unchanged. Any mismatch (or
   * a miss) returns undefined so the caller recomputes.
   */
  get(key: string, signal: string): CachedChunkPayload | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.signal === signal) {
      // Refresh recency (Map preserves insertion order → re-insert = move to end).
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.payload;
    }
    return undefined;
  }

  set(key: string, signal: string, payload: CachedChunkPayload): void {
    this.entries.delete(key);
    this.entries.set(key, { signal, payload });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
