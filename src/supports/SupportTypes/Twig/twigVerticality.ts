import { shaftVerticalCos, type ShaftedEntity } from '../shaftVerticality';

/**
 * The verticality gate a twig must pass to be worth placing.
 *
 * A twig bridges two model contacts across a thin gap, and its ends are contact
 * disks — the standoff a sloped or sidewall landing needs shoves the sockets
 * sideways, so the built shaft can end up far more canted than the line between
 * the two contacts. Past a certain cant the result is a near-horizontal whisker
 * hanging the island off a strut that carries no peel load, which reads in the
 * preview as a diagonal crossing the gap rather than a support.
 *
 * Looser than the stick's 20°, and for a measured reason: measured thin-gap and
 * floor twigs build at ≤17°, pointed-tip props off a nearby wall with a real
 * drop underneath land 23–43°, and the grazers — the ones that read as useless
 * whiskers — start at 48°.
 *
 * This is a rule about twigs, so it lives with the twig, and it is enforced in
 * the twig's REGISTERED builder: every path that builds one is covered, instead
 * of only the cavity fallback, which used to carry its own copy of this check.
 */
export const MAX_TWIG_SHAFT_ANGLE_DEG = 45;

/** Whether a built twig stands vertical enough to keep. */
export function isTwigShaftVerticalEnough(entity: ShaftedEntity): boolean {
    return shaftVerticalCos(entity) >= Math.cos((MAX_TWIG_SHAFT_ANGLE_DEG * Math.PI) / 180);
}
