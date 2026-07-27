import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm, composeModelMatrix, type FullResSplicedModel } from './rasterLayerZipExport';
import { clampSliceJobNumber } from './sliceJobLimits';
import { prepareLoadedModelsForOutput, resolveOutputGeometrySource, resolveOutputSectionPlan } from '@/features/mesh-modifiers/prepareModelGeometry';
import { describeImportRunMapRecompute, planImportSectionSplice, type ImportRunMapRecomputeReason, type ImportSectionSplicePlan } from '@/utils/importRunMap';
import { resolveOutputFileExtension, resolveOutputFormatVersion, resolveOutputSettingsMode, resolveSlicingFormatDefinition } from './formats/registry';
import { getSavedSlicingPerformanceSettings, type PngCompressionStrategy } from '@/components/settings/performancePreferences';
import {
    isNativeSlicerAvailable,
    sliceSolidAndEncodeWithNativeSlicerToTempPath,
    type AntiAliasingLevel,
    type NativeSlicerPerfMetrics,
    type NativeSlicerRuntimeMetrics,
} from './tauri/nativeSlicerBridge';
import { invoke } from '@tauri-apps/api/core';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';

function resolvePngCompressionStrategy(
    mode: PngCompressionStrategy,
    antiAliasingLevel: AntiAliasingLevel,
    outputUsesPngLayers: boolean,
): 'fastest' | 'balanced' | 'smallest' | 'optimal' {
    if (!outputUsesPngLayers) {
        return 'fastest';
    }

    if (mode !== 'auto') {
        return mode;
    }

    if (antiAliasingLevel === 'Off') {
        return 'fastest';
    }

    // Any level of AA (2x, 4x, 8x, 16x) benefits from balanced compression 
    // to avoid ballooning file sizes from the gray anti-aliased pixels.
    return 'balanced';
}

function resolveContainerCompressionLevel(strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal'): number {
    switch (strategy) {
        case 'fastest': return 1;
        case 'balanced': return 3;
        case 'smallest': return 6;
        case 'optimal': return 9;
        default: return 2;
    }
}

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
const MESH_TRANSPORT_ENCODING = 'quantized_u16' as const;
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

/** Response of the Rust `stage_fullres_mesh_from_source` command. */
type FullResSpliceSummary = {
    /** Triangles this pass appended. */
    stagedTriangleCount: number;
    /** Triangles in the source file — `staged + skipped` must equal it (Ph3). */
    sourceTriangleCount: number;
    skippedTriangleCount: number;
    /** `all` | `model` | `support`. */
    section: string;
    /** `not-required` | `provided` | `recomputed` | `no-split`. */
    runMapSource: string;
    /** Bounds of the STAGED triangles; `[0,0,0]` twice when nothing was staged. */
    worldMin: [number, number, number];
    worldMax: [number, number, number];
    spliceMs: number;
};

/** Bytes per staged quantized-u16 triangle (9 components × 2 bytes). */
const QUANTIZED_U16_BYTES_PER_TRIANGLE = 18;

function describeFullResSpliceError(raw: string): string {
    if (raw.includes('FULLRES_SOURCE_MISSING')) return 'the original file is missing or unreadable';
    if (raw.includes('FULLRES_SOURCE_STALE')) return 'the original file changed since import';
    return raw;
}

/**
 * Surfaces a degrade-to-preview event to the editor shell's toast subsystem
 * (listener in page.tsx routes it to the operation-error toast). Never
 * silent: silently slicing the preview is the exact defect Phase 1 fixes.
 */
function emitFullResDegradeWarning(modelName: string, reason: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('dragonfruit:fullres-degraded', {
        detail: {
            message: `"${modelName}": ${reason} — sliced the reduced preview instead.`,
        },
    }));
}

function logDebug(...args: unknown[]): void {
    if (typeof console === 'undefined' || typeof console.debug !== 'function') return;
    console.debug(DEBUG_PREFIX, ...args);
}

