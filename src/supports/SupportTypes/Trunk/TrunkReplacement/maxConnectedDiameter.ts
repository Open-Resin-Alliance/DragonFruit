import type { Branch, Knot, Leaf, Roots, SupportState, Trunk } from '../../../types';
import { getJointDiameter } from '../../../constants';
import { splitShaft } from '../../../SupportPrimitives/Joint/jointUtils';
import { resolveSegmentEndpoints } from '../../../SupportPrimitives/Knot/segmentEndpoints';
import { getSettings } from '../../../Settings/state';
import { getSupportTypeDescriptor, SUPPORT_TYPES, type SupportTypeDescriptor, type SupportTypeId } from '../../../supportTypeRegistry';

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

/**
 * The diameter a support contributes to its connected graph.
 *
 * A shafted type reports its widest segment; a brace its profile; a leaf its
 * contact cone.
 */
function memberDiameterOf(descriptor: SupportTypeDescriptor, entity: Record<string, unknown>): number {
    if (descriptor.hasSegments) {
        return collectSegmentDiameters(entity as unknown as { segments: { diameter: number }[] });
    }

    const profileDiameter = (entity.profile as { diameter?: number } | undefined)?.diameter;
    if (typeof profileDiameter === 'number') return profileDiameter;

    if (entity.contactCone) return getLeafDiameter(entity as unknown as Leaf);
    return 0;
}

/** Which support a shaft id belongs to, prefix forms included. */
function ownerOfShaft(snapshot: SupportState, shaftId: string): { typeId: SupportTypeId; id: string } | null {
    if (!shaftId) return null;

    for (const descriptor of SUPPORT_TYPES) {
        const prefix = descriptor.segmentSelectionPrefix;
        if (!prefix || !shaftId.startsWith(prefix)) continue;
        const ownerId = shaftId.slice(prefix.length);
        const collection = snapshot[descriptor.location.key] as unknown as Record<string, unknown>;
        return collection?.[ownerId] ? { typeId: descriptor.id, id: ownerId } : null;
    }

    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.hasSegments) continue;
        const collection = snapshot[descriptor.location.key] as unknown as Record<string, { id: string; segments?: { id: string }[] }>;
        for (const entity of Object.values(collection ?? {})) {
            if (entity.segments?.some((segment) => segment.id === shaftId)) {
                return { typeId: descriptor.id, id: entity.id };
            }
        }
    }
    return null;
}


function leafConeKey(leafId: string) {
    return `leafCone:${leafId}`;
}

/**
 * Computes the maximum "member diameter" across the entire connected support graph
 * reachable from a given trunk.
 */
