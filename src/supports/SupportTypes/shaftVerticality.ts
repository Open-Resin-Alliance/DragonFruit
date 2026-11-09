/**
 * Shaft-axis geometry shared by the types that gate on it (sticks, twigs).
 *
 * The RULES live with their types — `Stick/stickVerticality.ts` and
 * `Twig/twigVerticality.ts` — because the cant a 12mm column tolerates is not
 * the cant a 1mm strut tolerates. This is only the measurement they share.
 */

export interface ShaftedEntity {
    segments: {
        bottomJoint?: { pos: { x: number; y: number; z: number } } | null;
        topJoint?: { pos: { x: number; y: number; z: number } } | null;
    }[];
}

/** |cos| of the shaft's deviation from vertical, 1 = perfectly vertical. */
export function shaftVerticalCos(entity: ShaftedEntity): number {
    const seg = entity.segments[0];
    const a = seg?.bottomJoint?.pos;
    const b = seg?.topJoint?.pos;
    if (!a || !b) return 1;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const vz = b.z - a.z;
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-6) return 1;
    return Math.abs(vz) / len;
}
