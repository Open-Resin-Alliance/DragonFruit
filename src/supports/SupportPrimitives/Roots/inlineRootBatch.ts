import type { Vec3 } from '../../types';
import { inlineRootId, type SupportEndpoint } from '../../supportTypeRegistry';
import type { InstancedRoot } from './InstancedRootsGroup';

/**
 * The plate disc's own thickness, the same 0.1 the stump's proxy recipe and its
 * synthetic root use: an inline root has no `Roots` row whose `diskHeight` could
 * say.
 */
const INLINE_ROOT_DISK_HEIGHT_MM = 0.1;

function readVec3(value: unknown): Vec3 | null {
    if (!value || typeof value !== 'object') return null;
    const { x, y, z } = value as Vec3;
    return typeof x === 'number' && typeof y === 'number' && typeof z === 'number'
        ? { x, y, z }
        : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A batched plate root for a type whose root is geometry on the entity.
 *
 * An `inlineRoot` has no `Roots` row, so its dimensions come off the entity's own
 * fields, which its endpoint declares. Null when a declared field is missing or
 * is not a position — a half-built entity stays out of the batch rather than
 * appearing at the plate origin.
 *
 * A type declaring no top radius is a cylinder at the base width, and one
 * declaring no height is a disc alone.
 */
export function inlineRootBatchInstance(
    endpoint: SupportEndpoint,
    entity: { id: string; modelId?: string } & Record<string, unknown>,
): InstancedRoot | null {
    if (endpoint.kind !== 'inlineRoot' || !endpoint.field) return null;

    const basePos = readVec3(entity[endpoint.field]);
    const baseDiameter = readNumber(entity[endpoint.radiusField ?? '']);
    if (!basePos || baseDiameter === null) return null;

    const topDiameter = readNumber(entity[endpoint.topRadiusField ?? '']) ?? baseDiameter;
    const coneHeight = readNumber(entity[endpoint.heightField ?? '']) ?? 0;

    return {
        id: inlineRootId(entity.id),
        supportId: entity.id,
        modelId: entity.modelId,
        basePos,
        bottomRadius: Math.max(0.001, baseDiameter / 2),
        topRadius: Math.max(0.001, topDiameter / 2),
        effectiveDiskHeight: INLINE_ROOT_DISK_HEIGHT_MM,
        coneHeight: Math.max(0, coneHeight),
    };
}
