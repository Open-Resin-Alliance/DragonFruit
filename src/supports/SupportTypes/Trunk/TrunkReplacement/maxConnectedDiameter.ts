import type { Branch, Knot, Leaf, Roots, SupportState, Trunk } from '../../../types';
import { getJointDiameter } from '../../../constants';
import { splitShaft } from '../../../SupportPrimitives/Joint/jointUtils';
import { getTrunkSegmentEndpoints } from '../../../SupportPrimitives/Knot/knotUtils';
import { getSettings } from '../../../Settings';

function maxNum(a: number, b: number) {
    return a > b ? a : b;
}

function getLeafDiameter(leaf: Leaf): number {
    const profile = leaf.contactCone?.profile;
    if (!profile) return 0;
    return Math.max(profile.bodyDiameterMm ?? 0, profile.contactDiameterMm ?? 0);
}

function collectSegmentDiameters(entity: { segments: { diameter: number }[] }): number {
    let max = 0;
    for (const seg of entity.segments ?? []) {
        if (typeof seg.diameter === 'number') max = maxNum(max, seg.diameter);
    }
    return max;
}

function braceSegmentKey(braceId: string) {
    return `braceSegment:${braceId}`;
}

function leafConeKey(leafId: string) {
    return `leafCone:${leafId}`;
}

/**
 * Computes the maximum "member diameter" across the entire connected support graph
 * reachable from a given trunk.
 */
