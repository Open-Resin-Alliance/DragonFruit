import { useSyncExternalStore } from 'react';
import type { SupportBraceBuildResult, SupportBraceState } from './types';
import * as THREE from 'three';
import type { Vec3, Segment, BezierSegment } from '../../types';

const listeners = new Set<() => void>();

const initialState: SupportBraceState = {
    supportBraces: {},
    roots: {},
    knots: {},
    selectedId: null,
};

let state: SupportBraceState = { ...initialState };

function notify() {
    listeners.forEach((listener) => listener());
}

export function subscribeToSupportBraceStore(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getSupportBraceSnapshot(): SupportBraceState {
    return state;
}

export function setSupportBraceSnapshot(next: SupportBraceState) {
    state = next;
    notify();
}

export function resetSupportBraceStore() {
    state = { ...initialState };
    notify();
}

export function setSupportBraceSelectedId(id: string | null) {
    if (state.selectedId === id) return;
    state = {
        ...state,
        selectedId: id,
    };
    notify();
}

export function addSupportBrace(build: SupportBraceBuildResult) {
    state = {
        ...state,
        supportBraces: {
            ...state.supportBraces,
            [build.supportBrace.id]: build.supportBrace,
        },
        roots: {
            ...state.roots,
            [build.root.id]: build.root,
        },
        knots: {
            ...state.knots,
            [build.hostKnot.id]: build.hostKnot,
        },
    };
    notify();
}

export function updateSupportBrace(buildOrSupportBrace: SupportBraceBuildResult | SupportBraceState['supportBraces'][string]) {
    if ('supportBrace' in buildOrSupportBrace) {
        addSupportBrace(buildOrSupportBrace);
        return;
    }

    const supportBrace = buildOrSupportBrace;
    if (!state.supportBraces[supportBrace.id]) return;

    state = {
        ...state,
        supportBraces: {
            ...state.supportBraces,
            [supportBrace.id]: supportBrace,
        },
    };
    notify();
}

export function removeSupportBrace(id: string): SupportBraceBuildResult | null {
    const supportBrace = state.supportBraces[id];
    if (!supportBrace) return null;

    const root = state.roots[supportBrace.rootId];
    const hostKnot = state.knots[supportBrace.hostKnotId];
    if (!root || !hostKnot) return null;

    const remainingBraces = { ...state.supportBraces };
    delete remainingBraces[supportBrace.id];

    const remainingRoots = { ...state.roots };
    delete remainingRoots[root.id];

    const remainingKnots = { ...state.knots };
    delete remainingKnots[hostKnot.id];

    state = {
        ...state,
        supportBraces: remainingBraces,
        roots: remainingRoots,
        knots: remainingKnots,
        selectedId: state.selectedId === id ? null : state.selectedId,
    };
    notify();

    return {
        supportBrace,
        root,
        hostKnot,
    };
}

function transformVec3(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    const v = new THREE.Vector3(value.x, value.y, value.z).applyMatrix4(matrix);
    return { x: v.x, y: v.y, z: v.z };
}

function transformVec3PreserveZ(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    const transformed = transformVec3(value, matrix);
    return {
        ...transformed,
        z: value.z,
    };
}

function transformDirection(value: Vec3, normalMatrix: THREE.Matrix3): Vec3 {
    const v = new THREE.Vector3(value.x, value.y, value.z).applyMatrix3(normalMatrix);
    if (v.lengthSq() <= 1e-12) return value;
    v.normalize();
    return { x: v.x, y: v.y, z: v.z };
}

function transformSegment(segment: Segment, matrix: THREE.Matrix4, normalMatrix: THREE.Matrix3): Segment {
    const next: Segment = {
        ...segment,
        topJoint: segment.topJoint
            ? { ...segment.topJoint, pos: transformVec3(segment.topJoint.pos, matrix) }
            : segment.topJoint,
        bottomJoint: segment.bottomJoint
            ? { ...segment.bottomJoint, pos: transformVec3(segment.bottomJoint.pos, matrix) }
            : segment.bottomJoint,
    };

    if (segment.type === 'bezier') {
        const bezierNext = next as BezierSegment;
        bezierNext.controlPoint1 = transformVec3(segment.controlPoint1, matrix);
        bezierNext.controlPoint2 = transformVec3(segment.controlPoint2, matrix);
        bezierNext.startTangent = transformDirection(segment.startTangent, normalMatrix);
        bezierNext.endTangent = transformDirection(segment.endTangent, normalMatrix);
    }

    return next;
}

export function transformSupportBracesForModel(
    modelId: string,
    deltaMatrix: THREE.Matrix4,
    touchedRootIds?: Set<string>,
    touchedKnotIds?: Set<string>,
    touchedSegmentIds?: Set<string>,
    preserveRootZ = false,
) {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    let changed = false;
    let nextSupportBraces = state.supportBraces;
    let nextRoots = state.roots;
    let nextKnots = state.knots;

    for (const supportBrace of Object.values(state.supportBraces)) {
        const isConnectedToTouchedGraph = !!(
            (touchedRootIds && touchedRootIds.has(supportBrace.rootId))
            || (touchedKnotIds && touchedKnotIds.has(supportBrace.hostKnotId))
            || (touchedSegmentIds && supportBrace.segments.some((segment) => touchedSegmentIds.has(segment.id)))
        );

        if (supportBrace.modelId !== modelId && !isConnectedToTouchedGraph) continue;

        if (!changed) {
            nextSupportBraces = { ...state.supportBraces };
            nextRoots = { ...state.roots };
            nextKnots = { ...state.knots };
            changed = true;
        }

        const hostKnot = state.knots[supportBrace.hostKnotId];

        const transformedSupportBrace = {
            ...supportBrace,
            segments: supportBrace.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
        };

        nextSupportBraces[supportBrace.id] = transformedSupportBrace;

        const root = state.roots[supportBrace.rootId];
        if (root) {
            nextRoots[root.id] = {
                ...root,
                transform: {
                    ...root.transform,
                    pos: preserveRootZ
                        ? transformVec3PreserveZ(root.transform.pos, deltaMatrix)
                        : transformVec3(root.transform.pos, deltaMatrix),
                },
            };
        }

        if (hostKnot) {
            nextKnots[hostKnot.id] = {
                ...hostKnot,
                pos: transformVec3(hostKnot.pos, deltaMatrix),
            };
        }
    }

    if (!changed) return;

    state = {
        ...state,
        supportBraces: nextSupportBraces,
        roots: nextRoots,
        knots: nextKnots,
    };
    notify();
}

export function transformAllSupportBraces(deltaMatrix: THREE.Matrix4, preserveRootZ = false): boolean {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    const supportBraceEntries = Object.values(state.supportBraces);
    if (supportBraceEntries.length === 0) return false;

    const nextSupportBraces = { ...state.supportBraces };
    const nextRoots = { ...state.roots };
    const nextKnots = { ...state.knots };

    for (const supportBrace of supportBraceEntries) {
        nextSupportBraces[supportBrace.id] = {
            ...supportBrace,
            segments: supportBrace.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
        };

        const root = state.roots[supportBrace.rootId];
        if (root) {
            nextRoots[root.id] = {
                ...root,
                transform: {
                    ...root.transform,
                    pos: preserveRootZ
                        ? transformVec3PreserveZ(root.transform.pos, deltaMatrix)
                        : transformVec3(root.transform.pos, deltaMatrix),
                },
            };
        }

        const hostKnot = state.knots[supportBrace.hostKnotId];
        if (hostKnot) {
            nextKnots[hostKnot.id] = {
                ...hostKnot,
                pos: transformVec3(hostKnot.pos, deltaMatrix),
            };
        }
    }

    state = {
        ...state,
        supportBraces: nextSupportBraces,
        roots: nextRoots,
        knots: nextKnots,
    };
    notify();
    return true;
}

export function reassignAllSupportBraceModelIds(modelId: string): boolean {
    if (!modelId) return false;

    let changed = false;
    let nextSupportBraces = state.supportBraces;
    let nextRoots = state.roots;

    for (const supportBrace of Object.values(state.supportBraces)) {
        if (supportBrace.modelId === modelId) continue;

        if (!changed) {
            nextSupportBraces = { ...state.supportBraces };
            nextRoots = { ...state.roots };
            changed = true;
        }

        nextSupportBraces[supportBrace.id] = {
            ...supportBrace,
            modelId,
        };

        const root = state.roots[supportBrace.rootId];
        if (root && root.modelId !== modelId) {
            nextRoots[root.id] = {
                ...root,
                modelId,
            };
        }
    }

    if (!changed) return false;

    state = {
        ...state,
        supportBraces: nextSupportBraces,
        roots: nextRoots,
    };
    notify();
    return true;
}

export function useSupportBraceStoreState() {
    return useSyncExternalStore(
        subscribeToSupportBraceStore,
        getSupportBraceSnapshot,
        getSupportBraceSnapshot,
    );
}
