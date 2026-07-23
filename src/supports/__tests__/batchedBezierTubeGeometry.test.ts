import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
    buildBatchedBezierTubes,
    isCurvedBatchedShaft,
    resolveCurvedShaftIndexForFace,
} from '../Curves/batchedBezierTubeGeometry';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';

const RADIAL_SEGMENTS = 10;

function makeCurvedShaft(overrides: Partial<InstancedShaft> = {}): InstancedShaft {
    return {
        id: 'seg-1',
        start: { x: 0, y: 0, z: 0 },
        controlPoint1: { x: 0, y: 0, z: 5 },
        controlPoint2: { x: 6, y: 0, z: 10 },
        end: { x: 6, y: 0, z: 15 },
        diameter: 2,
        resolution: 16,
        supportId: 'trunk-1',
        ...overrides,
    };
}

function triangleCount(geometry: THREE.BufferGeometry): number {
    return geometry.getIndex()!.count / 3;
}

/**
 * A closed (watertight) triangle surface has every positional edge shared by
 * an even number of triangles, with matched opposing windings. Cap rims are
 * duplicated vertices, so compare positions (quantized), not vertex indices.
 */
function assertClosedSurface(geometry: THREE.BufferGeometry) {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const idx = geometry.getIndex()!;
    const keyOf = (v: number) => [
        Math.round(pos.getX(v) * 1e4),
        Math.round(pos.getY(v) * 1e4),
        Math.round(pos.getZ(v) * 1e4),
    ].join(',');

    // Track directed edges: a closed, consistently wound surface has every
    // directed edge cancelled by its reverse.
    const directed = new Map<string, number>();
    for (let t = 0; t < idx.count; t += 3) {
        const verts = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)].map(keyOf);
        for (let e = 0; e < 3; e += 1) {
            const a = verts[e];
            const b = verts[(e + 1) % 3];
            if (a === b) continue; // degenerate cap-center sliver, ignore
            const forward = `${a}|${b}`;
            const reverse = `${b}|${a}`;
            if ((directed.get(reverse) ?? 0) > 0) {
                directed.set(reverse, directed.get(reverse)! - 1);
            } else {
                directed.set(forward, (directed.get(forward) ?? 0) + 1);
            }
        }
    }
    const unmatched = Array.from(directed.values()).filter((count) => count !== 0);
    assert.strictEqual(unmatched.length, 0, `surface has ${unmatched.length} unmatched directed edges (open or inconsistently wound)`);
}

describe('isCurvedBatchedShaft', () => {
    it('detects curved entries by control-point presence', () => {
        assert.strictEqual(isCurvedBatchedShaft(makeCurvedShaft()), true);
        assert.strictEqual(isCurvedBatchedShaft({
            id: 's',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 0, y: 0, z: 1 },
            diameter: 1,
        }), false);
    });
});

describe('buildBatchedBezierTubes', () => {
    it('returns null for an empty list', () => {
        assert.strictEqual(buildBatchedBezierTubes([], RADIAL_SEGMENTS), null);
    });

    it('builds a closed tube whose surface follows the curve at the segment radius', () => {
        const shaft = makeCurvedShaft();
        const result = buildBatchedBezierTubes([shaft], RADIAL_SEGMENTS)!;

        assert.ok(result);
        assert.strictEqual(result.triangleRangeEnds.length, 1);
        assert.strictEqual(result.triangleRangeEnds[0], triangleCount(result.geometry));
        assert.ok(result.geometry.boundingSphere, 'bounding sphere must be precomputed');

        assertClosedSurface(result.geometry);

        // Every side vertex must sit ~radius away from the curve.
        const curve = new THREE.CubicBezierCurve3(
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 5),
            new THREE.Vector3(6, 0, 10),
            new THREE.Vector3(6, 0, 15),
        );
        const samples = curve.getPoints(400);
        const pos = result.geometry.getAttribute('position') as THREE.BufferAttribute;
        const sideVertexCount = (16 + 1) * (RADIAL_SEGMENTS + 1);
        const v = new THREE.Vector3();
        for (let i = 0; i < sideVertexCount; i += 1) {
            v.fromBufferAttribute(pos, i);
            let minDist = Infinity;
            for (const s of samples) minDist = Math.min(minDist, v.distanceTo(s));
            assert.ok(Math.abs(minDist - 1) < 0.05, `side vertex ${i} is ${minDist} from curve, expected ~1`);
        }
    });

    it('maps face indices back to the owning curve across multiple merged tubes', () => {
        const a = makeCurvedShaft({ id: 'seg-a' });
        const b = makeCurvedShaft({
            id: 'seg-b',
            start: { x: 20, y: 0, z: 0 },
            controlPoint1: { x: 20, y: 5, z: 4 },
            controlPoint2: { x: 24, y: 5, z: 8 },
            end: { x: 24, y: 0, z: 12 },
            resolution: 8,
        });
        const result = buildBatchedBezierTubes([a, b], RADIAL_SEGMENTS)!;

        assert.strictEqual(result.triangleRangeEnds.length, 2);
        const [endA, endB] = result.triangleRangeEnds;
        assert.strictEqual(endB, triangleCount(result.geometry));

        assert.strictEqual(resolveCurvedShaftIndexForFace(result.triangleRangeEnds, 0), 0);
        assert.strictEqual(resolveCurvedShaftIndexForFace(result.triangleRangeEnds, endA - 1), 0);
        assert.strictEqual(resolveCurvedShaftIndexForFace(result.triangleRangeEnds, endA), 1);
        assert.strictEqual(resolveCurvedShaftIndexForFace(result.triangleRangeEnds, endB - 1), 1);
        assert.strictEqual(resolveCurvedShaftIndexForFace(result.triangleRangeEnds, endB), -1);
        assert.strictEqual(resolveCurvedShaftIndexForFace(result.triangleRangeEnds, -1), -1);
        assert.strictEqual(resolveCurvedShaftIndexForFace([], 0), -1);
    });

    it('falls back to adaptive resolution when a curve does not specify one', () => {
        const shaft = makeCurvedShaft({ resolution: undefined });
        const result = buildBatchedBezierTubes([shaft], RADIAL_SEGMENTS)!;
        assert.ok(result);
        assert.ok(triangleCount(result.geometry) > 0);
        assertClosedSurface(result.geometry);
    });
});
