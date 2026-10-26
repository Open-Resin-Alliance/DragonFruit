import {
    CONE_RATIO_BUCKETS_PER_UNIT,
    coneShapeRatio,
} from '../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import {
    contactEndpointsFor,
    getSupportTypeDescriptor,
    type SupportTypeId,
} from '../supportTypeRegistry';
import { quantizeToScale } from '@/utils/math';
import type { ConeBatchSlot, ConeProfileKind } from './coneSlots';
import { coneBatchSlotFromContact, type DragBatchBucket } from './dragSlots';

/**
 * The private slot map one contact-disk (tip) drag writes through an instanced
 * batch.
 *
 * Same contract as `dragSlots.ts`, one gesture smaller: a tip drag on a
 * cone-only type mutates exactly one `ContactCone` and nothing else in the
 * entity, so the whole gesture is one cone — one body bucket, one tip ball and,
 * for a `disk` profile, one nib.
 *
 * Everything here is pure. The predicate is derived from the registry and the
 * declared contact field, never from a list of type names: a type opts in by
 * declaring `tipDragRebuildsGeometry: false` AND naming the field as a `cone`
 * contact.
 */

/** The single cone a tip drag redraws, at the instances its batch draws it. */
export type ConeDragSlot = {
    id: string;
    /** The declared contact field the per-frame write re-reads the cone from. */
    field: string;
    kind: ConeProfileKind;
    /** Body batch key: `String(quantizeToScale(coneShapeRatio, 10))`. */
    bodyKey: string;
    /** The bucket's geometry ratio, which the body batch's template carries. */
    bodyRatio: number;
    bodyInstance: number;
    tipInstance: number;
    /** Whether the profile owns a nib; only `disk` does. */
    isDisk: boolean;
    /** Present only for a `disk` profile. */
    diskInstance?: number;
};

/** Everything one tip-drag gesture draws. `cones` always holds exactly one. */
export type ConeDragSlotMap = {
    typeId: SupportTypeId;
    supportId: string;
    /** The dragged support's model, for the detail palette the batch copies. */
    modelId?: string;
    /** The declared contact field this gesture writes. */
    field: string;
    /** The dragged cone's id, which is also the id suppression hides. */
    coneId: string;
    cones: ConeDragSlot[];
    coneBodyBuckets: DragBatchBucket[];
    counts: {
        cones: number;
        coneNibs: number;
    };
};

export type BuildConeDragSlotMapOptions = {
    typeId: SupportTypeId;
    /** The declared contact field the cone lives in (`contactCone`, `contactConeA`, ...). */
    field: string;
    /** The committed cone at pointer-down. */
    cone: ContactCone;
    /** The dragged support's id, recorded on the slot. */
    supportId: string;
    modelId?: string;
};

/**
 * Whether a tip drag on `typeId` can be drawn as instances.
 *
 * Two conditions, both declared by the type rather than inferred here:
 *
 * 1. the type does not rebuild geometry around the cone
 *    (`tipDragRebuildsGeometry: false`) — a branch re-searches its socket and
 *    rebuilds its shaft, a twig moves its disk-end joint and both disks;
 * 2. `field` is one of the type's own declared `cone` contacts — a field name
 *    that happens to hold a cone is not enough, and a `disk` contact (a twig's
 *    `contactDiskA`) is a different primitive entirely.
 *
 * A degenerate normal is not a reason to refuse the gesture: it is a reason to
 * refuse the FRAME, and `buildConeDragSlotMap` returns null for it.
 */
export function isConeOnlyTipDrag(
    typeId: SupportTypeId | null | undefined,
    field: string | null | undefined,
    cone: ContactCone | null | undefined,
): boolean {
    if (!typeId || !field || !cone) return false;
    if (getSupportTypeDescriptor(typeId).tipDragRebuildsGeometry) return false;

    const contact = contactEndpointsFor(typeId).find((entry) => entry.field === field);
    return !!contact && contact.kind === 'cone';
}

/**
 * Build the private slot map for one tip drag, or null when the gesture must
 * stay on the detail path.
 *
 * Null is the fallback signal, not an error: an undeclared type/field pair or a
 * cone whose normal is degenerate (the axis quaternion would be NaN, which is
 * why the scene batches drop those too) means the detail renderer keeps
 * drawing this drag.
 */
export function buildConeDragSlotMap(
    options: BuildConeDragSlotMapOptions,
): ConeDragSlotMap | null {
    const { typeId, field, cone, supportId } = options;
    if (!isConeOnlyTipDrag(typeId, field, cone)) return null;

    const slot = coneBatchSlotFromContact(cone, supportId, options.modelId);
    if (!slot) return null;

    const rawRatio = coneShapeRatio(cone);
    const bodyKey = String(quantizeToScale(rawRatio, CONE_RATIO_BUCKETS_PER_UNIT));
    const isDisk = slot.kind === 'disk';

    const coneSlot: ConeDragSlot = {
        id: cone.id,
        field,
        kind: slot.kind,
        bodyKey,
        bodyRatio: rawRatio,
        bodyInstance: 0,
        tipInstance: 0,
        isDisk,
        ...(isDisk ? { diskInstance: 0 } : {}),
    };

    return {
        typeId,
        supportId,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        field,
        coneId: cone.id,
        cones: [coneSlot],
        coneBodyBuckets: [{ key: bodyKey, ratio: rawRatio, instances: 1 }],
        counts: { cones: 1, coneNibs: isDisk ? 1 : 0 },
    };
}

/** The cone slot of a map; the gesture always has exactly one. */
export function coneDragSlotOf(slotMap: ConeDragSlotMap): ConeDragSlot {
    return slotMap.cones[0];
}

/**
 * The scratch slot a per-frame write reuses, so a hit allocates nothing.
 *
 * Exported for the writer and its parity test: the same shape the scene batches
 * fill for a cone, field for field.
 */
export function emptyConeDragBatchSlot(): ConeBatchSlot {
    return {
        id: '',
        supportId: '',
        pos: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 0 },
        surfaceNormal: { x: 0, y: 0, z: 0 },
        kind: 'legacy',
        lengthMm: 0,
        contactRadius: 0,
        diskThickness: 0,
        penetrationMm: 0,
    };
}
