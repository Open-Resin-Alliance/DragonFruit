import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Box3, Vector3 } from 'three';
import { computeApproxModelWorldBounds, computePreciseModelWorldBounds, isBoundsDisjointFromVolume } from '@/utils/modelBounds';
import { buildSolidSliceMeshForWasm } from './rasterLayerZipExport';
import { attachJobMetadataPayloads, getJobMetadataPayloadDeclarations } from './jobMetadataPayloads';
import { prepareLoadedModelsForOutput } from '@/features/mesh-modifiers/prepareModelGeometry';
import { resolveOutputFileExtension, resolveSlicingFormatDefinition } from './formats/registry';
import { getSavedSlicingPerformanceSettings } from '@/components/settings/performancePreferences';
import {
    encodeStagePathHeader,
    isNativeSlicerAvailable,
    sliceSolidAndEncodeWithNativeSlicerToTempPath,
    type AntiAliasingLevel,
    type NativeSlicerPerfMetrics,
    type NativeSlicerRuntimeMetrics,
} from './tauri/nativeSlicerBridge';
import { invoke } from '@tauri-apps/api/core';
import { assembleSliceJob, buildNativeSliceJob, resolveSliceRasterSettings } from './sliceJobAssembly';
import { resolveSliceJobAntiAliasing, type SliceJobAntiAliasingRequest } from './sliceAntiAliasing';

const DEBUG_PREFIX = '[SlicingDebug]';
const BYTES_PER_TRIANGLE_XYZ = Float32Array.BYTES_PER_ELEMENT * 9;
const STAGING_PREALLOC_MIN_BYTES = 16 * 1024 * 1024;
const STAGING_PREALLOC_MAX_BYTES = 1024 * 1024 * 1024;
const STAGING_PREALLOC_HEADROOM = 1.35;
const STAGING_CHUNK_TARGET_MIN_BYTES = 16 * 1024 * 1024;
const STAGING_CHUNK_TARGET_MAX_BYTES = 128 * 1024 * 1024;
const STAGING_CHUNK_TARGET_DIVISOR = 6;
const STAGE_MESH_SINGLE_SHOT_MAX_BYTES = 256 * 1024 * 1024;
// File-backed staging incurs an additional disk write + read pass, so keep it as a
// high-watermark fallback for very large meshes where in-memory staging becomes risky.
const STAGE_MESH_FILE_BACKED_MIN_BYTES = 2 * 1024 * 1024 * 1024;
const MESH_TRANSPORT_ENCODING = 'raw_f32' as const;
const STAGE_PROGRESS_UPDATE_MIN_INTERVAL_MS = 250;
const STAGE_PROGRESS_UPDATE_MIN_BYTES = 64 * 1024 * 1024;

type StageMeshChunkAck = {
    chunkBytes: number;
    totalBytes: number;
    capacityBytes: number;
    reserveGrew: boolean;
    chunksReceived: number;
    appendNs: number;
    appendNsTotal: number;
};

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

function resolveMeshChunkTargetBytes(initialMeshStagingBytes: number): number {
    const dynamicTarget = Math.ceil(initialMeshStagingBytes / STAGING_CHUNK_TARGET_DIVISOR);
    return Math.max(
        STAGING_CHUNK_TARGET_MIN_BYTES,
        Math.min(STAGING_CHUNK_TARGET_MAX_BYTES, dynamicTarget),
    );
}

