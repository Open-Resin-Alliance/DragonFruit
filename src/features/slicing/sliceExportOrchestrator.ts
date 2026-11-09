import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { attachJobMetadataPayloads, getJobMetadataPayloadDeclarations } from './jobMetadataPayloads';
import { resolveOutputFileExtension, resolveSlicingFormatDefinition } from './formats/registry';
import { asciiFileBaseName } from './plateSliceNaming';
import { getSavedSlicingPerformanceSettings } from '@/components/settings/performancePreferences';
import {
    isNativeSlicerAvailable,
    sliceSolidAndEncodeWithNativeSlicerToTempPath,
    type AntiAliasingLevel,
    type NativeSlicerPerfMetrics,
    type NativeSlicerRuntimeMetrics,
} from './tauri/nativeSlicerBridge';
import { assembleSliceJob, buildNativeSliceJob } from './sliceJobAssembly';
import type { SliceJobAntiAliasingRequest } from './sliceAntiAliasing';
import { runWithSliceMesh } from './sliceMeshSnapshot';
export { prewarmSliceMesh, getSliceMeshInputSignature, equalSliceMeshInputSignatures, subscribeSliceMeshInputChanges } from './sliceMeshSnapshot';
export type { SliceMeshPrewarmOptions, SliceMeshInputSignature } from './sliceMeshSnapshot';

const DEBUG_PREFIX = '[SlicingDebug]';
const BYTES_PER_TRIANGLE_XYZ = Float32Array.BYTES_PER_ELEMENT * 9;
const STAGING_PREALLOC_MIN_BYTES = 16 * 1024 * 1024;
const STAGING_PREALLOC_MAX_BYTES = 1024 * 1024 * 1024;
const STAGING_PREALLOC_HEADROOM = 1.35;
const MESH_TRANSPORT_ENCODING = 'raw_f32' as const;

function logDebug(...args: unknown[]): void {
    if (typeof console === 'undefined' || typeof console.debug !== 'function') return;
    console.debug(DEBUG_PREFIX, ...args);
}

function estimateInitialMeshStagingBytes(models: LoadedModel[]): number {
    const visibleModelTriangles = models.reduce((sum, model) => {
        if (!model.visible) return sum;
        const triangleCount = Number.isFinite(model.polygonCount)
            ? Math.max(0, Math.floor(model.polygonCount))
            : 0;
        return sum + triangleCount;
    }, 0);

    if (visibleModelTriangles <= 0) {
        return STAGING_PREALLOC_MIN_BYTES;
    }

    const estimatedBytes = Math.ceil(
        visibleModelTriangles * BYTES_PER_TRIANGLE_XYZ * STAGING_PREALLOC_HEADROOM,
    );

    return Math.max(
        STAGING_PREALLOC_MIN_BYTES,
        Math.min(STAGING_PREALLOC_MAX_BYTES, estimatedBytes),
    );
}

export type SliceExportOrchestratorOptions = {
    models: LoadedModel[];
    excludedModelIds?: readonly string[];
    /**
     * The build volume of the plate being sliced, in world coordinates. Given
     * one, the in-bounds filter judges models against their own plate instead of
     * a volume centred on the origin, which is what a cascade needs.
     */
    plateVolumeBoundsMm?: { minX: number; minY: number; maxX: number; maxY: number };
    /** Where that plate sits in the cascade, so its geometry can be shifted to the origin. */
    plateOffsetMm?: { dxMm: number; dyMm: number };
    printerProfile: PrinterProfile;
    materialProfile: MaterialProfile;
    filenameBase: string;
    outputPath?: string | null;
    /** The user's anti-aliasing choice; without one the job slices with anti-aliasing off. */
    antiAliasing?: SliceJobAntiAliasingRequest;
    ditherEnabled?: boolean;
    ditherBitDepth?: number;
    ditherDeviceGamma?: number;
    outputMode?: 'download' | 'return';
    exportThumbnailPng?: Uint8Array | null;
    abortSignal?: AbortSignal;
    onProgress?: (done: number, total: number, phase: string) => void;
};

function encodeBytesToBase64(bytes: Uint8Array): string {
    // Chunk to avoid stack/memory pressure on large arrays.
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function createAbortError(message = 'Slicing canceled by user.'): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException(message, 'AbortError');
    }

    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

export type SliceExportArtifact = {
    blob: Blob | null;
    outputName: string;
    mimeType: string;
    byteSize: number;
    nativeTempPath: string | null;
    /** Output format identifier, e.g. ".nanodlp" or ".ctb". Used to route layer preview decoding to the correct plugin decoder. */
    outputFormat: string;
};

