import type { TauriInvoke } from './tauriMeshBridge';
import type { AppendLoadedSliceMesh, AppendedLoadedSliceMesh } from './loadedSliceMesh';
import {
  MESH_CHUNK_BYTES,
  appendSourceArgs,
  deserializeMeshChunkError,
  finalPlanArgs,
  serializeMeshChunkError,
  type MeshChunkNativeCommand,
  type MeshChunkPlanAck,
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
  /** SHA-256 time inside the worker; the rest of `wallMs - ipcMs` is copying/startup. */
  hashMs: number;
  /** `ipcMs` split by native command, so a slow invoke can be attributed. */
  commands: Record<string, { count: number; ms: number }>;
}

export interface MeshChunkUploadSession {
  /** Keep bytes unchanged until this promise settles; their buffer is never detached. */
  append(bytes: Uint8Array): Promise<void>;
  appendSource(source: AppendLoadedSliceMesh): Promise<AppendedLoadedSliceMesh | null>;
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
  /** Created on the first raw chunk; a retained-source session never hashes. */
  private worker: Worker | null = null;
  private requestId = 0;
  private ipcMs = 0;
  private readonly commandMs = new Map<string, { count: number; ms: number }>();
  private readonly startedAt = performance.now();
  private uploadId: string | undefined;
  private reserveBytes = 0;
  private retainForSlice = false;
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
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  private ensureAlive(): void {
    if (this.failure) throw this.failure;
    throwIfAborted(this.signal);
    if (!this.worker) throw new Error('Mesh upload worker is closed');
  }

  private ensureNotFailed(): void {
    if (this.failure) throw this.failure;
    throwIfAborted(this.signal);
  }

  /** A raw chunk needs hashing and reblocking off the main thread. */
  private ensureWorker(): void {
    if (this.worker) return;
    const worker = new Worker(new URL('./meshChunkUpload.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<MeshChunkWorkerOutput>) => this.onMessage(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.stop(new Error(event.message || 'Mesh upload worker failed'));
    };
    worker.onmessageerror = () => this.stop(new Error('Mesh upload worker response could not be deserialized'));
    this.worker = worker;
    // Adopt an upload a direct source append already created.
    void this.request<void>({
      type: 'begin', requestId: ++this.requestId,
      reserveBytes: this.reserveBytes, retainForSlice: this.retainForSlice, uploadId: this.uploadId,
    }).catch(() => undefined);
  }

  async start(reserveBytes: number, retainForSlice: boolean): Promise<void> {
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
      const error = new Error('Mesh upload reserveBytes must be a nonnegative safe integer');
      this.stop(error);
      throw error;
    }
    this.reserveBytes = reserveBytes;
    this.retainForSlice = retainForSlice;
  }

  private recordCommand(command: string, elapsed: number): void {
    this.ipcMs += elapsed;
    const entry = this.commandMs.get(command) ?? { count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += elapsed;
    this.commandMs.set(command, entry);
  }

  private trackUploadId(command: string, value: unknown): void {
    if (command === 'mesh_chunk_upload_plan'
      && value !== null && typeof value === 'object'
      && 'uploadId' in value && typeof value.uploadId === 'string') {
      this.uploadId = value.uploadId;
    }
  }

  /** A command that needs no hashing is invoked from the window directly. */
  private async relayDirect<T>(command: MeshChunkNativeCommand, args: Record<string, unknown>): Promise<T> {
    this.ensureNotFailed();
    const started = performance.now();
    try {
      const value = await this.invoke(command, args);
      this.recordCommand(command, performance.now() - started);
      this.trackUploadId(command, value);
      return value as T;
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
            value = await this.invoke(message.command, message.args,
              message.headers ? { headers: message.headers } : undefined);
          } finally {
            this.recordCommand(message.command, performance.now() - started);
          }
          this.trackUploadId(message.command, value);
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
      this.ensureNotFailed();
      this.ensureWorker();
      for (let offset = 0; offset < bytes.byteLength; offset += MESH_CHUNK_BYTES) {
        this.ensureAlive();
        // Transfer only a bounded fresh copy, never a renderer-owned buffer.
        const chunk = new Uint8Array(Math.min(MESH_CHUNK_BYTES, bytes.byteLength - offset));
        chunk.set(bytes.subarray(offset, offset + chunk.byteLength));
        await this.request<void>({ type: 'append', requestId: ++this.requestId, bytes: chunk }, [chunk.buffer]);
      }
    });
  }

  appendSource(source: AppendLoadedSliceMesh): Promise<AppendedLoadedSliceMesh | null> {
    if (this.phase !== 'open') return Promise.reject(this.failure ?? new Error('Mesh upload session is not open'));
    return this.enqueue(async () => {
      this.ensureNotFailed();
      if (this.worker) {
        return this.request<AppendedLoadedSliceMesh | null>({ type: 'append-source', requestId: ++this.requestId, source });
      }
      const result = await this.relayDirect<AppendedLoadedSliceMesh | null>(
        'mesh_chunk_upload_append_source',
        appendSourceArgs(source, this.uploadId ?? null, this.reserveBytes, this.retainForSlice),
      );
      if (result) this.uploadId = result.uploadId;
      return result;
    });
  }

  finish(stage = true): Promise<MeshChunkUploadResult> {
    if (this.phase !== 'open') return Promise.reject(this.failure ?? new Error('Mesh upload session is not open'));
    this.phase = 'finishing';
    return this.enqueue(async () => {
      let ack: MeshChunkUploadAck & { hashMs: number };
      if (this.worker) {
        ack = await this.request<MeshChunkUploadAck & { hashMs: number }>({ type: 'finish', requestId: ++this.requestId, stage });
      } else {
        const plan = await this.relayDirect<MeshChunkPlanAck>(
          'mesh_chunk_upload_plan',
          finalPlanArgs(this.uploadId ?? null, this.reserveBytes, this.retainForSlice, stage),
        );
        if (!plan.ack) throw new Error('Mesh upload plan did not finalize the upload');
        ack = { ...plan.ack, hashMs: 0 };
      }
      this.ensureNotFailed();
      this.phase = 'finished';
      this.dropWorker();
      if (stage) {
        this.signal?.removeEventListener('abort', this.onAbort);
        this.uploadId = undefined;
        this.release();
      }
      return { ...ack, ipcMs: this.ipcMs, wallMs: performance.now() - this.startedAt,
        commands: Object.fromEntries(this.commandMs) };
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
    }, options.headers ? { headers: options.headers } : undefined);
    await session.abort();
    return result;
  } catch (error) {
    await session.abort().catch(() => undefined);
    throw error;
  }
}

