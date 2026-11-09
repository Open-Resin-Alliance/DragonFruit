import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import type { Brace, Knot } from '../../types';

/**
 * How wide a brace is at each knot it spans: the knot's width less the joint
 * offset, capped by the brace's profile. Differing ends are what makes it taper.
 *
 * The renderer, the proxy layer and the exporter all draw the same brace.
 */
export function braceSpanDiameters(
    brace: Pick<Brace, 'profile'>,
    startKnot: Pick<Knot, 'diameter'> | undefined,
    endKnot: Pick<Knot, 'diameter'> | undefined,
): { startDiameterMm: number; endDiameterMm: number; isTapered: boolean } {
    const profileDiameter = Math.max(0.001, brace.profile?.diameter ?? 1);
    const atKnot = (knot: Pick<Knot, 'diameter'> | undefined) => Math.min(
        profileDiameter,
        Math.max(
            0.001,
            (knot?.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
        ),
    );

    const startDiameterMm = atKnot(startKnot);
    const endDiameterMm = atKnot(endKnot);
    return {
        startDiameterMm,
        endDiameterMm,
        isTapered: Math.abs(startDiameterMm - endDiameterMm) > 1e-4,
    };
}
