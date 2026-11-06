import type { TauriInvoke } from './tauriMeshBridge';
import {
  MESH_CHUNK_BYTES,
  deserializeMeshChunkError,
  serializeMeshChunkError,
  type MeshChunkUploadAck,
  type MeshChunkWorkerCommand,
  type MeshChunkWorkerOutput,
} from './meshChunkUpload.shared';

export type { MeshChunkUploadAck } from './meshChunkUpload.shared';

export interface MeshChunkUploadOptions {
  reserveBytes?: number;
  signal?: AbortSignal;
  retainForSlice?: boolean;
}

export interface MeshChunkUploadResult extends MeshChunkUploadAck {
  /** Native invoke round trips only; excludes hashing/copying/worker startup. */
  ipcMs: number;
  /** Upload session wall time after acquiring its turn. */
  wallMs: number;
}

export interface MeshChunkUploadSession {
  /** Keep bytes unchanged until this promise settles; their buffer is never detached. */
  append(bytes: Uint8Array): Promise<void>;
  /** stage=false retains the global upload turn until abort releases the ready handle. */
  finish(stage?: boolean): Promise<MeshChunkUploadResult>;
  abort(): Promise<void>;
}

function cancellationError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Mesh upload cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

// Native has one pending upload and one ready snapshot. A finished indexed
// request keeps its turn through the consuming command and its final abort.
let uploadQueue = Promise.resolve();

async function acquireUploadTurn(signal?: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  const previous = uploadQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  uploadQueue = previous.then(() => current);
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(cancellationError(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      previous.then(() => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) reject(cancellationError(signal));
        else resolve();
      });
    });
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

class ChunkUploadSession implements MeshChunkUploadSession {
  private worker: Worker | null;
  private requestId = 0;
  private ipcMs = 0;
  private readonly startedAt = performance.now();
  private uploadId: string | undefined;
  private phase: 'open' | 'finishing' | 'finished' | 'aborted' = 'open';
  private failure: Error | undefined;
  private operations = Promise.resolve();
  private relayWork = Promise.resolve();
  private cleanup: Promise<void> | undefined;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly onAbort = () => { void this.abort().catch(() => undefined); };

