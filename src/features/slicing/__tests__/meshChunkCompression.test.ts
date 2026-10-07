import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { promisify } from 'node:util';
import { createMeshChunkEncoder, prepareMeshChunk } from '../tauri/meshChunkCompression';

const ASSET_URL = new URL('../../../../public/wasm/lz4-1.10.0.wasm', import.meta.url);
const MODULE_URL = new URL('../tauri/meshChunkCompression.ts', import.meta.url);
const execFileAsync = promisify(execFile);

function wasmBytes(): Uint8Array {
  return readFileSync(ASSET_URL);
}

function floatBitFixture(triangles = 4096): Uint8Array {
  // Two ordered triangle patterns also cover signed zero, subnormals, infinity,
  // and a NaN payload: comparing floats would miss loss of their exact bits.
  const bits = [
    0xc0400000, 0xc0000000, 0x3f800000, 0x40800000, 0xbf800000, 0x40000000, 0x3f800000, 0x40a00000, 0x40400000,
    0x00000000, 0x80000000, 0x00000001, 0x007fffff, 0x00800000, 0x7f7fffff, 0x7f800000, 0xff800000, 0x7fc12345,
  ];
  const bytes = new Uint8Array(triangles * 9 * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.byteLength / 4; i++) view.setUint32(i * 4, bits[i % bits.length], true);
  return bytes;
}

function incompressibleBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x6d2b79f5;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

// Independent standard LZ4 block decoder, not the encoder's WASM decoder.
function decodeMeshBlock(encoded: Uint8Array): Uint8Array {
  assert.ok(encoded.byteLength >= 5);
  const decodedSize = new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0, true);
  const decoded = new Uint8Array(decodedSize);
  let input = 4;
  let output = 0;
  function lengthWithExtension(initial: number): number {
    let length = initial;
    if (initial === 15) {
      let extension: number;
      do {
        assert.ok(input < encoded.byteLength, 'length extension is present');
        extension = encoded[input++];
        length += extension;
      } while (extension === 255);
    }
    return length;
  }
  while (input < encoded.byteLength) {
    const token = encoded[input++];
    const literals = lengthWithExtension(token >>> 4);
    assert.ok(input + literals <= encoded.byteLength);
    assert.ok(output + literals <= decodedSize);
    decoded.set(encoded.subarray(input, input + literals), output);
    input += literals;
    output += literals;
    if (input === encoded.byteLength) break;
    assert.ok(input + 2 <= encoded.byteLength);
    const offset = encoded[input] | (encoded[input + 1] << 8);
    input += 2;
    assert.ok(offset > 0 && offset <= output, 'match points to earlier decoded bytes');
    const matches = lengthWithExtension(token & 15) + 4;
    assert.ok(output + matches <= decodedSize);
    for (let i = 0; i < matches; i++) decoded[output + i] = decoded[output + i - offset];
    output += matches;
  }
  assert.equal(output, decodedSize, 'size prefix exactly matches the decoded block');
  return decoded;
}

test('real WASM preserves ordered f32 bits and immutable subarray offsets with owned output', async () => {
  const encoder = await createMeshChunkEncoder(wasmBytes());
  const fixture = floatBitFixture();
  const storage = new Uint8Array(fixture.byteLength + 46).fill(0xa5);
  storage.set(fixture, 17);
  const before = storage.slice();
  const raw = storage.subarray(17, 17 + fixture.byteLength);
  const encoded = encoder.compress(raw);
  assert.ok(encoded.byteLength * 8 <= raw.byteLength * 7);
  assert.deepEqual(decodeMeshBlock(encoded), fixture);
  assert.deepEqual(storage, before, 'neither view contents nor neighboring bytes change');

  const savedOutput = encoded.slice();
  encoder.compress(incompressibleBytes(2 * 1024 * 1024));
  assert.deepEqual(encoded, savedOutput, 'later allocator reuse or memory growth cannot overwrite wire bytes');
  assert.deepEqual(decodeMeshBlock(encoded), fixture);
});

test('repeated real compression releases input and output allocations without unbounded growth', async () => {
  const encoder = await createMeshChunkEncoder(wasmBytes());
  const raw = incompressibleBytes(1024 * 1024);
  const original = raw.slice();
  for (let i = 0; i < 4; i++) encoder.compress(raw);
  const warmedBytes = encoder.memory.buffer.byteLength;
  for (let i = 0; i < 64; i++) {
    const encoded = encoder.compress(raw);
    assert.deepEqual(decodeMeshBlock(encoded), original);
  }
  // Allow allocator/page-layout variation, but not one retained allocation per call.
  assert.ok(encoder.memory.buffer.byteLength <= warmedBytes + raw.byteLength * 8);
  assert.deepEqual(raw, original);
});

