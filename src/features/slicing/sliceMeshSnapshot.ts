import { Box3, Vector3, type BufferGeometry } from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';
import { subscribeToMeshModifierStore } from '@/features/mesh-modifiers/meshModifierStore';
import { getModelOutputModifierSignature, prepareLoadedModelsForOutput } from '@/features/mesh-modifiers/prepareModelGeometry';
import type { PreparedLoadedModelsForOutput } from '@/features/mesh-modifiers/prepareModelGeometry';
import { computeApproxModelWorldBounds, computePreciseModelWorldBounds, isBoundsDisjointFromVolume } from '@/utils/modelBounds';
import { getSnapshot, subscribe as subscribeToSupports } from '@/supports/state';
import { SUPPORT_COLLECTION_KEYS } from '@/supports/supportTypeRegistry';
import { getRaftSettings, subscribeToRaftStore } from '@/supports/Rafts/Crenelated/RaftState';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';
import { getSavedSlicingPerformanceSettings, subscribeToSlicingPerformanceSettings } from '@/components/settings/performancePreferences';
import { invoke } from '@tauri-apps/api/core';
import { createMeshChunkUpload, type MeshChunkUploadResult } from '@/utils/meshChunkUpload';
import { SliceSnapshotMissError } from './tauri/nativeSlicerBridge';
import { runExclusiveNativeMesh } from '@/utils/tauriMeshBridge';
import { buildSolidSliceMeshForWasm, type SolidSliceMeshForWasm } from './rasterLayerZipExport';
import { resolveSliceJobAntiAliasing } from './sliceAntiAliasing';
import { resolveSliceRasterSettings } from './sliceJobAssembly';
import type { SliceExportOrchestratorOptions } from './sliceExportOrchestrator';

export type SliceMeshPrewarmOptions = Pick<SliceExportOrchestratorOptions,
    'models' | 'excludedModelIds' | 'plateVolumeBoundsMm' | 'plateOffsetMm'
    | 'printerProfile' | 'materialProfile' | 'antiAliasing'>;