function estimateInitialMeshStagingBytes(
    models: LoadedModel[],
    fullResCandidateIds: Set<string>,
): number {
    const visibleModelTriangles = models.reduce((sum, model) => {
        if (!model.visible) return sum;
        // Full-res splice candidates (P1) are staged Rust-side straight from the
        // ORIGINAL file — their bytes never enter the WebView — so the reserve
        // must reflect the full-resolution `polygonCount`, unchanged.
        if (fullResCandidateIds.has(model.id)) {
            const originalCount = Number.isFinite(model.polygonCount)
                ? Math.max(0, Math.floor(model.polygonCount))
                : 0;
            return sum + originalCount;
        }
        // STL-import P6 hygiene (audit §2d): the reduced preview geometry is what
        // actually streams through the WebView on the preview-staging path, so
        // estimate from its ACTUAL staged position count — not the source
        // `polygonCount`, which over-promises `stage_mesh_binary_start` totalBytes
        // for decimated previews. For a full-resolution (non-preview) model the
        // two are equal, so this is a no-op there.
        const position = model.geometry.geometry.getAttribute('position');
        const stagedTriangles = Math.floor(
            (model.geometry.geometry.getIndex()?.count ?? position?.count ?? 0) / 3,
        );
        return sum + stagedTriangles;
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

function resolveMeshTransportQuantizationBounds(printerProfile: PrinterProfile) {
    const widthMm = Math.max(1, Number(printerProfile.buildVolumeMm.width) || 1);
    const depthMm = Math.max(1, Number(printerProfile.buildVolumeMm.depth) || 1);
    const heightMm = Math.max(1, Number(printerProfile.buildVolumeMm.height) || 1);

    return {
        minX: -widthMm * 0.5,
        minY: -depthMm * 0.5,
        minZ: 0,
        maxX: widthMm * 0.5,
        maxY: depthMm * 0.5,
        maxZ: heightMm,
    };
}

function quantizeMeshChunkToUint16(chunk: Uint8Array, bounds: ReturnType<typeof resolveMeshTransportQuantizationBounds>): Uint8Array {
    if (chunk.byteLength === 0) return chunk;
    if (chunk.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error(`Mesh chunk byte length ${chunk.byteLength} is not aligned to f32 boundaries.`);
    }

    const floats = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / Float32Array.BYTES_PER_ELEMENT);
    const quantized = new Uint16Array(floats.length);

    const spans = [
        Math.max(0, bounds.maxX - bounds.minX),
        Math.max(0, bounds.maxY - bounds.minY),
        Math.max(0, bounds.maxZ - bounds.minZ),
    ];
    const mins = [bounds.minX, bounds.minY, bounds.minZ];
    const maxValue = 65535;

    for (let i = 0; i < floats.length; i += 1) {
        const axis = i % 3;
        const span = spans[axis];
        if (!Number.isFinite(span) || span <= 0) {
            quantized[i] = 0;
            continue;
        }

        const value = floats[i];
        const normalized = (value - mins[axis]) / span;
        const clamped = Math.max(0, Math.min(1, normalized));
        quantized[i] = Math.round(clamped * maxValue);
    }

    return new Uint8Array(quantized.buffer);
}

export type SliceExportOrchestratorOptions = {
    models: LoadedModel[];
    printerProfile: PrinterProfile;
    materialProfile: MaterialProfile;
    filenameBase: string;
    outputPath?: string | null;
    antiAliasingLevel?: AntiAliasingLevel;
    antiAliasingMode?: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
    blurBrushRadiusPx?: number;
    blurBrushKernel?: 'box' | 'gaussian';
    blurBrushSigma?: number;
    blurBrushSigmaX?: number;
    blurBrushSigmaY?: number;
    zBlurRadiusLayers?: number;
    zBlurKernel?: 'box' | 'gaussian';
    zBlurSigma?: number;
    zBlendLookBack?: number;
    zBlendMinimumAlphaPercent?: number;
    zBlendMaxAlphaPercent?: number;
    zBlendCustomLut?: number[];
    zaaKernel?: 'perturb';
    zaaPattern?: 'uniform' | 'halton' | 'base2';
    zaaDuplicateZ?: boolean;
    minimumAaAlphaPercentOverride?: number;
    aaOnSupports?: boolean;
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
            };
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

function setMetadataPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
    const segments = path
        .split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

    if (segments.length === 0) return;

    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        const existing = cursor[segment];
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
            cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
    }

    cursor[segments[segments.length - 1]] = value;
}

function coerceLocalMaterialSettingValue(
    rawValue: string | number | boolean,
    kind: 'number' | 'integer' | 'text' | 'boolean' | 'select',
): string | number | boolean {
    if (kind === 'boolean') {
        if (typeof rawValue === 'boolean') return rawValue;
        if (typeof rawValue === 'string') {
            const normalized = rawValue.trim().toLowerCase();
            if (normalized === 'true') return true;
            if (normalized === 'false') return false;
        }
        return Boolean(rawValue);
    }

    if (kind === 'number' || kind === 'integer') {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) return kind === 'integer' ? 0 : 0;
        return kind === 'integer' ? Math.round(parsed) : parsed;
    }

    return String(rawValue);
}

