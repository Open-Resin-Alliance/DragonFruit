import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { createMeshChunkUpload, type MeshChunkUploadSession } from '../meshChunkUpload';
import type { AppendLoadedSliceMesh } from '../loadedSliceMesh';
import type { TauriInvoke } from '../tauriMeshBridge';
import { runExclusiveNativeMesh } from '../tauriMeshBridge';
import {
  MESH_CHUNK_BYTES,
  MeshChunkWorkerBody,
  deserializeMeshChunkError,
  serializeMeshChunkError,
  type MeshChunkNativeCommand,
  type MeshChunkPlanAck,
  type MeshChunkRelay,
  type MeshChunkUploadAck,
  type MeshChunkWorkerInput,
  type MeshChunkWorkerOutput,
} from '../meshChunkUpload.shared';
import { isPlanChunk } from './helpers/fakeMeshChunkUpload';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function chunkRecorder() {
  const cached = new Set<string>();
  const plans: { final: boolean; chunks: { hash: string; byteLength: number }[] }[] = [];
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
    } else if (command === 'mesh_chunk_upload_plan') {
      const chunks = Array.isArray(args.chunks) ? args.chunks.filter(isPlanChunk) : [];
      if (args.uploadId == null) {
        id += 1;
        totalBytes = uploadedBytes = reusedBytes = 0;
      }
      plans.push({ final: args.finalUpload === true, chunks });
      let hit = 0;
      for (const chunk of chunks) {
        if (!cached.has(chunk.hash)) break;
        totalBytes += chunk.byteLength;
        reusedBytes += chunk.byteLength;
        hit += 1;
      }
      const plan: MeshChunkPlanAck = { uploadId: `upload-${id}`, cached: hit };
      if (args.finalUpload === true && hit === chunks.length) {
        plan.ack = {
          uploadId: `upload-${id}`, totalBytes, uploadedBytes, reusedBytes,
          chunkBytes: 0, capacityBytes: totalBytes, reserveGrew: false,
          chunksReceived: plans.reduce((sum, entry) => sum + entry.chunks.length, 0),
          appendNs: 0, appendNsTotal: 0,
        } satisfies MeshChunkUploadAck;
      }
      result = plan;
    } else {
      assert.fail(`Unexpected command ${command}`);
    }
    return result as T;
  };
  return { relay, plans, uploads };
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
  first.begin(bytes.byteLength);
  await first.append(bytes.subarray(0, 5));
  await first.append(bytes.subarray(5, MESH_CHUNK_BYTES - 6));
  assert.equal(recorder.plans.length, 0, 'a partial chunk is not hashed at an append boundary');
  await first.append(bytes.subarray(MESH_CHUNK_BYTES - 6));
  assert.equal(recorder.plans.length, 0, 'a batch below the plan size waits for finish');
  const firstAck = await first.finish(false);
  assert.deepEqual(recorder.plans.map((entry) => entry.chunks), [expected, []]);
  assert.deepEqual(recorder.uploads, expected);
  assert.equal(firstAck.uploadedBytes, bytes.byteLength);
  assert.equal(firstAck.reusedBytes, 0);
  assert.ok(firstAck.hashMs > 0);

  const second = new MeshChunkWorkerBody(recorder.relay);
  second.begin(bytes.byteLength);
  await second.append(bytes.subarray(0, MESH_CHUNK_BYTES));
  await second.append(bytes.subarray(MESH_CHUNK_BYTES));
  const before = recorder.plans.length + recorder.uploads.length;
  const secondAck = await second.finish(true);
  assert.equal(recorder.plans.length + recorder.uploads.length - before, 1,
    'an all-cached mesh costs one native round trip');
  assert.deepEqual(recorder.plans.at(-1)?.chunks, expected);
  assert.equal(recorder.plans.at(-1)?.final, true);
  assert.equal(secondAck.uploadedBytes, 0);
  assert.equal(secondAck.reusedBytes, bytes.byteLength);

  bytes[bytes.byteLength - 1] ^= 1;
  const third = new MeshChunkWorkerBody(recorder.relay);
  third.begin(bytes.byteLength);
  await third.append(bytes.subarray(0, MESH_CHUNK_BYTES));
  await third.append(bytes.subarray(MESH_CHUNK_BYTES));
  const thirdAck = await third.finish(false);
  assert.equal(thirdAck.uploadedBytes, 20, 'only a changed tail is uploaded');
  assert.equal(thirdAck.reusedBytes, MESH_CHUNK_BYTES);
  assert.deepEqual(recorder.uploads.at(-1), {
    hash: sha256(bytes.subarray(MESH_CHUNK_BYTES)), byteLength: 20,
  });
});

