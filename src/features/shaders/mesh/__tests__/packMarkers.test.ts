import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { packIslandMarkers } from '../packMarkers';
import { MAX_ISLAND_MARKERS } from '../softClay';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';

function makeMarker(overrides: Partial<IslandMarker> & { id: number; weight: number }): IslandMarker {
  return {
    centerX: 1,
    centerY: 2,
    baseZ: 3,
    pixelCount: 0,
    geometryHeight: 0,
    ...overrides,
  };
}

describe('packIslandMarkers', () => {
  it('returns zero count + zeroed buffer for empty input', () => {
    const a = packIslandMarkers([]);
    assert.equal(a.count, 0);
    assert.equal(a.markers.length, MAX_ISLAND_MARKERS * 4);
    assert.ok(a.markers.every((v) => v === 0));

    const b = packIslandMarkers(undefined);
    assert.equal(b.count, 0);
  });

  it('packs xyzw in order: centerX, centerY, baseZ, weight', () => {
    const r = packIslandMarkers([
      makeMarker({ id: 1, weight: 0.5, centerX: 10, centerY: 20, baseZ: 30 }),
    ]);
    assert.equal(r.count, 1);
    assert.equal(r.markers[0], 10);
    assert.equal(r.markers[1], 20);
    assert.equal(r.markers[2], 30);
    assert.equal(r.markers[3], 0.5);
  });

  it('skips negative-id markers (debug/seed)', () => {
    const r = packIslandMarkers([
      makeMarker({ id: -1, weight: 1 }),
      // weight 0.75 is exactly representable in Float32 (unlike 0.7 which
      // rounds to 0.6999... and breaks strictEqual).
      makeMarker({ id: 5, weight: 0.75, centerX: 9 }),
    ]);
    assert.equal(r.count, 1);
    assert.equal(r.markers[0], 9);
    assert.equal(r.markers[3], 0.75);
  });

  it('skips weight<=0 markers', () => {
    const r = packIslandMarkers([
      makeMarker({ id: 1, weight: 0 }),
      makeMarker({ id: 2, weight: -0.1 }),
      makeMarker({ id: 3, weight: 0.4, centerX: 7 }),
    ]);
    assert.equal(r.count, 1);
    assert.equal(r.markers[0], 7);
  });

  it('skips NaN weight (the <=0 form lets NaN through; we guard with !(>0))', () => {
    const r = packIslandMarkers([
      makeMarker({ id: 1, weight: Number.NaN }),
      makeMarker({ id: 2, weight: 0.5, centerX: 11 }),
    ]);
    assert.equal(r.count, 1);
    assert.equal(r.markers[0], 11);
  });

  it('skips markers with NaN coordinates', () => {
    const r = packIslandMarkers([
      makeMarker({ id: 1, weight: 0.5, centerX: Number.NaN }),
      makeMarker({ id: 2, weight: 0.5, centerY: Number.NaN }),
      makeMarker({ id: 3, weight: 0.5, baseZ: Number.NaN }),
      makeMarker({ id: 4, weight: 0.5, centerX: 13 }),
    ]);
    assert.equal(r.count, 1);
    assert.equal(r.markers[0], 13);
  });

  it('skips markers with Infinity coordinates', () => {
    const r = packIslandMarkers([
      makeMarker({ id: 1, weight: 0.5, baseZ: Number.POSITIVE_INFINITY }),
      makeMarker({ id: 2, weight: 0.5, centerX: Number.NEGATIVE_INFINITY }),
      makeMarker({ id: 3, weight: 0.5, centerY: 15 }),
    ]);
    assert.equal(r.count, 1);
    assert.equal(r.markers[1], 15);
  });

  it('caps at MAX_ISLAND_MARKERS', () => {
    const many: IslandMarker[] = Array.from({ length: MAX_ISLAND_MARKERS + 5 }, (_, i) =>
      makeMarker({ id: i + 1, weight: 1, centerX: i }),
    );
    const r = packIslandMarkers(many);
    assert.equal(r.count, MAX_ISLAND_MARKERS);
    // The (MAX+1)th and beyond aren't written into the buffer.
    assert.equal(r.markers[(MAX_ISLAND_MARKERS - 1) * 4 + 0], MAX_ISLAND_MARKERS - 1);
  });
});
