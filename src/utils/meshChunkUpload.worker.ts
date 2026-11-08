import {
  MeshChunkWorkerBody,
  deserializeMeshChunkError,
  serializeMeshChunkError,
  type MeshChunkNativeCommand,
  type MeshChunkRelay,
  type MeshChunkWorkerInput,
  type MeshChunkWorkerOutput,
} from './meshChunkUpload.shared';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MeshChunkWorkerInput>) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: MeshChunkWorkerOutput, transfer: Transferable[]): void;
};

let nextRelayId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const relay: MeshChunkRelay = <T>(
  command: MeshChunkNativeCommand,
  args: Record<string, unknown> | Uint8Array,
  headers?: Record<string, string>,
): Promise<T> => new Promise<T>((resolve, reject) => {
  const relayId = ++nextRelayId;
  pending.set(relayId, { resolve: resolve as (value: unknown) => void, reject });
  try {
    scope.postMessage({ type: 'invoke', relayId, command, args, headers },
      args instanceof Uint8Array ? [args.buffer as ArrayBuffer] : []);
  } catch (error) {
    pending.delete(relayId);
    reject(error);
  }
});

const body = new MeshChunkWorkerBody(relay);
let operations = Promise.resolve();

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'relay-result') {
    const request = pending.get(message.relayId);
    if (!request) return;
    pending.delete(message.relayId);
    if (message.ok) request.resolve(message.value);
    else request.reject(deserializeMeshChunkError(message.error));
    return;
  }
  operations = operations.then(async () => {
    try {
      let value: unknown;
      switch (message.type) {
        case 'begin': value = await body.begin(message.reserveBytes, message.retainForSlice); break;
        case 'append': await body.append(message.bytes); break;
        case 'append-source': value = await body.appendSource(message.source); break;
        case 'finish': value = await body.finish(message.stage); break;
      }
      scope.postMessage({ type: 'result', requestId: message.requestId, value }, []);
    } catch (error) {
      scope.postMessage({ type: 'error', requestId: message.requestId, error: serializeMeshChunkError(error) }, []);
    }
  });
};

scope.onmessageerror = () => {
  const error = new Error('Mesh worker could not deserialize a request');
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  scope.postMessage({ type: 'fatal', error: serializeMeshChunkError(error) }, []);
};