export type SliceMeshInputSignature = readonly (string | number | boolean | null | undefined)[];
// The only per-triangle field retained is the necessary multi-tank assignment;
// no prepared geometries or world-space triangle positions survive preparation.
export type SliceMeshDescriptor = Omit<SolidSliceMeshForWasm, 'trianglesXYZ'> & { sourceModelIds: readonly string[] };
type Snapshot = { signature: SliceMeshInputSignature; descriptor: SliceMeshDescriptor; snapshotId: string | null; preparationAck: MeshChunkUploadResult };
type Preparation = {
    signature: SliceMeshInputSignature;
    controller: AbortController;
    users: number;
    onBake: Set<() => void>;
    promise: Promise<Snapshot>;
};
let latest: Snapshot | null = null;
let preparation: Preparation | null = null;
let preparationTail: Promise<void> = Promise.resolve();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | null | undefined): number {
    if (!value) return 0;
    let id = identities.get(value);
    if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
    return id;
}
function geometrySignature(target: Array<string | number | boolean | null | undefined>, bounds: GeometryWithBounds): void {
    const geometry: BufferGeometry = bounds.geometry;
    target.push(identity(geometry));
    for (const attribute of [geometry.getAttribute('position'), geometry.getIndex()]) {
        const data = attribute && 'data' in attribute ? attribute.data : undefined;
        target.push(identity(attribute), attribute?.count, attribute?.itemSize, attribute?.normalized,
            attribute && 'version' in attribute && typeof attribute.version === 'number' ? attribute.version : undefined,
            identity(data), data?.version, identity(attribute?.array), attribute?.array.length);
    }
    target.push(bounds.center.x, bounds.center.y, bounds.center.z,
        bounds.bbox.min.x, bounds.bbox.min.y, bounds.bbox.min.z,
        bounds.bbox.max.x, bounds.bbox.max.y, bounds.bbox.max.z,
        bounds.size.x, bounds.size.y, bounds.size.z,
        bounds.meshDefects?.nativeRepairReport?.model_triangle_count,
        bounds.meshDefects?.nativeRepairReport?.likely_support_geometry);
}
export function equalSliceMeshInputSignatures(a: SliceMeshInputSignature, b: SliceMeshInputSignature): boolean {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}
/** Whether a prepared snapshot already covers this exact input. */
export function hasWarmSliceMesh(signature: SliceMeshInputSignature): boolean {
    return latest !== null && equalSliceMeshInputSignatures(latest.signature, signature);
}
export function getSliceMeshInputSignature(options: SliceMeshPrewarmOptions): SliceMeshInputSignature {
    const raster = resolveSliceRasterSettings(options);
    const { supportTipShrinkPercent } = resolveSliceJobAntiAliasing({ ...options, layerHeightMm: raster.layerHeightMm, request: options.antiAliasing });
    const activeMaterial = getActiveMaterialProfile();
    const activePrinter = getActivePrinterProfile();
    const tipPenetration = activeMaterial && activePrinter ? calculateTipOffset(
        activeMaterial.antiAliasingSettings, activeMaterial.layerHeightMm,
        activePrinter.pixelSize?.x ? activePrinter.pixelSize.x / 1000 : (activePrinter.buildVolumeMm?.width ?? 143) / (activePrinter.display?.resolutionX ?? 2560),
        activePrinter.pixelSize?.y ? activePrinter.pixelSize.y / 1000 : (activePrinter.buildVolumeMm?.depth ?? 89) / (activePrinter.display?.resolutionY ?? 1620),
    ) : 0;
    const result: Array<string | number | boolean | null | undefined> = [
        JSON.stringify(raster), options.printerProfile.buildVolumeMm.width,
        options.printerProfile.buildVolumeMm.depth, options.printerProfile.buildVolumeMm.height,
        options.printerProfile.materialMode, JSON.stringify(options.printerProfile.tankMaterials ?? []),
        JSON.stringify(options.plateVolumeBoundsMm), options.plateOffsetMm?.dxMm, options.plateOffsetMm?.dyMm,
        supportTipShrinkPercent, tipPenetration, getSavedSlicingPerformanceSettings().pngCompressionStrategy,
        JSON.stringify(getRaftSettings()),
    ];
    const excluded = new Set(options.excludedModelIds ?? []);
    for (const model of options.models) {
        if (!model.visible || excluded.has(model.id)) continue;
        result.push(model.id, model.name, model.polygonCount, model.isSupportGeometry, model.materialProfileId,
            JSON.stringify(model.bodyMaterialProfileIds ?? []),
            model.transform.position.x, model.transform.position.y, model.transform.position.z,
            model.transform.rotation.x, model.transform.rotation.y, model.transform.rotation.z, model.transform.rotation.order,
            model.transform.scale.x, model.transform.scale.y, model.transform.scale.z);
        geometrySignature(result, model.geometry);
        result.push(model.splitBodies?.length ?? 0);
        for (const body of model.splitBodies ?? []) geometrySignature(result, body);
        const modifierInputs = getModelOutputModifierSignature(model);
        result.push(modifierInputs?.[0], modifierInputs?.[1]);
    }
    const supports = getSnapshot();
    for (const key of SUPPORT_COLLECTION_KEYS) result.push(identity(supports[key]));
    return result;
}
/** Notify on producer-store edits without treating support hover/selection as geometry. */
export function subscribeSliceMeshInputChanges(listener: () => void): () => void {
    let collections = SUPPORT_COLLECTION_KEYS.map((key) => getSnapshot()[key]);
    const stop = [
        subscribeToSupports(() => {
            const next = SUPPORT_COLLECTION_KEYS.map((key) => getSnapshot()[key]);
            if (next.every((value, index) => value === collections[index])) return;
            collections = next;
            listener();
        }),
        subscribeToRaftStore(listener), subscribeToMeshModifierStore(listener),
        subscribeToSlicingPerformanceSettings(listener),
    ];
    return () => { for (const unsubscribe of stop) unsubscribe(); };
}
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Mesh operation cancelled', 'AbortError');
}
function visibleModelsForSlice(options: SliceMeshPrewarmOptions): LoadedModel[] {
    const excluded = new Set(options.excludedModelIds ?? []);
    const width = Math.max(1, Number(options.printerProfile.buildVolumeMm.width) || 1);
    const depth = Math.max(1, Number(options.printerProfile.buildVolumeMm.depth) || 1);
    const height = Math.max(1, Number(options.printerProfile.buildVolumeMm.height) || 1);
    const plate = options.plateVolumeBoundsMm;
    const volume = plate ? new Box3(new Vector3(plate.minX, plate.minY, 0), new Vector3(plate.maxX, plate.maxY, height))
        : new Box3(new Vector3(-width / 2, -depth / 2, 0), new Vector3(width / 2, depth / 2, height));
    return options.models.filter((model) => {
        if (!model.visible || excluded.has(model.id)) return false;
        const approximate = computeApproxModelWorldBounds(model.geometry, model.transform);
        if (volume.containsBox(approximate)) return true;
        if (isBoundsDisjointFromVolume(approximate, volume, 0.01)) return false;
        return !isBoundsDisjointFromVolume(computePreciseModelWorldBounds(model.geometry, model.transform), volume, 0.01);
    });
}
async function prepareSnapshot(
    options: SliceMeshPrewarmOptions,
    signature: SliceMeshInputSignature,
    signal: AbortSignal | undefined,
    onBake: () => void,
    onReady?: (snapshot: Snapshot, ack: MeshChunkUploadResult) => Promise<void>,
): Promise<Snapshot> {
    throwIfAborted(signal);
    const models = visibleModelsForSlice(options);
    if (models.length === 0) throw new Error('No in-bounds visible models available for slicing.');
    let prepared: PreparedLoadedModelsForOutput | null = await prepareLoadedModelsForOutput(models, { onBake, signal });
    try {
        throwIfAborted(signal);
        const combined = prepared.models.filter((model) => {
            const boundary = model.geometry.meshDefects?.nativeRepairReport?.model_triangle_count;
            const geometry = model.geometry.geometry;
            const count = Math.floor((geometry.getIndex()?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3);
            return boundary != null && boundary > 0 && boundary < count;
        });
        if (combined.length > 0) throw new Error(
            `Classified support geometry was not separated before slicing: ${combined.map((model) => model.name).join(', ')}`,
        );
        // Never acquire the stage queue around modifier baking: native modifiers
        // use that same queue. Even the warm miss leaves it before coming here.
        return await runExclusiveNativeMesh(async () => {
            throwIfAborted(signal);
            if (!prepared) throw new Error('Prepared geometry was released before mesh assembly.');
            const triangleEstimate = models.reduce((sum, model) => sum + (Number.isFinite(model.polygonCount) ? Math.max(0, Math.floor(model.polygonCount)) : 0), 0);
            const reserveBytes = Math.max(16 * 1024 * 1024, Math.min(1024 * 1024 * 1024, Math.ceil(triangleEstimate * 36 * 1.35)));
            const upload = await createMeshChunkUpload(invoke, { signal, reserveBytes, retainForSlice: true });
            try {
                const raster = resolveSliceRasterSettings(options);
                const { supportTipShrinkPercent } = resolveSliceJobAntiAliasing({ ...options, layerHeightMm: raster.layerHeightMm, request: options.antiAliasing });
                const mesh = await buildSolidSliceMeshForWasm({
                    ...options, models: prepared.models, filenameBase: '', supportTipShrinkPercent,
                    abortSignal: signal, meshChunkTargetBytes: 4 * 1024 * 1024,
                    flushBinaryMeshChunk: async (bytes) => { throwIfAborted(signal); await upload.append(bytes); },
                    appendLoadedMesh: async (source) => { throwIfAborted(signal); return upload.appendSource(source); },
                });
                throwIfAborted(signal);
                const ack = await upload.finish();
                const descriptor: SliceMeshDescriptor = { ...mesh, sourceModelIds: models.map((model) => model.id) };
                Reflect.deleteProperty(descriptor, 'trianglesXYZ');
                const snapshot: Snapshot = { signature, descriptor, snapshotId: ack.sliceSnapshotId ?? null, preparationAck: ack };
                prepared.dispose();
                prepared = null;
                throwIfAborted(signal);
                if (equalSliceMeshInputSignatures(signature, getSliceMeshInputSignature(options))) {
                    latest = snapshot.snapshotId ? snapshot : null;
                }
                await onReady?.(snapshot, ack);
                return snapshot;
            } catch (error) {
                await upload.abort();
                throw error;
            }
        }, signal);
    } finally { prepared?.dispose(); }
}
function startPreparation(
    options: SliceMeshPrewarmOptions,
    signature: SliceMeshInputSignature,
    onReady?: (snapshot: Snapshot, ack: MeshChunkUploadResult) => Promise<void>,
): { entry: Preparation; completion: Promise<Snapshot> } {
    let resolve!: (snapshot: Snapshot) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Snapshot>((done, fail) => { resolve = done; reject = fail; });
    // Cold exports observe completion directly; the shared ready notification may have no subscribers.
    void promise.catch(() => undefined);
    const entry: Preparation = { signature, controller: new AbortController(), users: 0, onBake: new Set(), promise };
    preparation = entry;
    const completion = preparationTail.then(() => prepareSnapshot(options, signature, entry.controller.signal, () => {
        for (const notify of entry.onBake) notify();
    }, async (snapshot, ack) => {
        resolve(snapshot);
        await onReady?.(snapshot, ack);
    }));
    // A cancelled subscriber can leave a native bake unwinding. Do not start a
    // replacement producer until that producer has released its real resources.
    preparationTail = completion.then(() => undefined, () => undefined);
    void completion.then(resolve, reject).finally(() => { if (preparation === entry) preparation = null; });
    return { entry, completion };
}
function requestSnapshot(options: SliceMeshPrewarmOptions, signal?: AbortSignal, onBake?: () => void): Promise<Snapshot> {
    throwIfAborted(signal);
    const signature = getSliceMeshInputSignature(options);
    if (latest && equalSliceMeshInputSignatures(latest.signature, signature)) return Promise.resolve(latest);
    let entry = preparation;
    if (!entry || entry.controller.signal.aborted || !equalSliceMeshInputSignatures(entry.signature, signature)) {
        entry = startPreparation(options, signature).entry;
    }
    const joined = entry;
    joined.users += 1;
    if (onBake) joined.onBake.add(onBake);
    return new Promise<Snapshot>((resolve, reject) => {
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            signal?.removeEventListener('abort', abort);
            if (onBake) joined.onBake.delete(onBake);
            if (--joined.users === 0) joined.controller.abort();
        };
        const abort = () => { release(); try { throwIfAborted(signal); } catch (error) { reject(error); } };
        signal?.addEventListener('abort', abort, { once: true });
        joined.promise.then((snapshot) => { if (!released) { release(); resolve(snapshot); } },
            (error) => { if (!released) { release(); reject(error); } });
        if (signal?.aborted) abort();
    });
}
/** Prepare only the native mesh snapshot; never slice, attach metadata or produce output. */
export async function prewarmSliceMesh(options: SliceMeshPrewarmOptions, signal?: AbortSignal): Promise<void> {
    await requestSnapshot(options, signal);
}
export async function runWithSliceMesh<T>(
    options: SliceMeshPrewarmOptions,
    signal: AbortSignal | undefined,
    onBake: () => void,
    consume: (descriptor: SliceMeshDescriptor, ack: MeshChunkUploadResult, meshPrepMs: number, snapshotId?: string) => Promise<T>,
): Promise<T> {
    const started = performance.now();
    throwIfAborted(signal);
    const signature = getSliceMeshInputSignature(options);
    // The slice command restores the retained snapshot itself, so a warm export
    // is one invoke. A native miss falls through to the cold path below.
    const consumeSnapshot = async (snapshot: Snapshot): Promise<{ result: T } | null> => {
        if (!snapshot.snapshotId || !equalSliceMeshInputSignatures(signature, snapshot.signature)) return null;
        return runExclusiveNativeMesh(async () => {
            throwIfAborted(signal);
            if (!equalSliceMeshInputSignatures(signature, getSliceMeshInputSignature(options))) return null;
            try {
                // No staging invoke happened; the stored preparation describes the mesh.
                const ack: MeshChunkUploadResult = {
                    ...snapshot.preparationAck, ipcMs: 0, wallMs: 0, hashMs: 0, commands: {},
                };
                return { result: await consume(snapshot.descriptor, ack, performance.now() - started, snapshot.snapshotId ?? undefined) };
            } catch (error) {
                if (error instanceof SliceSnapshotMissError) {
                    if (latest === snapshot) latest = null;
                    return null;
                }
                throw error;
            }
        }, signal);
    };
    if (latest && equalSliceMeshInputSignatures(signature, latest.signature)) {
        const hit = await consumeSnapshot(latest);
        if (hit) return hit.result;
    }
    if (preparation && !preparation.controller.signal.aborted
        && equalSliceMeshInputSignatures(preparation.signature, signature)) {
        const snapshot = await requestSnapshot(options, signal, onBake);
        const hit = await consumeSnapshot(snapshot);
        if (hit) return hit.result;
    }
    // A cold export consumes its freshly staged bytes inside the same guard.
    // Publishing a shared ready promise lets background callers join it without
    // forcing a second upload or restore, including when disk retention is unavailable.
    let result!: T; // onReady is awaited by completion before result is read.
    const { entry, completion } = startPreparation(options, getSliceMeshInputSignature(options), async (snapshot, ack) => {
        throwIfAborted(signal);
        if (!equalSliceMeshInputSignatures(snapshot.signature, getSliceMeshInputSignature(options))) {
            throw new Error('Scene changed while preparing slice input; retry with the current scene.');
        }
        result = await consume(snapshot.descriptor, ack, performance.now() - started);
    });
    entry.users += 1;
    entry.onBake.add(onBake);
    return new Promise<T>((resolve, reject) => {
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            signal?.removeEventListener('abort', abort);
            entry.onBake.delete(onBake);
            if (--entry.users === 0) entry.controller.abort();
        };
        const abort = () => { release(); try { throwIfAborted(signal); } catch (error) { reject(error); } };
        signal?.addEventListener('abort', abort, { once: true });
        completion.then(() => { release(); resolve(result); }, error => { release(); reject(error); });
        if (signal?.aborted) abort();
    });
}