function mergeMetadataOverridesIntoMetadata(
    metadataJson: string,
    outputFormat: string,
    materialProfile: MaterialProfile,
    settingsMode?: string,
    printerOutputFormat?: string,
): string {
    try {
        const parsed = JSON.parse(metadataJson) as Record<string, unknown>;

        if (settingsMode) {
            const printer = (parsed.printer ?? {}) as Record<string, unknown>;
            parsed.printer = {
                ...printer,
                settingsMode,
            };

            const exportNode = (parsed.export ?? {}) as Record<string, unknown>;
            const formatKey = outputFormat.replace(/^\./, '').toLowerCase();
            const formatNode = (exportNode[formatKey] ?? {}) as Record<string, unknown>;
            exportNode[formatKey] = {
                ...formatNode,
                settingsMode,
            };
            parsed.export = exportNode;
        }

        const adapter = getProfileLocalMaterialSettingsAdapter(printerOutputFormat ?? outputFormat, settingsMode)
            ?? getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
        const fieldSchema = adapter?.fields ?? [];
        if (fieldSchema.length > 0) {
            const localForOutput = materialProfile.localSettingsByOutput?.[printerOutputFormat ?? outputFormat]
                ?? materialProfile.localSettingsByOutput?.[outputFormat]
                ?? {};

            fieldSchema.forEach((field) => {
                if (field.kind === 'spacer') return;

                const fieldValue = Object.prototype.hasOwnProperty.call(localForOutput, field.key)
                    ? localForOutput[field.key]
                    : field.defaultValue;

                const coercedValue = coerceLocalMaterialSettingValue(
                    fieldValue,
                    field.kind,
                );

                const targetPath = (field.metadataPath?.trim() || `material.${field.key}`);
                setMetadataPathValue(parsed, targetPath, coercedValue);
            });
        }

        return JSON.stringify(parsed);
    } catch {
        return metadataJson;
    }
}