test('the first retained source creates the upload in its own invoke', async () => {
  const commands: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  const relay: MeshChunkRelay = async <T>(
    command: MeshChunkNativeCommand,
    args: Record<string, unknown> | Uint8Array,
  ): Promise<T> => {
    commands.push(command);
    assert.equal(command, 'mesh_chunk_upload_append_source');
    assert.ok(!(args instanceof Uint8Array));
    sent.push(args);
    return { uploadId: 'upload-source', triangleCount: 3, meshBounds: bounds } as T;
  };
  const body = new MeshChunkWorkerBody(relay);
  body.begin(4096, true);
  const source: AppendLoadedSliceMesh = {
    sourceId: 'source-1', expectedCorners: 9, triangleStart: 0, triangleEnd: 3, order: 'soup',
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], center: [0, 0, 0], plateOffset: [0, 0],
    flipWinding: false,
  };
  const first = await body.appendSource(source);
  assert.equal(first?.uploadId, 'upload-source');
  assert.equal(sent[0].uploadId, null, 'the first source creates the upload natively');
  assert.equal(sent[0].reserveBytes, 4096);
  assert.equal(sent[0].retainForSlice, true);
  await body.appendSource(source);
  assert.equal(sent[1].uploadId, 'upload-source', 'later sources reuse the created upload');
  assert.deepEqual(commands, ['mesh_chunk_upload_append_source', 'mesh_chunk_upload_append_source']);
});

test('a retained-source session never starts a hashing worker', async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let workers = 0;
  class ForbiddenWorker {
    constructor() { workers += 1; throw new Error('a source-only session must not start a worker'); }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: ForbiddenWorker });
  const commands: string[] = [];
  const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  const invoke: TauriInvoke = async <T>(command: string, args?: InvokeArgs): Promise<T> => {
    commands.push(command);
    const fields = args as Record<string, unknown>;
    if (command === 'mesh_chunk_upload_append_source') {
      assert.equal(fields.uploadId, null, 'the first source creates the upload');
      assert.equal(fields.reserveBytes, 4096);
      return { uploadId: 'upload-direct', triangleCount: 3, meshBounds: bounds } as T;
    }
    assert.equal(command, 'mesh_chunk_upload_plan');
    assert.equal(fields.uploadId, 'upload-direct');
    assert.equal(fields.finalUpload, true);
    assert.equal(fields.stage, true);
    return {
      uploadId: 'upload-direct', cached: 0,
      ack: {
        uploadId: 'upload-direct', chunkBytes: 36, totalBytes: 108, capacityBytes: 4096,
        reserveGrew: false, chunksReceived: 3, appendNs: 0, appendNsTotal: 0,
        uploadedBytes: 0, reusedBytes: 108,
      },
    } as T;
  };
  try {
    const session = await createMeshChunkUpload(invoke, { reserveBytes: 4096, retainForSlice: true });
    const appended = await session.appendSource({
      sourceId: 'source-1', expectedCorners: 9, triangleStart: 0, triangleEnd: 3, order: 'geometry',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], center: [0, 0, 0], plateOffset: [0, 0],
      flipWinding: false,
    });
    assert.equal(appended?.uploadId, 'upload-direct');
    const ack = await session.finish(true);
    assert.equal(workers, 0);
    assert.deepEqual(commands, ['mesh_chunk_upload_append_source', 'mesh_chunk_upload_plan']);
    assert.equal(ack.hashMs, 0);
    assert.deepEqual(ack.commands.mesh_chunk_upload_append_source?.count, 1);
    assert.deepEqual(ack.commands.mesh_chunk_upload_plan?.count, 1);
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});

