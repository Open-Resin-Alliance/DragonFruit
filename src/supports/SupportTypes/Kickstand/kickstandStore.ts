import { useSyncExternalStore } from 'react';
import type { KickstandBuildResult, KickstandState } from './types';
import * as THREE from 'three';
import type { Vec3, Segment, BezierSegment } from '../../types';

const listeners = new Set<() => void>();

const initialState: KickstandState = {
    kickstands: {},
    roots: {},
    knots: {},
    selectedId: null,
};

let state: KickstandState = { ...initialState };

function notify() {
    listeners.forEach((listener) => listener());
}

export function subscribeToKickstandStore(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getKickstandSnapshot(): KickstandState {
    return state;
}

export function setKickstandSnapshot(next: KickstandState) {
    state = next;
    notify();
}

export function resetKickstandStore() {
    state = { ...initialState };
    notify();
}

export function setKickstandSelectedId(id: string | null) {
    if (state.selectedId === id) return;
    state = {
        ...state,
        selectedId: id,
    };
    notify();
}

export function addKickstand(build: KickstandBuildResult) {
    state = {
        ...state,
        kickstands: {
            ...state.kickstands,
            [build.kickstand.id]: build.kickstand,
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

export function updateKickstand(buildOrKickstand: KickstandBuildResult | KickstandState['kickstands'][string]) {
    if ('kickstand' in buildOrKickstand) {
        addKickstand(buildOrKickstand);
        return;
    }

    const kickstand = buildOrKickstand;
    if (!state.kickstands[kickstand.id]) return;

    state = {
        ...state,
        kickstands: {
            ...state.kickstands,
            [kickstand.id]: kickstand,
        },
    };
    notify();
}

export function removeKickstand(id: string): KickstandBuildResult | null {
    const kickstand = state.kickstands[id];
    if (!kickstand) return null;

    const root = state.roots[kickstand.rootId];
    const hostKnot = state.knots[kickstand.hostKnotId];
    if (!root || !hostKnot) return null;

    const remainingKickstands = { ...state.kickstands };
    delete remainingKickstands[kickstand.id];

    const remainingRoots = { ...state.roots };
    delete remainingRoots[root.id];

    const remainingKnots = { ...state.knots };
    delete remainingKnots[hostKnot.id];

    state = {
        ...state,
        kickstands: remainingKickstands,
        roots: remainingRoots,
        knots: remainingKnots,
        selectedId: state.selectedId === id ? null : state.selectedId,
    };
    notify();

    return {
        kickstand,
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

export function transformKickstandsForModel(
    modelId: string,
    deltaMatrix: THREE.Matrix4,
    touchedRootIds?: Set<string>,
    touchedKnotIds?: Set<string>,
    touchedSegmentIds?: Set<string>,
    preserveRootZ = false,
): boolean {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    let changed = false;
    let nextKickstands = state.kickstands;
    let nextRoots = state.roots;
    let nextKnots = state.knots;

    for (const kickstand of Object.values(state.kickstands)) {
        const isConnectedToTouchedGraph = !!(
            (touchedRootIds && touchedRootIds.has(kickstand.rootId))
            || (touchedKnotIds && touchedKnotIds.has(kickstand.hostKnotId))
            || (touchedSegmentIds && kickstand.segments.some((segment) => touchedSegmentIds.has(segment.id)))
        );

        if (kickstand.modelId !== modelId && !isConnectedToTouchedGraph) continue;

        if (!changed) {
            nextKickstands = { ...state.kickstands };
            nextRoots = { ...state.roots };
            nextKnots = { ...state.knots };
            changed = true;
        }

        const hostKnot = state.knots[kickstand.hostKnotId];

        const transformedKickstand = {
            ...kickstand,
            segments: kickstand.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
        };

        nextKickstands[kickstand.id] = transformedKickstand;

        const root = state.roots[kickstand.rootId];
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

    if (!changed) return false;

    state = {
        ...state,
        kickstands: nextKickstands,
        roots: nextRoots,
        knots: nextKnots,
    };
    notify();
    return true;
}

export function transformAllKickstands(deltaMatrix: THREE.Matrix4, preserveRootZ = false): boolean {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    const kickstandEntries = Object.values(state.kickstands);
    if (kickstandEntries.length === 0) return false;

    const nextKickstands = { ...state.kickstands };
    const nextRoots = { ...state.roots };
    const nextKnots = { ...state.knots };

    for (const kickstand of kickstandEntries) {
        nextKickstands[kickstand.id] = {
            ...kickstand,
            segments: kickstand.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
        };

        const root = state.roots[kickstand.rootId];
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

        const hostKnot = state.knots[kickstand.hostKnotId];
        if (hostKnot) {
            nextKnots[hostKnot.id] = {
                ...hostKnot,
                pos: transformVec3(hostKnot.pos, deltaMatrix),
            };
        }
    }

    state = {
        ...state,
        kickstands: nextKickstands,
        roots: nextRoots,
        knots: nextKnots,
    };
    notify();
    return true;
}

export function reassignAllKickstandModelIds(modelId: string): boolean {
    if (!modelId) return false;

    let changed = false;
    let nextKickstands = state.kickstands;
    let nextRoots = state.roots;

    for (const kickstand of Object.values(state.kickstands)) {
        if (kickstand.modelId === modelId) continue;

        if (!changed) {
            nextKickstands = { ...state.kickstands };
            nextRoots = { ...state.roots };
            changed = true;
        }

        nextKickstands[kickstand.id] = {
            ...kickstand,
            modelId,
        };

        const root = state.roots[kickstand.rootId];
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
        kickstands: nextKickstands,
        roots: nextRoots,
    };
    notify();
    return true;
}

export function useKickstandStoreState() {
    return useSyncExternalStore(
        subscribeToKickstandStore,
        getKickstandSnapshot,
        getKickstandSnapshot,
    );
}
