import type { AppendLoadedSliceMesh, AppendedLoadedSliceMesh } from './loadedSliceMesh';

export const MESH_CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * Chunks hashed before one native plan call. Each held chunk is transport
 * memory, and each plan replaces one round trip per chunk, so this trades
 * `MESH_PLAN_BATCH_CHUNKS * MESH_CHUNK_BYTES` for fewer invokes.
 */
export const MESH_PLAN_BATCH_CHUNKS = 8;

export interface MeshChunkUploadAck {
  uploadId: string;
  chunkBytes: number;
  totalBytes: number;
  capacityBytes: number;
  reserveGrew: boolean;
  chunksReceived: number;
  appendNs: number;
  appendNsTotal: number;
  uploadedBytes: number;
  reusedBytes: number;
  sliceSnapshotId?: string | null;
}

export interface MeshChunkWorkerError {
  name: string;
  message: string;
  stack?: string;
}

export type MeshChunkNativeCommand =
  | 'mesh_chunk_upload_plan'
  | 'mesh_chunk_upload_append'
  | 'mesh_chunk_upload_append_source'
  | 'mesh_chunk_upload_abort';

/** One chunk the worker intends to append, in upload order. */
export interface MeshChunkPlanChunk {
  hash: string;
  byteLength: number;
}

export interface MeshChunkPlanAck {
  uploadId: string;
  /** Leading chunks that already existed natively and were appended from cache. */
  cached: number;
  /** Present only when the plan also finalized the upload. */
  ack?: MeshChunkUploadAck;
}

export type MeshChunkRelay = <T>(
  command: MeshChunkNativeCommand,
  args: Record<string, unknown> | Uint8Array,
  headers?: Record<string, string>,
) => Promise<T>;

export type MeshChunkWorkerCommand =
  | { type: 'begin'; requestId: number; reserveBytes: number; retainForSlice?: boolean; uploadId?: string }
  | { type: 'append'; requestId: number; bytes: Uint8Array }
  | { type: 'append-source'; requestId: number; source: AppendLoadedSliceMesh }
  | { type: 'finish'; requestId: number; stage: boolean };

export type MeshChunkWorkerInput = MeshChunkWorkerCommand | (
  { type: 'relay-result'; relayId: number } & (
    | { ok: true; value: unknown }
    | { ok: false; error: MeshChunkWorkerError }
  )
);

export type MeshChunkWorkerOutput =
  | { type: 'result'; requestId: number; value: unknown }
  | { type: 'error'; requestId: number; error: MeshChunkWorkerError }
  | { type: 'fatal'; error: MeshChunkWorkerError }
  | {
    type: 'invoke';
    relayId: number;
    command: MeshChunkNativeCommand;
    args: Record<string, unknown> | Uint8Array;
    headers?: Record<string, string>;
  };

export function serializeMeshChunkError(error: unknown): MeshChunkWorkerError {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) };
}