test('factory rejects malformed modules, missing ABI exports, and unsupported input sizes', async () => {
  await assert.rejects(createMeshChunkEncoder(new Uint8Array([1, 2, 3])), WebAssembly.CompileError);
  // A valid empty module exercises required-export validation, not a dummy codec.
  await assert.rejects(
    createMeshChunkEncoder(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    Error,
  );
  const encoder = await createMeshChunkEncoder(wasmBytes());
  assert.throws(() => encoder.compress(new Uint8Array()), Error);
  assert.throws(() => encoder.compress(new Uint8Array(256 * 1024 * 1024 + 1)), Error);
});

test('shared initialization preserves active callers, cancels aborted callers, and accounts for encode time', async (t) => {
  let release!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { release = resolve; });
  let fetchCalls = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL): Promise<Response> => {
    assert.equal(String(input), '/wasm/lz4-1.10.0.wasm');
    fetchCalls++;
    return response;
  });
  let clock = 10;
  const clockMock = t.mock.method(performance, 'now', () => clock++);
  try {
    for (const raw of [new Uint8Array(), new Uint8Array(64 * 1024 - 1), new Uint8Array(256 * 1024 * 1024 + 1)]) {
      const payload = await prepareMeshChunk(raw);
      assert.deepEqual(payload.bytes, raw);
      assert.deepEqual(payload.headers, { 'Content-Type': 'application/octet-stream' });
      assert.equal(payload.compressionMs, 0);
    }
    assert.equal(fetchCalls, 0, 'untouched size cases do not initialize the codec');

    const raw = floatBitFixture();
    const before = raw.slice();
    const activeCaller = prepareMeshChunk(raw);
    const controller = new AbortController();
    const cancelledCaller = prepareMeshChunk(raw, controller.signal);
    const cancelled = assert.rejects(cancelledCaller, { name: 'AbortError' });
    controller.abort();
    assert.equal(fetchCalls, 1, 'concurrent eligible callers share initialization');
    assert.deepEqual(raw, before, 'producer bytes remain untouched while initialization is pending');
    clock = 210;
    release(new Response(new Uint8Array(wasmBytes())));
    const activePayload = await activeCaller;
    await cancelled;
    assert.deepEqual(activePayload.headers, {
      'Content-Type': 'application/octet-stream', 'x-mesh-compression': 'lz4',
    });
    assert.ok(activePayload.compressionMs >= 199, 'initialization wait is included in the encode interval');
    assert.deepEqual(decodeMeshBlock(activePayload.bytes), before);
    assert.deepEqual(raw, before);

    const minimum = new Uint8Array(64 * 1024);
    const boundaryPayload = await prepareMeshChunk(minimum);
    assert.equal(boundaryPayload.headers['x-mesh-compression'], 'lz4', '64 KiB is eligible');
    assert.deepEqual(decodeMeshBlock(boundaryPayload.bytes), minimum);
    const random = incompressibleBytes(128 * 1024);
    const randomBefore = random.slice();
    const unprofitable = await prepareMeshChunk(random);
    assert.deepEqual(unprofitable.bytes, random);
    assert.deepEqual(unprofitable.headers, { 'Content-Type': 'application/octet-stream' });
    assert.equal(unprofitable.compressionMs, 1, 'attempted encoding is still timed when raw wins');
    assert.deepEqual(random, randomBefore);
    assert.equal(fetchCalls, 1);
  } finally {
    fetchMock.mock.restore();
    clockMock.mock.restore();
  }
});

for (const failure of [
  { name: 'missing asset', fetchBody: 'return new Response(null, { status: 404 });', expected: 'Error' },
  { name: 'malformed asset', fetchBody: "return new Response('not a wasm module');", expected: 'WebAssembly.CompileError' },
  { name: 'network failure', fetchBody: 'throw networkFailure;', expected: '(error) => error === networkFailure' },
]) {
  test(`prepare surfaces ${failure.name} without a raw fallback`, async () => {
    // A process per failure isolates the module-level singleton from other tests.
    // Only fetch is replaced; real compilation and real policy still execute.
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const { prepareMeshChunk } = createRequire(import.meta.url)(${JSON.stringify(MODULE_URL.pathname)});
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      const networkFailure = new Error('asset network failed');
      globalThis.fetch = async () => { fetchCalls++; ${failure.fetchBody} };
      try {
        const raw = new Uint8Array(64 * 1024);
        await assert.rejects(prepareMeshChunk(raw), ${failure.expected});
        await assert.rejects(prepareMeshChunk(raw), ${failure.expected});
        assert.equal(fetchCalls, 1, 'no silent retry or fallback');
        assert.deepEqual(raw, new Uint8Array(raw.length));
        const small = await prepareMeshChunk(raw.subarray(0, 16));
        assert.equal(small.compressionMs, 0);
        assert.equal(small.headers['x-mesh-compression'], undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    `;
    await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: new URL('../../../../', import.meta.url),
    });
  });
}