function resolveEffectiveDitherPolicy(options: SliceExportOrchestratorOptions): {
    ditherEnabled: boolean;
    ditherBitDepth: number;
    ditherDeviceGamma: number;
} {
    const materialDitherEnabled = options.materialProfile.antiAliasingSettings?.ditherEnabled ?? false;
    const materialDitherBitDepth = options.materialProfile.antiAliasingSettings?.ditherBitDepth ?? 3;
    const materialDitherGamma = options.materialProfile.antiAliasingSettings?.ditherDeviceGamma ?? 3.0;

    const configuredDitherEnabled = options.ditherEnabled ?? materialDitherEnabled;
    const configuredDitherBitDepth = options.ditherBitDepth ?? materialDitherBitDepth;
    const configuredDitherGamma = options.ditherDeviceGamma ?? materialDitherGamma;

    const printerBitDepthRaw = Number(options.printerProfile.bitDepth?.bits);
    const printerBitDepth = Number.isFinite(printerBitDepthRaw)
        ? Math.round(printerBitDepthRaw)
        : null;

    const hasKnownNon8BitDisplay = printerBitDepth != null && printerBitDepth > 0 && printerBitDepth !== 8;
    const derivedBitDepth = (printerBitDepth != null && printerBitDepth > 0)
        ? Math.max(2, Math.min(7, printerBitDepth))
        : Math.max(2, Math.min(7, Math.round(configuredDitherBitDepth)));

    return {
        ditherEnabled: hasKnownNon8BitDisplay ? true : configuredDitherEnabled,
        ditherBitDepth: derivedBitDepth,
        ditherDeviceGamma: Math.max(0.5, Math.min(4.0, Number(configuredDitherGamma))),
    };
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

    const format = resolveSlicingFormatDefinition({
        printerProfile: options.printerProfile,
        materialProfile: options.materialProfile,
    });

    logDebug('Export orchestrator start', {
        format: format.outputFormat,
        displayName: format.displayName,
        printer: options.printerProfile.name,
        material: options.materialProfile.name,
        modelCount: options.models.length,
    });

    throwIfAborted(options.abortSignal);
    const nativeAvailable = await isNativeSlicerAvailable();
    if (!nativeAvailable) {
        throw new Error('Native slicer requires DragonFruit Desktop (Tauri). JS/WebGPU slicing has been removed.');
    }

    options.onProgress?.(0, 1, 'Preparing');
    emitDiagnosticProgress('Preparing mesh', 0, 1, {
        format: format.outputFormat,
        modelCount: options.models.length,
    });

    const visibleModels = options.models.filter((model) => model.visible);

    // Phase-1 full-res routing: native-preview models with a retained source
    // path are staged Rust-side from the ORIGINAL file (bytes never enter
    // the WebView). The splice appends into the in-memory staged buffer, so
    // any candidate forces streamed staging (`stage_mesh_binary_start` +
    // chunk appends) even when the size estimate would have picked
    // single-shot or file-backed. No candidates ⇒ the decision below is
    // byte-identical to before.
    const fullResCandidateIds = new Set(
        visibleModels
            .filter((model) => resolveOutputGeometrySource(model).kind === 'fullres-source-file')
            .map((model) => model.id),
    );

    const initialMeshStagingBytes = estimateInitialMeshStagingBytes(options.models, fullResCandidateIds);
    const meshTransportBytesEstimate = Math.ceil(initialMeshStagingBytes / 2);
    const meshTransportEncoding: 'raw_f32' | 'quantized_u16' = MESH_TRANSPORT_ENCODING;
    const meshTransportQuantization = resolveMeshTransportQuantizationBounds(options.printerProfile);
    const meshChunkTargetBytes = resolveMeshChunkTargetBytes(meshTransportBytesEstimate);
    const meshTransferMode: 'single-shot' | 'streamed' | 'file-backed' = fullResCandidateIds.size > 0
        ? 'streamed'
        : meshTransportBytesEstimate >= STAGE_MESH_FILE_BACKED_MIN_BYTES
            ? 'file-backed'
            : meshTransportBytesEstimate <= STAGE_MESH_SINGLE_SHOT_MAX_BYTES
                ? 'single-shot'
                : 'streamed';
    let meshStageFilePath: string | null = null;
    /** Byte offset of the next chunk in the file-backed stage sequence. */
    let meshStageFileOffset = 0;

    if (fullResCandidateIds.size > 0) {
        logDebug('Full-res splice candidates force streamed staging', {
            fullResCandidateCount: fullResCandidateIds.size,
        });
    }

    if (meshTransferMode === 'streamed') {
        // Tell Rust to reserve a realistic staging buffer before chunks arrive.
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
        const transportChunk = meshTransportEncoding === 'quantized_u16'
            ? quantizeMeshChunkToUint16(chunk, meshTransportQuantization)
            : chunk;

        cumulativeBytesStage += transportChunk.byteLength;
        stageMeshChunkCount += 1;
        maybeEmitStageProgress();

        const chunkInvokeStart = performance.now();
        const chunkAck = await invoke<StageMeshChunkAck>('stage_mesh_binary_chunk', transportChunk, {
            headers: { 'Content-Type': 'application/octet-stream' },
        });

        stageMeshAckAppendNsTotal = Math.max(stageMeshAckAppendNsTotal, chunkAck.appendNsTotal ?? 0);
        stageMeshCapacityMaxBytes = Math.max(stageMeshCapacityMaxBytes, chunkAck.capacityBytes ?? 0);
        if (chunkAck.reserveGrew) {
            stageMeshReserveGrowthEvents += 1;
        }

        stageMeshIpcMs += performance.now() - chunkInvokeStart;
    };

    const handleMeshFileChunk = async (chunk: Uint8Array) => {
        throwIfAborted(options.abortSignal);
        if (!meshStageFilePath) {
            throw new Error('Mesh stage file path was not allocated before chunk append.');
        }

        const transportChunk = meshTransportEncoding === 'quantized_u16'
            ? quantizeMeshChunkToUint16(chunk, meshTransportQuantization)
            : chunk;

        cumulativeBytesStage += transportChunk.byteLength;
        stageMeshChunkCount += 1;
        maybeEmitStageProgress();

        const appendStart = performance.now();
        // The offset header is what makes this a well-formed chunk sequence:
        // chunk 0 truncates, later chunks append, and Rust's contention backstop
        // (`stage_append_chunk`) can tell "starting a new stage file" from
        // "resuming mid-sequence after another writer stole the appender".
        // Without it every chunk looked mid-sequence and the first one relied on
        // the appender happening to be closed — which it is not after an aborted
        // stage write, and which would append to stale bytes rather than
        // truncating.
        const chunkOffset = meshStageFileOffset;
        meshStageFileOffset += transportChunk.byteLength;
        const appendedLen = await invoke<number>('append_mesh_stage_chunk', transportChunk, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'x-mesh-stage-path': meshStageFilePath,
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

    // Ph3: ONE definition of "these sections still need separating", shared with
    // `prepareLoadedModelsForOutput`, which is what splits them. This used to
    // re-implement the same arithmetic beside it — including Ph2 finding F3's
    // accidental resolution guard — so the two could drift and the assertion
    // could fire (or fail to) for reasons neither site stated.
    const survivingCombinedModels = preparedModelsForOutput.models.filter(
        (model) => resolveOutputSectionPlan(model).kind === 'scene-split',
    );
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

    // ════ Ph3 — THE FOUR-PASS STAGING INTERLEAVE ════════════════════════════
    //
    // The slicing engine takes ONE split index, so the staged buffer must be
    // `[every model triangle | every support triangle]` across the whole scene.
    // A spliced model therefore contributes to it TWICE:
    //
    //   ① this loop            — splice each candidate's MODEL runs
    //   ② collector            — every collector model's model triangles
    //   ③ spliceSupportSections — splice each candidate's SUPPORT complement
    //   ④ collector            — support sections, then generated supports/rafts
    //
    // Passes ②–④ happen inside `buildSolidSliceMeshForWasm`, which calls ③ back
    // through `onModelSectionStaged` after flushing ②. Doing ① and ③ together
    // here instead would produce `[model | support | model | support]`, which no
    // single split index can describe — and reading that layout with one index
    // slices supports as model, silently, at full confidence.
    //
    // A model whose partition is unknown (`plan.kind === 'whole'`) is spliced
    // exactly as it was before Ph3: one whole-file pass in ①, nothing in ③.
    // Failure is never silent: the model degrades to the preview path with a
    // user-visible warning.
    const fullResSplices = new Map<string, FullResSplicedModel>();
    /**
     * Ph3d — model-half passes whose partition must be verified once staging
     * has committed them. Deferred out of the pass-① try so a failure aborts
     * instead of degrading into a double-stage; see the push site.
     */
    const modelSectionPartitionChecks: Array<{ name: string; summary: FullResSpliceSummary }> = [];
    /** Candidates whose support complement pass ③ must still stage. */
    const supportSectionPasses: Array<{
        model: LoadedModel;
        source: Extract<ReturnType<typeof resolveOutputGeometrySource>, { kind: 'fullres-source-file' }>;
        plan: Extract<ImportSectionSplicePlan, { kind: 'sections' }>;
    }> = [];

    const stageFullResSection = async (
        model: LoadedModel,
        source: Extract<ReturnType<typeof resolveOutputGeometrySource>, { kind: 'fullres-source-file' }>,
        section: 'all' | 'model' | 'support',
        plan: ImportSectionSplicePlan,
    ) => {
        const matrix = composeModelMatrix(model.transform);
        return invoke<FullResSpliceSummary>('stage_fullres_mesh_from_source', {
            sourcePath: source.sourcePath,
            matrix16: Array.from(matrix.elements),
            cPre: source.cPre,
            expectedSizeBytes: source.fingerprint?.sizeBytes ?? null,
            expectedMtimeMs: source.fingerprint?.mtimeMs ?? null,
            quantization: meshTransportQuantization,
            section,
            // A sectioned pass with no runs tells Rust to re-derive the map from
            // the source file. The recomputed map deliberately never comes back
            // here: the 64 KiB cap exists because such a map can be unbounded,
            // and handing the WebView the thing the cap refused would defeat it.
            modelRuns: plan.kind === 'sections' && plan.runs ? Array.from(plan.runs) : null,
            runMapRecomputeReason: plan.kind === 'sections' ? plan.recomputeReason : null,
        });
    };

    if (fullResCandidateIds.size > 0) {
        for (const model of preparedModelsForOutput.models) {
            if (!fullResCandidateIds.has(model.id)) continue;
            const source = resolveOutputGeometrySource(model);
            if (source.kind !== 'fullres-source-file') {
                // D1 rider. This model resolved to the full-res source when the
                // candidate set was computed (pre-bake) and no longer does, so
                // something between the two calls dropped its `nativePreview` —
                // historically the classified-support split, whose halves are
                // rebuilt from a bare Float32Array. This was the ONLY degrade in
                // this loop that took a bare `continue`: the model quietly fell
                // back to preview-fidelity slicing with no log line and no toast,
                // and the user's only clue was the printed part. Every other arm
                // here warns; now so does this one.
                console.warn(
                    `[SlicingFullRes] "${model.name}" lost its full-resolution marker during `
                    + 'modifier baking — slicing the reduced preview instead.',
                );
                emitFullResDegradeWarning(
                    model.name,
                    'its full-resolution marker was lost while preparing the scene',
                );
                continue;
            }

            if (!source.cPre) {
                console.warn(
                    `[SlicingFullRes] "${model.name}" has no stored import frame datum (cPre) — `
                    + 'slicing the reduced preview instead.',
                );
                emitFullResDegradeWarning(model.name, 'its import frame datum was not stored');
                continue;
            }

            throwIfAborted(options.abortSignal);
            options.onProgress?.(0, 1, 'Staging Full-Resolution Mesh');

            // ══ Ph3d — WHICH PASSES DOES THIS MODEL JOIN? ══════════════════
            //
            // Ph3 assumed one shape: a whole file that may need splitting into
            // two passes. Ph3d adds a second: a model that IS one section of a
            // file (a Split-to-Bodies half), which joins exactly ONE pass.
            //
            // The half's own classification cannot answer this — it reports no
            // split, which `planImportSectionSplice` would read as "splice the
            // whole file" and stage the OTHER half along with it. The answer
            // comes from the chokepoint's `section`, which carries the parent's
            // run map precisely because that map is what defines both sections.
            const sourceSection = source.section;
            const plan: ImportSectionSplicePlan = sourceSection.kind === 'whole'
                ? planImportSectionSplice({
                    runtime: model.geometry.importRunMap ?? null,
                    summary: model.geometry.nativePreview?.runMap ?? null,
                    persistedRuns: model.geometry.importRunMap?.runs ?? null,
                    storedRecompute: model.geometry.importRunMapRecompute ?? null,
                    // FRAME NOTE (audit §3.1 site 10, step R7). Frame (B) — a
                    // count measured on the SCENE buffer — standing in for the
                    // frame-(A) question "does the SOURCE FILE have a split?".
                    // Boolean use only, and only as `planImportSectionSplice`'s
                    // last resort, once every run map and summary has been found
                    // missing. If the two frames disagree the file is spliced
                    // whole instead of by section (or the reverse), which is a
                    // degrade to the pre-Ph3 path, not a wrong cut.
                    reportSplitExists:
                        (model.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0) > 0,
                })
                : {
                    kind: 'sections' as const,
                    runs: sourceSection.runs,
                    recomputeReason: sourceSection.recomputeReason as ImportRunMapRecomputeReason | null,
                };
            if (plan.kind === 'sections' && plan.recomputeReason) {
                console.warn(
                    `[SlicingFullRes] "${model.name}": recomputing the import run map from the `
                    + `source file because ${describeImportRunMapRecompute(plan.recomputeReason)}. `
                    + 'This re-runs the import classification and costs seconds on a large model.',
                );
            }

            // A SUPPORT half contributes nothing to pass ① — every one of its
            // triangles belongs on the far side of the split index. It is still
            // registered now, with a zero model count, because the collector
            // decides what to stream from this map BEFORE pass ③ runs and must
            // skip this model's preview geometry. The sentinel bounds are
            // unioned in by pass ③; the bounds merge already skips an entry that
            // staged nothing at all.
            if (sourceSection.kind === 'support') {
                if (plan.kind !== 'sections') {
                    // Unreachable: a sectioned source takes the `sections` arm
                    // above unconditionally. Stated as a check rather than a
                    // cast, because the alternative to a loud failure here is
                    // splicing a support half as a whole file.
                    throw new Error(
                        `"${model.name}" is a support section but resolved to a whole-file splice `
                        + 'plan — the slice was stopped rather than staging the entire source.',
                    );
                }
                fullResSplices.set(model.id, {
                    modelTriangleCount: 0,
                    supportTriangleCount: 0,
                    worldMin: [Infinity, Infinity, Infinity],
                    worldMax: [-Infinity, -Infinity, -Infinity],
                });
                supportSectionPasses.push({ model, source, plan });
                continue;
            }

            const spliceInvokeStart = performance.now();
            try {
                const summary = await stageFullResSection(
                    model,
                    source,
                    plan.kind === 'sections' ? 'model' : 'all',
                    plan,
                );
                stageMeshIpcMs += performance.now() - spliceInvokeStart;
                fullResSplices.set(model.id, {
                    modelTriangleCount: summary.stagedTriangleCount,
                    supportTriangleCount: 0,
                    worldMin: summary.worldMin,
                    worldMax: summary.worldMax,
                });
                if (sourceSection.kind === 'whole' && plan.kind === 'sections') {
                    supportSectionPasses.push({ model, source, plan });
                }
                // Ph3d — a MODEL half's partition check is DEFERRED to just
                // after this loop. It cannot live in this try: by now the half's
                // triangles are in the staged buffer, so failing into the
                // degrade-to-preview catch below would stage them a SECOND time
                // from the collector. Same asymmetry Ph3 documented for pass ③ —
                // before anything is staged a failure may degrade; after it, it
                // must abort.
                if (sourceSection.kind === 'model') {
                    modelSectionPartitionChecks.push({ name: model.name, summary });
                }
                cumulativeBytesStage += summary.stagedTriangleCount * QUANTIZED_U16_BYTES_PER_TRIANGLE;
                console.warn(
                    `[SlicingFullRes] staged the full-res ${summary.section} section for `
                    + `"${model.name}": ${summary.stagedTriangleCount.toLocaleString()} of `
                    + `${summary.sourceTriangleCount.toLocaleString()} source triangles from `
                    + `${source.sourcePath} in ${summary.spliceMs.toFixed(1)} ms `
                    + `(run map: ${summary.runMapSource}; scene preview holds `
                    + `${model.geometry.nativePreview?.previewTriangleCount?.toLocaleString() ?? '?'} triangles).`,
                );
            } catch (spliceError) {
                stageMeshIpcMs += performance.now() - spliceInvokeStart;
                const rawMessage = spliceError instanceof Error ? spliceError.message : String(spliceError);
                const reason = describeFullResSpliceError(rawMessage);
                console.warn(
                    `[SlicingFullRes] full-res splice failed for "${model.name}" — slicing the reduced preview instead: ${rawMessage}`,
                );
                emitFullResDegradeWarning(model.name, reason);
                // Not registered in fullResSplices ⇒ the collector stages the
                // preview geometry exactly as before (Rust truncated any
                // partial append).
            }
        }

        // Ph3d — the MODEL-half partition check, run now that pass ① has
        // committed. A model half has no pass ③, so the check Ph3 put there
        // cannot cover it; the same arithmetic holds on its single summary,
        // because a sectioned pass reports what it skipped.
        for (const { name, summary } of modelSectionPartitionChecks) {
            const accounted = summary.stagedTriangleCount + summary.skippedTriangleCount;
            if (accounted !== summary.sourceTriangleCount) {
                throw new Error(
                    `Full-resolution model section for "${name}" accounted for ${accounted} of `
                    + `${summary.sourceTriangleCount} source triangles — the run map does not `
                    + 'describe this file, so the slice was stopped.',
                );
            }
        }
    }

    // PASS ③ — fired by the collector once every model triangle is staged and
    // flushed, and before the first support triangle. Each spliced model's
    // support complement lands here, on the far side of the split index.
    //
    // A failure here CANNOT degrade to the preview the way pass ① can: the
    // model section is already in the buffer, so the model's support triangles
    // would simply be missing from the print. It aborts the job instead — a
    // failed slice the user can retry beats a silently unsupported one.
    const spliceSupportSections = async () => {
        for (const { model, source, plan } of supportSectionPasses) {
            throwIfAborted(options.abortSignal);
            options.onProgress?.(0, 1, 'Staging Full-Resolution Supports');
            const spliceInvokeStart = performance.now();
            let summary: FullResSpliceSummary;
            try {
                summary = await stageFullResSection(model, source, 'support', plan);
            } catch (spliceError) {
                stageMeshIpcMs += performance.now() - spliceInvokeStart;
                const rawMessage = spliceError instanceof Error ? spliceError.message : String(spliceError);
                throw new Error(
                    `Full-resolution support section could not be staged for "${model.name}" after `
                    + `its model section was: ${describeFullResSpliceError(rawMessage)}. `
                    + 'The slice was stopped rather than printed without those supports.',
                );
            }
            stageMeshIpcMs += performance.now() - spliceInvokeStart;

            const entry = fullResSplices.get(model.id);
            if (!entry) continue;
            entry.supportTriangleCount = summary.stagedTriangleCount;
            if (summary.stagedTriangleCount > 0) {
                for (let axis = 0; axis < 3; axis += 1) {
                    entry.worldMin[axis] = Math.min(entry.worldMin[axis], summary.worldMin[axis]);
                    entry.worldMax[axis] = Math.max(entry.worldMax[axis], summary.worldMax[axis]);
                }
            }
            cumulativeBytesStage += summary.stagedTriangleCount * QUANTIZED_U16_BYTES_PER_TRIANGLE;

            // The partition check, stated as arithmetic rather than trusted:
            // every triangle in the file is accounted for exactly once.
            //
            // Ph3d — WHICH two numbers those are depends on who owns the other
            // section. For a WHOLE-file model both passes are its own, so the
            // entry's two counts are the partition. For a SUPPORT HALF the model
            // section belongs to a DIFFERENT model (its sibling half), so the
            // entry's model count is 0 by construction and summing it would fail
            // a correct split. The pass's own report is the right pair there:
            // what it staged plus what it skipped is the file.
            const isSectionHalf = source.section.kind !== 'whole';
            const accounted = isSectionHalf
                ? summary.stagedTriangleCount + summary.skippedTriangleCount
                : entry.modelTriangleCount + entry.supportTriangleCount;
            if (accounted !== summary.sourceTriangleCount) {
                throw new Error(
                    `Full-resolution section splice for "${model.name}" staged ${accounted} of `
                    + `${summary.sourceTriangleCount} source triangles — the model and support `
                    + 'sections do not partition the file, so the slice was stopped.',
                );
            }
            console.warn(
                `[SlicingFullRes] staged the full-res support section for "${model.name}": `
                + `${summary.stagedTriangleCount.toLocaleString()} triangles in `
                + `${summary.spliceMs.toFixed(1)} ms (run map: ${summary.runMapSource}).`,
            );
        }
    };

    const meshPrepStartMs = performance.now();
    let solidMesh: Awaited<ReturnType<typeof buildSolidSliceMeshForWasm>>;
    try {
        solidMesh = await buildSolidSliceMeshForWasm({
            models: preparedModelsForOutput.models,
            printerProfile: options.printerProfile,
            materialProfile: options.materialProfile,
            filenameBase: options.filenameBase,
            flushBinaryMeshChunk: meshTransferMode === 'streamed'
                ? handleMeshChunk
                : meshTransferMode === 'file-backed'
                    ? handleMeshFileChunk
                    : undefined,
            meshChunkTargetBytes,
            ...(fullResSplices.size > 0 ? { fullResSplices } : {}),
            ...(supportSectionPasses.length > 0 ? { onModelSectionStaged: spliceSupportSections } : {}),
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
        const transportBytes = meshTransportEncoding === 'quantized_u16'
            ? quantizeMeshChunkToUint16(meshBytes, meshTransportQuantization)
            : meshBytes;
        const mb = Math.round(transportBytes.byteLength / (1024 * 1024));
        options.onProgress?.(0, 1, `Transferring Mesh (${mb} MB)`);

        const chunkInvokeStart = performance.now();
        const chunkAck = await invoke<StageMeshChunkAck>('stage_mesh_binary_set', transportBytes, {
            headers: { 'Content-Type': 'application/octet-stream' },
        });

        stageMeshIpcMs += performance.now() - chunkInvokeStart;
        cumulativeBytesStage = chunkAck.totalBytes > 0 ? chunkAck.totalBytes : transportBytes.byteLength;
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

    const resolvedPngStrategy = resolvePngCompressionStrategy(
        solidMesh.pngCompressionStrategy,
        options.antiAliasingLevel ?? 'Off',
        format.layerDataKind === 'png',
    );

    const effectiveDitherPolicy = resolveEffectiveDitherPolicy(options);

    const nativeJob = {
        outputFormat: format.outputFormat,
        formatVersion: resolveOutputFormatVersion(
            format.outputFormat,
            options.printerProfile.display.formatVersion,
        ),
        settingsMode: resolveOutputSettingsMode(
            format.outputFormat,
            options.printerProfile.display.settingsMode,
        ),
        sourceWidthPx: solidMesh.sourceWidthPx,
        sourceHeightPx: solidMesh.sourceHeightPx,
        widthPx: solidMesh.widthPx,
        heightPx: solidMesh.heightPx,
        xPackingMode: solidMesh.xPackingMode,
        pngCompressionStrategy: resolvedPngStrategy,
        antiAliasingLevel: options.antiAliasingLevel ?? 'Off',
        antiAliasingMode: options.antiAliasingMode ?? 'Blur',
        blurBrushRadiusPx: clampSliceJobNumber('blurBrushRadiusPx', options.blurBrushRadiusPx),
        blurBrushKernel: options.blurBrushKernel ?? 'gaussian',
        blurBrushSigmaX: clampSliceJobNumber('blurBrushSigmaX', options.blurBrushSigmaX ?? options.blurBrushSigma),
        blurBrushSigmaY: clampSliceJobNumber('blurBrushSigmaY', options.blurBrushSigmaY ?? options.blurBrushSigma),
        zBlurRadiusLayers: clampSliceJobNumber('zBlurRadiusLayers', options.zBlurRadiusLayers),
        zBlurKernel: options.zBlurKernel ?? 'box',
        zBlurSigma: clampSliceJobNumber('zBlurSigma', options.zBlurSigma),
        zBlendLookBack: clampSliceJobNumber('zBlendLookBack', options.zBlendLookBack),
        zBlendMinimumAlphaPercent: clampSliceJobNumber('zBlendMinimumAlphaPercent', options.zBlendMinimumAlphaPercent),
        zBlendMaxAlphaPercent: clampSliceJobNumber('zBlendMaxAlphaPercent', options.zBlendMaxAlphaPercent),
        zBlendCustomLut: options.zBlendCustomLut,
        zaaKernel: options.zaaKernel,
        zaaPattern: options.zaaPattern,
        zaaDuplicateZ: options.zaaDuplicateZ,
        aaOnSupports: options.aaOnSupports ?? (perfSettings.aaOnSupportsExperimental === true),
        minimumAaAlphaPercent: clampSliceJobNumber(
            'minimumAaAlphaPercent',
            options.minimumAaAlphaPercentOverride
            ?? options.materialProfile.minimumAaAlphaPercent
            ?? 50,
        ),
        mirrorX: solidMesh.mirrorX,
        mirrorY: solidMesh.mirrorY,
        ditherEnabled: effectiveDitherPolicy.ditherEnabled,
        ditherBitDepth: effectiveDitherPolicy.ditherBitDepth,
        ditherDeviceGamma: effectiveDitherPolicy.ditherDeviceGamma,
        modelTriangleCount: solidMesh.modelTriangleCount,
        containerCompressionLevel: resolveContainerCompressionLevel(resolvedPngStrategy),
        buildWidthMm: solidMesh.buildWidthMm,
        buildDepthMm: solidMesh.buildDepthMm,
        layerHeightMm: solidMesh.layerHeightMm,
        totalLayers: solidMesh.totalLayers,
        exportThumbnailPngBase64: options.exportThumbnailPng && options.exportThumbnailPng.length > 0
            ? encodeBytesToBase64(options.exportThumbnailPng)
            : null,
        trianglesXYZ: solidMesh.trianglesXYZ,
        meshEncoding: meshTransportEncoding,
        meshQuantization: meshTransportQuantization,
        outputPath: options.outputPath?.trim() || null,
        metadataJson: mergeMetadataOverridesIntoMetadata(
            solidMesh.metadataJson,
            format.outputFormat,
            options.materialProfile,
            resolveOutputSettingsMode(format.outputFormat, options.printerProfile.display.settingsMode),
            options.printerProfile.display.outputFormat,
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