  constructor(
    private readonly invoke: TauriInvoke,
    private readonly release: () => void,
    private readonly signal?: AbortSignal,
  ) {
    this.worker = new Worker(new URL('./meshChunkUpload.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<MeshChunkWorkerOutput>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.stop(new Error(event.message || 'Mesh upload worker failed'));
    };
    this.worker.onmessageerror = () => this.stop(new Error('Mesh upload worker response could not be deserialized'));
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  private ensureAlive(): void {
    if (this.failure) throw this.failure;
    throwIfAborted(this.signal);
    if (!this.worker) throw new Error('Mesh upload worker is closed');
  }

  async start(reserveBytes: number, retainForSlice: boolean): Promise<void> {
    try {
      await this.request<string>({ type: 'begin', requestId: ++this.requestId, reserveBytes, retainForSlice });
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private request<T>(message: MeshChunkWorkerCommand, transfer: Transferable[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.ensureAlive();
      this.pending.set(message.requestId, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.worker!.postMessage(message, transfer);
      } catch (error) {
        this.pending.delete(message.requestId);
        reject(error);
      }
    });
  }

  private onMessage(message: MeshChunkWorkerOutput): void {
    if (!this.worker || this.failure) return;
    if (message.type === 'invoke') {
      // Only a window can call Tauri invoke. No hashing or cache decisions here.
      this.relayWork = this.relayWork.then(async () => {
        if (!this.worker || this.failure) return;
        try {
          const started = performance.now();
          let value: unknown;
          try {
            value = await this.invoke(message.command, message.args, { headers: message.headers });
          } finally {
            this.ipcMs += performance.now() - started;
          }
          if (message.command === 'mesh_chunk_upload_begin') this.uploadId = value as string;
          this.worker?.postMessage({ type: 'relay-result', relayId: message.relayId, ok: true, value });
        } catch (error) {
          this.worker?.postMessage({
            type: 'relay-result', relayId: message.relayId, ok: false, error: serializeMeshChunkError(error),
          });
        }
      }).catch((error: unknown) => this.stop(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (message.type === 'fatal') {
      this.stop(deserializeMeshChunkError(message.error));
      return;
    }
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      const error = deserializeMeshChunkError(message.error);
      request.reject(error);
      this.stop(error);
    } else {
      request.resolve(message.value);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result.catch((error: unknown) => {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
  }

  append(bytes: Uint8Array): Promise<void> {
    if (this.phase !== 'open') return Promise.reject(this.failure ?? new Error('Mesh upload session is not open'));
    return this.enqueue(async () => {
      this.ensureAlive();
      for (let offset = 0; offset < bytes.byteLength; offset += MESH_CHUNK_BYTES) {
        this.ensureAlive();
        // Transfer only a bounded fresh copy, never a renderer-owned buffer.
        const chunk = new Uint8Array(Math.min(MESH_CHUNK_BYTES, bytes.byteLength - offset));
        chunk.set(bytes.subarray(offset, offset + chunk.byteLength));
        await this.request<void>({ type: 'append', requestId: ++this.requestId, bytes: chunk }, [chunk.buffer]);
      }
    });
  }

  finish(stage = true): Promise<MeshChunkUploadResult> {
    if (this.phase !== 'open') return Promise.reject(this.failure ?? new Error('Mesh upload session is not open'));
    this.phase = 'finishing';
    return this.enqueue(async () => {
      const ack = await this.request<MeshChunkUploadAck>({ type: 'finish', requestId: ++this.requestId, stage });
      this.ensureAlive();
      this.phase = 'finished';
      this.dropWorker();
      if (stage) {
        this.signal?.removeEventListener('abort', this.onAbort);
        this.uploadId = undefined;
        this.release();
      }
      return { ...ack, ipcMs: this.ipcMs, wallMs: performance.now() - this.startedAt };
    });
  }

  private dropWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.phase = 'aborted';
    this.dropWorker();
    this.signal?.removeEventListener('abort', this.onAbort);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    void this.cleanNative().catch(() => undefined);
  }

  private cleanNative(): Promise<void> {
    if (!this.cleanup) {
      this.cleanup = (async () => {
        try {
          // In particular, wait for a cancelled begin to reveal its upload ID.
          await this.relayWork;
          if (this.uploadId !== undefined) {
            await this.invoke('mesh_chunk_upload_abort', { uploadId: this.uploadId });
          }
        } finally {
          this.release();
        }
      })();
    }
    return this.cleanup;
  }

  abort(): Promise<void> {
    this.stop(cancellationError(this.signal));
    return this.cleanNative();
  }
}

export async function createMeshChunkUpload(
  invoke: TauriInvoke,
  options: MeshChunkUploadOptions = {},
): Promise<MeshChunkUploadSession> {
  const release = await acquireUploadTurn(options.signal);
  let session: ChunkUploadSession;
  try {
    throwIfAborted(options.signal);
    session = new ChunkUploadSession(invoke, release, options.signal);
  } catch (error) {
    release();
    throw error;
  }
  await session.start(options.reserveBytes ?? 0, options.retainForSlice === true);
  return session;
}

export async function stageMeshBytes(
  invoke: TauriInvoke,
  bytes: Uint8Array,
  options: MeshChunkUploadOptions = {},
): Promise<MeshChunkUploadResult> {
  const session = await createMeshChunkUpload(invoke, {
    ...options, reserveBytes: options.reserveBytes ?? bytes.byteLength,
  });
  try {
    await session.append(bytes);
    const ack = await session.finish(true);
    await session.abort();
    return ack;
  } catch (error) {
    await session.abort().catch(() => undefined);
    throw error;
  }
}

export async function invokeWithChunkedMesh<T>(
  invoke: TauriInvoke,
  command: string,
  bytes: Uint8Array,
  options: { args?: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const session = await createMeshChunkUpload(invoke, { reserveBytes: bytes.byteLength, signal: options.signal });
  try {
    await session.append(bytes);
    const ack = await session.finish(false);
    throwIfAborted(options.signal);
    const result = await invoke<T>(command, {
      ...options.args, meshUploadId: ack.uploadId, expectedBytes: bytes.byteLength,
    }, {
      headers: options.headers,
    });
    await session.abort();
    return result;
  } catch (error) {
    await session.abort().catch(() => undefined);
    throw error;
  }
}


/** Restore native retained bytes without creating a worker or reading renderer geometry. */
export async function restoreCachedSliceMesh(
  invoke: TauriInvoke,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<MeshChunkUploadResult | null> {
  const release = await acquireUploadTurn(signal);
  const started = performance.now();
  try {
    throwIfAborted(signal);
    const ack = await invoke<MeshChunkUploadAck | null>('restore_cached_slice_mesh', { snapshotId });
    const elapsed = performance.now() - started;
    throwIfAborted(signal);
    return ack ? { ...ack, ipcMs: elapsed, wallMs: elapsed } : null;
  } finally {
    release();
  }
}