export type SliceExportResult = {
    backend: 'native-rust-tauri';
    outputFormat: string;
    nativeAvailable: boolean;
    nativeError: string | null;
    artifact: SliceExportArtifact | null;
    benchmark: {
        totalElapsedMs: number;
        meshPrepMs: number | null;
        coreSlicingMs: number | null;
        totalLayers: number | null;
        layersPerSecond: number | null;
        jobConfig: {
            outputFormat: string;
            formatVersion?: string;
            settingsMode?: string;
            outputDisplayName: string;
            sourceWidthPx: number;
            sourceHeightPx: number;
            widthPx: number;
            heightPx: number;
            xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
            pngCompressionStrategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
            containerCompressionLevel: number;
            antiAliasingLevel: AntiAliasingLevel;
            antiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
            blurBrushRadiusPx: number;
            blurBrushKernel: 'box' | 'gaussian';
            blurBrushSigmaX: number;
            blurBrushSigmaY: number;
            zBlurRadiusLayers: number;
            zBlurKernel: 'box' | 'gaussian';
            zBlurSigma: number;
            aaOnSupports: boolean;
            minimumAaAlphaPercent: number;
            zaaKernel?: 'perturb';
            zaaPattern?: 'uniform' | 'halton' | 'base2';
            zaaDuplicateZ?: boolean;
            modelTriangleCount: number;
            triangleFloatCount: number;
            buildWidthMm: number;
            buildDepthMm: number;
            layerHeightMm: number;
            totalLayers: number;
            metadataJsonBytes: number;
            exportThumbnailProvided: boolean;
            exportThumbnailBytes: number;
            initialMeshStagingBytes: number;
            meshChunkTargetBytes: number;
            meshEncoding: 'raw_f32' | 'quantized_u16';
            meshQuantization: {
                minX: number;
                minY: number;
                minZ: number;
                maxX: number;
                maxY: number;
                maxZ: number;
            } | null;
            meshTransferMode: 'cached-chunks';
        };
        nativePerf: {
            perf: NativeSlicerPerfMetrics | null;
            runtime: NativeSlicerRuntimeMetrics | null;
            bridgePayloadBuildMs: number | null;
            bridgeInvokeRoundTripMs: number | null;
            bridgeTotalMs: number | null;
            bridgePayloadChars: number | null;
            bridgePayloadContributors?: Record<string, { chars: number; bytes: number }>;
            bridgePayloadUploadedBytes?: number;
            bridgePayloadReusedBytes?: number;
            bridgePayloadCacheMs?: number;
            triangleFloatCount: number | null;
            meshBytesLen: number | null;
            stageMeshMs: number | null;
            stageMeshWallMs: number;
            stageMeshHashMs: number;
            stageMeshCommands: Record<string, { count: number; ms: number }>;
            stageMeshBytes: number | null;
            stageMeshUploadedBytes: number;
            stageMeshReusedBytes: number;
            stageMeshChunkCount: number | null;
            stageMeshAvgChunkBytes: number | null;
            stageMeshThroughputMiBPerSec: number | null;
            stageMeshAckAppendMs: number | null;
            stageMeshCapacityMaxBytes: number | null;
            stageMeshReserveGrowthEvents: number | null;
            transportOverheadMs: number | null;
            renderWallMs: number | null;
            renderCpuMs: number | null;
            indexBuildMs: number | null;
            pngEncodeCpuMs: number | null;
            archiveEncodeMs: number | null;
            totalMs: number | null;
            renderWallMsPerLayer: number | null;
            renderCpuMsPerLayer: number | null;
            pngCpuMsPerLayer: number | null;
            totalMsPerLayer: number | null;
        };
    };
};

/**
 * Orchestrates export via DragonFruit Desktop native slicer.
 */
