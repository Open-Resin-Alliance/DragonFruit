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
     * Directions to try, as unit XY vectors, in preference order. The caller
     * orders them: the surface normal's outward direction first, because that
     * is the way off the surface the tip is attached to. Order decides ties
     * only, since the search keeps looking for a joint closer to the socket's
     * own column than the one it already has.
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
    /** Index in `options.directions` that produced this joint. Absent for the grid search. */
    directionIndex?: number;
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

    // The objective is the lateral offset: everything below the joint is
    // vertical, so the closer the joint sits to the socket's own column, the
    // more of the support is a plain pillar. `directions` is therefore a
    // preference order for ties, not a decision: taking the first direction to
    // succeed is what produced supports that set off one way and then leaned
    // out until some column cleared, when a neighbouring direction had a closer
    // one all along.
    let best: EscapeJoint | null = null;

    for (let directionIndex = 0; directionIndex < opts.directions.length; directionIndex++) {
        const dir = opts.directions[directionIndex];

        for (const leanDeg of opts.leanRampFromVerticalDeg) {
            const sinLean = Math.sin(leanDeg * DEG);
            const cosLean = Math.cos(leanDeg * DEG);
            // Once a joint is in hand, every remaining walk only has to beat it.
            const lateralLimitMm = best ? best.lateralMm : maxLateralMm;
            const maxTravelMm = lateralLimitMm / sinLean;
            let previous = socketPos;

            for (let travelledMm = opts.stepMm; travelledMm <= maxTravelMm; travelledMm += opts.stepMm) {
                if (probes >= MAX_PROBES) {
                    return best
                        ? { joint: best, probes, outcome: 'found' }
                        : { joint: null, probes, outcome: 'probe-budget' };
                }

                const lateralMm = travelledMm * sinLean;
                if (best && lateralMm >= best.lateralMm) break;
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
                    best = { joint: point, leanFromVerticalDeg: leanDeg, lateralMm, directionIndex };
                    // This walk cannot beat itself: lateral only grows along it.
                    break;
                }

                previous = point;
            }
        }
    }

    if (best) return { joint: best, probes, outcome: 'found' };
    return { joint: null, probes, outcome: 'never-cleared' };
}

export interface GridJointSearchOptions {
    /** Shaft keep-out radius: shaft radius + the global collision standoff. */
    clearanceMm: number;
    /** Lattice spacing. The candidate joints are the nodes of this lattice. */
    spacingMm: number;
    /** Hard cap on how far the joint may sit from the socket's own column. */
    maxLateralMm: number;
    /** Lean ramp from vertical, in degrees, tried in order. See `findEscapeJoint`. */
    leanRampFromVerticalDeg: number[];
    /** Shortest vertical leg worth having below the joint, in mm. */
    minVerticalLegMm: number;
    /** How many of the nearest nodes to try before giving up. */
    maxNodeCount: number;
    /**
     * The direction the shaft is already travelling in, as the horizontal
     * component of the cone axis. Among nodes at the same distance the ones
     * nearest this direction are tried first, so the escape keeps leaving the
     * way it started instead of hunting sideways for a node. Null when the
     * direction is degenerate (a flat ceiling), where any node is as good.
     */
    preferredDirection: { x: number; y: number } | null;
    /** True when the roots volume can sit at this XY. */
    baseFitsAt: (x: number, y: number) => boolean;
}

/**
 * The grid-mode search: the same gates as `findEscapeJoint`, but the candidate
 * joints are lattice nodes rather than free points along a ray.
 *
 * What differs is where the vertical leg lands. The free search drops as soon
 * as the column below is clear, which puts the base wherever that happens to
 * be. Grid mode has to land the drop on a node, so it chooses the node first
 * and derives the joint from it: the drop is `lateral / tan(lean)`, which makes
 * the vertical leg exactly vertical by construction. Nodes are walked
 * nearest-first, so the joint stays as close to the socket's own column as the
 * model allows, and the first node that satisfies every gate wins.
 */
