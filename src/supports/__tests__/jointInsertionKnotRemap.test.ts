import { describe, it } from 'node:test';
import assert from 'node:assert';
import { remapKnotAcrossSplit, calculateKnotPositionOnSegmentFromT } from '../SupportPrimitives/Knot/knotUtils';
import { splitShaft } from '../SupportPrimitives/Joint/jointUtils';
import { subdivideCubicBezier, getBezierPointAtT } from '../Curves/BezierUtils';
import type { Knot, Trunk, Roots, Vec3, BezierSegment, StraightSegment } from '../types';

// Issue #204: inserting a joint splits a host segment into a bottom half (keeps the
// original id) and a top half (new id). Attached knots must be re-anchored so their
// absolute world position does not change, otherwise branches/leaves slide down.

const dist = (a: Vec3, b: Vec3) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function makeKnot(overrides: Partial<Knot>): Knot {
    return {
        id: 'knot-1',
        parentShaftId: 'seg-orig',
        t: 0.5,
        pos: { x: 0, y: 0, z: 0 },
        ...overrides,
    };
}

describe('remapKnotAcrossSplit', () => {
    it('returns null when the knot is not on the split segment', () => {
        const knot = makeKnot({ parentShaftId: 'other-seg' });
        assert.strictEqual(remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 0.5), null);
    });

    it('returns null when the knot has no t', () => {
        const knot = makeKnot({ t: undefined });
        assert.strictEqual(remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 0.5), null);
    });

    it('returns null for a degenerate split at t≈0 or t≈1 (no safe rescale)', () => {
        const knot = makeKnot({ t: 0.5 });
        assert.strictEqual(remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 0), null);
        assert.strictEqual(remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 1), null);
    });

    it('keeps a below-split knot on the bottom segment and rescales t = t/splitT', () => {
        const knot = makeKnot({ t: 0.2 });
        const remap = remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 0.5);
        assert.ok(remap);
        assert.strictEqual(remap!.parentShaftId, 'seg-orig');
        assert.ok(Math.abs(remap!.t - 0.4) < 1e-9); // 0.2 / 0.5
    });

    it('moves an above-split knot to the top segment and rescales t = (t-splitT)/(1-splitT)', () => {
        const knot = makeKnot({ t: 0.8 });
        const remap = remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 0.5);
        assert.ok(remap);
        assert.strictEqual(remap!.parentShaftId, 'seg-top');
        assert.ok(Math.abs(remap!.t - 0.6) < 1e-9); // (0.8 - 0.5) / 0.5
    });

    it('keeps a knot exactly at the split on the bottom segment (t = 1)', () => {
        const knot = makeKnot({ t: 0.5 });
        const remap = remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', 0.5);
        assert.ok(remap);
        assert.strictEqual(remap!.parentShaftId, 'seg-orig');
        assert.ok(Math.abs(remap!.t - 1) < 1e-9);
    });
});

describe('remap preserves world position on a STRAIGHT segment', () => {
    it('the rescaled t on the correct half maps to the same world point', () => {
        const start: Vec3 = { x: 0, y: 0, z: 0 };
        const end: Vec3 = { x: 0, y: 0, z: 10 };
        const straight: StraightSegment = { id: 'seg-orig', diameter: 1, type: 'straight' };

        const splitT = 0.3;
        const split: Vec3 = { x: 0, y: 0, z: 3 };

        for (const originalT of [0.1, 0.3, 0.55, 0.9]) {
            const worldBefore = calculateKnotPositionOnSegmentFromT(start, end, straight, originalT);
            const knot = makeKnot({ t: originalT });
            const remap = remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', splitT)!;

            const half = remap.parentShaftId === 'seg-orig'
                ? { s: start, e: split }
                : { s: split, e: end };
            const worldAfter = calculateKnotPositionOnSegmentFromT(half.s, half.e, straight, remap.t);

            assert.ok(dist(worldBefore, worldAfter) < 1e-6, `t=${originalT} drifted ${dist(worldBefore, worldAfter)}`);
        }
    });
});

