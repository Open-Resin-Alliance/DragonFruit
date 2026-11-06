import assert from 'node:assert/strict';
import test from 'node:test';
import { PreparedGeometryCache } from '../preparedGeometryCache';

const triangle = (x: number) => new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]);

function fakeDirectory() {
  const files = new Map<string, Uint8Array>();
  const writes: number[] = [];
  const reads: number[] = [];
  const hooks: {
    write?: () => Promise<void>;
    read?: () => Promise<void>;
    quota?: boolean;
    partial?: boolean;
  } = {};
  const directory = {
    async *entries() {
      for (const name of files.keys()) yield [name, { kind: 'file' }];
    },
    async removeEntry(name: string) { files.delete(name); },
    async getFileHandle(name: string) {
      if (!files.has(name)) files.set(name, new Uint8Array());
      return {
        async getFile() {
          const bytes = files.get(name);
          if (!bytes) throw new Error('Missing file');
          return {
            size: bytes.length,
            slice(start: number, end: number) {
              reads.push(end - start);
              return {
                async arrayBuffer() {
                  await hooks.read?.();
                  return bytes.slice(start, end).buffer;
                },
              };
            },
          };
        },
        async createWritable() {
          const parts: Uint8Array[] = [];
          return {
            async write(bytes: Uint8Array) {
              writes.push(bytes.length);
              await hooks.write?.();
              if (hooks.quota) throw new Error('QuotaExceededError');
              if (hooks.partial) {
                files.set(name, bytes.slice(0, 4));
                throw new Error('Interrupted write');
              }
              parts.push(bytes.slice());
            },
            async close() {
              const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
              let offset = 0;
              for (const part of parts) { bytes.set(part, offset); offset += part.length; }
              files.set(name, bytes);
            },
            async abort() { parts.length = 0; },
          };
        },
      };
    },
  };
  // The fake implements only the standard OPFS members the cache consumes.
  const handle = directory as unknown as FileSystemDirectoryHandle;
  return { handle, files, writes, reads, hooks };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('nine small models remain hot and cache ownership is independent of every output', async () => {
  let opened = 0;
  const cache = new PreparedGeometryCache({ getDirectory: async () => { opened += 1; return null; } });
  for (let i = 0; i < 9; i += 1) {
    const ticket = cache.begin(`model-${i}`);
    const input = triangle(i);
    await cache.put(`key-${i}`, input, ticket);
    input.fill(-1);
    cache.end(ticket);
  }
  for (let i = 0; i < 9; i += 1) {
    const ticket = cache.begin(`model-${i}`);
    const first = await cache.get(`key-${i}`, ticket);
    assert.deepEqual(first, triangle(i));
    first?.fill(-2);
    assert.deepEqual(await cache.get(`key-${i}`, ticket), triangle(i));
    cache.end(ticket);
  }
  assert.equal(opened, 0, 'RAM-only workloads must not create OPFS files');
});

test('spill reload preserves bytes and evicts least-recent disk payload within its budget', async () => {
  const fs = fakeDirectory();
  const cache = new PreparedGeometryCache({ ramBytes: 36, spillBytes: 72, getDirectory: async () => fs.handle });
  const ticket = cache.begin('model');
  await cache.put('a', triangle(1), ticket);
  await cache.put('b', triangle(2), ticket);
  await cache.put('c', triangle(3), ticket);
  assert.deepEqual(await cache.get('a', ticket), triangle(1));
  await cache.put('d', triangle(4), ticket);
  assert.equal(await cache.get('b', ticket), null, 'oldest disk entry must be evicted');
  assert.deepEqual(await cache.get('a', ticket), triangle(1));
  assert.deepEqual(await cache.get('c', ticket), triangle(3));
  assert.deepEqual(await cache.get('d', ticket), triangle(4));
  assert.ok([...fs.files.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= 72);
  cache.end(ticket);
});

test('metadata cap bounds tiny spilled results as well as payload bytes', async () => {
  const fs = fakeDirectory();
  const cache = new PreparedGeometryCache({ ramBytes: 0, spillBytes: 1024, maxEntries: 2, getDirectory: async () => fs.handle });
  const ticket = cache.begin('model');
  for (let i = 0; i < 3; i += 1) await cache.put(`${i}`, triangle(i), ticket);
  assert.equal(await cache.get('0', ticket), null);
  assert.deepEqual(await cache.get('1', ticket), triangle(1));
  assert.deepEqual(await cache.get('2', ticket), triangle(2));
  assert.equal(fs.files.size, 2);
  cache.end(ticket);
});

test('large spills use bounded IO and reject same-size corruption and truncated files', async () => {
  const fs = fakeDirectory();
  const cache = new PreparedGeometryCache({ ramBytes: 0, getDirectory: async () => fs.handle });
  const ticket = cache.begin('large');
  const input = new Float32Array((4 * 1024 * 1024) / 4 + 9);
  input[0] = 12.5;
  input[input.length - 1] = -9.25;
  await cache.put('large', input, ticket);
  assert.deepEqual(fs.writes, [4 * 1024 * 1024, 36]);
  assert.deepEqual(await cache.get('large', ticket), input);
  assert.deepEqual(fs.reads, [4 * 1024 * 1024, 36]);
  const stored = fs.files.values().next().value;
  assert.ok(stored);
  stored[stored.length - 1] ^= 1;
  assert.equal(await cache.get('large', ticket), null, 'same-size corrupt data is not geometry');
  await cache.put('truncated', triangle(7), ticket);
  const name = fs.files.keys().next().value;
  assert.ok(name);
  fs.files.set(name, new Uint8Array(4));
  assert.equal(await cache.get('truncated', ticket), null);
  cache.end(ticket);
});

test('synchronous clear fences in-flight spill completion and all subsequent stale puts', async () => {
  const fs = fakeDirectory();
  const entered = deferred();
  const release = deferred();
  fs.hooks.write = async () => { entered.resolve(); await release.promise; };
  const cache = new PreparedGeometryCache({ ramBytes: 0, getDirectory: async () => fs.handle });
  const stale = cache.begin('model');
  const pending = cache.put('key', triangle(1), stale);
  await entered.promise;
  cache.clearModel('model');
  assert.equal(stale.valid, false);
  release.resolve();
  await pending;
  await cache.put('key', triangle(2), stale);
  const fresh = cache.begin('model');
  assert.equal(await cache.get('key', fresh), null);
  assert.equal(fs.files.size, 0, 'cancelled spill must leave no committed or partial file');
  cache.end(stale);
  cache.end(fresh);
});

test('clear during a disk read returns a genuine miss instead of resurrecting the entry', async () => {
  const fs = fakeDirectory();
  const cache = new PreparedGeometryCache({ ramBytes: 0, getDirectory: async () => fs.handle });
  const ticket = cache.begin('model');
  await cache.put('key', triangle(1), ticket);
  const entered = deferred();
  const release = deferred();
  fs.hooks.read = async () => { entered.resolve(); await release.promise; };
  const pending = cache.get('key', ticket);
  await entered.promise;
  cache.clearModel('model');
  release.resolve();
  assert.equal(await pending, null);
  const fresh = cache.begin('model');
  assert.equal(await cache.get('key', fresh), null);
  cache.end(ticket);
  cache.end(fresh);
});

test('unavailable OPFS, quota and partial writes retain only valid bounded RAM results', async () => {
  for (const failure of ['unavailable', 'quota', 'partial'] as const) {
    const fs = fakeDirectory();
    fs.hooks.quota = failure === 'quota';
    fs.hooks.partial = failure === 'partial';
    const cache = new PreparedGeometryCache({
      ramBytes: 36,
      getDirectory: async () => failure === 'unavailable' ? null : fs.handle,
    });
    const ticket = cache.begin('model');
    await cache.put('old', triangle(1), ticket);
    await cache.put('new', triangle(2), ticket);
    assert.equal(await cache.get('old', ticket), null, `${failure} must be a true miss`);
    assert.deepEqual(await cache.get('new', ticket), triangle(2));
    assert.equal(fs.files.size, 0, `${failure} must not retain partial files`);
    cache.end(ticket);
  }
});