export function findGridJoint(
    sdf: SDFCache,
    socketPos: Vec3,
    rootTopZ: number,
    opts: GridJointSearchOptions,
): EscapeJointSearchResult {
    let probes = 0;

    const columnClear = (x: number, y: number, z: number): boolean => {
        probes++;
        return !sdf.segmentBlocked(x, y, z, x, y, rootTopZ, opts.clearanceMm);
    };
    const segmentClear = (from: Vec3, to: Vec3): boolean => {
        probes++;
        return !sdf.segmentBlocked(from.x, from.y, from.z, to.x, to.y, to.z, opts.clearanceMm);
    };

    const maxLateralMm = Math.min(opts.maxLateralMm, socketPos.z - rootTopZ - opts.minVerticalLegMm);
    if (maxLateralMm <= 0 || opts.spacingMm <= 0) {
        return { joint: null, probes, outcome: 'no-direction' };
    }

    // The lattice is the one the grid keys are named on: multiples of the
    // spacing, so a node round-trips through `gridNodeKeyFromXY`.
    const originX = Math.round(socketPos.x / opts.spacingMm) * opts.spacingMm;
    const originY = Math.round(socketPos.y / opts.spacingMm) * opts.spacingMm;

    /**
     * Tests one node, all leans. Split out so the ring walk below stays a walk:
     * enumerating and sorting the whole lattice square would cost thousands of
     * allocations for what is usually an answer on the first node.
     */
    const tryNode = (ix: number, iy: number): EscapeJointSearchResult | null => {
        const x = originX + ix * opts.spacingMm;
        const y = originY + iy * opts.spacingMm;
        const lateralMm = Math.hypot(x - socketPos.x, y - socketPos.y);
        if (lateralMm > maxLateralMm) return null;

        for (const leanDeg of opts.leanRampFromVerticalDeg) {
            if (probes >= MAX_PROBES) {
                return { joint: null, probes, outcome: 'probe-budget' };
            }

            // A shallower lean reaches the node with less drop, which lifts the
            // joint and lengthens the vertical leg. The ramp runs from the
            // shape's 45 degrees outwards only because a wide obstacle can
            // leave the 45 degree path blocked.
            const dropMm = lateralMm / Math.tan(leanDeg * DEG);
            const z = socketPos.z - dropMm;
            if (z <= rootTopZ + opts.minVerticalLegMm) continue;

            const joint: Vec3 = { x, y, z };
            if (!segmentClear(socketPos, joint)) continue;
            if (!columnClear(x, y, z)) continue;
            if (!opts.baseFitsAt(x, y)) continue;
            return {
                joint: { joint, leanFromVerticalDeg: leanDeg, lateralMm },
                probes,
                outcome: 'found',
            };
        }
        return null;
    };

    // Square rings outwards from the socket's own node, so the nearest node that
    // works is the one that wins. Within a ring the nodes sit at similar
    // distances, so that is where direction is decided: nearest the direction
    // the shaft is already travelling first, which is what keeps the escape
    // going one way instead of sideways to whichever node the lattice offers.
    const preferredAngle = opts.preferredDirection
        ? Math.atan2(opts.preferredDirection.y, opts.preferredDirection.x)
        : null;
    const maxRings = Math.ceil(maxLateralMm / opts.spacingMm);
    let tested = 0;
    for (let ring = 0; ring <= maxRings; ring++) {
        const offsets: Array<{ ix: number; iy: number; deviation: number }> = [];
        for (let ix = -ring; ix <= ring; ix++) {
            for (let iy = -ring; iy <= ring; iy++) {
                if (ring > 0 && Math.abs(ix) !== ring && Math.abs(iy) !== ring) continue;
                const dx = originX + ix * opts.spacingMm - socketPos.x;
                const dy = originY + iy * opts.spacingMm - socketPos.y;
                const deviation = preferredAngle === null || (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9)
                    ? 0
                    : Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - preferredAngle),
                        Math.cos(Math.atan2(dy, dx) - preferredAngle)));
                offsets.push({ ix, iy, deviation });
            }
        }
        offsets.sort((a, b) => a.deviation - b.deviation);
        for (const offset of offsets) {
            const attempt = tryNode(offset.ix, offset.iy);
            if (attempt) return attempt;
            tested++;
            if (tested >= opts.maxNodeCount) {
                return { joint: null, probes, outcome: 'probe-budget' };
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
