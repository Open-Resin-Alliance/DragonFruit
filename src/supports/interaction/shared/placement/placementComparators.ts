import type { Vec3 } from '../../../types';

/**
 * Value comparisons the placement stores share.
 *
 * A placement store guards every write so an unchanged snap target or hover
 * position does not re-render the scene. Which fields matter is per-type, but
 * two comparisons are not: a point, and the host snap target the two
 * shaft-snapping types both carry.
 */

/** Two points are the same point. */
export function vecEq(a: Vec3, b: Vec3): boolean {
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Where a placement snapped to on a host shaft.
 *
 * Branch and leaf snap to the same thing -- a point along a segment, carrying
 * that segment's diameter -- so they share the shape rather than each declaring
 * an inline anonymous one.
 */
export interface HostSnapTarget {
    targetId: string;
    snappedPos: Vec3;
    t?: number;
    hostDiameterMm?: number;
    hostSegmentId?: string;
}

/**
 * The same host snap target, field by field.
 *
 * Reference equality first because a store's setter is usually handed the very
 * object it last wrote; the field walk is what stops a fresh but identical
 * target from re-rendering.
 */
export function hostSnapTargetEq(a: HostSnapTarget | null, b: HostSnapTarget | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    return (
        a.targetId === b.targetId &&
        a.t === b.t &&
        a.hostDiameterMm === b.hostDiameterMm &&
        a.hostSegmentId === b.hostSegmentId &&
        vecEq(a.snappedPos, b.snappedPos)
    );
}

/**
 * Whether two hover positions match, tolerating both being absent.
 *
 * A hover position arrives fresh from a raycast every frame, so this compares
 * components rather than references.
 */
export function hoverPositionEq(a: Vec3 | null, b: Vec3 | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return vecEq(a, b);
}
