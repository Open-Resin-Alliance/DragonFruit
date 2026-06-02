import type { Vec3 } from '../../types';

export interface GridAStarDebugPassSnapshot {
    label: string;
    searchStepMm: number;
    expansions: number;
    reached: boolean;
    stagnated: boolean;
    hitExpansionLimit: boolean;
    expandedNodes: Vec3[];
    frontierNodes: Vec3[];
    rawPath: Vec3[];
    simplifiedPath: Vec3[];
}

export interface SupportPathfindingDebugEvent {
    stage: string;
    severity: 'info' | 'success' | 'warning' | 'error';
    message: string;
    details?: string;
}

export interface SupportPathfindingConeDebugMetrics {
    nominalClear: boolean;
    activeClear: boolean;
    activeDiskAngleDeg: number;
    maxDiskAngleDeg: number;
    activeConeLengthMm: number;
    activeAddedLengthMm: number;
    stretchLimitExceeded: boolean;
    diskAngleLimitExceeded: boolean;
}

export interface SupportPathfindingSearchDebugEnvelope {
    maxTotalLateralMm: number;
    rescueRadiiMm: number[];
    rootTopZ: number;
    clearanceMm: number;
}

export interface SupportPathfindingDebugOutcome {
    status: 'pending' | 'placed' | 'straight' | 'routed' | 'fallback' | 'blocked' | 'preview';
    reason: string;
    blockedReasons?: string[];
}

export interface SupportPathfindingDebugSnapshot {
    modelId: string;
    socketPos: Vec3;
    nominalSocketPos?: Vec3;
    rootTopZ: number;
    clearanceMm: number;
    basePos?: Vec3;
    finalChain?: Vec3[];
    outcome?: SupportPathfindingDebugOutcome;
    cone?: SupportPathfindingConeDebugMetrics;
    envelope?: SupportPathfindingSearchDebugEnvelope;
    events?: SupportPathfindingDebugEvent[];
    passes: GridAStarDebugPassSnapshot[];
    updatedAtMs: number;
}

interface SupportPathfindingDebugState {
    enabled: boolean;
    tuningEnabled: boolean;
    snapshot: SupportPathfindingDebugSnapshot | null;
}

let state: SupportPathfindingDebugState = {
    enabled: false,
    tuningEnabled: false,
    snapshot: null,
};

const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function subscribeToSupportPathfindingDebugState(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getSupportPathfindingDebugState(): SupportPathfindingDebugState {
    return state;
}

export function getSupportPathfindingDebugEnabled(): boolean {
    return state.enabled;
}

export function setSupportPathfindingDebugEnabled(enabled: boolean): void {
    if (state.enabled === enabled) return;
    state = {
        ...state,
        enabled,
        tuningEnabled: enabled ? state.tuningEnabled : false,
        snapshot: enabled ? state.snapshot : null,
    };
    emit();
}

export function toggleSupportPathfindingDebugEnabled(): void {
    setSupportPathfindingDebugEnabled(!state.enabled);
}

export function getSupportPathfindingDebugTuningEnabled(): boolean {
    return state.enabled && state.tuningEnabled;
}

export function setSupportPathfindingDebugTuningEnabled(enabled: boolean): void {
    if (!state.enabled) return;
    if (state.tuningEnabled === enabled) return;
    state = {
        ...state,
        tuningEnabled: enabled,
    };
    emit();
}

export function toggleSupportPathfindingDebugTuningEnabled(): void {
    setSupportPathfindingDebugTuningEnabled(!state.tuningEnabled);
}

export function setSupportPathfindingDebugSnapshot(snapshot: SupportPathfindingDebugSnapshot | null): void {
    if (!state.enabled && snapshot !== null) return;
    state = {
        ...state,
        snapshot,
    };
    emit();
}
