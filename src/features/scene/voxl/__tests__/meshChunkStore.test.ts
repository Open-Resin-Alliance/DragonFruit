import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { MeshChunkStore } from '../meshChunkStore';

/**
 * COW compressed-chunk store (Ph0.1 sub-phase C).
 *
 * The defect this pins: the per-model encode memo stored RAW STL bytes and threw
 * the compressed result away, so zlib-6 re-ran over every model's entire
 * geometry on every 30 s autosave tick — 3 589 ms / 172 MiB for one 4M-tri
 * model, 11 125 ms / 515 MiB for a 3-model plate — and nothing was ever evicted,
 * so a deleted 4M-tri model kept ~191 MiB resident for the rest of the session.
 *
 * Two properties carry the whole design:
 *
 *  - **Dirty tracking is by geometry SIGNATURE, not by a boolean flag.** The
 *    signature is derived from the geometry object, so it cannot drift the way a
 *    flag missed by a future mutation path would. A missed bake hook therefore
 *    costs a lazy re-bake, never a stale write.
 *  - **The store is content-addressed** (`owner → sha`, `sha → compressed`), so
 *    cross-tick reuse, multi-instance dedup, and eviction are one mechanism.
 */

const RAW_A = new Uint8Array(4096).fill(0xa1);
const RAW_B = new Uint8Array(4096).fill(0xb2);

function countingEncoder(bytes: Uint8Array) {
  const state = { calls: 0 };
  return {
    state,
    encode: () => {
      state.calls += 1;
      return bytes;
    },
  };
}

