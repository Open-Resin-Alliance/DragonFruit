export const MESH_CHUNK_BYTES = 4 * 1024 * 1024;

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
}

export interface MeshChunkWorkerError {
  name: string;
  message: string;
  stack?: string;
}

export type MeshChunkNativeCommand =
  | 'mesh_chunk_upload_begin'
  | 'mesh_chunk_upload_append_cached'
  | 'mesh_chunk_upload_append'
  | 'mesh_chunk_upload_finish';

export type MeshChunkRelay = <T>(
  command: MeshChunkNativeCommand,
  args: Record<string, unknown> | Uint8Array,
  headers?: Record<string, string>,
) => Promise<T>;

export type MeshChunkWorkerCommand =
  | { type: 'begin'; requestId: number; reserveBytes: number }
  | { type: 'append'; requestId: number; bytes: Uint8Array }
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

/** DOM-free worker body; the relay is the only route to native IPC. */
export class MeshChunkWorkerBody {
  private uploadId: string | undefined;
  private finished = false;
  private partial: Uint8Array | undefined;
  private partialBytes = 0;

  constructor(private readonly relay: MeshChunkRelay) {}

  async begin(reserveBytes: number): Promise<string> {
    if (this.uploadId !== undefined) throw new Error('Mesh upload already began');
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
      throw new Error('Mesh upload reserveBytes must be a nonnegative safe integer');
    }
    this.uploadId = await this.relay<string>('mesh_chunk_upload_begin', { reserveBytes });
    return this.uploadId;
  }

  private activeUploadId(): string {
    if (this.uploadId === undefined || this.finished) {
      throw new Error('Mesh upload session is not open');
    }
    return this.uploadId;
  }

  private async uploadChunk(bytes: Uint8Array): Promise<void> {
    const uploadId = this.activeUploadId();
    const byteLength = bytes.byteLength;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    let hash = '';
    for (const byte of digest) hash += byte.toString(16).padStart(2, '0');
    const cached = await this.relay<boolean>('mesh_chunk_upload_append_cached', {
      uploadId, hash, byteLength,
    });
    if (!cached) {
      await this.relay<void>('mesh_chunk_upload_append', bytes, {
        'Content-Type': 'application/octet-stream',
        'x-mesh-upload-id': uploadId,
        'x-mesh-chunk-hash': hash,
      });
    }
  }

  /** Each input is at most one chunk; append boundaries do not affect hashes. */
  async append(bytes: Uint8Array): Promise<void> {
    this.activeUploadId();
    if (bytes.byteLength > MESH_CHUNK_BYTES) throw new Error('Mesh worker input exceeds one chunk');
    if (!this.partial && bytes.byteLength === MESH_CHUNK_BYTES) {
      await this.uploadChunk(bytes);
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
        await this.uploadChunk(chunk);
      }
    }
  }

  async finish(stage: boolean): Promise<MeshChunkUploadAck> {
    const uploadId = this.activeUploadId();
    if (this.partial) {
      const tail = this.partial.subarray(0, this.partialBytes);
      this.partial = undefined;
      this.partialBytes = 0;
      await this.uploadChunk(tail);
    }
    const ack = await this.relay<MeshChunkUploadAck>('mesh_chunk_upload_finish', { uploadId, stage });
    this.finished = true;
    return ack;
  }
}