export function computeMaxConnectedDiameterFromTrunk(snapshot: SupportState, trunkId: string): number {
    const trunk = snapshot.trunks[trunkId];
    if (!trunk) return 0;

    const visitedTrunks = new Set<string>();
    const visitedBranches = new Set<string>();
    const visitedTwigs = new Set<string>();
    const visitedSticks = new Set<string>();
    const visitedBraces = new Set<string>();
    const visitedLeaves = new Set<string>();
    const visitedKnots = new Set<string>();

    const trunkQueue: string[] = [trunkId];
    const branchQueue: string[] = [];
    const twigQueue: string[] = [];
    const stickQueue: string[] = [];
    const braceQueue: string[] = [];
    const leafQueue: string[] = [];
    const knotQueue: string[] = [];

    let maxDiameter = 0;

    while (
        trunkQueue.length ||
        branchQueue.length ||
        twigQueue.length ||
        stickQueue.length ||
        braceQueue.length ||
        leafQueue.length ||
        knotQueue.length
    ) {
        const take = <T>(q: T[]): T => q.pop() as T;

        if (trunkQueue.length) {
            const id = take(trunkQueue);
            if (visitedTrunks.has(id)) continue;
            visitedTrunks.add(id);

            const t = snapshot.trunks[id];
            if (!t) continue;

            maxDiameter = maxNum(maxDiameter, collectSegmentDiameters(t));

            const segIds = new Set(t.segments.map((s) => s.id));
            for (const knot of Object.values(snapshot.knots)) {
                if (segIds.has(knot.parentShaftId)) {
                    knotQueue.push(knot.id);
                }
            }

            continue;
        }

        if (branchQueue.length) {
            const id = take(branchQueue);
            if (visitedBranches.has(id)) continue;
            visitedBranches.add(id);

            const b = snapshot.branches[id];
            if (!b) continue;

            maxDiameter = maxNum(maxDiameter, collectSegmentDiameters(b));
            knotQueue.push(b.parentKnotId);

            const segIds = new Set(b.segments.map((s) => s.id));
            for (const knot of Object.values(snapshot.knots)) {
                if (segIds.has(knot.parentShaftId)) {
                    knotQueue.push(knot.id);
                }
            }

            continue;
        }

        if (twigQueue.length) {
            const id = take(twigQueue);
            if (visitedTwigs.has(id)) continue;
            visitedTwigs.add(id);

            const t = snapshot.twigs[id];
            if (!t) continue;
            maxDiameter = maxNum(maxDiameter, collectSegmentDiameters(t));

            const segIds = new Set(t.segments.map((s) => s.id));
            for (const knot of Object.values(snapshot.knots)) {
                if (segIds.has(knot.parentShaftId)) {
                    knotQueue.push(knot.id);
                }
            }

            continue;
        }

        if (stickQueue.length) {
            const id = take(stickQueue);
            if (visitedSticks.has(id)) continue;
            visitedSticks.add(id);

            const s = snapshot.sticks[id];
            if (!s) continue;
            maxDiameter = maxNum(maxDiameter, collectSegmentDiameters(s));

            const segIds = new Set(s.segments.map((s2) => s2.id));
            for (const knot of Object.values(snapshot.knots)) {
                if (segIds.has(knot.parentShaftId)) {
                    knotQueue.push(knot.id);
                }
            }

            continue;
        }

        if (braceQueue.length) {
            const id = take(braceQueue);
            if (visitedBraces.has(id)) continue;
            visitedBraces.add(id);

            const brace = snapshot.braces[id];
            if (!brace) continue;

            maxDiameter = maxNum(maxDiameter, brace.profile?.diameter ?? 0);
            knotQueue.push(brace.startKnotId);
            knotQueue.push(brace.endKnotId);

            const segKey = braceSegmentKey(id);
            for (const knot of Object.values(snapshot.knots)) {
                if (knot.parentShaftId === segKey) {
                    knotQueue.push(knot.id);
                }
            }

            continue;
        }

        if (leafQueue.length) {
            const id = take(leafQueue);
            if (visitedLeaves.has(id)) continue;
            visitedLeaves.add(id);

            const leaf = snapshot.leaves[id];
            if (!leaf) continue;

            maxDiameter = maxNum(maxDiameter, getLeafDiameter(leaf));
            knotQueue.push(leaf.parentKnotId);

            const segKey = leafConeKey(id);
            for (const knot of Object.values(snapshot.knots)) {
                if (knot.parentShaftId === segKey) {
                    knotQueue.push(knot.id);
                }
            }

            continue;
        }

        const knotId = take(knotQueue);
        if (visitedKnots.has(knotId)) continue;
        visitedKnots.add(knotId);

        const knot = snapshot.knots[knotId];
        if (!knot) continue;

        if (typeof knot.diameter === 'number') {
            maxDiameter = maxNum(maxDiameter, Math.max(0, knot.diameter - 0.1));
        }

        // Attached branches/leaves
        for (const b of Object.values(snapshot.branches)) {
            if (b.parentKnotId === knotId) branchQueue.push(b.id);
        }
        for (const l of Object.values(snapshot.leaves)) {
            if (l.parentKnotId === knotId) leafQueue.push(l.id);
        }

        // Braces connected to knot
        for (const br of Object.values(snapshot.braces)) {
            if (br.startKnotId === knotId || br.endKnotId === knotId) braceQueue.push(br.id);
        }

        // Segment ownership by parentShaftId (braceSegment / leafCone)
        if (knot.parentShaftId.startsWith('braceSegment:')) {
            const braceId = knot.parentShaftId.slice('braceSegment:'.length);
            braceQueue.push(braceId);
        }
        if (knot.parentShaftId.startsWith('leafCone:')) {
            const leafId = knot.parentShaftId.slice('leafCone:'.length);
            leafQueue.push(leafId);
        }

        // Segment ownership for shafts
        for (const t of Object.values(snapshot.trunks)) {
            if (t.segments.some((s) => s.id === knot.parentShaftId)) {
                trunkQueue.push(t.id);
                break;
            }
        }
        for (const b of Object.values(snapshot.branches)) {
            if (b.segments.some((s) => s.id === knot.parentShaftId)) {
                branchQueue.push(b.id);
                break;
            }
        }
        for (const t of Object.values(snapshot.twigs)) {
            if (t.segments.some((s) => s.id === knot.parentShaftId)) {
                twigQueue.push(t.id);
                break;
            }
        }
        for (const s of Object.values(snapshot.sticks)) {
            if (s.segments.some((seg) => seg.id === knot.parentShaftId)) {
                stickQueue.push(s.id);
                break;
            }
        }
    }

    return maxDiameter;
}