export function computeMaxConnectedDiameterFromTrunk(snapshot: SupportState, trunkId: string): number {
    if (!snapshot.trunks[trunkId]) return 0;

    // Knots by the shaft they sit on, built once. Each arm of the walk this
    // replaces scanned every knot in the store, per entity visited.
    const knotIdsByShaft = new Map<string, string[]>();
    for (const knot of Object.values(snapshot.knots)) {
        const list = knotIdsByShaft.get(knot.parentShaftId);
        if (list) list.push(knot.id);
        else knotIdsByShaft.set(knot.parentShaftId, [knot.id]);
    }

    // Entities by the knot they hang from, by declared `hostedBy knots` edges.
    const entitiesByKnot = new Map<string, { typeId: SupportTypeId; id: string }[]>();
    for (const descriptor of SUPPORT_TYPES) {
        const knotEdges = descriptor.edges.filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy');
        if (knotEdges.length === 0) continue;

        const collection = snapshot[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;
        for (const entity of Object.values(collection ?? {})) {
            for (const edge of knotEdges) {
                const knotId = entity[edge.field];
                if (typeof knotId !== 'string') continue;
                const entry = { typeId: descriptor.id, id: entity.id as string };
                const list = entitiesByKnot.get(knotId);
                if (list) list.push(entry);
                else entitiesByKnot.set(knotId, [entry]);
            }
        }
    }

    /** The shaft ids a knot can name for this entity: real segments, or a prefix. */
    const shaftKeysOf = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>): string[] => {
        if (descriptor.segmentSelectionPrefix) return [`${descriptor.segmentSelectionPrefix}${entity.id}`];
        const segments = (entity.segments as { id: string }[] | undefined) ?? [];
        return segments.map((segment) => segment.id);
    };

    const visitedSupports = new Set<string>();
    const visitedKnots = new Set<string>();
    const supportQueue: { typeId: SupportTypeId; id: string }[] = [{ typeId: 'trunk', id: trunkId }];
    const knotQueue: string[] = [];

    let maxDiameter = 0;

    while (supportQueue.length || knotQueue.length) {
        const next = supportQueue.pop();
        if (next) {
            if (visitedSupports.has(next.id)) continue;
            visitedSupports.add(next.id);

            const descriptor = getSupportTypeDescriptor(next.typeId);
            const entity = (snapshot[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>)[next.id];
            if (!entity) continue;

            maxDiameter = maxNum(maxDiameter, memberDiameterOf(descriptor, entity));

            // Knots sitting on this support's shaft, and the knots it hangs from.
            for (const shaftKey of shaftKeysOf(descriptor, entity)) {
                for (const knotId of knotIdsByShaft.get(shaftKey) ?? []) knotQueue.push(knotId);
            }
            for (const edge of descriptor.edges) {
                if (edge.to !== 'knots' || edge.ownership !== 'hostedBy') continue;
                const knotId = entity[edge.field];
                if (typeof knotId === 'string') knotQueue.push(knotId);
            }

            // A leaf's cone is addressed as a shaft too, so a knot can sit on it.
            for (const knotId of knotIdsByShaft.get(leafConeKey(next.id)) ?? []) knotQueue.push(knotId);

            continue;
        }

        const knotId = knotQueue.pop() as string;
        if (visitedKnots.has(knotId)) continue;
        visitedKnots.add(knotId);

        const knot = snapshot.knots[knotId];
        if (!knot) continue;

        if (typeof knot.diameter === 'number') {
            maxDiameter = maxNum(maxDiameter, Math.max(0, knot.diameter - 0.1));
        }

        for (const entry of entitiesByKnot.get(knotId) ?? []) supportQueue.push(entry);

        // The shaft this knot sits on is part of the same graph.
        const owner = ownerOfShaft(snapshot, knot.parentShaftId);
        if (owner) supportQueue.push(owner);
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

    const leavesByParentKnotId = new Map<string, Leaf[]>();
    for (const l of Object.values(snapshot.leaves)) {
        if (!l?.parentKnotId) continue;
        const list = leavesByParentKnotId.get(l.parentKnotId);
        if (list) list.push(l);
        else leavesByParentKnotId.set(l.parentKnotId, [l]);
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
        const endpoints = resolveSegmentEndpoints('trunk', nextTrunk, seg, segIndex, { root });

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

        // This caller performs its own knot rehosting below, so it does not pass
        // knots into splitShaft and only consumes the trunk.
        const { trunk: trunkAfterSplit } = splitShaft(nextTrunk, segIdToSplit, splitPoint, splitT, root);
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

    // Demand at the top of each segment from any branch/leaf-attached knot
    // anchored to that segment. Auto merge/fan knots carry no `t` — the
    // demand applies to the knot's own segment regardless (the stepwise
    // running max thickens that segment and everything below it).
    const trunkSegIds = new Set(nextTrunk.segments.map((s) => s.id));
    const demandAtTopBySegId = new Map<string, number>();
    for (const knot of nextKnotById.values()) {
        if (!trunkSegIds.has(knot.parentShaftId)) continue;
        const attachedBranches = branchesByParentKnotId.get(knot.id);
        const attachedLeaves = leavesByParentKnotId.get(knot.id);
        const n = (attachedBranches?.length ?? 0) + (attachedLeaves?.length ?? 0);
        if (n === 0) continue;

        let memberDemand = 0;
        for (const b of attachedBranches ?? []) memberDemand = Math.max(memberDemand, branchDemandDiameterMm(b));
        for (const l of attachedLeaves ?? []) memberDemand = Math.max(memberDemand, getLeafDiameter(l));

        // The host matches its fattest member — no per-attachment growth.
        // The old +10%/member calibration made a uniform-band chunk tree
        // bulge at the attachment knot (thick lower shaft, thin canopy) —
        // a diameter step with no load story, especially jarring on light
        // tiers. A host still thickens when a member is genuinely fatter.
        const demand = memberDemand;

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

/**
 * Forest-wide diameter resize (auto-support plan step 5).
 *
 * Re-derives every trunk's stepwise diameter profile from its final
 * attachment tree, so a trunk carrying four branches gets thicker where it
 * carries them while a lone trunk stays at its placed (empirical) diameter.
 *
 * Pure: returns an updated snapshot (trunks + rehosted knots). Trunks are
 * processed sequentially so a later trunk sees the earlier rehosts; the
 * per-trunk profile only touches that trunk's own segments/knots, so order
 * does not change the result.
 */
export function computeForestDiameterProfile(snapshot: SupportState): SupportState {
    let working = snapshot;
    for (const trunkId of Object.keys(snapshot.trunks)) {
        const applied = computeAndApplyTrunkDiameterProfile(working, trunkId);
        if (!applied) continue;

        let nextKnots = working.knots;
        for (const u of applied.knotUpdates) {
            nextKnots = { ...nextKnots, [u.after.id]: u.after };
        }
        working = {
            ...working,
            trunks: { ...working.trunks, [applied.trunk.id]: applied.trunk },
            knots: nextKnots,
        };
    }
    return working;
}
