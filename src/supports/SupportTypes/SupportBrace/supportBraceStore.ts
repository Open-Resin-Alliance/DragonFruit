import { useSyncExternalStore } from 'react';
import type { SupportBraceBuildResult, SupportBraceState } from './types';
import * as THREE from 'three';
import type { Vec3, Segment } from '../../types';

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
        next.controlPoint1 = transformVec3(segment.controlPoint1, matrix);
        next.controlPoint2 = transformVec3(segment.controlPoint2, matrix);
        next.startTangent = transformDirection(segment.startTangent, normalMatrix);
        next.endTangent = transformDirection(segment.endTangent, normalMatrix);
    }

    return next;
}

export function transformSupportBracesForModel(modelId: string, deltaMatrix: THREE.Matrix4) {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    let changed = false;
    let nextSupportBraces = state.supportBraces;
    let nextRoots = state.roots;
    let nextKnots = state.knots;

    for (const supportBrace of Object.values(state.supportBraces)) {
        if (supportBrace.modelId !== modelId) continue;

        if (!changed) {
            nextSupportBraces = { ...state.supportBraces };
            nextRoots = { ...state.roots };
            nextKnots = { ...state.knots };
            changed = true;
        }

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
                    pos: transformVec3(root.transform.pos, deltaMatrix),
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

    if (!changed) return;

    state = {
        ...state,
        supportBraces: nextSupportBraces,
        roots: nextRoots,
        knots: nextKnots,
    };
    notify();
}

export function useSupportBraceStoreState() {
    return useSyncExternalStore(
        subscribeToSupportBraceStore,
        getSupportBraceSnapshot,
        getSupportBraceSnapshot,
    );
}
