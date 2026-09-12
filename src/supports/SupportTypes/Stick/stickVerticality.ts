/**
 * The verticality gate a stick must pass to be worth placing.
 *
 * A stick is a vertical bridge between two model contacts. Surface-normal
 * standoffs shove its sockets sideways on sloped surfaces, and past a certain
 * cant the result is a wedged stick rather than a bridge -- so the placement
 * that produced it is rejected and the caller falls back.
 *
 * This is a rule about sticks, so it lives with the stick.
 */

interface ShaftedEntity {
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

/** Cant beyond this is a wedged stick, not a bridge (calibration knob). */
export const MAX_SHAFT_ANGLE_DEG = 20;

/** Whether a built stick stands vertical enough to keep. */
export function isShaftVerticalEnough(entity: ShaftedEntity): boolean {
    return shaftVerticalCos(entity) >= Math.cos((MAX_SHAFT_ANGLE_DEG * Math.PI) / 180);
}
