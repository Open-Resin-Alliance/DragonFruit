import { getSupportEntities, getSupportEntity } from '../../state';
import {
    FLEXING_KNOT_HOST_TYPES,
    getSupportTypeDescriptor,
    type SupportTypeId,
} from '../../supportTypeRegistry';
import type { ContactCone } from '../ContactCone/types';
import type { ElasticChainInitialState, ElasticChainResult } from '../../PlacementLogic/ElasticChainSolver';
import type { Segment, Vec3 } from '../../types';
import { getSocketPosition } from '../ContactCone';

/**
 * Applies one solved elastic chain to the shaft it came from.
 *
 * The entity is looked up by id alone, so every flexing type is written back
 * rather than only the one a call site named.
 */

/** Solved segments by shaft id, whichever type each shaft is. */
export type ShaftSegmentsById = Record<string, readonly Segment[]>;

const JOINT_EPSILON_MM = 0.0001;

/**
 * The shaft's segments with the solved joint positions written in, or null when
 * the solve moved nothing.
 */
export function applySolvedJoints(
    segments: readonly Segment[],
    result: ElasticChainResult,
): readonly Segment[] | null {
    let changed = false;

    const next = segments.map((seg) => {
        let segChanged = false;
        let newTopJoint = seg.topJoint;
        let newBottomJoint = seg.bottomJoint;

        if (seg.topJoint && result.jointPositions[seg.topJoint.id]) {
            const pos = result.jointPositions[seg.topJoint.id];
            if (Math.abs(pos.z - seg.topJoint.pos.z) > JOINT_EPSILON_MM) {
                newTopJoint = { ...seg.topJoint, pos };
                segChanged = true;
            }
        }

        if (seg.bottomJoint && result.jointPositions[seg.bottomJoint.id]) {
            const pos = result.jointPositions[seg.bottomJoint.id];
            if (Math.abs(pos.z - seg.bottomJoint.pos.z) > JOINT_EPSILON_MM) {
                newBottomJoint = { ...seg.bottomJoint, pos };
                segChanged = true;
            }
        }

        if (!segChanged) return seg;
        changed = true;
        return { ...seg, topJoint: newTopJoint, bottomJoint: newBottomJoint };
    });

    return changed ? next : null;
}

/** A flexing shaft the store still holds, by id alone -- its type is its own. */
export function getFlexingShaft(shaftId: string): { id: string; segments: Segment[] } | null {
    const entity = getSupportEntity(shaftId) as { id: string; segments?: Segment[] } | null;
    if (!entity?.segments) return null;
    return entity as { id: string; segments: Segment[] };
}

/**
 * Writes one solved chain into `into`.
 *
 * A shaft that moved gets its new segments; one that returned to its committed
 * geometry gets an explicit entry only when it already had a preview override,
 * so the caller can prune it. `keepSyncEntry` is that "already overridden" test
 * -- the release path drops such shafts instead, so it passes none.
 */
export function collectSolvedShaft(
    into: ShaftSegmentsById,
    shaftId: string,
    result: ElasticChainResult,
    keepSyncEntry?: (shaftId: string) => boolean,
): void {
    const shaft = getFlexingShaft(shaftId);
    if (!shaft) return;

    const solved = applySolvedJoints(shaft.segments, result);
    if (solved) {
        into[shaft.id] = solved;
    } else if (keepSyncEntry?.(shaft.id)) {
        into[shaft.id] = shaft.segments;
    } else {
        delete into[shaft.id];
    }
}

/** A flexing shaft, with the type it came from. */
export interface FlexingShaft {
    id: string;
    typeId: SupportTypeId;
    segments: Segment[];
}

/**
 * Every shaft that flexes off the given knots.
 *
 * Which types flex, and the field naming their host knot, are both declared:
 * scanning one type by one field would skip a second flexing type silently.
 */
export function flexingShaftsOn(knotIds: string | readonly string[]): FlexingShaft[] {
    const wanted = typeof knotIds === 'string' ? [knotIds] : knotIds;
    const found: FlexingShaft[] = [];

    for (const { typeId, knotFields } of FLEXING_KNOT_HOST_TYPES) {
        for (const entity of getSupportEntities<FlexingShaft>(typeId)) {
            const record = entity as unknown as Record<string, unknown>;
            const onKnot = knotFields.some((field) => {
                const value = record[field];
                return typeof value === 'string' && wanted.includes(value);
            });
            if (onKnot) found.push({ ...entity, typeId });
        }
    }

    return found;
}

/**
 * The shaft's contact, from the field its type declares for its upper endpoint.
 * Types spell it differently, so reading one name drops the others' tip.
 */
export function contactOf(shaft: { typeId: SupportTypeId }): ContactCone | undefined {
    const upper = getSupportTypeDescriptor(shaft.typeId).upper;
    if (!upper.field) return undefined;
    return (shaft as unknown as Record<string, ContactCone | undefined>)[upper.field];
}

/**
 * The elastic starting state for every shaft flexing off the given knots.
 *
 * The joint chain is read bottom-to-top, taking each segment's top joint and
 * falling back to the next segment's bottom joint where a segment carries only
 * one. The tip constraint uses the SOCKET position -- where the shaft meets the
 * contact -- not the tip that touches the model.
 */
export function captureFlexingShafts(
    knotIds: string | readonly string[],
    knotPos: Vec3,
): Record<string, ElasticChainInitialState> {
    const captured: Record<string, ElasticChainInitialState> = {};

    for (const shaft of flexingShaftsOn(knotIds)) {
        const joints: { id: string; pos: Vec3 }[] = [];

        for (let i = 0; i < shaft.segments.length; i += 1) {
            const seg = shaft.segments[i];
            const joint = seg.topJoint
                ?? (i < shaft.segments.length - 1 ? shaft.segments[i + 1].bottomJoint : undefined);
            if (joint) joints.push({ id: joint.id, pos: { ...joint.pos } });
        }

        const contact = contactOf(shaft);

        captured[shaft.id] = {
            shaftId: shaft.id,
            shaftTypeId: shaft.typeId,
            knotPos: { ...knotPos },
            joints,
            contactCone: contact
                ? { pos: getSocketPosition(contact.pos, contact.normal, contact.profile) }
                : undefined,
        };
    }

    return captured;
}
