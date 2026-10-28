import * as THREE from 'three';

import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type {
    BezierSegment,
    BraceCurve,
    ContactDisk,
    Joint,
    Knot,
    Roots,
    Segment,
    Vec3,
} from './types';
import type { SupportTypeId } from './supportTypeRegistry';
import { contactEndpointsFor, getSupportTypeDescriptor, transformExtrasFor } from './supportTypeRegistry';

function transformVec3(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    // Inline the affine multiply: a plate move transforms tens of thousands of
    // these, and allocating a Vector3 for each one was measurable.
    const e = matrix.elements;
    const x = value.x;
    const y = value.y;
    const z = value.z;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const invW = w !== 0 && w !== 1 ? 1 / w : 1;
    return {
        x: (e[0] * x + e[4] * y + e[8] * z + e[12]) * invW,
        y: (e[1] * x + e[5] * y + e[9] * z + e[13]) * invW,
        z: (e[2] * x + e[6] * y + e[10] * z + e[14]) * invW,
    };
}

function transformVec3PreserveZ(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    const transformed = transformVec3(value, matrix);
    return {
        ...transformed,
        z: value.z,
    };
}

function transformDirection(value: Vec3, normalMatrix: THREE.Matrix3): Vec3 {
    const e = normalMatrix.elements;
    const x = e[0] * value.x + e[3] * value.y + e[6] * value.z;
    const y = e[1] * value.x + e[4] * value.y + e[7] * value.z;
    const z = e[2] * value.x + e[5] * value.y + e[8] * value.z;
    const lengthSq = x * x + y * y + z * z;
    if (lengthSq <= 1e-12) return value;
    const invLength = 1 / Math.sqrt(lengthSq);
    return { x: x * invLength, y: y * invLength, z: z * invLength };
}

function transformJoint(joint: import('./types').Joint | undefined, matrix: THREE.Matrix4) {
    if (!joint) return joint;
    return {
        ...joint,
        pos: transformVec3(joint.pos, matrix),
    };
}

