import type { Vec3 } from '../../types';

export interface SupportPathfindingDebugEvent {
    stage: string;
    severity: 'info' | 'success' | 'warning' | 'error';
    message: string;
    details?: string;
}

export interface SupportPathfindingSearchDebugEnvelope {
    /** How far the joint may sit from the socket's own column. */
    maxTotalLateralMm: number;
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
    envelope?: SupportPathfindingSearchDebugEnvelope;
    events?: SupportPathfindingDebugEvent[];
    updatedAtMs: number;
    // Extended diagnostics for tuning
    /** True when this is a hover-preview call (reduced budget, endpoint-only checks). */
    isPreview?: boolean;
    /** The final angle validation threshold in degrees. */
    maxSegmentAngleDeg?: number;
    /** True when the straight-down pre-flight check was clear. */
    straightPreflightClear?: boolean;
    /** True when roots fit under the straight-down socket. */
    rootsFitStraightDown?: boolean;
    /**
     * SDF probes the router spent on this placement. The unit of cost for the
     * route search, so a slow placement can be told from a slow frame.
     */
    routerProbes?: number;
}

export interface PotentialFieldDebugTuning {
    marginMm: number;
    repulsionStrength: number;
    stepMm: number;
    maxLateralMm: number;
    tangentWeight: number;
}

interface SupportPathfindingDebugState {
    enabled: boolean;
    tuningEnabled: boolean;
    snapshot: SupportPathfindingDebugSnapshot | null;
    pfTuning: PotentialFieldDebugTuning;
}

let state: SupportPathfindingDebugState = {
    enabled: false,
    tuningEnabled: false,
    snapshot: null,
    pfTuning: {
        marginMm: 2.5,
        repulsionStrength: 8.0,
        stepMm: 1.0,
        maxLateralMm: 30.0,
        tangentWeight: 0.5,
    },
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

export function getPotentialFieldTuning(): PotentialFieldDebugTuning {
    return state.pfTuning;
}

export function setPotentialFieldTuning(tuning: Partial<PotentialFieldDebugTuning>): void {
    state = {
        ...state,
        pfTuning: {
            ...state.pfTuning,
            ...tuning,
        },
    };
    emit();
}

// ---------- Performance diagnostics bridge ----------

export {
    getPerfReport,
    getPerfSummary,
    configurePerf as setPathfindingPerfConfig,
    resetPerf as resetPathfindingPerf,
} from './pathfindingPerf';
