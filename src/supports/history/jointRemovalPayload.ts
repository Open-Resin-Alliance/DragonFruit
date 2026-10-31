import { findShaftOwnerOfJoint, removeJointById } from '../state';
import { getSupportTypeDescriptor } from '../supportTypeRegistry';
import type { SupportTypeId } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import { captureSupportEditSnapshot } from './supportEditHistory';

/** What a joint removal records: one or the other, by what the type declares. */
export interface ResolvedJointRemoval {
    typeId: SupportTypeId;
    id: string;
    edit?: { before: unknown; after: unknown };
    snapshot?: { before: SupportState; after: SupportState };
}

/**
 * Removes one joint and resolves its undo entry. A type with no `historyUpdate`
 * records a snapshot, captured BEFORE the removal rebinds its knots.
 */
export function removeJointWithPayload(jointId: string): ResolvedJointRemoval | null {
    const owner = findShaftOwnerOfJoint(jointId);
    const needsSnapshot = !owner || !getSupportTypeDescriptor(owner.typeId).historyUpdate;
    const before = needsSnapshot ? captureSupportEditSnapshot().support : null;

    const result = removeJointById(jointId);
    if (!result) return null;

    const descriptor = getSupportTypeDescriptor(result.typeId);
    if (descriptor.historyUpdate) {
        return {
            typeId: result.typeId,
            id: result.id,
            edit: { before: result.before, after: result.after },
        };
    }

    return {
        typeId: result.typeId,
        id: result.id,
        snapshot: before
            ? { before, after: captureSupportEditSnapshot().support }
            : undefined,
    };
}
