import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
import type { TauriInvoke } from '../../tauriMeshBridge';
import {
  MeshChunkWorkerBody,
  deserializeMeshChunkError,
  serializeMeshChunkError,
  type MeshChunkNativeCommand,
  type MeshChunkRelay,
  type MeshChunkUploadAck,
  type MeshChunkWorkerInput,
  type MeshChunkWorkerOutput,
} from '../../meshChunkUpload.shared';

type NativeInvoke = (
  command: string,
  args?: InvokeArgs,
  options?: { headers?: Record<string, string> },
) => Promise<unknown>;

type PlanChunk = { hash: string; byteLength: number };

export function isPlanChunk(value: unknown): value is PlanChunk {
  return typeof value === 'object' && value !== null
    && 'hash' in value && typeof value.hash === 'string'
    && 'byteLength' in value && typeof value.byteLength === 'number';
}

/** Real chunk hashing behind a browser Worker façade; only native IPC is faked. */
export function installFakeMeshChunkUpload(nativeInvoke: NativeInvoke) {
  const stats = { workerStarts: 0, uploadBegins: 0, restoreCalls: 0 };
  class MeshWorker {
    onmessage: ((event: MessageEvent<MeshChunkWorkerOutput>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    private terminated = false;
    private relayId = 0;
    private operations = Promise.resolve();
    private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    private relay: MeshChunkRelay = <T>(
      command: MeshChunkNativeCommand,
      args: Record<string, unknown> | Uint8Array,
      headers?: Record<string, string>,
    ): Promise<T> => new Promise<T>((resolve, reject) => {
      const relayId = ++this.relayId;
      this.pending.set(relayId, { resolve: resolve as (value: unknown) => void, reject });
      this.emit({ type: 'invoke', relayId, command, args, headers });
    });
    private body = new MeshChunkWorkerBody(this.relay);

    constructor() { stats.workerStarts += 1; }

    private emit(message: MeshChunkWorkerOutput): void {
      const data = structuredClone(message);
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data } as MessageEvent<MeshChunkWorkerOutput>);
      });
    }

    postMessage(input: MeshChunkWorkerInput, transfer: Transferable[] = []): void {
      const message = structuredClone(input, { transfer });
      if (message.type === 'relay-result') {
        const pending = this.pending.get(message.relayId);
        assert.ok(pending, 'worker received a response for an unknown relay');
        this.pending.delete(message.relayId);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(deserializeMeshChunkError(message.error));
        return;
      }
      this.operations = this.operations.then(async () => {
        if (this.terminated) return;
        try {
          let value: unknown;
          switch (message.type) {
            case 'begin': value = await this.body.begin(message.reserveBytes, message.retainForSlice); break;
            case 'append': await this.body.append(message.bytes); break;
            case 'append-source': value = await this.body.appendSource(message.source); break;
            case 'finish': value = await this.body.finish(message.stage); break;
          }
          this.emit({ type: 'result', requestId: message.requestId, value });
        } catch (error) {
          this.emit({ type: 'error', requestId: message.requestId, error: serializeMeshChunkError(error) });
        }
      });
    }

    terminate(): void { this.terminated = true; }
  }

  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: MeshWorker });
  const cache = new Map<string, Uint8Array>();
  let nextId = 0;
  let staged = new Uint8Array(0);
  let ready: { uploadId: string; bytes: Uint8Array } | undefined;
  let retained: { snapshotId: string; bytes: Uint8Array; ack: MeshChunkUploadAck } | undefined;
  let retentionAvailable = true;
  let pending: {
    uploadId: string; chunks: Uint8Array[]; reserveBytes: number;
    uploadedBytes: number; reusedBytes: number; retainForSlice: boolean;
  } | undefined;

  const finalize = (stage: boolean): MeshChunkUploadAck => {
    assert.ok(pending);
    const totalBytes = pending.uploadedBytes + pending.reusedBytes;
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of pending.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (stage) staged = bytes;
    else ready = { uploadId: pending.uploadId, bytes };
    const ack = {
      uploadId: pending.uploadId, totalBytes, capacityBytes: Math.max(totalBytes, pending.reserveBytes),
      reserveGrew: totalBytes > pending.reserveBytes, chunksReceived: pending.chunks.length,
      chunkBytes: pending.chunks[pending.chunks.length - 1]?.byteLength ?? 0, appendNs: 0, appendNsTotal: 0,
      uploadedBytes: pending.uploadedBytes, reusedBytes: pending.reusedBytes,
      ...(stage && pending.retainForSlice && retentionAvailable ? { sliceSnapshotId: pending.uploadId } : {}),
    } satisfies MeshChunkUploadAck;
    if (stage && pending.retainForSlice && retentionAvailable) {
      retained = { snapshotId: pending.uploadId, bytes: bytes.slice(), ack };
    }
    pending = undefined;
    return ack;
  };

  const invoke: TauriInvoke = async <T>(
    command: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ): Promise<T> => {
    const fields = args as Record<string, unknown> | undefined;
    const headers = options ? Object.fromEntries(new Headers(options.headers)) : undefined;
    let result: unknown;
    switch (command) {
      case 'mesh_chunk_upload_plan': {
        const chunks = Array.isArray(fields?.chunks) ? fields.chunks.filter(isPlanChunk) : [];
        if (fields?.uploadId == null) {
          stats.uploadBegins += 1;
          assert.equal(pending, undefined, 'an unfinished native upload was replaced');
          assert.equal(ready, undefined, 'an unconsumed native snapshot was replaced');
          pending = {
            uploadId: `test-upload-${++nextId}`, chunks: [],
            reserveBytes: typeof fields?.reserveBytes === 'number' ? fields.reserveBytes : 0,
            uploadedBytes: 0, reusedBytes: 0,
            retainForSlice: fields?.retainForSlice === true,
          };
        }
        assert.ok(pending);
        assert.equal(fields?.uploadId ?? pending.uploadId, pending.uploadId);
        let cached = 0;
        while (cached < chunks.length) {
          const bytes = cache.get(chunks[cached].hash);
          if (bytes === undefined || bytes.byteLength !== chunks[cached].byteLength) break;
          pending.chunks.push(bytes);
          pending.reusedBytes += bytes.byteLength;
          cached += 1;
        }
        const plan: { uploadId: string; cached: number; ack?: MeshChunkUploadAck } = {
          uploadId: pending.uploadId, cached,
        };
        if (fields?.finalUpload === true && cached === chunks.length) plan.ack = finalize(fields.stage === true);
        result = plan;
        break;
      }
      case 'mesh_chunk_upload_append': {
        assert.ok(pending);
        assert.ok(args instanceof Uint8Array);
        assert.equal(headers?.['x-mesh-upload-id'], pending.uploadId);
        const hash = createHash('sha256').update(args).digest('hex');
        assert.equal(headers?.['x-mesh-chunk-hash'], hash);
        const bytes = args.slice();
        cache.set(hash, bytes);
        pending.chunks.push(bytes);
        pending.uploadedBytes += bytes.byteLength;
        break;
      }
      case 'slice_solid_native_to_temp_path': {
        // The real command restores the retained snapshot itself before slicing.
        const snapshotId = fields?.snapshotId;
        if (typeof snapshotId === 'string') {
          stats.restoreCalls += 1;
          if (!retained || retained.snapshotId !== snapshotId) {
            result = { status: 'snapshotMiss' };
            break;
          }
          staged = retained.bytes.slice();
        }
        result = await nativeInvoke(command, args, headers ? { headers } : undefined);
        break;
      }
      case 'mesh_chunk_upload_abort':
        if (pending?.uploadId === fields?.uploadId) pending = undefined;
        if (ready?.uploadId === fields?.uploadId) ready = undefined;
        break;
      default:
        result = await nativeInvoke(command, args, headers ? { headers } : undefined);
    }
    return result as T;
  };

  return {
    invoke,
    readStaged: () => staged.slice(),
    replaceStaged: (bytes: Uint8Array) => { staged = bytes.slice(); },
    discardSliceSnapshot: () => { retained = undefined; },
    setSliceRetention: (available: boolean) => { retentionAvailable = available; if (!available) retained = undefined; },
    readStats: () => ({ ...stats }),
    readUpload: (args: unknown) => {
      const fields = args as { meshUploadId: string; expectedBytes: number };
      assert.ok(ready, 'consumer has no immutable mesh snapshot');
      assert.equal(fields.meshUploadId, ready.uploadId);
      assert.equal(fields.expectedBytes, ready.bytes.byteLength);
      const bytes = ready.bytes.slice();
      ready = undefined;
      return bytes;
    },
    restore: () => {
      if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker);
      else Reflect.deleteProperty(globalThis, 'Worker');
    },
  };
}