function deferredBytes() {
  let resolve!: (bytes: Uint8Array) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Uint8Array>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('the COW compressed-chunk store', () => {
  let store: MeshChunkStore;

  beforeEach(() => {
    store = new MeshChunkStore();
  });

  test('an unchanged model is NOT re-encoded or re-compressed on a second tick', async () => {
    const a = countingEncoder(RAW_A);

    const first = await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });
    const second = await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });

    assert.equal(a.state.calls, 1, 'the STL encoder ran again for unchanged geometry');
    assert.equal(store.stats().compressions, 1, 'zlib re-ran over unchanged geometry (the 3 589 ms defect)');
    assert.equal(store.stats().hits, 1);
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.data, first.data, 'the second tick must hand back the SAME blob, not a copy');
  });

  test('lookup by signature is the dirty primitive — no flag is consulted', async () => {
    const a = countingEncoder(RAW_A);
    await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });

    assert.ok(store.lookup('m0', 'sig-1'), 'a matching signature must resolve without a bake');
    assert.equal(store.lookup('m0', 'sig-2'), null, 'a changed signature must read as dirty');
  });

  test('a geometry mutation re-bakes exactly that model and zero neighbours', async () => {
    const a = countingEncoder(RAW_A);
    const b = countingEncoder(RAW_B);

    await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });
    await store.bake({ modelId: 'm1', signature: 'sig-1', encode: b.encode });

    // m0 is hollowed: `replaceModelGeometry` produces a new BufferGeometry, so
    // its signature changes. m1 is untouched.
    const mutated = new Uint8Array(4096).fill(0xc3);
    const c = countingEncoder(mutated);
    await store.bake({ modelId: 'm0', signature: 'sig-2', encode: c.encode });
    await store.bake({ modelId: 'm1', signature: 'sig-1', encode: b.encode });

    assert.equal(c.state.calls, 1, 'the mutated model must re-bake exactly once');
    assert.equal(b.state.calls, 1, 'an untouched neighbour must NOT re-bake');
    assert.equal(store.stats().compressions, 3, 'expected 2 initial bakes + 1 re-bake');
  });

  test('N models with identical geometry hold ONE blob', async () => {
    const a = countingEncoder(RAW_A);

    // Distinct signatures (different BufferGeometry uuids) but identical bytes —
    // exactly what Fill Plate produces.
    await store.bake({ modelId: 'm0', signature: 'geo-0', encode: a.encode });
    await store.bake({ modelId: 'm1', signature: 'geo-1', encode: a.encode });
    await store.bake({ modelId: 'm2', signature: 'geo-2', encode: a.encode });

    const stats = store.stats();
    assert.equal(stats.blobs, 1, 'three identical meshes must share one compressed blob');
    assert.equal(stats.owners, 3);
    assert.equal(stats.compressions, 1, 'only the first identical mesh may pay for compression');
    assert.equal(stats.retainedBytes, store.lookup('m0', 'geo-0')!.data.length);
  });

  test('deleting a model releases its bytes', async () => {
    const a = countingEncoder(RAW_A);
    await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });
    assert.ok(store.stats().retainedBytes > 0);

    store.release('m0');

    const stats = store.stats();
    assert.equal(stats.blobs, 0, 'a deleted model retained its compressed bytes forever');
    assert.equal(stats.owners, 0);
    assert.equal(stats.retainedBytes, 0);
    assert.equal(stats.evictions, 1);
    assert.equal(store.lookup('m0', 'sig-1'), null);
  });

  test('refcounting: releasing one of two sharers keeps the blob alive', async () => {
    const a = countingEncoder(RAW_A);
    await store.bake({ modelId: 'm0', signature: 'geo-0', encode: a.encode });
    await store.bake({ modelId: 'm1', signature: 'geo-1', encode: a.encode });

    store.release('m0');
    assert.equal(store.stats().blobs, 1, 'the surviving sharer lost its bytes');
    assert.ok(store.lookup('m1', 'geo-1'));

    store.release('m1');
    assert.equal(store.stats().blobs, 0);
  });

  test('re-baking releases the superseded blob instead of leaking it', async () => {
    const a = countingEncoder(RAW_A);
    const b = countingEncoder(RAW_B);

    await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });
    await store.bake({ modelId: 'm0', signature: 'sig-2', encode: b.encode });

    assert.equal(store.stats().blobs, 1, 'the pre-mutation blob was retained after the mutation');
    assert.equal(store.stats().evictions, 1);
  });

  test('retainOnly evicts every model that has left the scene', async () => {
    const a = countingEncoder(RAW_A);
    const b = countingEncoder(RAW_B);
    await store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode });
    await store.bake({ modelId: 'm1', signature: 'sig-1', encode: b.encode });

    store.retainOnly(['m1']);

    assert.equal(store.stats().owners, 1);
    assert.equal(store.lookup('m0', 'sig-1'), null);
    assert.ok(store.lookup('m1', 'sig-1'));
  });

  /**
   * Ph5 forward-compat. The original-mesh embed is a SECOND chunk for the same
   * model, so the store is keyed on (modelId, slot) rather than modelId alone.
   * Ph5 bakes it once at import with `slot: 'original'`; every tick and every
   * explicit save then references it, and a deletion releases both slots in one
   * call. Nothing about that path is implemented here — this test only pins the
   * key shape so it does not have to be retrofitted.
   */
  test('slots are independent, and deleting a model releases all of them', async () => {
    const preview = countingEncoder(RAW_A);
    const original = countingEncoder(RAW_B);

    await store.bake({ modelId: 'm0', slot: 'preview', signature: 'sig-1', encode: preview.encode });
    await store.bake({ modelId: 'm0', slot: 'original', signature: 'file-1', encode: original.encode });

    assert.equal(store.stats().owners, 2);
    assert.ok(store.lookup('m0', 'sig-1', 'preview'));
    assert.ok(store.lookup('m0', 'file-1', 'original'));
    assert.equal(store.lookup('m0', 'sig-1', 'original'), null, 'slots must not alias each other');

    store.release('m0');
    assert.equal(store.stats().owners, 0, 'deleting a model must release every slot it owns');
    assert.equal(store.stats().blobs, 0);
  });

  test('concurrent bakes of the same key collapse into one compression', async () => {
    const a = countingEncoder(RAW_A);
    const [first, second] = await Promise.all([
      store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode }),
      store.bake({ modelId: 'm0', signature: 'sig-1', encode: a.encode }),
    ]);

    assert.equal(store.stats().compressions, 1, 'a coalesced bake ran zlib twice');
    assert.equal(first.data, second.data);
  });

  test('concurrent identical content preserves every owner reference', async () => {
    const [first, second] = await Promise.all([
      store.bake({ modelId: 'm0', signature: 'geo-0', encode: () => RAW_A.slice() }),
      store.bake({ modelId: 'm1', signature: 'geo-1', encode: () => RAW_A.slice() }),
    ]);

    assert.equal(first.data, second.data, 'both owners must use the canonical blob');
    store.release('m0');
    assert.ok(store.lookup('m1', 'geo-1'), 'releasing one owner evicted the surviving owner');
    assert.equal(store.stats().blobs, 1);
    store.release('m1');
    assert.equal(store.stats().blobs, 0);
  });

  test('a bake completing after release returns its bytes without retaining them', async () => {
    const encoded = deferredBytes();
    const pending = store.bake({ modelId: 'm0', signature: 'sig-1', encode: () => encoded.promise });
    store.release('m0');
    encoded.resolve(RAW_A);
    const result = await pending;

    assert.equal(result.uncompressedSize, RAW_A.length);
    assert.equal(store.stats().owners, 0, 'a completed bake resurrected a deleted owner');
    assert.equal(store.stats().blobs, 0);
    assert.equal(store.isBakeInFlight(), false);
  });

  test('retainOnly invalidates pending-only owners without dropping retained work', async () => {
    const removed = deferredBytes();
    const kept = deferredBytes();
    const removedBake = store.bake({ modelId: 'removed', signature: 's0', encode: () => removed.promise });
    const keptBake = store.bake({ modelId: 'kept', signature: 's1', encode: () => kept.promise });
    store.retainOnly(['kept']);
    removed.resolve(RAW_A);
    kept.resolve(RAW_B);
    await Promise.all([removedBake, keptBake]);

    assert.equal(store.lookup('removed', 's0'), null);
    assert.ok(store.lookup('kept', 's1'));
    assert.equal(store.stats().owners, 1);
    assert.equal(store.stats().blobs, 1);
  });

  test('clear invalidates old work without letting its cleanup remove a fresh bake', async () => {
    const old = deferredBytes();
    const fresh = deferredBytes();
    const oldBake = store.bake({ modelId: 'm0', signature: 'sig-1', encode: () => old.promise });
    store.clear();
    const freshBake = store.bake({ modelId: 'm0', signature: 'sig-1', encode: () => fresh.promise });
    const freshPending = store.pending('m0', 'sig-1');
    old.resolve(RAW_A);
    await oldBake;

    assert.equal(store.stats().owners, 0);
    assert.equal(store.stats().blobs, 0);
    assert.equal(store.stats().compressions, 0, 'old work changed reset statistics');
    assert.equal(store.pending('m0', 'sig-1'), freshPending);
    assert.equal(store.isBakeInFlight(), true);
    fresh.resolve(RAW_B);
    await freshBake;
    assert.ok(store.lookup('m0', 'sig-1'));
    assert.equal(store.stats().owners, 1);
    assert.equal(store.stats().blobs, 1);
  });

  test('an older signature completing last cannot overwrite the newer bake', async () => {
    const old = deferredBytes();
    const fresh = deferredBytes();
    const oldBake = store.bake({ modelId: 'm0', signature: 'old', encode: () => old.promise });
    const freshBake = store.bake({ modelId: 'm0', signature: 'fresh', encode: () => fresh.promise });
    fresh.resolve(RAW_B);
    const expected = await freshBake;
    old.resolve(RAW_A);
    await oldBake;

    assert.equal(store.lookup('m0', 'old'), null);
    assert.equal(store.lookup('m0', 'fresh')?.data, expected.data);
    assert.equal(store.stats().blobs, 1);
  });

  test('returning to a cached signature invalidates a different pending bake', async () => {
    const cached = await store.bake({ modelId: 'm0', signature: 'cached', encode: () => RAW_A });
    const changed = deferredBytes();
    const changedBake = store.bake({ modelId: 'm0', signature: 'changed', encode: () => changed.promise });
    await store.bake({ modelId: 'm0', signature: 'cached', encode: () => RAW_A });
    changed.resolve(RAW_B);
    await changedBake;

    assert.equal(store.lookup('m0', 'cached')?.data, cached.data);
    assert.equal(store.lookup('m0', 'changed'), null);
    assert.equal(store.stats().blobs, 1);
  });

  test('releasing a pending preview leaves the original slot live', async () => {
    const preview = deferredBytes();
    const original = deferredBytes();
    const previewBake = store.bake({ modelId: 'm0', signature: 's0', encode: () => preview.promise });
    const originalBake = store.bake({ modelId: 'm0', slot: 'original', signature: 's1', encode: () => original.promise });
    store.release('m0', 'preview');
    preview.resolve(RAW_A);
    original.resolve(RAW_B);
    await Promise.all([previewBake, originalBake]);

    assert.equal(store.lookup('m0', 's0'), null);
    assert.ok(store.lookup('m0', 's1', 'original'));
    assert.equal(store.stats().owners, 1);
  });

  test('precompressed chunks with a known digest are adopted and shared', async () => {
    const precompressed = { data: RAW_A, compression: 0, uncompressedSize: RAW_A.length, sha256: 'known-digest' };
    const encode = () => { throw new Error('precompressed chunks must not be encoded'); };
    await Promise.all([
      store.bake({ modelId: 'm0', signature: 's0', precompressed, encode }),
      store.bake({ modelId: 'm1', signature: 's1', precompressed, encode }),
    ]);
    store.release('m0');
    assert.equal(store.lookup('m1', 's1')?.data, RAW_A);
    assert.equal(store.stats().compressions, 0);
  });

  test('a rejected bake does not strand pending work or block a retry', async () => {
    const encoded = deferredBytes();
    const pending = store.bake({ modelId: 'm0', signature: 'sig-1', encode: () => encoded.promise });
    const rejected = assert.rejects(pending, /encode failed/);
    encoded.reject(new Error('encode failed'));
    await rejected;
    assert.equal(store.pending('m0', 'sig-1'), null);
    assert.equal(store.isBakeInFlight(), false);
    await store.bake({ modelId: 'm0', signature: 'sig-1', encode: () => RAW_A });
    assert.ok(store.lookup('m0', 'sig-1'));
  });

  test('payloads too small or too incompressible to shrink are stored raw', async () => {
    const tiny = new Uint8Array([1, 2, 3, 4]);
    const t = countingEncoder(tiny);
    const baked = await store.bake({ modelId: 'm0', signature: 'sig-1', encode: t.encode });

    // Mirrors the codec's own policy (`raw.length > 64` and only if it shrinks),
    // which is what keeps the emitted bytes identical to the pre-store writer.
    assert.equal(baked.compression, 0, 'a 4-byte payload must not be zlib-wrapped');
    assert.deepEqual([...baked.data], [...tiny]);
    assert.equal(baked.uncompressedSize, tiny.length);
  });
});
