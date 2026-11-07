import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { createMeshChunkUpload, invokeWithChunkedMesh, restoreCachedSliceMesh, stageMeshBytes, type MeshChunkUploadSession } from '../meshChunkUpload';
import { installFakeMeshChunkUpload } from './helpers/fakeMeshChunkUpload';
import type { TauriInvoke } from '../tauriMeshBridge';
import { runExclusiveNativeMesh } from '../tauriMeshBridge';
import {
  MESH_CHUNK_BYTES,
  MeshChunkWorkerBody,
  deserializeMeshChunkError,
  serializeMeshChunkError,
  type MeshChunkNativeCommand,
  type MeshChunkRelay,
  type MeshChunkUploadAck,
  type MeshChunkWorkerInput,
  type MeshChunkWorkerOutput,
} from '../meshChunkUpload.shared';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function chunkRecorder() {
  const cached = new Set<string>();
  const lookups: { hash: string; byteLength: number }[] = [];
  const uploads: { hash: string; byteLength: number }[] = [];
  let id = 0;
  let totalBytes = 0;
  let uploadedBytes = 0;
  let reusedBytes = 0;
  const relay: MeshChunkRelay = async <T>(
    command: MeshChunkNativeCommand,
    args: Record<string, unknown> | Uint8Array,
    headers?: Record<string, string>,
  ): Promise<T> => {
    let result: unknown;
    if (args instanceof Uint8Array) {
      assert.equal(command, 'mesh_chunk_upload_append');
      assert.equal(headers?.['Content-Type'], 'application/octet-stream');
      assert.equal(headers?.['x-mesh-upload-id'], `upload-${id}`);
      assert.ok(args.byteLength <= MESH_CHUNK_BYTES);
      assert.equal(args.byteLength % 4, 0);
      const hash = sha256(args);
      assert.equal(headers?.['x-mesh-chunk-hash'], hash);
      uploads.push({ hash, byteLength: args.byteLength });
      cached.add(hash);
      totalBytes += args.byteLength;
      uploadedBytes += args.byteLength;
    } else if (command === 'mesh_chunk_upload_begin') {
      totalBytes = uploadedBytes = reusedBytes = 0;
      result = `upload-${++id}`;
    } else if (command === 'mesh_chunk_upload_append_cached') {
      const hash = args.hash as string;
      const byteLength = args.byteLength as number;
      lookups.push({ hash, byteLength });
      result = cached.has(hash);
      if (result) {
        totalBytes += byteLength;
        reusedBytes += byteLength;
      }
    } else if (command === 'mesh_chunk_upload_finish') {
      result = {
        uploadId: `upload-${id}`, totalBytes, uploadedBytes, reusedBytes,
        chunkBytes: 0, capacityBytes: totalBytes, reserveGrew: false,
        chunksReceived: lookups.length, appendNs: 0, appendNsTotal: 0,
      } as MeshChunkUploadAck;
    } else {
      assert.fail(`Unexpected command ${command}`);
    }
    return result as T;
  };
  return { relay, lookups, uploads };
}

