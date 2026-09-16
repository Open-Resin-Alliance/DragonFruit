/**
 * EscapeJointSearch — the whole route search for a support trunk.
 *
 * A trunk has to get from the contact-cone socket to a point it can drop from
 * straight down. Slicers solve that with one diagonal and one joint, and this
 * searches for exactly that: in each direction, walk outward along a 45° ray
 * until the column below clears. The direction search is the whole search; it
 * is what minimises how far the joint has to sit from the socket's own column,
 * and a joint closer to vertical is a stronger support.
 *
 * Why 45° and not "as steep as it can get": for a given lateral offset the 45°
 * point is the highest joint the ceiling allows (drop >= lateral), so it ends
 * the diagonal sooner and starts the vertical earlier than any steeper leg to
 * the same column, and its diagonal is the shortest. Steeper is legal but never
 * better, so the search never spends probes on it.
 *
 * What it deliberately is not:
 *
 * - Not a lattice search. No grid, no frontier, no cost function, no expansion
 *   budget, nothing to tune. Every candidate is tested against the signed
 *   distance field directly.
 * - Not a contour follower. The route never bends mid-air to hug the model: it
 *   leaves the socket once and drops once. Two segments, one joint.
 * - Not unbounded. The walk is capped by the lateral envelope, by the height
 *   available above the root, and by a hard probe budget, so a placement costs
 *   the same order of work whether the model is a cube or a skull.
 *
 * Cost is counted in SDF probes and reported back, so callers and tests can
 * hold it to a bound instead of trusting a comment.
 */

import type { Vec3 } from '../types';
import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';

export interface EscapeJointSearchOptions {
    /** Shaft keep-out radius: shaft radius + the global collision standoff. */
    clearanceMm: number;
    /** Lateral step of the outward walk, in mm. */
    stepMm: number;
    /** Hard cap on how far the joint may sit from the socket's own column. */
    maxLateralMm: number;
    /**
     * Lean ceiling from vertical, in degrees, as a ramp tried in order. The
     * first entry is the shape: a 45° diagonal out of the pocket. Later entries
     * exist only for obstacles no 45° leg can get around — the shaft still ends
     * in a single joint and a vertical drop, it just tilts further to clear.
     */
    leanRampFromVerticalDeg: number[];
    /** Shortest vertical leg worth having below the joint, in mm. */
    minVerticalLegMm: number;
    /**
     * Directions to try, in preference order, as unit XY vectors. The caller
     * orders them: the surface normal's outward direction first, because that
     * is the way off the surface the tip is attached to.
     */
    directions: Array<{ x: number; y: number }>;
    /** True when the roots volume can sit at this XY. */
    baseFitsAt: (x: number, y: number) => boolean;
}

export interface EscapeJoint {
    /** Where the diagonal ends and the vertical leg begins. */
    joint: Vec3;
    /** Lean of the diagonal, degrees from vertical. Never above the ceiling. */
    leanFromVerticalDeg: number;
    /** Lateral distance from the socket's column. */
    lateralMm: number;
    /** Index in `options.directions` that produced this joint. */
    directionIndex: number;
}

export interface EscapeJointSearchResult {
    joint: EscapeJoint | null;
    /** SDF probes spent: the unit of cost this search is held to. */
    probes: number;
    outcome: 'found' | 'no-direction' | 'never-cleared' | 'probe-budget';
}

/** Hard ceiling on SDF probes for one placement. */
const MAX_PROBES = 900;

const DEG = Math.PI / 180;

/**
 * Finds the joint: the first point, in the best direction, from which a
 * straight drop to `rootTopZ` is clear and can carry a root.
 *
 * `socketPos` is where the shaft leaves the contact cone. Returns `null` when
 * nothing inside the envelope works, which the caller treats as "no route"
 * rather than growing the search.
 */
export function findEscapeJoint(
    sdf: SDFCache,
    socketPos: Vec3,
    rootTopZ: number,
    opts: EscapeJointSearchOptions,
): EscapeJointSearchResult {
    let probes = 0;

    /** Is the column from this point down to the root clear? */
    const columnClear = (x: number, y: number, z: number): boolean => {
        probes++;
        return !sdf.segmentBlocked(x, y, z, x, y, rootTopZ, opts.clearanceMm);
    };
    /** Is this straight segment clear? Used on the leg, so a diagonal cannot tunnel through a thin wall. */
    const segmentClear = (from: Vec3, to: Vec3): boolean => {
        probes++;
        return !sdf.segmentBlocked(from.x, from.y, from.z, to.x, to.y, to.z, opts.clearanceMm);
    };

    const maxLateralMm = Math.min(opts.maxLateralMm, socketPos.z - rootTopZ - opts.minVerticalLegMm);
    if (maxLateralMm <= 0 || opts.directions.length === 0) {
        return { joint: null, probes, outcome: 'no-direction' };
    }

    for (let directionIndex = 0; directionIndex < opts.directions.length; directionIndex++) {
        const dir = opts.directions[directionIndex];

        for (const leanDeg of opts.leanRampFromVerticalDeg) {
            const sinLean = Math.sin(leanDeg * DEG);
            const cosLean = Math.cos(leanDeg * DEG);
            const maxTravelMm = maxLateralMm / sinLean;
            let previous = socketPos;

            for (let travelledMm = opts.stepMm; travelledMm <= maxTravelMm; travelledMm += opts.stepMm) {
                if (probes >= MAX_PROBES) {
                    return { joint: null, probes, outcome: 'probe-budget' };
                }

                const lateralMm = travelledMm * sinLean;
                const point: Vec3 = {
                    x: socketPos.x + lateralMm * dir.x,
                    y: socketPos.y + lateralMm * dir.y,
                    z: socketPos.z - travelledMm * cosLean,
                };
                if (point.z <= rootTopZ + opts.minVerticalLegMm) break;

                // The leg itself must stay clear. Without this, a diagonal
                // aimed across the model can punch through a thin wall and
                // emerge into open air on the far side, which would read as a
                // valid escape.
                if (!segmentClear(previous, point)) break;

                if (columnClear(point.x, point.y, point.z) && opts.baseFitsAt(point.x, point.y)) {
                    return {
                        joint: { joint: point, leanFromVerticalDeg: leanDeg, lateralMm, directionIndex },
                        probes,
                        outcome: 'found',
                    };
                }

                previous = point;
            }
        }
    }

    return { joint: null, probes, outcome: 'never-cleared' };
}

/**
 * Directions to try, in preference order: the outward direction the caller
 * cares about first, then its neighbours around the compass. A direction is
 * only ever a tie-break between equally good joints, so a coarse fan is enough.
 */
export function buildDirectionFan(preferred: { x: number; y: number } | null, count: number): Array<{ x: number; y: number }> {
    const directions: Array<{ x: number; y: number }> = [];
    const baseAngle = preferred ? Math.atan2(preferred.y, preferred.x) : 0;
    for (let i = 0; i < count; i++) {
        // Alternate either side of the preferred angle so the first few
        // candidates stay near the way off the surface.
        const offset = i === 0 ? 0 : (Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1) * 2 * Math.PI) / count;
        const angle = baseAngle + offset;
        directions.push({ x: Math.cos(angle), y: Math.sin(angle) });
    }
    return directions;
}
