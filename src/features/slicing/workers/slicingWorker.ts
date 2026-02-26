import { sliceSolidLayersChunkWithSlicerWasm, type WasmSolidSliceJobEnvelope } from '../wasm/slicerWasmBridge';

type SliceWorkerRequest =
  | {
    type: 'init-solid-nanodlp-job';
    payload: {
      job: WasmSolidSliceJobEnvelope;
    };
  }
  | {
    type: 'slice-solid-nanodlp-chunk';
    payload: {
      startLayer: number;
      layerCount: number;
      chunkId: number;
    };
  };

type SliceWorkerProgress = {
  type: 'progress';
  payload: {
    phase: string;
    done: number;
    total: number;
  };
};

type SliceWorkerResult = {
  type: 'result';
  payload: {
    chunkPayload: ArrayBuffer;
    startLayer: number;
    layerCount: number;
    chunkId: number;
    elapsedMs: number;
  };
};

type SliceWorkerError = {
  type: 'error';
  payload: {
    message: string;
  };
};

const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<SliceWorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

workerSelf.onmessage = async (event: MessageEvent<SliceWorkerRequest>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === 'init-solid-nanodlp-job') {
    currentJob = message.payload.job;
    return;
  }

  if (message.type !== 'slice-solid-nanodlp-chunk') return;

  try {
    const { startLayer, layerCount, chunkId } = message.payload;
    const job = currentJob;
    if (!job) {
      throw new Error('Chunk request received before worker job initialization.');
    }

    const progressStart: SliceWorkerProgress = {
      type: 'progress',
      payload: {
        phase: `Chunk ${chunkId} starting`,
        done: startLayer,
        total: Math.max(1, job.totalLayers),
      },
    };
    workerSelf.postMessage(progressStart);

    const startMs = performance.now();
    const chunkPayload = await sliceSolidLayersChunkWithSlicerWasm(
      job,
      startLayer,
      layerCount,
    );
    const elapsedMs = performance.now() - startMs;

    const progressDone: SliceWorkerProgress = {
      type: 'progress',
      payload: {
        phase: `Chunk ${chunkId} completed`,
        done: Math.min(job.totalLayers, startLayer + layerCount),
        total: Math.max(1, job.totalLayers),
      },
    };
    workerSelf.postMessage(progressDone);

    const chunkBuffer = new Uint8Array(chunkPayload).buffer;
    const result: SliceWorkerResult = {
      type: 'result',
      payload: {
        chunkPayload: chunkBuffer,
        startLayer,
        layerCount,
        chunkId,
        elapsedMs,
      },
    };

    workerSelf.postMessage(result, [chunkBuffer]);
  } catch (error) {
    const err: SliceWorkerError = {
      type: 'error',
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
    workerSelf.postMessage(err);
  }
};

let currentJob: WasmSolidSliceJobEnvelope | null = null;

export {};