test('worker hashes fixed chunks across unaligned append batches and sends no bytes on cache hits', async () => {
  const bytes = new Uint8Array(MESH_CHUNK_BYTES + 20);
  for (let i = 0; i < bytes.byteLength; i += 1) bytes[i] = i % 251;
  const expected = [
    { hash: sha256(bytes.subarray(0, MESH_CHUNK_BYTES)), byteLength: MESH_CHUNK_BYTES },
    { hash: sha256(bytes.subarray(MESH_CHUNK_BYTES)), byteLength: 20 },
  ];
  const recorder = chunkRecorder();
  const first = new MeshChunkWorkerBody(recorder.relay);
  await first.begin(bytes.byteLength);
  await first.append(bytes.subarray(0, 5));
  await first.append(bytes.subarray(5, MESH_CHUNK_BYTES - 6));
  assert.equal(recorder.lookups.length, 0, 'a partial chunk is not hashed at an append boundary');
  await first.append(bytes.subarray(MESH_CHUNK_BYTES - 6));
  assert.deepEqual(recorder.uploads, expected.slice(0, 1));
  const firstAck = await first.finish(false);
  assert.deepEqual(recorder.lookups, expected);
  assert.deepEqual(recorder.uploads, expected);
  assert.equal(firstAck.uploadedBytes, bytes.byteLength);
  assert.equal(firstAck.reusedBytes, 0);

  const second = new MeshChunkWorkerBody(recorder.relay);
  await second.begin(bytes.byteLength);
  await second.append(bytes.subarray(0, MESH_CHUNK_BYTES));
  await second.append(bytes.subarray(MESH_CHUNK_BYTES));
  const secondAck = await second.finish(true);
  assert.deepEqual(recorder.lookups, [...expected, ...expected]);
  assert.deepEqual(recorder.uploads, expected, 'a cache hit must not relay raw bytes');
  assert.equal(secondAck.uploadedBytes, 0);
  assert.equal(secondAck.reusedBytes, bytes.byteLength);

  bytes[bytes.byteLength - 1] ^= 1;
  const third = new MeshChunkWorkerBody(recorder.relay);
  await third.begin(bytes.byteLength);
  await third.append(bytes.subarray(0, MESH_CHUNK_BYTES));
  await third.append(bytes.subarray(MESH_CHUNK_BYTES));
  const thirdAck = await third.finish(false);
  assert.equal(thirdAck.uploadedBytes, 20, 'only a changed tail is uploaded');
  assert.equal(thirdAck.reusedBytes, MESH_CHUNK_BYTES);
  assert.deepEqual(recorder.uploads[2], {
    hash: sha256(bytes.subarray(MESH_CHUNK_BYTES)), byteLength: 20,
  });
});

test('a rejected tail upload never publishes a completed snapshot and preserves structured native errors', async () => {
  const commands: MeshChunkNativeCommand[] = [];
  const error = new Error('native chunk rejected');
  error.name = 'ChunkIntegrityError';
  const relay: MeshChunkRelay = async <T>(command: MeshChunkNativeCommand): Promise<T> => {
    commands.push(command);
    if (command === 'mesh_chunk_upload_begin') return 'upload-error' as T;
    if (command === 'mesh_chunk_upload_append_cached') return false as T;
    throw error;
  };
  const body = new MeshChunkWorkerBody(relay);
  await body.begin(36);
  await body.append(new Uint8Array(36));
  await assert.rejects(body.finish(false), error);
  assert.deepEqual(commands, [
    'mesh_chunk_upload_begin', 'mesh_chunk_upload_append_cached', 'mesh_chunk_upload_append',
  ]);
  const restored = deserializeMeshChunkError(structuredClone(serializeMeshChunkError(error)));
  assert.equal(restored.name, error.name);
  assert.equal(restored.message, error.message);
  assert.equal(restored.stack, error.stack);
});

