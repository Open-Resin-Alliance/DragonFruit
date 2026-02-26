import type { WasmSolidSliceJobEnvelope } from './wasm/slicerWasmBridge';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { getSavedSlicingPerformanceSettings } from '@/components/settings/performancePreferences';

type SliceInWorkerOptions = {
  job: WasmSolidSliceJobEnvelope;
  previewPngBytes?: Uint8Array;
  onProgress?: (done: number, total: number, phase: string) => void;
  onLayerPreview?: (layerIndex: number, totalLayers: number, pngBytes: Uint8Array) => void;
  abortSignal?: AbortSignal;
  chunkSize?: number;
  maxWorkers?: number;
};

type SliceInWorkerResult = {
  blob: Blob;
  coreElapsedMs: number;
};

type SliceWorkerInboundMessage =
  | {
    type: 'progress';
    payload: {
      phase: string;
      done: number;
      total: number;
    };
  }
  | {
    type: 'result';
    payload: {
      chunkPayload: ArrayBuffer;
      startLayer: number;
      layerCount: number;
      chunkId: number;
      elapsedMs: number;
    };
  }
  | {
    type: 'error';
    payload: {
      message: string;
    };
  };

const DEBUG_PREFIX = '[SlicingDebug]';

function logDebug(...args: unknown[]): void {
  if (typeof console === 'undefined' || typeof console.debug !== 'function') return;
  console.debug(DEBUG_PREFIX, ...args);
}

function createAbortError(message = 'Slicing canceled by user.'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function supportsSlicingWorker(): boolean {
  return typeof Worker !== 'undefined';
}

function decodeChunkPayload(chunkPayload: ArrayBuffer): Array<{ layerIndex: number; pngBytes: Uint8Array }> {
  const bytes = new Uint8Array(chunkPayload);
  if (bytes.byteLength < 8) {
    throw new Error('Invalid chunk payload: too short.');
  }

  if (bytes[0] !== 0x44 || bytes[1] !== 0x46 || bytes[2] !== 0x43 || bytes[3] !== 0x4b) {
    throw new Error('Invalid chunk payload: missing DFCK header.');
  }

  const view = new DataView(chunkPayload);
  const count = view.getUint32(4, true);
  let offset = 8;
  const layers: Array<{ layerIndex: number; pngBytes: Uint8Array }> = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 8 > bytes.byteLength) {
      throw new Error('Invalid chunk payload: truncated layer header.');
    }

    const layerIndex = view.getUint32(offset, true);
    offset += 4;
    const pngLen = view.getUint32(offset, true);
    offset += 4;

    if (offset + pngLen > bytes.byteLength) {
      throw new Error('Invalid chunk payload: truncated layer bytes.');
    }

    const pngBytes = new Uint8Array(chunkPayload, offset, pngLen);
    offset += pngLen;
    layers.push({ layerIndex, pngBytes });
  }

  return layers;
}

function parseMetadataRoot(metadataJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore and fallback below
  }

  return {};
}

function extractPrinterName(metadataRoot: Record<string, unknown>): string {
  const printer = metadataRoot.printer;
  if (printer && typeof printer === 'object' && !Array.isArray(printer)) {
    const name = (printer as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) {
      return name;
    }
  }
  return 'Athena';
}

function extractSourceFile(metadataRoot: Record<string, unknown>): string {
  const sourceFile = metadataRoot.sourceFile;
  if (typeof sourceFile === 'string' && sourceFile.trim()) {
    return sourceFile;
  }
  return 'dragonfruit_export';
}

function extractMirrorX(metadataRoot: Record<string, unknown>): boolean {
  const printer = metadataRoot.printer;
  if (printer && typeof printer === 'object' && !Array.isArray(printer)) {
    const mirrorX = (printer as Record<string, unknown>).mirrorX;
    if (typeof mirrorX === 'boolean') return mirrorX;

    const display = (printer as Record<string, unknown>).display;
    if (display && typeof display === 'object' && !Array.isArray(display)) {
      const fromDisplay = (display as Record<string, unknown>).mirrorX;
      if (typeof fromDisplay === 'boolean') return fromDisplay;
    }
  }

  // Backward-compatible default with previous behavior.
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type PngHeaderInfo = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
};

