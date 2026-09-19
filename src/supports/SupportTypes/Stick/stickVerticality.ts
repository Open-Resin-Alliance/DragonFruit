import { shaftVerticalCos, type ShaftedEntity } from '../shaftVerticality';

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

/** Cant beyond this is a wedged stick, not a bridge (calibration knob). */
export const MAX_SHAFT_ANGLE_DEG = 20;

/** Whether a built stick stands vertical enough to keep. */
export function isShaftVerticalEnough(entity: ShaftedEntity): boolean {
    return shaftVerticalCos(entity) >= Math.cos((MAX_SHAFT_ANGLE_DEG * Math.PI) / 180);
}