export function applyDiameterToTrunk(trunk: Trunk, diameterMm: number): Trunk {
    if (!Number.isFinite(diameterMm) || diameterMm <= 0) return trunk;

    const jointDiameter = getJointDiameter(diameterMm);
    const jointById = new Map<string, number>();

    const nextSegments = trunk.segments.map((seg) => {
        const nextTopJoint = seg.topJoint
            ? {
                ...seg.topJoint,
                diameter: jointById.get(seg.topJoint.id) ?? jointDiameter,
            }
            : seg.topJoint;

        if (nextTopJoint) jointById.set(nextTopJoint.id, nextTopJoint.diameter);

        const nextBottomJoint = seg.bottomJoint
            ? {
                ...seg.bottomJoint,
                diameter: jointById.get(seg.bottomJoint.id) ?? jointDiameter,
            }
            : seg.bottomJoint;

        if (nextBottomJoint) jointById.set(nextBottomJoint.id, nextBottomJoint.diameter);

        return {
            ...seg,
            diameter: diameterMm,
            topJoint: nextTopJoint,
            bottomJoint: nextBottomJoint,
        };
    });

    return {
        ...trunk,
        segments: nextSegments,
    };
}

function maxFinite(...values: Array<number | undefined | null>): number {
    let max = 0;
    for (const v of values) {
        if (typeof v === 'number' && Number.isFinite(v)) max = Math.max(max, v);
    }
    return max;
}

function branchDemandDiameterMm(branch: Branch): number {
    let max = 0;
    for (const seg of branch.segments ?? []) {
        if (typeof seg.diameter === 'number') max = Math.max(max, seg.diameter);
    }
    return max;
}

function inferTrunkBaseDiameterMm(trunk: Trunk, override?: number): number {
    const candidates: Array<number | undefined | null> = [override, trunk.baseDiameterMm];

    let minSegDia = Number.POSITIVE_INFINITY;
    for (const seg of trunk.segments ?? []) {
        if (typeof seg.diameter === 'number' && Number.isFinite(seg.diameter) && seg.diameter > 0) {
            minSegDia = Math.min(minSegDia, seg.diameter);
        }
    }
    if (minSegDia !== Number.POSITIVE_INFINITY) candidates.push(minSegDia);

    candidates.push(getSettings().shaft.diameterMm);

    for (const v of candidates) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
    return 0;
}

function trunkContactDemandDiameterMm(trunk: Trunk, baseShaftDiameterMm?: number): number {
    const topShaftDia = inferTrunkBaseDiameterMm(trunk, baseShaftDiameterMm);
    const profile = trunk.contactCone?.profile;
    const coneDemand = profile ? maxFinite(profile.bodyDiameterMm, profile.contactDiameterMm) : 0;
    return Math.max(0, topShaftDia, coneDemand);
}

function computeLinearT(
    pos: { x: number; y: number; z: number },
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number }
): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < 0.000001) return 0;
    const vx = pos.x - start.x;
    const vy = pos.y - start.y;
    const vz = pos.z - start.z;
    const t = (vx * dx + vy * dy + vz * dz) / lenSq;
    return Math.min(1, Math.max(0, t));
}

export type TrunkKnotUpdate = { before: Knot; after: Knot };