function parsePngHeader(bytes: Uint8Array): PngHeaderInfo | null {
  if (bytes.byteLength < 33) return null;
  // PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) return null;
  }

  // First chunk should be IHDR
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLen = view.getUint32(8, false);
  if (ihdrLen < 13) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }

  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
    bitDepth: bytes[24],
    colorType: bytes[25],
  };
}

class ZipDeflateBlobBuilder {
  private readonly chunks: Uint8Array[] = [];

  private readonly zipper: Zip;

  private readonly level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

  private finalized = false;

  private finalPromiseResolve: ((blob: Blob) => void) | null = null;

  private finalPromiseReject: ((error: Error) => void) | null = null;

  constructor(level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 3) {
    this.level = level;
    this.zipper = new Zip((error, data, final) => {
      if (error) {
        this.finalPromiseReject?.(error instanceof Error ? error : new Error(String(error)));
        this.finalPromiseReject = null;
        this.finalPromiseResolve = null;
        return;
      }

      this.chunks.push(data);

      if (final) {
        const blob = new Blob(this.chunks.map((chunk) => chunk as unknown as BlobPart), {
          type: 'application/octet-stream',
        });
        this.finalPromiseResolve?.(blob);
        this.finalPromiseResolve = null;
        this.finalPromiseReject = null;
      }
    });
  }

  addFile(name: string, data: Uint8Array | string): void {
    if (this.finalized) {
      throw new Error('Cannot add files after ZIP finalization.');
    }

    const payload = typeof data === 'string' ? strToU8(data) : data;
    const entry = new ZipDeflate(name, { level: this.level });
    this.zipper.add(entry);
    entry.push(payload, true);
  }

  finalize(): Promise<Blob> {
    if (this.finalized) {
      throw new Error('ZIP has already been finalized.');
    }

    this.finalized = true;

    return new Promise<Blob>((resolve, reject) => {
      this.finalPromiseResolve = resolve;
      this.finalPromiseReject = reject;
      this.zipper.end();
    });
  }
}