describe('remap preserves world position on a BEZIER segment', () => {
    it('rescaled t on the matching sub-curve reproduces the original curve point', () => {
        const p0: Vec3 = { x: 0, y: 0, z: 0 };
        const cp1: Vec3 = { x: 4, y: 0, z: 2 };
        const cp2: Vec3 = { x: 4, y: 0, z: 8 };
        const p3: Vec3 = { x: 0, y: 0, z: 10 };

        const splitT = 0.4;
        const [leftCurve, rightCurve] = subdivideCubicBezier(p0, cp1, cp2, p3, splitT);

        // Bottom half keeps original id; top half is the right sub-curve.
        const bottomSeg: BezierSegment = {
            id: 'seg-orig', diameter: 1, type: 'bezier',
            controlPoint1: leftCurve[1], controlPoint2: leftCurve[2],
            startTangent: { x: 0, y: 0, z: 1 }, endTangent: { x: 0, y: 0, z: 1 },
            tension: 0.5, bias: 0.5, resolution: 16,
        };
        const topSeg: BezierSegment = {
            id: 'seg-top', diameter: 1, type: 'bezier',
            controlPoint1: rightCurve[1], controlPoint2: rightCurve[2],
            startTangent: { x: 0, y: 0, z: 1 }, endTangent: { x: 0, y: 0, z: 1 },
            tension: 0.5, bias: 0.5, resolution: 16,
        };

        for (const originalT of [0.1, 0.4, 0.65, 0.95]) {
            const worldBefore = getBezierPointAtT(p0, cp1, cp2, p3, originalT);
            const knot = makeKnot({ t: originalT });
            const remap = remapKnotAcrossSplit(knot, 'seg-orig', 'seg-orig', 'seg-top', splitT)!;

            const worldAfter = remap.parentShaftId === 'seg-orig'
                ? calculateKnotPositionOnSegmentFromT(leftCurve[0], leftCurve[3], bottomSeg, remap.t)
                : calculateKnotPositionOnSegmentFromT(rightCurve[0], rightCurve[3], topSeg, remap.t);

            assert.ok(dist(worldBefore, worldAfter) < 1e-6, `bezier t=${originalT} drifted ${dist(worldBefore, worldAfter)}`);
        }
    });
});

describe('splitShaft emits knot remaps for attached knots', () => {
    const root: Roots = {
        id: 'root-1',
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        diskHeight: 0,
        coneHeight: 0,
    } as unknown as Roots;

    const trunk: Trunk = {
        id: 'trunk-1',
        rootId: 'root-1',
        modelId: 'model-1',
        segments: [
            { id: 'seg-orig', diameter: 1, type: 'straight', topJoint: { id: 'j-top', pos: { x: 0, y: 0, z: 10 }, diameter: 1.5 } } as StraightSegment,
        ],
    } as unknown as Trunk;

    it('splits the segment and rehosts an above-split knot onto the new top segment', () => {
        const knots: Record<string, Knot> = {
            'k-below': makeKnot({ id: 'k-below', parentShaftId: 'seg-orig', t: 0.2 }),
            'k-above': makeKnot({ id: 'k-above', parentShaftId: 'seg-orig', t: 0.8 }),
            'k-other': makeKnot({ id: 'k-other', parentShaftId: 'seg-elsewhere', t: 0.5 }),
        };

        const { trunk: after, knotRemaps } = splitShaft(trunk, 'seg-orig', { x: 0, y: 0, z: 5 }, 0.5, root, knots);

        // Bottom keeps original id, top is new.
        assert.strictEqual(after.segments.length, 2);
        assert.strictEqual(after.segments[0].id, 'seg-orig');
        const topId = after.segments[1].id;
        assert.notStrictEqual(topId, 'seg-orig');

        // Only the two knots on seg-orig are remapped.
        assert.strictEqual(knotRemaps.length, 2);
        const below = knotRemaps.find((r) => r.knotId === 'k-below')!;
        const above = knotRemaps.find((r) => r.knotId === 'k-above')!;
        assert.strictEqual(below.parentShaftId, 'seg-orig');
        assert.ok(Math.abs(below.t - 0.4) < 1e-9);
        assert.strictEqual(above.parentShaftId, topId);
        assert.ok(Math.abs(above.t - 0.6) < 1e-9);
    });

    it('emits no remaps when no knots are supplied', () => {
        const { knotRemaps } = splitShaft(trunk, 'seg-orig', { x: 0, y: 0, z: 5 }, 0.5, root);
        assert.strictEqual(knotRemaps.length, 0);
    });
});
