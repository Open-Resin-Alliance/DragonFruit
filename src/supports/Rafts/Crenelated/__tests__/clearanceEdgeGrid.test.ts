import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildClearanceEdgeGrid,
  gridSegmentBlocked,
  segmentDistanceMm,
  type PolygonWithHoles,
} from '../geometry/polygonSet2d';

/** The answer the clustering used to compute, against every edge in the set. */
function bruteForceBlocked(clearance: readonly PolygonWithHoles[], ax: number, ay: number, bx: number, by: number): boolean {
  for (const poly of clearance) {
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let k = 0; k < ring.length; k += 1) {
        const c = ring[k];
        const d = ring[(k + 1) % ring.length];
        if (segmentDistanceMm(ax, ay, bx, by, c.x, c.y, d.x, d.y) <= 0.001) return true;
      }
    }
  }
  return false;
}

function polygon(points: [number, number][], holes: [number, number][][] = []): PolygonWithHoles {
  return {
    outer: points.map(([x, y]) => ({ x, y })) as unknown as PolygonWithHoles['outer'],
    holes: holes.map((ring) => ring.map(([x, y]) => ({ x, y })) as unknown as PolygonWithHoles['outer']),
  } as PolygonWithHoles;
}

// A 100 mm plate with two model footprints and a hole in one of them.
const clearance: PolygonWithHoles[] = [
  polygon([[0, 0], [40, 0], [40, 30], [0, 30]], [[[10, 10], [20, 10], [20, 20], [10, 20]]]),
  polygon([[60, 40], [95, 40], [95, 80], [60, 80]]),
];

describe('clearance edge grid', () => {
  const grid = buildClearanceEdgeGrid(clearance)!;

  it('builds from a polygon set', () => {
    assert.ok(grid);
    // 4 outer + 4 hole + 4 outer edges.
    assert.strictEqual(grid.edges.length, 12 * 4);
  });

  it('returns null for an empty set', () => {
    assert.strictEqual(buildClearanceEdgeGrid([]), null);
  });

  it('agrees with the brute force answer over a sweep of segments', () => {
    // Deterministic sweep, not random: every case is reproducible on failure.
    let checked = 0;
    let blocked = 0;
    for (let ax = -10; ax <= 110; ax += 7) {
      for (let ay = -10; ay <= 100; ay += 11) {
        for (const [dx, dy] of [[3, 1], [-2, 5], [12, -8], [0, 0]] as const) {
          const bx = ax + dx;
          const by = ay + dy;
          const expected = bruteForceBlocked(clearance, ax, ay, bx, by);
          const actual = gridSegmentBlocked(grid, ax, ay, bx, by);
          assert.strictEqual(actual, expected, `segment (${ax},${ay})->(${bx},${by})`);
          checked += 1;
          if (expected) blocked += 1;
        }
      }
    }
    // Both answers must appear, or the sweep is not exercising anything.
    assert.ok(checked > 500, `checked ${checked}`);
    assert.ok(blocked > 50, `blocked ${blocked}`);
    assert.ok(blocked < checked - 50, `unblocked ${checked - blocked}`);
  });

  it('finds an edge a hair away, which is what the epsilon is for', () => {
    // A segment parallel to the bottom edge, 0.0005 mm above it.
    assert.strictEqual(gridSegmentBlocked(grid, 5, 0.0005, 35, 0.0005), true);
    assert.strictEqual(bruteForceBlocked(clearance, 5, 0.0005, 35, 0.0005), true);
    // And 0.002 mm above it is clear.
    assert.strictEqual(gridSegmentBlocked(grid, 5, 0.002, 35, 0.002), false);
    assert.strictEqual(bruteForceBlocked(clearance, 5, 0.002, 35, 0.002), false);
  });
});