function buildNanodlpMetadata(job: WasmSolidSliceJobEnvelope): {
  metaJson: Record<string, unknown>;
  slicerJson: Record<string, unknown>;
  plateJson: Record<string, unknown>;
  profileJson: Record<string, unknown>;
  optionsJson: Record<string, unknown>;
} {
  const metadataRoot = parseMetadataRoot(job.metadataJson);
  const printerName = extractPrinterName(metadataRoot);
  const sourceFile = extractSourceFile(metadataRoot);
  const mirrorX = extractMirrorX(metadataRoot);
  const thicknessUm = Math.round(job.layerHeightMm * 1000);
  const zMaxMm = job.layerHeightMm * job.totalLayers;
  const xPixelSize = job.widthPx > 0 ? job.buildWidthMm / job.widthPx : 0;
  const yPixelSize = job.heightPx > 0 ? job.buildDepthMm / job.heightPx : 0;

  const metaJson = {
    format_version: 2,
    distro: 'athena',
    program: 'DragonFruit',
    version: '0.1.0',
    os: 'windows',
    arch: 'x86_64',
    profile: false,
  };

  const slicerJson = {
    Type: 'cws',
    URL: '',
    PWidth: job.widthPx,
    PHeight: job.heightPx,
    ScaleFactor: 0,
    StartLayer: 0,
    SupportDepth: thicknessUm,
    SupportLayerNumber: 0,
    Thickness: thicknessUm,
    XOffset: Math.floor(job.widthPx / 2),
    YOffset: Math.floor(job.heightPx / 2),
    ZOffset: 0,
    XPixelSize: xPixelSize,
    YPixelSize: yPixelSize,
    Mask: null,
    AutoCenter: 0,
    SliceFromZero: false,
    DisableValidator: false,
    PreviewGenerate: false,
    Running: false,
    Debug: false,
    IsFaulty: false,
    Corrupted: false,
    MultiMaterial: false,
    AdaptExport: '',
    PreviewColor: '',
    FaultyLayers: null,
    OverhangLayers: null,
    LayerStatus: null,
    File: '/job.cws',
    FileSize: 0,
    LayerCount: job.totalLayers,
    Boundary: {
      XMin: 0,
      XMax: 0,
      YMin: 0,
      YMax: 0,
      ZMin: 0,
      ZMax: zMaxMm,
    },
    Area: {
      PlateID: 0,
      Layers: [],
      TotalSolidArea: 0,
      Kill: false,
    },
    MC: {
      StartX: 0,
      StartY: 0,
      Width: 0,
      Height: 0,
      X: null,
      Y: null,
      MultiCureGap: 0,
      Count: 0,
    },
  };

  const plateJson = {
    PlateID: 0,
    ProfileID: 0,
    Profile: null,
    CreatedDate: 0,
    Path: '',
    LayersCount: job.totalLayers,
    Processed: true,
    TotalSolidArea: 0,
    MultiMaterial: false,
    MC: {
      StartX: 0,
      StartY: 0,
      Width: 0,
      Height: 0,
      X: null,
      Y: null,
      MultiCureGap: 0,
      Count: 0,
    },
    XMin: 0,
    XMax: 0,
    YMin: 0,
    YMax: 0,
    ZMin: 0,
    ZMax: zMaxMm,
    _dragonfruit: {
      source: 'dragonfruit-wasm',
      upstreamRef: 'Open-Resin-Alliance/VoxelShift',
      metadata: metadataRoot,
    },
  };

  const profileJson = {
    ResinID: 0,
    ProfileID: 0,
    Title: `DragonFruit — ${printerName}`,
    Desc: `Imported from ${sourceFile} via DragonFruit`,
    Thickness: thicknessUm,
    XOffset: Math.floor(job.widthPx / 2),
    YOffset: Math.floor(job.heightPx / 2),
    ZOffset: 0,
    AutoCenter: 0,
    XPixelSize: 0,
    YPixelSize: 0,
    ImageMirror: mirrorX ? 1 : 0,
    DisplayController: 1,
    Boundary: {
      XMin: 0,
      XMax: 0,
      YMin: 0,
      YMax: 0,
      ZMin: 0,
      ZMax: zMaxMm,
    },
    Area: { PlateID: 0, Layers: [], Kill: false },
  };

  const optionsJson = {
    PWidth: job.widthPx,
    PHeight: job.heightPx,
    SupportDepth: thicknessUm,
    Depth: thicknessUm,
    LiftSpeed: 0,
    RetractSpeed: 0,
    CureTime: 0,
    ExportType: 0,
    OutputPath: '',
    Suffix: '',
    SkipEmpty: 0,
    FillColorRGB: { R: 255, G: 255, B: 255, A: 255 },
    BlankColorRGB: { R: 0, G: 0, B: 0, A: 255 },
  };

  return {
    metaJson,
    slicerJson,
    plateJson,
    profileJson,
    optionsJson,
  };
}

type ChunkTask = {
  chunkId: number;
  startLayer: number;
  layerCount: number;
};

type InFlightChunk = {
  chunkId: number;
  layerCount: number;
  startedAtMs: number;
};