export function deserializeMeshChunkError(error: MeshChunkWorkerError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function negativeZeroBits(values: readonly number[], shift: number): number {
  let bits = 0;
  for (let index = 0; index < values.length; index++) {
    if (Object.is(values[index], -0)) bits |= 1 << (shift + index);
  }
  return bits;
}

/** Native arguments for one retained-source append; shared by the worker and the direct path. */
export function appendSourceArgs(
  source: AppendLoadedSliceMesh,
  uploadId: string | null,
  reserveBytes: number,
  retainForSlice: boolean,
): Record<string, unknown> {
  // JSON normalizes -0 to +0; carry its sign bits alongside numeric metadata.
  const negativeZeroMask = negativeZeroBits(source.matrix, 0)
    | negativeZeroBits(source.center, 16)
    | negativeZeroBits(source.plateOffset, 19);
  return { ...source, uploadId, reserveBytes, retainForSlice, negativeZeroMask };
}

/** Native arguments that consume an upload with nothing left to append. */
export function finalPlanArgs(
  uploadId: string | null,
  reserveBytes: number,
  retainForSlice: boolean,
  stage: boolean,
): Record<string, unknown> {
  return { uploadId, reserveBytes, retainForSlice, chunks: [], finalUpload: true, stage };
}

/** DOM-free worker body; the relay is the only route to native IPC. */
export class MeshChunkWorkerBody {
  private uploadId: string | undefined;
  private finished = false;
  private reserveBytes = 0;
  private retainForSlice = false;
  private partial: Uint8Array | undefined;
  private partialBytes = 0;
  private batch: { hash: string; bytes: Uint8Array }[] = [];
  private hashMsValue = 0;

  constructor(private readonly relay: MeshChunkRelay) {}

  /** SHA-256 time spent in this worker; the rest of the wall time is IPC. */
  get hashMs(): number {
    return this.hashMsValue;
  }

  /** Records the session's native options; the upload itself is created lazily. */
  begin(reserveBytes: number, retainForSlice = false, uploadId?: string): void {
    if (this.uploadId !== undefined || this.batch.length > 0 || this.partial) {
      throw new Error('Mesh upload already began');
    }
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
      throw new Error('Mesh upload reserveBytes must be a nonnegative safe integer');
    }
    this.reserveBytes = reserveBytes;
    this.retainForSlice = retainForSlice;
    // A direct source append may have created the upload before this worker existed.
    this.uploadId = uploadId;
  }

  private assertOpen(): void {
    if (this.finished) throw new Error('Mesh upload session is not open');
  }

  private async queueChunk(bytes: Uint8Array): Promise<void> {
    const started = performance.now();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    this.hashMsValue += performance.now() - started;
    let hash = '';
    for (const byte of digest) hash += byte.toString(16).padStart(2, '0');
    this.batch.push({ hash, bytes });
    if (this.batch.length >= MESH_PLAN_BATCH_CHUNKS) await this.flushBatch();
  }

  /**
   * One native round trip for the whole batch: create the upload when needed,
   * append the cached leading run, then send only the missing chunks. A final
   * plan also consumes the upload, so an all-cached mesh costs one invoke.
   */
  private async flushBatch(stage?: boolean): Promise<MeshChunkUploadAck | null> {
    const batch = this.batch;
    this.batch = [];
    const plan = await this.relay<MeshChunkPlanAck>('mesh_chunk_upload_plan', {
      uploadId: this.uploadId ?? null,
      reserveBytes: this.reserveBytes,
      retainForSlice: this.retainForSlice,
      chunks: batch.map(({ hash, bytes }) => ({ hash, byteLength: bytes.byteLength })),
      ...(stage === undefined ? {} : { finalUpload: true, stage }),
    });
    this.uploadId = plan.uploadId;
    if (plan.ack) return plan.ack;
    for (let index = plan.cached; index < batch.length; index++) {
      const { hash, bytes } = batch[index];
      await this.relay<void>('mesh_chunk_upload_append', bytes, {
        'Content-Type': 'application/octet-stream',
        'x-mesh-upload-id': plan.uploadId,
        'x-mesh-chunk-hash': hash,
      });
    }
    return null;
  }

  /** Each input is at most one chunk; append boundaries do not affect hashes. */
  async append(bytes: Uint8Array): Promise<void> {
    this.assertOpen();
    if (bytes.byteLength > MESH_CHUNK_BYTES) throw new Error('Mesh worker input exceeds one chunk');
    if (!this.partial && bytes.byteLength === MESH_CHUNK_BYTES) {
      await this.queueChunk(bytes);
      return;
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      this.partial ??= new Uint8Array(MESH_CHUNK_BYTES);
      const take = Math.min(MESH_CHUNK_BYTES - this.partialBytes, bytes.byteLength - offset);
      this.partial.set(bytes.subarray(offset, offset + take), this.partialBytes);
      this.partialBytes += take;
      offset += take;
      if (this.partialBytes === MESH_CHUNK_BYTES) {
        const chunk = this.partial;
        this.partial = undefined;
        this.partialBytes = 0;
        await this.queueChunk(chunk);
      }
    }
  }

  private async flushPartial(): Promise<void> {
    if (!this.partial) return;
    const tail = this.partial.subarray(0, this.partialBytes);
    this.partial = undefined;
    this.partialBytes = 0;
    await this.queueChunk(tail);
  }

  async appendSource(source: AppendLoadedSliceMesh): Promise<AppendedLoadedSliceMesh | null> {
    this.assertOpen();
    await this.flushPartial();
    if (this.batch.length > 0) await this.flushBatch();
    // The first source creates the upload natively, so a retained import does
    // not pay a separate begin round trip before its transform.
    const result = await this.relay<AppendedLoadedSliceMesh | null>(
      'mesh_chunk_upload_append_source',
      appendSourceArgs(source, this.uploadId ?? null, this.reserveBytes, this.retainForSlice),
    );
    if (result) this.uploadId = result.uploadId;
    return result;
  }

  async finish(stage: boolean): Promise<MeshChunkUploadAck & { hashMs: number }> {
    this.assertOpen();
    await this.flushPartial();
    const flushed = await this.flushBatch(stage);
    // A batch with misses uploads them raw; a second, empty plan consumes the upload.
    const ack = flushed ?? await this.flushBatch(stage);
    if (!ack) throw new Error('Mesh upload plan did not finalize the upload');
    this.finished = true;
    return { ...ack, hashMs: this.hashMsValue };
  }
}