export function computeAndApplyTrunkDiameterProfile(
    snapshot: SupportState,
    trunkId: string,
    options?: { baseShaftDiameterMm?: number }
): { trunk: Trunk; knotUpdates: TrunkKnotUpdate[] } | null {
    const trunk = snapshot.trunks[trunkId];
    if (!trunk) return null;

    const root: Roots | undefined = snapshot.roots[trunk.rootId] ?? undefined;
    if (!root) return null;

    let nextTrunk: Trunk = structuredClone(trunk);
    const nextKnotById = new Map<string, Knot>();
    for (const k of Object.values(snapshot.knots)) {
        nextKnotById.set(k.id, structuredClone(k));
    }

    const beforeByKnotId = new Map<string, Knot>();
    const recordUpdate = (after: Knot) => {
        const before = snapshot.knots[after.id];
        if (!before) return;
        if (!beforeByKnotId.has(after.id)) beforeByKnotId.set(after.id, structuredClone(before));
        nextKnotById.set(after.id, after);
    };

    const branchesByParentKnotId = new Map<string, Branch[]>();
    for (const b of Object.values(snapshot.branches)) {
        if (!b?.parentKnotId) continue;
        const list = branchesByParentKnotId.get(b.parentKnotId);
        if (list) list.push(b);
        else branchesByParentKnotId.set(b.parentKnotId, [b]);
    }

    const epsT = 1e-6;
    const isNearlyZero = (t: number) => t <= epsT;
    const isNearlyOne = (t: number) => t >= 1 - epsT;

    const trunkKnotsWithBranches = Object.values(snapshot.knots)
        .filter((k) => trunk.segments.some((s) => s.id === k.parentShaftId))
        .filter((k) => (branchesByParentKnotId.get(k.id)?.length ?? 0) > 0)
        .sort((a, b) => b.pos.z - a.pos.z);

    // Split segments top-down so that each branch-attached knot becomes a segment boundary.
    for (const originalKnot of trunkKnotsWithBranches) {
        const knot = nextKnotById.get(originalKnot.id);
        if (!knot) continue;

        const segIndex = nextTrunk.segments.findIndex((s) => s.id === knot.parentShaftId);
        if (segIndex === -1) continue;

        const seg = nextTrunk.segments[segIndex];
        const endpoints = getTrunkSegmentEndpoints(nextTrunk, seg, segIndex, root);

        const existingT = typeof knot.t === 'number'
            ? Math.min(1, Math.max(0, knot.t))
            : endpoints
                ? computeLinearT(knot.pos, endpoints.start, endpoints.end)
                : 0;

        // If knot lies on the segment boundary, associate it with the thicker side (below).
        if (isNearlyZero(existingT)) {
            if (segIndex > 0) {
                const prevSeg = nextTrunk.segments[segIndex - 1];
                if (prevSeg) {
                    const after = { ...knot, parentShaftId: prevSeg.id, t: 1 };
                    if (after.parentShaftId !== knot.parentShaftId || after.t !== knot.t) recordUpdate(after);
                }
            }
            continue;
        }

        if (isNearlyOne(existingT)) {
            const after = { ...knot, t: 1 };
            if (after.t !== knot.t) recordUpdate(after);
            continue;
        }

        const splitT = existingT;
        const splitPoint = knot.pos;
        const segIdToSplit = seg.id;

        const trunkAfterSplit = splitShaft(nextTrunk, segIdToSplit, splitPoint, splitT, root);
        const bottomSegIndex = trunkAfterSplit.segments.findIndex((s) => s.id === segIdToSplit);
        if (bottomSegIndex === -1) {
            nextTrunk = trunkAfterSplit;
            continue;
        }

        const topSeg = trunkAfterSplit.segments[bottomSegIndex + 1];
        if (!topSeg) {
            nextTrunk = trunkAfterSplit;
            continue;
        }

        const topSegId = topSeg.id;

        // Rehost/rescale all trunk-hosted knots that were on the split segment.
        for (const k of nextKnotById.values()) {
            if (k.parentShaftId !== segIdToSplit) continue;

            const kt = typeof k.t === 'number'
                ? Math.min(1, Math.max(0, k.t))
                : endpoints
                    ? computeLinearT(k.pos, endpoints.start, endpoints.end)
                    : 0;

            // Attachments at boundary belong to thicker side (below): keep on bottom at t=1.
            if (Math.abs(kt - splitT) <= epsT) {
                const after = { ...k, parentShaftId: segIdToSplit, t: 1 };
                if (after.parentShaftId !== k.parentShaftId || after.t !== k.t) recordUpdate(after);
                continue;
            }

            if (kt < splitT) {
                const afterT = splitT <= epsT ? 0 : kt / splitT;
                const after = { ...k, parentShaftId: segIdToSplit, t: afterT };
                if (after.parentShaftId !== k.parentShaftId || after.t !== k.t) recordUpdate(after);
                continue;
            }

            const denom = 1 - splitT;
            const afterT = denom <= epsT ? 0 : (kt - splitT) / denom;
            const after = { ...k, parentShaftId: topSegId, t: afterT };
            if (after.parentShaftId !== k.parentShaftId || after.t !== k.t) recordUpdate(after);
        }

        nextTrunk = trunkAfterSplit;
    }

    // Demand at the top of each segment from any branch-attached knot anchored to that segment.
    const trunkSegIds = new Set(nextTrunk.segments.map((s) => s.id));
    const demandAtTopBySegId = new Map<string, number>();
    for (const knot of nextKnotById.values()) {
        if (!trunkSegIds.has(knot.parentShaftId)) continue;
        const attached = branchesByParentKnotId.get(knot.id);
        if (!attached || attached.length === 0) continue;
        if (typeof knot.t !== 'number' || knot.t < 1 - epsT) continue;

        let demand = 0;
        for (const b of attached) demand = Math.max(demand, branchDemandDiameterMm(b));

        const prev = demandAtTopBySegId.get(knot.parentShaftId) ?? 0;
        if (demand > prev) demandAtTopBySegId.set(knot.parentShaftId, demand);
    }

    // Apply stepwise diameters top -> bottom.
    const segDiameters: number[] = new Array(nextTrunk.segments.length);
    let runningMax = trunkContactDemandDiameterMm(nextTrunk, options?.baseShaftDiameterMm);
    for (let i = nextTrunk.segments.length - 1; i >= 0; i--) {
        const seg = nextTrunk.segments[i];
        const localDemand = demandAtTopBySegId.get(seg.id) ?? 0;
        runningMax = Math.max(runningMax, localDemand);
        segDiameters[i] = runningMax;
    }

    // Assign joint diameters to match thicker adjacent segment.
    const jointDiameterById = new Map<string, number>();
    for (let i = 0; i < nextTrunk.segments.length; i++) {
        const seg = nextTrunk.segments[i];
        const segDia = segDiameters[i] ?? seg.diameter;

        if (seg.bottomJoint) {
            const belowDia = i > 0 ? (segDiameters[i - 1] ?? nextTrunk.segments[i - 1]?.diameter) : segDia;
            const thick = Math.max(segDia, belowDia ?? segDia);
            const candidate = getJointDiameter(thick);
            const prev = jointDiameterById.get(seg.bottomJoint.id) ?? 0;
            jointDiameterById.set(seg.bottomJoint.id, Math.max(prev, candidate));
        }

        if (seg.topJoint) {
            const aboveDia = i + 1 < segDiameters.length ? (segDiameters[i + 1] ?? seg.diameter) : segDia;
            const thick = Math.max(segDia, aboveDia);
            const candidate = getJointDiameter(thick);
            const prev = jointDiameterById.get(seg.topJoint.id) ?? 0;
            jointDiameterById.set(seg.topJoint.id, Math.max(prev, candidate));
        }
    }

    const nextSegments = nextTrunk.segments.map((seg, idx) => {
        const segDia = segDiameters[idx] ?? seg.diameter;
        const topJoint = seg.topJoint
            ? {
                ...seg.topJoint,
                diameter: jointDiameterById.get(seg.topJoint.id) ?? seg.topJoint.diameter,
            }
            : seg.topJoint;

        const bottomJoint = seg.bottomJoint
            ? {
                ...seg.bottomJoint,
                diameter: jointDiameterById.get(seg.bottomJoint.id) ?? seg.bottomJoint.diameter,
            }
            : seg.bottomJoint;

        return {
            ...seg,
            diameter: segDia,
            topJoint,
            bottomJoint,
        };
    });

    const knotUpdates: TrunkKnotUpdate[] = [];
    for (const [id, before] of beforeByKnotId.entries()) {
        const after = nextKnotById.get(id);
        if (after) knotUpdates.push({ before, after });
    }

    return {
        trunk: {
            ...nextTrunk,
            segments: nextSegments,
        },
        knotUpdates,
    };
}