test('worker refuses oversized inputs before hashing or native cache lookup', async () => {
  const recorder = chunkRecorder();
  const body = new MeshChunkWorkerBody(recorder.relay);
  await body.begin(0);
  await assert.rejects(body.append(new Uint8Array(MESH_CHUNK_BYTES + 1)), /exceeds one chunk/);
  assert.deepEqual(recorder.lookups, []);
  assert.deepEqual(recorder.uploads, []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('cancelled native begin is cleaned by its exact ID before another worker can acquire the queue', async () => {
  // This fake models only worker startup, not raw mesh processing/forwarding.
  const instances: StartupWorker[] = [];
  class StartupWorker {
    onmessage: ((event: MessageEvent<MeshChunkWorkerOutput>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    requestId = 0;
    constructor() { instances.push(this); }
    postMessage(message: MeshChunkWorkerInput) {
      if (message.type === 'begin') {
        this.requestId = message.requestId;
        queueMicrotask(() => this.emit({
          type: 'invoke', relayId: 1, command: 'mesh_chunk_upload_begin',
          args: { reserveBytes: message.reserveBytes },
        }));
      } else if (message.type === 'relay-result' && message.ok) {
        queueMicrotask(() => this.emit({ type: 'result', requestId: this.requestId, value: message.value }));
      } else {
        assert.fail('Startup-only worker received an unexpected request');
      }
    }
    emit(message: MeshChunkWorkerOutput) {
      this.onmessage?.({ data: message } as MessageEvent<MeshChunkWorkerOutput>);
    }
    terminate() { this.terminated = true; }
  }
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: StartupWorker });
  const beginEntered = deferred<void>();
  const beginResult = deferred<string>();
  const abortEntered = deferred<void>();
  const abortResult = deferred<void>();
  const abortedIds: unknown[] = [];
  let begins = 0;
  const invoke: TauriInvoke = async <T>(
    command: string,
    args?: InvokeArgs,
  ): Promise<T> => {
    if (command === 'mesh_chunk_upload_begin') {
      if (++begins === 1) {
        beginEntered.resolve(undefined);
        return await beginResult.promise as T;
      }
      return 'new-upload' as T;
    }
    assert.equal(command, 'mesh_chunk_upload_abort');
    const uploadId = (args as Record<string, unknown>).uploadId;
    abortedIds.push(uploadId);
    if (uploadId === 'old-upload') {
      abortEntered.resolve(undefined);
      await abortResult.promise;
    }
    return undefined as T;
  };
  const controller = new AbortController();
  const creating = createMeshChunkUpload(invoke, { signal: controller.signal });
  let next: Promise<MeshChunkUploadSession> | undefined;
  try {
    await beginEntered.promise;
    const rejected = assert.rejects(creating, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(instances[0].terminated, true);
    next = createMeshChunkUpload(invoke);
    await Promise.resolve();
    assert.equal(instances.length, 1);
    beginResult.resolve('old-upload');
    await abortEntered.promise;
    assert.deepEqual(abortedIds, ['old-upload']);
    assert.equal(instances.length, 1, 'queue remains held while native abort is pending');
    abortResult.resolve(undefined);
    const session = await next;
    assert.equal(instances.length, 2);
    await session.abort();
    assert.deepEqual(abortedIds, ['old-upload', 'new-upload']);
  } finally {
    controller.abort();
    beginResult.resolve('old-upload');
    abortResult.resolve(undefined);
    await creating.catch(() => undefined);
    await next?.then((session) => session.abort(), () => undefined);
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});


test('cancelling a queued native mesh pass never takes the active pass ownership', async () => {
  const active = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = runExclusiveNativeMesh(async () => {
    order.push('active');
    active.resolve();
    await release.promise;
    order.push('readback complete');
  });
  await active.promise;
  const controller = new AbortController();
  const cancelled = runExclusiveNativeMesh(async () => { order.push('cancelled pass ran'); }, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  try {
    await rejected;
    assert.deepEqual(order, ['active']);
    const next = runExclusiveNativeMesh(async () => { order.push('next'); });
    release.resolve();
    await first;
    await next;
    assert.deepEqual(order, ['active', 'readback complete', 'next']);
  } finally {
    release.resolve();
    await first;
  }
});


test('retained slice restore does not wait for an unrelated native analysis computation', { timeout: 5000 }, async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const abort = new AbortController();
  t.signal.addEventListener('abort', () => { abort.abort(); release.resolve(undefined); }, { once: true });
  const sliceBytes = new Uint8Array(new Float32Array([0,0,0, 1,0,0, 0,1,0]).buffer);
  const analysisBytes = new Uint8Array(new Float32Array([0,0,0, 2,0,0, 0,3,0]).buffer);
  const backend = installFakeMeshChunkUpload(async (command, args) => {
    assert.equal(command, 'long_analysis');
    const received = backend.readUpload(args);
    entered.resolve(undefined);
    await release.promise;
    assert.deepEqual(received, analysisBytes, 'restoring slice data must not replace the analysis input');
    const p = new Float32Array(received.buffer, received.byteOffset, received.byteLength / 4);
    return Math.abs((p[3]-p[0])*(p[7]-p[1])-(p[4]-p[1])*(p[6]-p[0]))/2;
  });
  let analysis: Promise<number> | undefined;
  try {
    const cached = await stageMeshBytes(backend.invoke, sliceBytes, { retainForSlice: true });
    assert.ok(cached.sliceSnapshotId);
    analysis = invokeWithChunkedMesh<number>(backend.invoke, 'long_analysis', analysisBytes);
    await entered.promise;
    const restored = await runExclusiveNativeMesh(() => restoreCachedSliceMesh(backend.invoke, cached.sliceSnapshotId!, abort.signal));
    assert.ok(restored);
    assert.equal(restored.uploadedBytes, 0);
    assert.equal(restored.uploadQueueWaitMs, 0);
    assert.deepEqual(backend.readStaged(), sliceBytes);
    release.resolve(undefined);
    assert.equal(await analysis, 3);
  } finally {
    abort.abort(); release.resolve(undefined);
    await analysis?.catch(() => undefined);
    backend.restore();
  }
});