export async function runSliceExportOrchestrator(options: SliceExportOrchestratorOptions): Promise<SliceExportResult> {
    throwIfAborted(options.abortSignal);
    const orchestratorStartMs = performance.now();
    const emitDiagnosticProgress = (phase: string, done: number, total: number, extra?: Record<string, unknown>) => {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent('dragonfruit:slicing-progress', {
            detail: {
                phase,
                done,
                total,
                ...extra,
            },
        }));
    };

    const excludedModelIdSet = new Set(options.excludedModelIds ?? []);
    const visibleModels = options.models.filter((model) => model.visible && !excludedModelIdSet.has(model.id));
    if (visibleModels.length === 0) {
        throw new Error('No in-bounds visible models available for slicing.');
    }

    const format = resolveSlicingFormatDefinition({
        printerProfile: options.printerProfile,
        materialProfile: options.materialProfile,
    });
    // The profile's format is only as real as the plugin that declares it. Saying so
    // is the whole point: the alternative - substituting another format's definition -
    // writes bytes whose encoder does not match the file's name.
    if (!format) {
        throw new Error(
            `No encoder is installed for "${options.printerProfile.display.outputFormat}". `
            + 'Install the plugin that provides that output format, or pick another one for this printer profile.',
        );
    }

    logDebug('Export orchestrator start', {
        format: format.outputFormat,
        displayName: format.displayName,
        printer: options.printerProfile.name,
        material: options.materialProfile.name,
        modelCount: options.models.length,
        excludedModelCount: excludedModelIdSet.size,
    });

    throwIfAborted(options.abortSignal);
    const nativeAvailable = await isNativeSlicerAvailable();
    if (!nativeAvailable) {
        throw new Error('Native slicer requires DragonFruit Desktop (Tauri). JS/WebGPU slicing has been removed.');
    }

    options.onProgress?.(0, 1, 'Preparing');
    emitDiagnosticProgress('Preparing mesh', 0, 1, {
        format: format.outputFormat,
        modelCount: visibleModels.length,
    });

    const initialMeshStagingBytes = estimateInitialMeshStagingBytes(visibleModels);
    // Preserve all crossings; the rasterizer alone crops to the printable volume.
    const meshTransportBytesEstimate = initialMeshStagingBytes;
    const meshTransportEncoding = MESH_TRANSPORT_ENCODING;
    const meshTransportQuantization = null;
    const meshChunkTargetBytes = 4 * 1024 * 1024;
    const meshTransferMode = 'cached-chunks' as const;
    return runWithSliceMesh(options, options.abortSignal,
        () => options.onProgress?.(0, 1, 'Baking Modifiers'),
        async (descriptor, chunkAck, meshPrepMs, snapshotId) => {
        const sourceModelIds = new Set(descriptor.sourceModelIds);
        const visibleModels = options.models.filter((model) => sourceModelIds.has(model.id));
        const solidMesh = { ...descriptor, trianglesXYZ: new Float32Array(0) };
        const cumulativeBytesStage = chunkAck.totalBytes;
        const stageMeshIpcMs = chunkAck.ipcMs;
        const stageMeshChunkCount = chunkAck.chunksReceived;
        const stageMeshAckAppendNsTotal = chunkAck.appendNsTotal;
        const stageMeshCapacityMaxBytes = chunkAck.capacityBytes;
        const stageMeshReserveGrowthEvents = Number(chunkAck.reserveGrew);
        const stageMeshUploadedBytes = chunkAck.uploadedBytes;
        const stageMeshReusedBytes = chunkAck.reusedBytes;
        emitDiagnosticProgress('Preparing mesh complete', 1, 1, {
            meshPrepMs,
            triangleFloatCount: cumulativeBytesStage / Float32Array.BYTES_PER_ELEMENT,
            totalLayers: solidMesh.totalLayers,
        });

        options.onProgress?.(0, solidMesh.totalLayers, 'Staging');

        const perfSettings = getSavedSlicingPerformanceSettings();

        const assembled = assembleSliceJob({
            printerProfile: options.printerProfile,
            materialProfile: options.materialProfile,
            scene: {
                totalLayers: solidMesh.totalLayers,
                tallestObjectHeightMm: solidMesh.tallestObjectHeightMm,
                models: solidMesh.models,
            },
            dither: options,
            antiAliasing: options.antiAliasing,
        });

        const nativeJob = {
            ...buildNativeSliceJob(assembled, {
                pngCompressionMode: solidMesh.pngCompressionStrategy,
                aaOnSupportsFallback: perfSettings.aaOnSupportsExperimental === true,
                modelTriangleCount: solidMesh.modelTriangleCount,
            }),
            exportThumbnailPngBase64: options.exportThumbnailPng && options.exportThumbnailPng.length > 0
                ? encodeBytesToBase64(options.exportThumbnailPng)
                : null,
            trianglesXYZ: solidMesh.trianglesXYZ,
            meshByteLength: cumulativeBytesStage,
            tankCount: solidMesh.tankCount,
            triangleTankIndex: solidMesh.triangleTankIndex,
            meshEncoding: meshTransportEncoding,
            meshQuantization: meshTransportQuantization,
            outputPath: options.outputPath?.trim() || null,
            metadataJson: await attachJobMetadataPayloads(
                assembled.metadataJson,
                { models: visibleModels },
                getJobMetadataPayloadDeclarations(),
            ),
        };

        const coreStartMs = performance.now();
        logDebug('Native slicing starting…');
        logDebug('Native slicing AA settings', {
            antiAliasingLevel: nativeJob.antiAliasingLevel,
            antiAliasingMode: nativeJob.antiAliasingMode,
            blurBrushRadiusPx: nativeJob.blurBrushRadiusPx,
            zBlurRadiusLayers: nativeJob.zBlurRadiusLayers,
            zaaKernel: nativeJob.zaaKernel,
            zaaPattern: nativeJob.zaaPattern,
            zaaDuplicateZ: nativeJob.zaaDuplicateZ,
        });

        let progressTotal = solidMesh.totalLayers;
        let progressDone = 0;

        options.onProgress?.(0, solidMesh.totalLayers, 'Slicing');

        const slicerProgressCallback = (done: number, total: number, phase: string) => {
            progressTotal = Math.max(1, total);
            progressDone = Math.max(0, Math.min(done, progressTotal));
            options.onProgress?.(
                progressDone,
                progressTotal,
                phase,
            );
        };

        const encodedArtifact = await sliceSolidAndEncodeWithNativeSlicerToTempPath(
            nativeJob,
            options.abortSignal,
            slicerProgressCallback,
            snapshotId ? { snapshotId } : undefined,
        );
        const coreSlicingMs = performance.now() - coreStartMs;
        logDebug('Native slicing completed', { coreSlicingMs });

        throwIfAborted(options.abortSignal);
        options.onProgress?.(Math.max(progressDone, progressTotal), progressTotal, 'Finalizing');

        const printerExt = resolveOutputFileExtension(
            options.printerProfile.display.outputFormat,
            options.printerProfile.display.formatVersion,
        ) || format.outputFormat.replace(/^\./, '') || 'slice';
        const outputName = `${asciiFileBaseName(options.filenameBase)}.${printerExt}`;

        const totalElapsedMs = performance.now() - orchestratorStartMs;
        options.onProgress?.(progressTotal, progressTotal, 'Handoff');
        const layersPerSecond = totalElapsedMs > 0
            ? (solidMesh.totalLayers * 1000) / totalElapsedMs
            : null;
        const stageMeshAvgChunkBytes = stageMeshChunkCount > 0
            ? (cumulativeBytesStage / stageMeshChunkCount)
            : null;
        const stageMeshThroughputMiBPerSec = stageMeshIpcMs > 0
            ? ((stageMeshUploadedBytes / (1024 * 1024)) / (stageMeshIpcMs / 1000))
            : null;
        const stageMeshAckAppendMs = stageMeshAckAppendNsTotal > 0
            ? (stageMeshAckAppendNsTotal / 1_000_000)
            : null;

        return {
            backend: 'native-rust-tauri',
            outputFormat: format.outputFormat,
            nativeAvailable,
            nativeError: null,
            artifact: {
                blob: null,
                outputName,
                mimeType: 'application/octet-stream',
                byteSize: encodedArtifact.byteLen,
                nativeTempPath: encodedArtifact.tempPath,
                outputFormat: format.outputFormat,
            },
            benchmark: {
                totalElapsedMs,
                meshPrepMs,
                coreSlicingMs,
                totalLayers: solidMesh.totalLayers,
                layersPerSecond,
                jobConfig: {
                    outputFormat: format.outputFormat,
                    formatVersion: nativeJob.formatVersion,
                    settingsMode: nativeJob.settingsMode,
                    outputDisplayName: format.displayName,
                    sourceWidthPx: nativeJob.sourceWidthPx,
                    sourceHeightPx: nativeJob.sourceHeightPx,
                    widthPx: nativeJob.widthPx,
                    heightPx: nativeJob.heightPx,
                    xPackingMode: nativeJob.xPackingMode,
                    pngCompressionStrategy: nativeJob.pngCompressionStrategy,
                    containerCompressionLevel: nativeJob.containerCompressionLevel,
                    antiAliasingLevel: nativeJob.antiAliasingLevel,
                    antiAliasingMode: nativeJob.antiAliasingMode,
                    blurBrushRadiusPx: nativeJob.blurBrushRadiusPx,
                    blurBrushKernel: nativeJob.blurBrushKernel,
                    blurBrushSigmaX: nativeJob.blurBrushSigmaX,
                    blurBrushSigmaY: nativeJob.blurBrushSigmaY,
                    zBlurRadiusLayers: nativeJob.zBlurRadiusLayers,
                    zBlurKernel: nativeJob.zBlurKernel,
                    zBlurSigma: nativeJob.zBlurSigma,
                    aaOnSupports: nativeJob.aaOnSupports,
                    minimumAaAlphaPercent: nativeJob.minimumAaAlphaPercent,
                    zaaKernel: nativeJob.zaaKernel,
                    zaaPattern: nativeJob.zaaPattern,
                    zaaDuplicateZ: nativeJob.zaaDuplicateZ,
                    modelTriangleCount: nativeJob.modelTriangleCount,
                    triangleFloatCount: cumulativeBytesStage / Float32Array.BYTES_PER_ELEMENT,
                    buildWidthMm: nativeJob.buildWidthMm,
                    buildDepthMm: nativeJob.buildDepthMm,
                    layerHeightMm: nativeJob.layerHeightMm,
                    totalLayers: nativeJob.totalLayers,
                    metadataJsonBytes: nativeJob.metadataJson.length,
                    exportThumbnailProvided: Boolean(options.exportThumbnailPng && options.exportThumbnailPng.length > 0),
                    exportThumbnailBytes: options.exportThumbnailPng?.length ?? 0,
                    initialMeshStagingBytes: meshTransportBytesEstimate,
                    meshChunkTargetBytes,
                    meshEncoding: meshTransportEncoding,
                    meshQuantization: meshTransportQuantization,
                    meshTransferMode,
                },
                nativePerf: {
                    perf: encodedArtifact.perf,
                    runtime: encodedArtifact.runtime,
                    bridgePayloadBuildMs: encodedArtifact.bridge?.payloadBuildMs ?? null,
                    bridgeInvokeRoundTripMs: encodedArtifact.bridge?.invokeRoundTripMs ?? null,
                    bridgeTotalMs: encodedArtifact.bridge?.bridgeTotalMs ?? null,
                    bridgePayloadChars: encodedArtifact.bridge?.payloadChars ?? null,
                    bridgePayloadContributors: encodedArtifact.bridge?.payloadContributors,
                    bridgePayloadUploadedBytes: encodedArtifact.bridge?.payloadUploadedBytes,
                    bridgePayloadReusedBytes: encodedArtifact.bridge?.payloadReusedBytes,
                    bridgePayloadCacheMs: encodedArtifact.bridge?.payloadCacheMs,
                    triangleFloatCount: encodedArtifact.bridge?.triangleFloatCount ?? null,
                    meshBytesLen: encodedArtifact.bridge?.meshBytesLen ?? null,
                    stageMeshMs: stageMeshIpcMs,
                    stageMeshWallMs: chunkAck.wallMs,
                    stageMeshHashMs: chunkAck.hashMs,
                    stageMeshCommands: chunkAck.commands,
                    stageMeshBytes: cumulativeBytesStage > 0 ? cumulativeBytesStage : null,
                    stageMeshUploadedBytes,
                    stageMeshReusedBytes,
                    stageMeshChunkCount: stageMeshChunkCount > 0 ? stageMeshChunkCount : null,
                    stageMeshAvgChunkBytes,
                    stageMeshThroughputMiBPerSec,
                    stageMeshAckAppendMs,
                    stageMeshCapacityMaxBytes: stageMeshCapacityMaxBytes > 0 ? stageMeshCapacityMaxBytes : null,
                    stageMeshReserveGrowthEvents,
                    transportOverheadMs: encodedArtifact.perf
                        ? Math.max(0, coreSlicingMs - (encodedArtifact.perf.totalNs / 1_000_000))
                        : null,
                    renderWallMs: encodedArtifact.perf ? (encodedArtifact.perf.renderWallNs / 1_000_000) : null,
                    renderCpuMs: encodedArtifact.perf ? (encodedArtifact.perf.renderNs / 1_000_000) : null,
                    indexBuildMs: encodedArtifact.perf ? (encodedArtifact.perf.indexBuildNs / 1_000_000) : null,
                    pngEncodeCpuMs: encodedArtifact.perf ? (encodedArtifact.perf.pngEncodeNs / 1_000_000) : null,
                    archiveEncodeMs: encodedArtifact.perf ? (encodedArtifact.perf.archiveEncodeNs / 1_000_000) : null,
                    totalMs: encodedArtifact.perf ? (encodedArtifact.perf.totalNs / 1_000_000) : null,
                    renderWallMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
                        ? (encodedArtifact.perf.renderWallNs / 1_000_000) / encodedArtifact.perf.layers
                        : null,
                    renderCpuMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
                        ? (encodedArtifact.perf.renderNs / 1_000_000) / encodedArtifact.perf.layers
                        : null,
                    pngCpuMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
                        ? (encodedArtifact.perf.pngEncodeNs / 1_000_000) / encodedArtifact.perf.layers
                        : null,
                    totalMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
                        ? (encodedArtifact.perf.totalNs / 1_000_000) / encodedArtifact.perf.layers
                        : null,
                },
            },
        };
    });
}
