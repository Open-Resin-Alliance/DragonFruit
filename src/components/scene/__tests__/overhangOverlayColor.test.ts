import assert from 'node:assert/strict';
import test from 'node:test';

import { formationOverhangColor, toppleVertexWeights } from '../IslandOverhangOverlay';

const FORMATION_ORANGE = '#ffa500';

test('formation overhangs keep the flat orange', () => {
    assert.equal(`#${formationOverhangColor().getHexString()}`, FORMATION_ORANGE);
});

/** Two triangles sharing an edge, as welded positions (9 floats per triangle). */
function twoTriangles(): number[] {
    return [
        0, 0, 0, 1, 0, 0, 0, 1, 0, // shares the 0,0,0 - 1,0,0 edge
        0, 0, 0, 1, 0, 0, 1, 1, 0,
    ];
}

test('a shared vertex carries the average of the faces meeting there', () => {
    // Share 1.0 on one side of the seam, 0.0 on the other: the two vertices on
    // the seam must come out at 0.5, or the boundary steps at the triangle edge
    // (the staircase this exists to remove).
    const w = toppleVertexWeights(twoTriangles(), [1, 0]);
    // Vertices 0 and 1 are the shared seam, in both triangles.
    for (const v of [0, 1, 3, 4]) {
        assert.equal(w[v], 0.5, `seam vertex ${v} averages (got ${w[v]})`);
    }
    // The two tips keep their own face's value.
    assert.equal(w[2], 1, 'first triangle tip');
    assert.equal(w[5], 0, 'second triangle tip');
});

test('an unshared vertex keeps its own share', () => {
    const lone = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const w = toppleVertexWeights(lone, [0.75]);
    assert.deepEqual([...w], [0.75, 0.75, 0.75]);
});

test('the field stays finite and in range', () => {
    const w = toppleVertexWeights(twoTriangles(), [1, 1]);
    for (const value of w) {
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `weight ${value}`);
    }
    // A missing share reads as no load rather than NaN.
    const missing = toppleVertexWeights(twoTriangles(), [1]);
    for (const value of missing) assert.ok(Number.isFinite(value), `weight ${value}`);
});