function transformSegment(segment: Segment, matrix: THREE.Matrix4, normalMatrix: THREE.Matrix3): Segment {
    const next: Segment = {
        ...segment,
        topJoint: transformJoint(segment.topJoint, matrix),
        bottomJoint: transformJoint(segment.bottomJoint, matrix),
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

function transformContactCone(
    cone: import('./SupportPrimitives/ContactCone/types').ContactCone,
    matrix: THREE.Matrix4,
    normalMatrix: THREE.Matrix3,
) {
    return {
        ...cone,
        pos: transformVec3(cone.pos, matrix),
        normal: transformDirection(cone.normal, normalMatrix),
        surfaceNormal: cone.surfaceNormal ? transformDirection(cone.surfaceNormal, normalMatrix) : cone.surfaceNormal,
    };
}

function transformContactDisk(
    disk: import('./types').ContactDisk,
    matrix: THREE.Matrix4,
    normalMatrix: THREE.Matrix3,
) {
    return {
        ...disk,
        pos: transformVec3(disk.pos, matrix),
        surfaceNormal: transformDirection(disk.surfaceNormal, normalMatrix),
        coneAxis: transformDirection(disk.coneAxis, normalMatrix),
    };
}

/**
 * A rigid delta between two model transforms, with the rule that rides on it:
 * under a pure translation a plate root keeps its Z, so a raft does not climb
 * with a model lifted off the plate.
 */
export type SupportDeltaTransform = {
    matrix: THREE.Matrix4;
    normalMatrix: THREE.Matrix3;
    preserveRootZ: boolean;
};

/**
 * The delta carrying support geometry from `beforeTransform` to
 * `afterTransform`, or null when the two are the same transform.
 */
export function buildSupportDeltaTransform(
    beforeTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
    afterTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
): SupportDeltaTransform | null {
    const beforeMatrix = new THREE.Matrix4().compose(
        beforeTransform.position.clone(),
        quaternionFromGlobalEuler(beforeTransform.rotation),
        beforeTransform.scale.clone(),
    );
    const afterMatrix = new THREE.Matrix4().compose(
        afterTransform.position.clone(),
        quaternionFromGlobalEuler(afterTransform.rotation),
        afterTransform.scale.clone(),
    );

    if (transformsRoughlyEqual(beforeMatrix, afterMatrix)) return null;

    const matrix = afterMatrix.clone().multiply(beforeMatrix.clone().invert());
    const isPureTranslation = eulersRoughlyEqual(beforeTransform.rotation, afterTransform.rotation)
        && vectorsRoughlyEqual(beforeTransform.scale, afterTransform.scale);
    const deltaTranslation = afterTransform.position.clone().sub(beforeTransform.position);

    return {
        matrix,
        normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix),
        preserveRootZ: isPureTranslation && Math.abs(deltaTranslation.z) > 1e-8,
    };
}

/**
 * One support record moved by `delta`, whatever collection it lives in: a
 * declared shaft, its declared contacts, and whatever `transformExtrasFor`
 * names. A root keeps its Z under a pure translation, a knot is a point, and a
 * kickstand's own root and host knot move with the shared collections they
 * live in.
 *
 * Shared by the store's own transform and the paste path, so a pasted copy
 * lands exactly where a move would have put it.
 */
export function transformSupportRecord(
    target: SupportTypeId | 'roots' | 'knots',
    record: Record<string, unknown>,
    delta: SupportDeltaTransform,
): Record<string, unknown> {
    const { matrix, normalMatrix, preserveRootZ } = delta;

    if (target === 'roots') {
        const root = record as unknown as Roots;
        return {
            ...root,
            transform: {
                ...root.transform,
                pos: preserveRootZ
                    ? transformVec3PreserveZ(root.transform.pos, matrix)
                    : transformVec3(root.transform.pos, matrix),
            },
        } as unknown as Record<string, unknown>;
    }

    if (target === 'knots') {
        const knot = record as unknown as Knot;
        return { ...knot, pos: transformVec3(knot.pos, matrix) } as unknown as Record<string, unknown>;
    }

    const descriptor = getSupportTypeDescriptor(target);
    let next: Record<string, unknown> | null = null;

    if (descriptor.hasSegments) {
        next = { ...record };
        next.segments = ((record.segments ?? []) as Segment[])
            .map((segment) => transformSegment(segment, matrix, normalMatrix));
    }

    for (const { kind, field } of contactEndpointsFor(descriptor.id)) {
        const contact = record[field];
        if (!contact) continue;
        if (!next) next = { ...record };
        next[field] = kind === 'disk'
            ? transformContactDisk(contact as never, matrix, normalMatrix)
            : transformContactCone(contact as never, matrix, normalMatrix);
    }

    for (const field of transformExtrasFor(descriptor.id)) {
        const value = record[field];
        if (!value) continue;
        if (!next) next = { ...record };
        next[field] = field === 'curve'
            ? {
                ...(value as BraceCurve),
                controlPoint1: transformVec3((value as BraceCurve).controlPoint1, matrix),
                controlPoint2: transformVec3((value as BraceCurve).controlPoint2, matrix),
                startTangent: transformDirection((value as BraceCurve).startTangent, normalMatrix),
                endTangent: transformDirection((value as BraceCurve).endTangent, normalMatrix),
            }
            : field === 'joint'
                ? { ...(value as Joint), pos: transformVec3((value as Joint).pos, matrix) }
                : transformVec3(value as Vec3, matrix);
    }

    // Nothing declared reaches this record: return it by reference, so a caller
    // that signals "unchanged" by identity still sees the original.
    return next ?? record;
}

function transformsRoughlyEqual(a: THREE.Matrix4, b: THREE.Matrix4, epsilon = 1e-8) {
    const ae = a.elements;
    const be = b.elements;
    for (let i = 0; i < 16; i += 1) {
        if (Math.abs(ae[i] - be[i]) > epsilon) return false;
    }
    return true;
}

function vectorsRoughlyEqual(a: THREE.Vector3, b: THREE.Vector3, epsilon = 1e-8) {
    return Math.abs(a.x - b.x) <= epsilon
        && Math.abs(a.y - b.y) <= epsilon
        && Math.abs(a.z - b.z) <= epsilon;
}

function eulersRoughlyEqual(a: THREE.Euler, b: THREE.Euler, epsilon = 1e-8) {
    return Math.abs(a.x - b.x) <= epsilon
        && Math.abs(a.y - b.y) <= epsilon
        && Math.abs(a.z - b.z) <= epsilon
        && a.order === b.order;
}
