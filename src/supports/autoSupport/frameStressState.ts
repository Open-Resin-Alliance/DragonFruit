import type * as THREE from 'three';
import type { SupportFrameStressReport } from './supportGraphStress';
import type { PrintabilityReport } from './printability';
import type { ToppleRiskReport } from './toppleRisk';
import { extractRepresentativeLayers, type RepresentativeLayerProfile } from './tractionOptimization';

export interface FrameStressStoreSnapshot {
    byModelId: Record<string, SupportFrameStressReport>;
    /** Live printability verdicts, keyed the same way as the frame reports. */
    printabilityByModelId: Record<string, PrintabilityReport>;
    /** Solved-demand topple margin from the last placement run, per model. */
    toppleRiskByModelId: Record<string, ToppleRiskReport>;
    overlayEnabled: boolean;
}

let currentSnapshot: FrameStressStoreSnapshot = {
    byModelId: {},
    printabilityByModelId: {},
    toppleRiskByModelId: {},
    overlayEnabled: false,
};

const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

export function getFrameStressSnapshot(): FrameStressStoreSnapshot {
    return currentSnapshot;
}

export function subscribeFrameStress(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function setModelFrameStress(modelId: string, report: SupportFrameStressReport): void {
    currentSnapshot = {
        ...currentSnapshot,
        byModelId: {
            ...currentSnapshot.byModelId,
            [modelId]: report,
        },
    };
    emit();
}

export function clearModelFrameStress(modelId?: string): void {
    if (!modelId) {
        if (Object.keys(currentSnapshot.byModelId).length === 0) return;
        currentSnapshot = { ...currentSnapshot, byModelId: {} };
        emit();
        return;
    }
    if (!currentSnapshot.byModelId[modelId]) return;
    const nextByModel = { ...currentSnapshot.byModelId };
    delete nextByModel[modelId];
    currentSnapshot = { ...currentSnapshot, byModelId: nextByModel };
    emit();
}

/** Drop a stale printability verdict; the next evaluate call replaces it. */
export function clearModelPrintability(modelId?: string): void {
    if (!modelId) {
        if (Object.keys(currentSnapshot.printabilityByModelId).length === 0) return;
        currentSnapshot = { ...currentSnapshot, printabilityByModelId: {} };
        emit();
        return;
    }
    if (!currentSnapshot.printabilityByModelId[modelId]) return;
    const nextPrintability = { ...currentSnapshot.printabilityByModelId };
    delete nextPrintability[modelId];
    currentSnapshot = { ...currentSnapshot, printabilityByModelId: nextPrintability };
    emit();
}

/** Store the topple risk the last placement run measured for one model. */
export function setModelToppleRisk(modelId: string, report: ToppleRiskReport): void {
    currentSnapshot = {
        ...currentSnapshot,
        toppleRiskByModelId: {
            ...currentSnapshot.toppleRiskByModelId,
            [modelId]: report,
        },
    };
    emit();
}

/** Drop a stale topple risk (a run that could not measure the pose). */
export function clearModelToppleRisk(modelId?: string): void {
    if (!modelId) {
        if (Object.keys(currentSnapshot.toppleRiskByModelId).length === 0) return;
        currentSnapshot = { ...currentSnapshot, toppleRiskByModelId: {} };
        emit();
        return;
    }
    if (!currentSnapshot.toppleRiskByModelId[modelId]) return;
    const next = { ...currentSnapshot.toppleRiskByModelId };
    delete next[modelId];
    currentSnapshot = { ...currentSnapshot, toppleRiskByModelId: next };
    emit();
}

/** Store the live printability verdict for one model. */
export function setModelPrintability(modelId: string, report: PrintabilityReport): void {
    currentSnapshot = {
        ...currentSnapshot,
        printabilityByModelId: {
            ...currentSnapshot.printabilityByModelId,
            [modelId]: report,
        },
    };
    emit();
}

export function getStressOverlayEnabled(): boolean {
    return currentSnapshot.overlayEnabled;
}

export function setStressOverlayEnabled(enabled: boolean): void {
    if (currentSnapshot.overlayEnabled === enabled) return;
    currentSnapshot = { ...currentSnapshot, overlayEnabled: enabled };
    emit();
}

let hoveredLayerZMm: number | null = null;
const hoveredLayerListeners = new Set<() => void>();

export function getHoveredStressLayerZ(): number | null {
    return hoveredLayerZMm;
}

export function setHoveredStressLayerZ(zMm: number | null): void {
    const normalized = typeof zMm === 'number' && Number.isFinite(zMm) ? zMm : null;
    if (hoveredLayerZMm === normalized) return;
    hoveredLayerZMm = normalized;
    for (const fn of hoveredLayerListeners) fn();
}

export function subscribeHoveredStressLayerZ(listener: () => void): () => void {
    hoveredLayerListeners.add(listener);
    return () => {
        hoveredLayerListeners.delete(listener);
    };
}

const layerProfileCache = new WeakMap<
    THREE.Mesh,
    { geometryUuid: string; matrixSig: string; layerHeightMm: number | undefined; profile: RepresentativeLayerProfile }
>();

/**
 * The representative-layer profile for a mesh, sliced at `layerHeightMm` (the
 * print profile's layer height) when given, so the peel curve has one point per
 * printed layer rather than one per cluster. The cache key includes the height:
 * switching profile re-slices, moving supports does not.
 */
export function getCachedRepresentativeLayers(mesh: THREE.Mesh, layerHeightMm?: number): RepresentativeLayerProfile {
    mesh.updateMatrixWorld();
    const e = mesh.matrixWorld.elements;
    let matrixSig = '';
    for (let i = 0; i < 16; i++) {
        matrixSig += (i > 0 ? ',' : '') + Math.round(e[i] * 1e4);
    }
    const geometryUuid = mesh.geometry?.uuid ?? '';
    const cached = layerProfileCache.get(mesh);
    if (
        cached
        && cached.geometryUuid === geometryUuid
        && cached.matrixSig === matrixSig
        && cached.layerHeightMm === layerHeightMm
    ) {
        return cached.profile;
    }
    const profile = extractRepresentativeLayers(mesh, undefined, { layerHeightMm });
    layerProfileCache.set(mesh, { geometryUuid, matrixSig, layerHeightMm, profile });
    return profile;
}
