/**
 * Zigzag chains: a continuous braced path where each link ends exactly
 * where the next begins, alternating trunk ends while climbing by the
 * edge rise (dz) each link — \/\/\/ instead of independent diagonals.
 * Unlike the fixed-interval ladder, the chain steps by its own rise so
 * consecutive links join seamlessly.
 *
 * The rise is normally the edge's horizontal span, but never less than
 * minRiseMm: a pair of nearly coincident trunks spans almost nothing, and
 * stepping by that span stacked one 45° stub per fraction of a millimeter —
 * the ultra-dense ladder that used to fill the gap. A floored link simply
 * steepens, and still begins where the previous one ended.
 */
import { AUTO_BRACING_HARD_RULES } from './settings';

export interface ZigZagEdge<E> {
    a: E;
    b: E;
    /** Horizontal distance between the ends — the per-link rise. */
    hDist: number;
}

const MAX_CHAIN_LINKS = 200;

export function runZigZagChain<E>(
    edges: ZigZagEdge<E>[],
    startZ: number,
    maxZ: number,
    firstSection: 'initial' | 'repeating',
    place: (
        low: E,
        high: E,
        section: 'initial' | 'repeating',
        atZ: number,
        minRiseMm: number,
    ) => void,
    minRiseMm: number = AUTO_BRACING_HARD_RULES.minZigZagRiseMm,
): void {
    edges.forEach((edge, edgeIndex) => {
        if (!(edge.hDist > 0)) return;
        // Climb at least minRiseMm per link: on a very short span the 45° link
        // would otherwise rise by almost nothing and the chain would pack an
        // unbounded number of stubs into the gap.
        const rise = Math.max(edge.hDist, minRiseMm);
        // Alternate the starting end per edge so neighboring chains mirror.
        let low = edgeIndex % 2 === 0 ? edge.a : edge.b;
        let high = edgeIndex % 2 === 0 ? edge.b : edge.a;
        let z = startZ;
        let section = firstSection;
        for (let link = 0; link < MAX_CHAIN_LINKS && z < maxZ; link++) {
            place(low, high, section, z, rise);
            z += rise;
            [low, high] = [high, low];
            section = 'repeating';
        }
    });
}