export async function sliceSolidNanodlpInWorker(options: SliceInWorkerOptions): Promise<SliceInWorkerResult> {
  if (!supportsSlicingWorker()) {
    throw new Error('Web Workers are not available in this runtime.');
  }

  if (options.abortSignal?.aborted) {
    throw createAbortError();
  }

  return new Promise<SliceInWorkerResult>((resolve, reject) => {
    const totalLayers = Math.max(1, options.job.totalLayers);
    const perfSettings = getSavedSlicingPerformanceSettings();
    const rawConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2;
    const reserveThreads = perfSettings.cpuProfile === 'balanced' ? 2 : 1;
    const defaultWorkers = Math.max(1, rawConcurrency - reserveThreads);
    const targetWorkers = options.maxWorkers ?? defaultWorkers;

    const isGranularProgress = perfSettings.progressGranularity === 'granular';
    const adaptiveChunkSize = Math.max(
      isGranularProgress ? 2 : 4,
      Math.min(isGranularProgress ? 12 : 24, Math.ceil(totalLayers / Math.max(1, Math.ceil(targetWorkers * 1.25)))),
    );
    const chunkSize = Math.max(1, Math.min(totalLayers, options.chunkSize ?? adaptiveChunkSize));
    const workerCount = Math.max(1, Math.min(targetWorkers, Math.ceil(totalLayers / chunkSize)));

    const chunkQueue: ChunkTask[] = [];
    let chunkId = 0;
    for (let start = 0; start < totalLayers; start += chunkSize) {
      chunkQueue.push({
        chunkId: chunkId++,
        startLayer: start,
        layerCount: Math.min(chunkSize, totalLayers - start),
      });
    }

    const workers: Worker[] = [];
    const inFlightByWorker = new Map<Worker, ChunkTask | null>();
    const inFlightByChunk = new Map<number, InFlightChunk>();
    const pendingLayers = new Map<number, Uint8Array>();
    let nextLayerToWrite = 0;
    let doneLayers = 0;
    let completedChunks = 0;
    let activeWorkers = workerCount;
    let workerElapsedMsTotal = 0;
    let rejected = false;
    let finalizing = false;
    let firstLayerHeaderReported = false;
    let abortListenerAttached = false;
    let heartbeatTimer: number | null = null;
    let averageChunkElapsedMs = 200;
    let maxReportedDone = 0;
    let hasCommittedLayer = false;
    let lastEmitMs = 0;

    const zipBuilder = new ZipDeflateBlobBuilder(3);
    const metadata = buildNanodlpMetadata(options.job);
    zipBuilder.addFile('meta.json', JSON.stringify(metadata.metaJson, null, 2));
    zipBuilder.addFile('slicer.json', JSON.stringify(metadata.slicerJson, null, 2));
    zipBuilder.addFile('plate.json', JSON.stringify(metadata.plateJson, null, 2));
    zipBuilder.addFile('profile.json', JSON.stringify(metadata.profileJson, null, 2));
    zipBuilder.addFile('options.json', JSON.stringify(metadata.optionsJson, null, 2));
    zipBuilder.addFile('info.json', '[]');
    let firstLayerPng: Uint8Array | null = null;
    let previewLayerPng: Uint8Array | null = null;
    const preferredBackend = perfSettings.computeBackend;
    const hasNavigatorGpu = typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);

    const emitProgress = (done: number, phase: string) => {
      const bounded = Math.max(0, Math.min(totalLayers, done));

      // Keep progress monotonic, but avoid sudden teleports when many contiguous layers
      // flush at once after out-of-order chunk completions.
      const nowMs = performance.now();
      const dtMs = lastEmitMs > 0 ? Math.max(16, nowMs - lastEmitMs) : 120;
      lastEmitMs = nowMs;

      if (bounded >= totalLayers) {
        maxReportedDone = totalLayers;
        options.onProgress?.(maxReportedDone, totalLayers, phase);
        return;
      }

      const maxLayersPerSec = hasCommittedLayer ? 420 : 220;
      const maxStep = Math.max(1, Math.round((maxLayersPerSec * dtMs) / 1000));
      const nextTarget = Math.max(maxReportedDone, bounded);

      if (nextTarget > maxReportedDone) {
        maxReportedDone = Math.min(nextTarget, maxReportedDone + maxStep);
      }

      options.onProgress?.(maxReportedDone, totalLayers, phase);
    };

    if (preferredBackend === 'webgpu') {
      if (hasNavigatorGpu) {
        emitProgress(0, 'WebGPU requested (experimental): CPU/WASM fallback currently active');
      } else {
        emitProgress(0, 'WebGPU requested but unavailable on this device/browser; using CPU/WASM');
      }
    }

    const cleanupAll = () => {
      if (abortListenerAttached && options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
        abortListenerAttached = false;
      }

      if (heartbeatTimer != null && typeof window !== 'undefined') {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      for (const worker of workers) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
      logDebug('Worker NanoDLP slicing started', {
        totalLayers,
        chunkSize,
        workerCount,
        chunkCount: chunkId,
        packingMode: options.job.xPackingMode,
        source: `${options.job.sourceWidthPx}x${options.job.sourceHeightPx}`,
        output: `${options.job.widthPx}x${options.job.heightPx}`,
      });
    };

    const rejectOnce = (message: string) => {
      if (rejected) return;
      rejected = true;
      cleanupAll();
      reject(new Error(message));
    };

    const rejectAbortOnce = () => {
      if (rejected) return;
      rejected = true;
      cleanupAll();
      reject(createAbortError());
    };

    const abortHandler = () => {
      rejectAbortOnce();
    };

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        rejectAbortOnce();
        return;
      }
      options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      abortListenerAttached = true;
    }

    const tryFinalize = async () => {
      if (rejected) return;
      if (doneLayers < totalLayers || completedChunks < chunkId) return;
      if (finalizing) return;
      finalizing = true;

      try {
        const providedPreview = options.previewPngBytes && options.previewPngBytes.byteLength > 0
          ? Uint8Array.from(options.previewPngBytes)
          : null;
        const previewPng = providedPreview ?? previewLayerPng ?? firstLayerPng;
        if (previewPng) {
          zipBuilder.addFile('3d.png', previewPng);
          zipBuilder.addFile('3d.png.meta', '{}');
        }

        const blob = await zipBuilder.finalize();
        logDebug('Worker NanoDLP slicing finalized', {
          doneLayers,
          completedChunks,
          totalChunks: chunkId,
          coreElapsedMs: workerElapsedMsTotal,
          blobBytes: blob.size,
        });
        cleanupAll();
        resolve({
          blob,
          coreElapsedMs: workerElapsedMsTotal,
        });
      } catch (error) {
        rejectOnce(error instanceof Error ? error.message : String(error));
      }
    };

    const flushReadyLayers = () => {
      while (nextLayerToWrite < totalLayers) {
        const png = pendingLayers.get(nextLayerToWrite);
        if (!png) break;
        pendingLayers.delete(nextLayerToWrite);

        if (!firstLayerPng) {
          firstLayerPng = Uint8Array.from(png);
          if (!firstLayerHeaderReported) {
            const hdr = parsePngHeader(firstLayerPng);
            if (hdr) {
              emitProgress(
                doneLayers,
                `NanoDLP layer PNG: ${hdr.width}x${hdr.height}, bitDepth=${hdr.bitDepth}, colorType=${hdr.colorType}`,
              );
              firstLayerHeaderReported = true;
            }
          }
        } else if (!previewLayerPng && !bytesEqual(firstLayerPng, png)) {
          previewLayerPng = Uint8Array.from(png);
        }

        options.onLayerPreview?.(nextLayerToWrite, totalLayers, Uint8Array.from(png));

        zipBuilder.addFile(`${nextLayerToWrite + 1}.png`, png);
        nextLayerToWrite += 1;
      }

      doneLayers = nextLayerToWrite;
      if (doneLayers > 0) {
        hasCommittedLayer = true;
      }
    };

    const emitEstimatedProgress = () => {
      if (rejected || finalizing || totalLayers <= 0) return;

      if (!hasCommittedLayer) {
        emitProgress(0, 'Processing slices…');
        return;
      }

      let estimatedInFlightLayers = 0;
      if (inFlightByChunk.size > 0) {
        const nowMs = performance.now();
        const expectedMs = Math.max(120, averageChunkElapsedMs * 1.15);
        for (const chunk of inFlightByChunk.values()) {
          const elapsed = Math.max(0, nowMs - chunk.startedAtMs);
          const ratio = Math.max(0, Math.min(0.92, elapsed / expectedMs));
          estimatedInFlightLayers += chunk.layerCount * ratio;
        }
      }

      const estimatedDone = Math.max(
        doneLayers,
        Math.min(totalLayers - 0.0001, doneLayers + estimatedInFlightLayers),
      );

      emitProgress(estimatedDone, 'Processing slices…');
    };

    if (typeof window !== 'undefined') {
      heartbeatTimer = window.setInterval(
        emitEstimatedProgress,
        isGranularProgress ? 110 : 190,
      );
    }

    const dispatchNext = (worker: Worker) => {
      if (rejected) return;
      if (options.abortSignal?.aborted) {
        rejectAbortOnce();
        return;
      }

      const next = chunkQueue.shift();
      if (!next) {
        inFlightByWorker.set(worker, null);
        activeWorkers -= 1;

        if (activeWorkers <= 0) {
          void tryFinalize();
        }
        return;
      }

      inFlightByWorker.set(worker, next);
      inFlightByChunk.set(next.chunkId, {
        chunkId: next.chunkId,
        layerCount: next.layerCount,
        startedAtMs: performance.now(),
      });
      logDebug('Dispatching chunk', {
        chunkId: next.chunkId,
        startLayer: next.startLayer,
        layerCount: next.layerCount,
      });
      worker.postMessage({
        type: 'slice-solid-nanodlp-chunk',
        payload: {
          startLayer: next.startLayer,
          layerCount: next.layerCount,
          chunkId: next.chunkId,
        },
      });
    };

    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(new URL('./workers/slicingWorker.ts', import.meta.url), { type: 'module' });
      workers.push(worker);
      inFlightByWorker.set(worker, null);

      worker.onerror = (event) => {
        rejectOnce(event.message || 'Unknown worker error.');
      };

      worker.onmessage = (event: MessageEvent<SliceWorkerInboundMessage>) => {
        if (rejected) return;
        const message = event.data;
        if (!message) return;

        if (message.type === 'progress') {
          const boundedDone = Math.max(doneLayers, Math.min(totalLayers - 1, message.payload.done));
          emitProgress(boundedDone, message.payload.phase);
          return;
        }

        if (message.type === 'error') {
          logDebug('Worker reported error', message.payload);
          rejectOnce(message.payload.message);
          return;
        }

        if (message.type === 'result') {
          try {
            const inFlight = inFlightByChunk.get(message.payload.chunkId);
            if (inFlight) {
              inFlightByChunk.delete(message.payload.chunkId);
            }

            workerElapsedMsTotal += message.payload.elapsedMs;
            completedChunks += 1;
            averageChunkElapsedMs = averageChunkElapsedMs <= 0
              ? message.payload.elapsedMs
              : ((averageChunkElapsedMs * 0.82) + (message.payload.elapsedMs * 0.18));
            logDebug('Chunk completed', {
              chunkId: message.payload.chunkId,
              startLayer: message.payload.startLayer,
              layerCount: message.payload.layerCount,
              elapsedMs: message.payload.elapsedMs,
            });
            const decodedLayers = decodeChunkPayload(message.payload.chunkPayload);
            for (const entry of decodedLayers) {
              pendingLayers.set(entry.layerIndex, entry.pngBytes);
            }

            flushReadyLayers();

            dispatchNext(worker);
            void tryFinalize();
          } catch (error) {
            rejectOnce(error instanceof Error ? error.message : String(error));
          }
        }
      };

      worker.postMessage({
        type: 'init-solid-nanodlp-job',
        payload: {
          job: options.job,
        },
      });

      dispatchNext(worker);
    }
  });
}