export type SliceExportOrchestratorOptions = {
    models: LoadedModel[];
    excludedModelIds?: readonly string[];
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
    onLayerPreview?: (layerIndex: number, totalLayers: number, pngBytes: Uint8Array) => void;
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
            meshTransferMode: 'single-shot' | 'streamed' | 'file-backed';
            meshStageFilePath: string | null;
        };
        nativePerf: {
            perf: NativeSlicerPerfMetrics | null;
            runtime: NativeSlicerRuntimeMetrics | null;
            bridgePayloadBuildMs: number | null;
            bridgeInvokeRoundTripMs: number | null;
            bridgeTotalMs: number | null;
            bridgePayloadChars: number | null;
            triangleFloatCount: number | null;
            meshBytesLen: number | null;
            stageMeshMs: number | null;
            stageMeshBytes: number | null;
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

function safeFilenameBase(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return 'slice_export';
    const cleaned = trimmed.replace(/[^a-z0-9-_]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'slice_export';
}

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
    const halfWidth = Math.max(1, Number(options.printerProfile.buildVolumeMm.width) || 1) * 0.5;
    const halfDepth = Math.max(1, Number(options.printerProfile.buildVolumeMm.depth) || 1) * 0.5;
    const buildHeight = Math.max(1, Number(options.printerProfile.buildVolumeMm.height) || 1);
    const buildVolume = new Box3(new Vector3(-halfWidth, -halfDepth, 0), new Vector3(halfWidth, halfDepth, buildHeight));
    const visibleModels = options.models.filter((model) => {
        if (!model.visible || excludedModelIdSet.has(model.id)) return false;
        const approximate = computeApproxModelWorldBounds(model.geometry, model.transform);
        if (buildVolume.containsBox(approximate)) return true;
        // An enclosing box that misses the volume cannot contribute any pixels.
        // For rotated boxes that overlap, use the actual transformed vertices.
        if (isBoundsDisjointFromVolume(approximate, buildVolume, 0.01)) return false;
        return !isBoundsDisjointFromVolume(
            computePreciseModelWorldBounds(model.geometry, model.transform),
            buildVolume,
            0.01,
        );
    });
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
    // Keep outside crossings and closed surfaces intact. Plate-box quantization
    // clamps those coordinates; surface clipping removes the closing crossings.
    // The rasterizer alone crops the filled spans to the printable dimensions.
    const meshTransportBytesEstimate = initialMeshStagingBytes;
    const meshTransportEncoding = MESH_TRANSPORT_ENCODING;
    const meshTransportQuantization = null;
    const meshChunkTargetBytes = resolveMeshChunkTargetBytes(meshTransportBytesEstimate);
    const meshTransferMode: 'single-shot' | 'streamed' | 'file-backed' = meshTransportBytesEstimate >= STAGE_MESH_FILE_BACKED_MIN_BYTES
        ? 'file-backed'
        : meshTransportBytesEstimate <= STAGE_MESH_SINGLE_SHOT_MAX_BYTES
            ? 'single-shot'
            : 'streamed';
    let meshStageFilePath: string | null = null;

    let cumulativeBytesStage = 0;
    let stageMeshIpcMs = 0;
    let stageMeshChunkCount = 0;
    let stageMeshAckAppendNsTotal = 0;
    let stageMeshCapacityMaxBytes = 0;
    let stageMeshReserveGrowthEvents = 0;
    let lastStageProgressUpdateMs = 0;
    let lastStageProgressUpdateBytes = 0;

    const maybeEmitStageProgress = () => {
        const nowMs = performance.now();
        const shouldEmitProgress = stageMeshChunkCount === 1
            || (nowMs - lastStageProgressUpdateMs) >= STAGE_PROGRESS_UPDATE_MIN_INTERVAL_MS
            || (cumulativeBytesStage - lastStageProgressUpdateBytes) >= STAGE_PROGRESS_UPDATE_MIN_BYTES;
        if (!shouldEmitProgress) return;

        const mb = Math.round(cumulativeBytesStage / (1024 * 1024));
        options.onProgress?.(0, 1, `Transferring Mesh (${mb} MB)`);
        lastStageProgressUpdateMs = nowMs;
        lastStageProgressUpdateBytes = cumulativeBytesStage;
    };

    const handleMeshChunk = async (chunk: Uint8Array) => {
        throwIfAborted(options.abortSignal);

        cumulativeBytesStage += chunk.byteLength;
        stageMeshChunkCount += 1;
        maybeEmitStageProgress();

        const chunkInvokeStart = performance.now();
        const chunkAck = await invoke<StageMeshChunkAck>('stage_mesh_binary_chunk', chunk, {
            headers: { 'Content-Type': 'application/octet-stream' },
        });

        stageMeshAckAppendNsTotal = Math.max(stageMeshAckAppendNsTotal, chunkAck.appendNsTotal ?? 0);
        stageMeshCapacityMaxBytes = Math.max(stageMeshCapacityMaxBytes, chunkAck.capacityBytes ?? 0);
        if (chunkAck.reserveGrew) {
            stageMeshReserveGrowthEvents += 1;
        }

        stageMeshIpcMs += performance.now() - chunkInvokeStart;
    };

    /** Byte offset of the next chunk in the file-backed stage sequence. */
    let meshStageFileOffset = 0;

    const handleMeshFileChunk = async (chunk: Uint8Array) => {
        throwIfAborted(options.abortSignal);
        if (!meshStageFilePath) {
            throw new Error('Mesh stage file path was not allocated before chunk append.');
        }

        cumulativeBytesStage += chunk.byteLength;
        stageMeshChunkCount += 1;
        maybeEmitStageProgress();

        const chunkOffset = meshStageFileOffset;
        meshStageFileOffset += chunk.byteLength;

        const appendStart = performance.now();
        const appendedLen = await invoke<number>('append_mesh_stage_chunk', chunk, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'x-mesh-stage-path': encodeStagePathHeader(meshStageFilePath),
                'x-mesh-stage-offset': String(chunkOffset),
            },
        });
        stageMeshIpcMs += performance.now() - appendStart;

        if (appendedLen > 0) {
            cumulativeBytesStage = appendedLen;
        }
    };

    const modifierBakeStartMs = performance.now();
    options.onProgress?.(0, 1, 'Baking Modifiers');
    const preparedModelsForOutput = await prepareLoadedModelsForOutput(visibleModels);
    const modifierBakeMs = performance.now() - modifierBakeStartMs;

    const survivingCombinedModels = preparedModelsForOutput.models.filter((model) => {
        const modelTriangleCount = model.geometry.meshDefects?.nativeRepairReport?.model_triangle_count;
        if (!modelTriangleCount || modelTriangleCount <= 0) return false;
        const position = model.geometry.geometry.getAttribute('position');
        const totalTriangleCount = Math.floor(
            (model.geometry.geometry.getIndex()?.count ?? position?.count ?? 0) / 3,
        );
        return modelTriangleCount < totalTriangleCount;
    });
    if (survivingCombinedModels.length > 0) {
        preparedModelsForOutput.dispose();
        throw new Error(
            `Classified support geometry was not separated before slicing: ${survivingCombinedModels
                .map((model) => model.name)
                .join(', ')}`,
        );
    }

    logDebug('Prepared models for slice/export handoff', {
        visibleModelCount: visibleModels.length,
        preparedModelCount: preparedModelsForOutput.models.length,
        modifiedModelCount: preparedModelsForOutput.modifiedModelCount,
        modifierBakeMs,
    });
    // Support tips shrink while the mesh is prepared, before the job is
    // assembled, so the anti-aliasing is resolved here first; assembleSliceJob
    // resolves the same request again below.
    const { supportTipShrinkPercent } = resolveSliceJobAntiAliasing({
        printerProfile: options.printerProfile,
        materialProfile: options.materialProfile,
        layerHeightMm: resolveSliceRasterSettings({
            printerProfile: options.printerProfile,
            materialProfile: options.materialProfile,
        }).layerHeightMm,
        request: options.antiAliasing,
    });
    const meshPrepStartMs = performance.now();
    let solidMesh: Awaited<ReturnType<typeof buildSolidSliceMeshForWasm>>;
    try {
        if (meshTransferMode === 'streamed') {
            // Modifier baking leaves raw f32 output in the shared native stage.
            // Reset it before appending the prepared scene, never before baking.
            await invoke('stage_mesh_binary_start', { totalBytes: meshTransportBytesEstimate });
        } else if (meshTransferMode === 'file-backed') {
            meshStageFilePath = await invoke<string>('allocate_mesh_stage_path');
        }

        logDebug('Initialized mesh staging buffer', {
            initialMeshStagingBytes,
            initialMeshStagingMiB: Number((initialMeshStagingBytes / (1024 * 1024)).toFixed(2)),
            meshChunkTargetBytes,
            meshChunkTargetMiB: Number((meshChunkTargetBytes / (1024 * 1024)).toFixed(2)),
            meshTransportBytesEstimate,
            meshTransportEncoding,
            meshTransferMode,
        });

        solidMesh = await buildSolidSliceMeshForWasm({
            models: preparedModelsForOutput.models,
            printerProfile: options.printerProfile,
            materialProfile: options.materialProfile,
            filenameBase: options.filenameBase,
            supportTipShrinkPercent,
            flushBinaryMeshChunk: meshTransferMode === 'streamed'
                ? handleMeshChunk
                : meshTransferMode === 'file-backed'
                    ? handleMeshFileChunk
                    : undefined,
            meshChunkTargetBytes,
        });
    } finally {
        preparedModelsForOutput.dispose();
    }
    const meshPrepMs = performance.now() - meshPrepStartMs;

    if (meshTransferMode === 'single-shot') {
        const meshBytes = new Uint8Array(
            solidMesh.trianglesXYZ.buffer,
            solidMesh.trianglesXYZ.byteOffset,
            solidMesh.trianglesXYZ.byteLength,
        );
        const mb = Math.round(meshBytes.byteLength / (1024 * 1024));
        options.onProgress?.(0, 1, `Transferring Mesh (${mb} MB)`);

        const chunkInvokeStart = performance.now();
        const chunkAck = await invoke<StageMeshChunkAck>('stage_mesh_binary_set', meshBytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
        });

        stageMeshIpcMs += performance.now() - chunkInvokeStart;
        cumulativeBytesStage = chunkAck.totalBytes > 0 ? chunkAck.totalBytes : meshBytes.byteLength;
        stageMeshChunkCount = chunkAck.chunksReceived > 0 ? chunkAck.chunksReceived : 1;
        stageMeshAckAppendNsTotal = Math.max(stageMeshAckAppendNsTotal, chunkAck.appendNsTotal ?? 0);
        stageMeshCapacityMaxBytes = Math.max(stageMeshCapacityMaxBytes, chunkAck.capacityBytes ?? 0);
        if (chunkAck.reserveGrew) {
            stageMeshReserveGrowthEvents += 1;
        }
    } else if (meshTransferMode === 'file-backed') {
        if (!meshStageFilePath) {
            throw new Error('Mesh stage file path missing for file-backed transfer mode.');
        }

        const registerStart = performance.now();
        const registeredLen = await invoke<number>('stage_mesh_file_path', {
            meshFilePath: meshStageFilePath,
        });
        stageMeshIpcMs += performance.now() - registerStart;

        if (registeredLen > 0) {
            cumulativeBytesStage = registeredLen;
        }
    }

    logDebug('Solid mesh prepared for native backend', {
        source: `${solidMesh.sourceWidthPx}x${solidMesh.sourceHeightPx}`,
        output: `${solidMesh.widthPx}x${solidMesh.heightPx}`,
        packingMode: solidMesh.xPackingMode,
        totalLayers: solidMesh.totalLayers,
        meshPrepMs,
        stagedMeshBytes: cumulativeBytesStage,
        stagedMeshChunkCount: stageMeshChunkCount,
        stageMeshIpcMs,
        meshTransportEncoding,
        meshTransferMode,
        meshStageFilePath,
        modifiedModelCount: preparedModelsForOutput.modifiedModelCount,
    });
    emitDiagnosticProgress('Preparing mesh complete', 1, 1, {
        meshPrepMs,
        triangleFloatCount: solidMesh.trianglesXYZ.length,
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
    );
    const coreSlicingMs = performance.now() - coreStartMs;
    logDebug('Native slicing completed', { coreSlicingMs });

    throwIfAborted(options.abortSignal);
    options.onProgress?.(Math.max(progressDone, progressTotal), progressTotal, 'Finalizing');

    const printerExt = resolveOutputFileExtension(
        options.printerProfile.display.outputFormat,
        options.printerProfile.display.formatVersion,
    ) || format.outputFormat.replace(/^\./, '') || 'slice';
    const outputName = `${safeFilenameBase(options.filenameBase)}.${printerExt}`;

    const totalElapsedMs = performance.now() - orchestratorStartMs;
    options.onProgress?.(progressTotal, progressTotal, 'Handoff');
    const layersPerSecond = totalElapsedMs > 0
        ? (solidMesh.totalLayers * 1000) / totalElapsedMs
        : null;
    const stageMeshAvgChunkBytes = stageMeshChunkCount > 0
        ? (cumulativeBytesStage / stageMeshChunkCount)
        : null;
    const stageMeshThroughputMiBPerSec = stageMeshIpcMs > 0
        ? ((cumulativeBytesStage / (1024 * 1024)) / (stageMeshIpcMs / 1000))
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
                triangleFloatCount: nativeJob.trianglesXYZ.length,
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
                meshStageFilePath,
            },
            nativePerf: {
                perf: encodedArtifact.perf,
                runtime: encodedArtifact.runtime,
                bridgePayloadBuildMs: encodedArtifact.bridge?.payloadBuildMs ?? null,
                bridgeInvokeRoundTripMs: encodedArtifact.bridge?.invokeRoundTripMs ?? null,
                bridgeTotalMs: encodedArtifact.bridge?.bridgeTotalMs ?? null,
                bridgePayloadChars: encodedArtifact.bridge?.payloadChars ?? null,
                triangleFloatCount: encodedArtifact.bridge?.triangleFloatCount ?? null,
                meshBytesLen: encodedArtifact.bridge?.meshBytesLen ?? null,
                stageMeshMs: stageMeshIpcMs > 0
                    ? stageMeshIpcMs
                    : (encodedArtifact.bridge?.stageMeshMs ?? null),
                stageMeshBytes: cumulativeBytesStage > 0 ? cumulativeBytesStage : null,
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
}