test('a rejected tail upload never publishes a completed snapshot and preserves structured native errors', async () => {
  const commands: MeshChunkNativeCommand[] = [];
  const error = new Error('native chunk rejected');
  error.name = 'ChunkIntegrityError';
  const relay: MeshChunkRelay = async <T>(command: MeshChunkNativeCommand): Promise<T> => {
    commands.push(command);
    if (command === 'mesh_chunk_upload_plan') return { uploadId: 'upload-error', cached: 0 } as T;
    throw error;
  };
  const body = new MeshChunkWorkerBody(relay);
  body.begin(36);
  await body.append(new Uint8Array(36));
  await assert.rejects(body.finish(false), error);
  assert.deepEqual(commands, ['mesh_chunk_upload_plan', 'mesh_chunk_upload_append']);
  const restored = deserializeMeshChunkError(structuredClone(serializeMeshChunkError(error)));
  assert.equal(restored.name, error.name);
  assert.equal(restored.message, error.message);
  assert.equal(restored.stack, error.stack);
});

test('worker refuses oversized inputs before hashing or native cache lookup', async () => {
  const recorder = chunkRecorder();
  const body = new MeshChunkWorkerBody(recorder.relay);
  body.begin(0);
  await assert.rejects(body.append(new Uint8Array(MESH_CHUNK_BYTES + 1)), /exceeds one chunk/);
  assert.deepEqual(recorder.plans, []);
  assert.deepEqual(recorder.uploads, []);
});

test('cancelled native plan is cleaned by its exact ID before another worker can acquire the queue', async () => {
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
        queueMicrotask(() => this.emit({ type: 'result', requestId: message.requestId, value: undefined }));
        return;
      }
      if (message.type === 'append') {
        this.requestId = message.requestId;
        queueMicrotask(() => this.emit({
          type: 'invoke', relayId: 1, command: 'mesh_chunk_upload_plan',
          args: { uploadId: null, chunks: [] },
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
  const planEntered = Promise.withResolvers<void>();
  const planResult = Promise.withResolvers<unknown>();
  const abortEntered = Promise.withResolvers<void>();
  const abortResult = Promise.withResolvers<void>();
  const abortedIds: unknown[] = [];
  let plans = 0;
  const invoke: TauriInvoke = async <T>(
    command: string,
    args?: InvokeArgs,
  ): Promise<T> => {
    if (command === 'mesh_chunk_upload_plan') {
      if (++plans === 1) {
        planEntered.resolve(undefined);
        return await planResult.promise as T;
      }
      return { uploadId: 'new-upload', cached: 0 } as T;
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
  const session = await createMeshChunkUpload(invoke, { signal: controller.signal });
  const appending = session.append(new Uint8Array(36));
  let next: Promise<MeshChunkUploadSession> | undefined;
  try {
    await planEntered.promise;
    const rejected = assert.rejects(appending, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(instances[0].terminated, true);
    next = createMeshChunkUpload(invoke);
    await Promise.resolve();
    assert.equal(instances.length, 1);
    planResult.resolve({ uploadId: 'old-upload', cached: 0 });
    await abortEntered.promise;
    assert.deepEqual(abortedIds, ['old-upload']);
    assert.equal(instances.length, 1, 'queue remains held while native abort is pending');
    abortResult.resolve(undefined);
    const nextSession = await next;
    assert.equal(instances.length, 1, 'a session starts no worker until a raw chunk needs one');
    await nextSession.abort();
    assert.deepEqual(abortedIds, ['old-upload'], 'a session that never planned owns no native upload');
  } finally {
    controller.abort();
    planResult.resolve({ uploadId: 'old-upload', cached: 0 });
    abortResult.resolve(undefined);
    await appending.catch(() => undefined);
    await next?.then((created) => created.abort(), () => undefined);
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
