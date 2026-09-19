/**
 * A reference implementation of `computeMaxConnectedDiameterFromTrunk`, for the
 * derived walk to be compared against. It covers neither stumps nor kickstands,
 * which is the one place the two are expected to disagree.
 */

import type { Leaf, SupportState } from '../../types';
import type { SupportTypeId } from '../../supportTypeRegistry';
import { contactEndpointsFor, SUPPORT_TYPES } from '../../supportTypeRegistry';
import { entitiesIn, keyOf } from '../helpers/typeCollections';

/** The type this reference is written around: the one carrying a cone at both ends. */
const SUBJECT_TYPE: SupportTypeId = (() => {
    const twoEnded = SUPPORT_TYPES.find(
        (descriptor) => contactEndpointsFor(descriptor.id).filter((endpoint) => endpoint.kind === 'cone').length === 2,
    );
    if (!twoEnded) throw new Error('no declared type carries a cone at both ends');
    return twoEnded.id;
})();

function maxNum(a: number, b: number) {
    return a > b ? a : b;
}

function getLeafDiameter(leaf: Leaf): number {
    const profile = leaf.contactCone?.profile;
    if (!profile) return 0;
    return Math.max(profile.bodyDiameterMm ?? 0, profile.contactDiameterMm ?? 0);
}

function collectSegmentDiameters(entity: { segments: Array<{ diameter?: number }> }): number {
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


/** What this arm reads off a bridge: the segments whose ends the span runs between. */
interface BridgeEntity {
    id: string;
    segments: Array<{ id: string; diameter?: number }>;
}

export function originalMaxConnectedDiameterFromTrunk(snapshot: SupportState, trunkId: string): number {
    const trunk = snapshot.trunks[trunkId];
    if (!trunk) return 0;

    // The stick arm's own collection, keyed by the registry rather than by a
    // property name: `SupportState` calls it whatever the registry declares.
    const sticks = entitiesIn<BridgeEntity>(snapshot, keyOf(SUBJECT_TYPE));
    const stickById = new Map(sticks.map((stick) => [stick.id, stick]));

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

            const s = stickById.get(id);
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
        for (const s of sticks) {
            if (s.segments.some((seg) => seg.id === knot.parentShaftId)) {
                stickQueue.push(s.id);
                break;
            }
        }
    }

    return maxDiameter;
}
