import assert from 'node:assert/strict';
import test from 'node:test';

import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { computeIslandMarkers } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { IslandTracker } from '@/volumeAnalysis/IslandScan/islandTracker';
import { rleEncode, rleEncodeLabels, rleLabelComponents, type RleLabels, type RleMask } from '@/volumeAnalysis/IslandScan/rle';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import { TerritoryTracker } from '@/volumeAnalysis/TerritorySystem/TerritoryTracker';
import { calculateIslandVolume } from '@/volumeAnalysis/VoxelSystem/IslandVolume';

function paintBox(buf: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      buf[y * w + x] = 1;
    }
  }
}

function runSolidMasks(
  masks: RleMask[],
  finalize: boolean,
  options?: { minOverlapPx?: number; overlapNeighborhoodPx?: number; radiusPx?: number; connectivity?: 4 | 8 },
): { tracker: IslandTracker; labels: RleLabels[] } {
  const tracker = new IslandTracker(0.1, options ?? { minOverlapPx: 1, overlapNeighborhoodPx: 1, connectivity: 8 });
  const labels: RleLabels[] = [];
  let prevIl: RleLabels | null = null;

  for (let l = 0; l < masks.length; l++) {
    const mask = masks[l];
    const { labels: compLabels, components } = rleLabelComponents(mask, options?.connectivity ?? 8);
    const il = tracker.processLayer(l, compLabels, components, prevIl, mask);
    labels.push(il);
    prevIl = il;
  }

  if (finalize && masks.length > 0) {
    tracker.finalizeIslands(masks.length - 1);
  }
  return { tracker, labels };
}

function collectLabelIds(labels: RleLabels): number[] {
  const ids = new Set<number>();
  for (const row of labels.rows) {
    for (let i = 0; i < row.length; i += 3) {
      if (row[i + 2] > 0) ids.add(row[i + 2]);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

test('FLD-05 TS: L=0 grounded body immediately absorbs hanging fold without PendingMerge (even via radiusPx)', () => {
  const w = 24;
  const h = 12;
  const numLayers = 36;
  const masks: RleMask[] = [];

  const d0 = new Uint8Array(w * h);
  paintBox(d0, w, 2, 4, 2, 4); // small L=0 body (4 px)
  masks.push(rleEncode(d0, w, h));

  const d1 = new Uint8Array(d0);
  paintBox(d1, w, 10, 20, 2, 8); // large L=1 hanging fold (60 px)
  masks.push(rleEncode(d1, w, h));

  const dUpper = new Uint8Array(w * h);
  paintBox(dUpper, w, 2, 20, 3, 4);
  paintBox(dUpper, w, 10, 20, 2, 8);
  const mUpper = rleEncode(dUpper, w, h);
  for (let l = 2; l < numLayers; l++) {
    masks.push(mUpper);
  }

  const { tracker, labels } = runSolidMasks(masks, true, { minOverlapPx: 1, radiusPx: 1, connectivity: 8 });
  const islands = tracker.getIslands();

  assert.equal(islands.some((i) => i.isMergedPlaceholder), false, 'must not create PendingMerge placeholder');
  const body = islands.find((i) => i.firstLayer === 0)!;
  const fold = islands.find((i) => i.firstLayer === 1)!;

  assert.equal(body.status, 'active');
  assert.equal(body.lastLayer, 35);
  assert.equal(body.parentId, undefined);
  assert.ok(body.childIds.includes(fold.id));

  assert.equal(fold.status, 'complete');
  assert.equal(fold.lastLayer, 1);
  assert.equal(fold.parentId, body.id);

  for (let l = 2; l < numLayers; l++) {
    assert.deepEqual(collectLabelIds(labels[l]), [body.id]);
  }
});

test('FLD-05 TS: two grounded bodies absorb fold and reparent fold on finalize', () => {
  const w = 24;
  const h = 10;
  const numLayers = 10;
  const masks: RleMask[] = [];

  const d0 = new Uint8Array(w * h);
  paintBox(d0, w, 1, 4, 2, 6);
  paintBox(d0, w, 15, 19, 2, 6);
  masks.push(rleEncode(d0, w, h));

  const d1 = new Uint8Array(d0);
  paintBox(d1, w, 7, 12, 2, 6);
  masks.push(rleEncode(d1, w, h));

  const dBar = new Uint8Array(w * h);
  paintBox(dBar, w, 1, 19, 2, 6);
  const mBar = rleEncode(dBar, w, h);
  for (let l = 2; l < numLayers; l++) masks.push(mBar);

  const { tracker } = runSolidMasks(masks, false);
  const preIslands = tracker.getIslands();
  const preFold = preIslands.find((i) => i.firstLayer === 1 && !i.isMergedPlaceholder)!;
  const placeholder = preIslands.find((i) => i.isMergedPlaceholder)!;
  assert.equal(preFold.status, 'complete');
  assert.equal(preFold.lastLayer, 1);
  assert.equal(preFold.parentId, placeholder.id);

  tracker.finalizeIslands(numLayers - 1);
  const postIslands = tracker.getIslands();
  const winner = postIslands.find((i) => i.firstLayer === 0 && i.parentId === undefined)!;
  const otherGrounded = postIslands.find((i) => i.firstLayer === 0 && i.id !== winner.id)!;
  const fold = postIslands.find((i) => i.id === preFold.id)!;
  const postPlaceholder = postIslands.find((i) => i.id === placeholder.id)!;

  assert.equal(postPlaceholder.status, 'complete');
  assert.equal(postPlaceholder.parentId, winner.id);
  assert.equal(fold.parentId, winner.id);
  assert.equal(otherGrounded.parentId, winner.id);
  assert.ok(winner.childIds.includes(fold.id));
  assert.ok(winner.childIds.includes(otherGrounded.id));
});

test('FLD-05 TS: floating L>0 merges complete placeholder at +30 and route +31..35 stats to winner', () => {
  const w = 20;
  const h = 10;
  const numLayers = 36;
  const masks: RleMask[] = [];

  masks.push(rleEncode(new Uint8Array(w * h), w, h));

  const d1 = new Uint8Array(w * h);
  paintBox(d1, w, 1, 7, 2, 6); // 24 px
  paintBox(d1, w, 12, 14, 2, 4); // 4 px
  masks.push(rleEncode(d1, w, h));

  const dBar = new Uint8Array(w * h);
  paintBox(dBar, w, 1, 14, 2, 6);
  const mBar = rleEncode(dBar, w, h);
  for (let l = 2; l < numLayers; l++) masks.push(mBar);

  const { tracker } = runSolidMasks(masks, false);
  const islands = tracker.getIslands();
  const placeholder = islands.find((i) => i.isMergedPlaceholder)!;
  const winner = islands.find((i) => !i.isMergedPlaceholder && i.parentId === undefined)!;

  assert.equal(placeholder.status, 'complete');
  assert.equal(placeholder.parentId, winner.id);
  assert.equal(winner.status, 'active');
  assert.equal(winner.lastLayer, 35);
  for (let l = 33; l <= 35; l++) {
    assert.ok(winner.perLayerAreaMm2.has(l), `winner must retain post-window layer ${l}`);
  }
});

test('FLD-05 TS: chained floating merges < 30 layers apart flush placeholder and remap preMergeLabels', () => {
  const w = 24;
  const h = 10;
  const numLayers = 37;
  const masks: RleMask[] = [];

  masks.push(rleEncode(new Uint8Array(w * h), w, h));

  const d1 = new Uint8Array(w * h);
  paintBox(d1, w, 1, 7, 2, 6);   // A: 24 px
  paintBox(d1, w, 9, 11, 2, 4);  // B: 4 px
  paintBox(d1, w, 16, 20, 2, 5); // C: 12 px
  masks.push(rleEncode(d1, w, h));

  const d2 = new Uint8Array(w * h);
  paintBox(d2, w, 1, 11, 2, 6);
  paintBox(d2, w, 16, 20, 2, 5);
  const m2 = rleEncode(d2, w, h);
  for (let l = 2; l <= 4; l++) masks.push(m2);

  const d5 = new Uint8Array(w * h);
  paintBox(d5, w, 1, 20, 2, 6);
  const m5 = rleEncode(d5, w, h);
  for (let l = 5; l < numLayers; l++) masks.push(m5);

  const { tracker } = runSolidMasks(masks, true);
  const islands = tracker.getIslands();
  const placeholders = islands.filter((i) => i.isMergedPlaceholder);
  assert.equal(placeholders.length, 2);
  for (const p of placeholders) {
    assert.equal(p.status, 'complete');
    assert.notEqual(p.parentId, undefined);
    const parent = islands.find((i) => i.id === p.parentId)!;
    assert.equal(Boolean(parent.isMergedPlaceholder), false, 'placeholder must never win election');
  }

  const roots = islands.filter((i) => !i.isMergedPlaceholder && i.parentId === undefined);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].lastLayer, 36);
  assert.equal(roots[0].status, 'active');
  assert.ok((roots[0].perLayerAreaMm2.get(1) ?? 0) > 0.20, 'A (24 px) must win election');
});

test('FLD-05 TS: top-30-layer merge resolves via finalizeIslands', () => {
  const w = 20;
  const h = 10;
  const numLayers = 11;
  const masks: RleMask[] = [];

  masks.push(rleEncode(new Uint8Array(w * h), w, h));

  const d1 = new Uint8Array(w * h);
  paintBox(d1, w, 1, 7, 2, 6);   // 24 px
  paintBox(d1, w, 12, 14, 2, 4); // 4 px
  masks.push(rleEncode(d1, w, h));

  const dBar = new Uint8Array(w * h);
  paintBox(dBar, w, 1, 14, 2, 6);
  const mBar = rleEncode(dBar, w, h);
  for (let l = 2; l < numLayers; l++) masks.push(mBar);

  const { tracker } = runSolidMasks(masks, true);
  const islands = tracker.getIslands();
  const placeholder = islands.find((i) => i.isMergedPlaceholder)!;
  const winner = islands.find((i) => !i.isMergedPlaceholder && i.parentId === undefined)!;

  assert.equal(placeholder.status, 'complete');
  assert.equal(placeholder.parentId, winner.id);
  assert.equal(winner.lastLayer, 10);
});

test('FLD-05 Consumer: computeIslandMarkers renders surviving merged parents and skips placeholders', () => {
  const w = 4;
  const h = 4;
  const l0 = new Int32Array(w * h);
  l0[0] = 1;
  const l1 = new Int32Array(w * h);
  l1[1] = 2;
  const l2 = new Int32Array(w * h);
  l2[0] = 3;
  l2[1] = 3;

  const makeIsland = (id: number, firstLayer: number, lastLayer: number, childIds: number[], parentId?: number, isMergedPlaceholder?: boolean): Island => ({
    id,
    firstLayer,
    lastLayer,
    status: isMergedPlaceholder || parentId !== undefined ? 'complete' : 'active',
    totalAreaMm2: 1,
    perLayerAreaMm2: new Map([[firstLayer, 1]]),
    parentId,
    childIds,
    isMergedPlaceholder,
    centroidSumX: 0,
    centroidSumY: 0,
    centroidSumZ: firstLayer,
    centroidCount: 1,
  });

  const scanResults: ScanResults = {
    grid: { originX: 0, originZ: 0, width: w, height: h, px_mm: 0.5 },
    layers: [],
    firstHit: new Int16Array(w * h),
    lastHit: new Int16Array(w * h),
    baseFootprint: new Uint8Array(w * h),
    baseLabels: new Int32Array(w * h),
    compBase: new Int16Array([-1, 0, 1, 2]),
    compTop: new Int16Array([-1, 2, 1, 2]),
    islands: [
      makeIsland(1, 0, 2, [2, 3], undefined, false),
      makeIsland(2, 1, 1, [], 1, false),
      makeIsland(3, 2, 2, [], 1, true),
    ],
    islandLabelsPerLayer: [
      rleEncodeLabels(l0, w, h),
      rleEncodeLabels(l1, w, h),
      rleEncodeLabels(l2, w, h),
    ],
  };

  const markers = computeIslandMarkers(scanResults, { min: { z: 0 } }, 0.25);
  try {
    const markerIds = markers.map((m) => m.id).sort((a, b) => a - b);
    assert.deepEqual(markerIds, [1, 2], 'surviving merged parent (1) must render and placeholder (3) must be skipped');
    const parentMarker = markers.find((m) => m.id === 1)!;
    assert.equal(parentMarker.baseZ, 0);
  } finally {
    markers.forEach((m) => m.geometry?.dispose());
  }
});

test('FLD-05 Consumer: TerritoryTracker Battle Path clamps vertical lookahead for tall active body', () => {
  const tallBody: Island = {
    id: 1,
    firstLayer: 0,
    lastLayer: 100,
    status: 'active',
    totalAreaMm2: 100,
    perLayerAreaMm2: new Map(),
    childIds: [],
    centroidSumX: 10,
    centroidSumY: 10,
    centroidSumZ: 100,
    centroidCount: 1,
    centroid: { x: 10, y: 10, z: 100 },
    lastLayerCentroid: { x: 10, y: 10, z: 100 },
  };
  const terminatedFold: Island = {
    id: 2,
    firstLayer: 2,
    lastLayer: 5,
    status: 'complete',
    totalAreaMm2: 5,
    perLayerAreaMm2: new Map(),
    childIds: [],
    centroidSumX: 12,
    centroidSumY: 10,
    centroidSumZ: 5,
    centroidCount: 1,
    centroid: { x: 12, y: 10, z: 5 },
    lastLayerCentroid: { x: 12, y: 10, z: 5 },
  };

  const tt = new TerritoryTracker([tallBody, terminatedFold]);
  const w = 20;
  const h = 20;

  // Previous layer (L=5) had pixel (10, 10) owned by fold 2
  const prevGrid = new Int32Array(w * h);
  prevGrid[10 * w + 10] = 2;
  const prevMap = rleEncodeLabels(prevGrid, w, h);

  // Layer 6 has pixel (10, 10) belonging to tallBody 1; Battle Path compares distSq3D at z=6
  const currGrid = new Int32Array(w * h);
  currGrid[10 * w + 10] = 1;
  const currMap = rleEncodeLabels(currGrid, w, h);

  const res = tt.processLayer(currMap, w, h, 6, prevMap);
  assert.equal(res.labelMap.rows[10][2], 1, 'tall active body must keep crease pixel at its XY center');
});

test('FLD-05 Consumer: calculateIslandVolume includes lastLayer without double subtraction in both branches', () => {
  const w = 2;
  const h = 2;
  const emptyLabels = rleEncodeLabels(new Int32Array(w * h), w, h);
  const l1Data = new Int32Array([1, 1, 0, 0]); // 2 px
  const l2Data = new Int32Array([1, 1, 1, 0]); // 3 px

  const scanResults: ScanResults = {
    grid: { originX: 0, originZ: 0, width: w, height: h, px_mm: 1.0 },
    layers: [],
    firstHit: new Int16Array(w * h),
    lastHit: new Int16Array(w * h),
    baseFootprint: new Uint8Array(w * h),
    baseLabels: new Int32Array(w * h),
    compBase: new Int16Array(0),
    compTop: new Int16Array(0),
    islands: [],
    islandLabelsPerLayer: [
      emptyLabels,
      rleEncodeLabels(l1Data, w, h),
      rleEncodeLabels(l2Data, w, h),
    ],
  };

  const completeMultiLayer: Island = {
    id: 1,
    firstLayer: 1,
    lastLayer: 2,
    status: 'complete',
    totalAreaMm2: 5,
    perLayerAreaMm2: new Map([[1, 2], [2, 3]]),
    childIds: [],
    centroidSumX: 0,
    centroidSumY: 0,
    centroidSumZ: 0,
    centroidCount: 0,
  };
  assert.equal(calculateIslandVolume(completeMultiLayer, scanResults, 0.5), 2.5);

  const completeSingleLayer: Island = {
    ...completeMultiLayer,
    lastLayer: 1,
    totalAreaMm2: 2,
    perLayerAreaMm2: new Map([[1, 2]]),
  };
  assert.equal(calculateIslandVolume(completeSingleLayer, scanResults, 0.5), 1.0);

  // Fallback pixel-counting branch (empty perLayerAreaMm2)
  const fallbackMultiLayer: Island = {
    ...completeMultiLayer,
    perLayerAreaMm2: new Map(),
  };
  assert.equal(calculateIslandVolume(fallbackMultiLayer, scanResults, 0.5), 2.5);
});

test('Phase D TS: indirect placeholder reference (U -> P1, then {U, G3}) flushes P1 cleanly', () => {
  const w = 44;
  const h = 14;
  const numLayers = 11;
  const masks: RleMask[] = [];

  // L0: G1 (x=9..14, y=8..12 = 20px), G2 (x=18..22, y=8..12 = 16px), G3 (x=26..32, y=1..5 = 24px)
  const d0 = new Uint8Array(w * h);
  paintBox(d0, w, 9, 14, 8, 12);
  paintBox(d0, w, 18, 22, 8, 12);
  paintBox(d0, w, 26, 32, 1, 5);
  masks.push(rleEncode(d0, w, h));

  // L1: G1, G2, G3 + ungrounded U (x=1..5, y=1..12 = 44px)
  const d1 = new Uint8Array(d0);
  paintBox(d1, w, 1, 5, 1, 12);
  masks.push(rleEncode(d1, w, h));

  // L2: comp_branch continues U (x=1..5, y=1..4 = 12px); G3 (x=26..32, y=1..5 = 24px);
  // comp_merge connects {U, G1, G2} (x=1..22, y=8..12 = 84px) -> creates P1, sets U.parentId = P1
  const d2 = new Uint8Array(w * h);
  paintBox(d2, w, 1, 5, 1, 4);
  paintBox(d2, w, 26, 32, 1, 5);
  paintBox(d2, w, 1, 22, 8, 12);
  masks.push(rleEncode(d2, w, h));

  // L3..10: comp_ug3 bridges {U, G3} (x=1..32, y=1..5 = 124px); comp_p1 continues P1 (x=9..22, y=8..12 = 52px)
  const d3 = new Uint8Array(w * h);
  paintBox(d3, w, 1, 32, 1, 5);
  paintBox(d3, w, 9, 22, 8, 12);
  const m3 = rleEncode(d3, w, h);
  for (let l = 3; l < numLayers; l++) masks.push(m3);

  // Inspect state right after L3 before finalizeIslands
  const { tracker: tL3 } = runSolidMasks(masks.slice(0, 4), false);
  const islL3 = tL3.getIslands();
  const uL3 = islL3.find((i) => i.firstLayer === 1 && !i.isMergedPlaceholder)!;
  const g1L3 = islL3.find(
    (i) =>
      i.firstLayer === 0 &&
      !i.isMergedPlaceholder &&
      (i.perLayerAreaMm2.get(0) ?? 0) > 0.18 &&
      (i.perLayerAreaMm2.get(0) ?? 0) < 0.22
  )!;
  const p1L3 = islL3.find((i) => i.isMergedPlaceholder && i.firstLayer === 2)!;

  assert.equal(p1L3.status, 'complete', 'P1 must flush before {U, G3} merge on L=3');
  assert.equal(p1L3.parentId, g1L3.id, 'P1 must finalize to G1 (not undefined or 0)');
  assert.equal(g1L3.status, 'active');
  assert.equal(g1L3.lastLayer, 3);
  assert.equal(uL3.status, 'active');
  assert.equal(uL3.lastLayer, 2);
  assert.equal(uL3.parentId, g1L3.id);

  // Full run + finalizeIslands: exact area conservation, no parentId = 0
  const expectedPx = 20 + 16 + 24 + (20 + 16 + 24 + 44) + (12 + 24 + 84) + (numLayers - 3) * (124 + 52);
  const expectedAreaMm2 = expectedPx * 0.1 * 0.1;

  const { tracker } = runSolidMasks(masks, true);
  const islands = tracker.getIslands();
  for (const p of islands.filter((i) => i.isMergedPlaceholder)) {
    assert.equal(p.status, 'complete');
    assert.notEqual(p.parentId, undefined);
    assert.notEqual(p.parentId, 0, 'parentId must never be 0');
    const parent = islands.find((i) => i.id === p.parentId)!;
    assert.equal(Boolean(parent.isMergedPlaceholder), false);
  }
  const actualAreaMm2 = islands
    .filter((i) => !i.isMergedPlaceholder)
    .reduce((sum, i) => sum + i.totalAreaMm2, 0);
  assert.ok(
    Math.abs(actualAreaMm2 - expectedAreaMm2) < 1e-6,
    `summed area ${actualAreaMm2} must equal exact solid area ${expectedAreaMm2}`
  );
});

test('Phase D TS: {U, P1} collapse to {P1} (resolved.size === 1) does NOT flush P1 prematurely', () => {
  const w = 28;
  const h = 12;
  const masks: RleMask[] = [];

  const d0 = new Uint8Array(w * h);
  paintBox(d0, w, 12, 16, 6, 10);
  paintBox(d0, w, 19, 22, 6, 10);
  masks.push(rleEncode(d0, w, h));

  const d1 = new Uint8Array(d0);
  paintBox(d1, w, 1, 9, 1, 7);
  masks.push(rleEncode(d1, w, h));

  const d2 = new Uint8Array(w * h);
  paintBox(d2, w, 1, 4, 1, 3);
  paintBox(d2, w, 7, 22, 5, 10);
  masks.push(rleEncode(d2, w, h));

  const d3 = new Uint8Array(w * h);
  paintBox(d3, w, 1, 22, 1, 10);
  masks.push(rleEncode(d3, w, h));

  const { tracker } = runSolidMasks(masks, false);
  const p1 = tracker.getIslands().find((i) => i.isMergedPlaceholder && i.firstLayer === 2)!;
  assert.equal(p1.status, 'active', '{U, P1} collapsing to {P1} must NOT prematurely flush P1');
  assert.equal(p1.parentId, undefined);
  assert.equal(p1.lastLayer, 3);
});

test('Phase D TS: same-layer split + flush preserves winner lastLayer and calculateIslandVolume', () => {
  const w = 32;
  const h = 12;
  const masks: RleMask[] = [];

  masks.push(rleEncode(new Uint8Array(w * h), w, h));

  const d1 = new Uint8Array(w * h);
  paintBox(d1, w, 1, 7, 2, 8);   // A: 36 px
  paintBox(d1, w, 10, 12, 6, 8); // B: 4 px
  paintBox(d1, w, 18, 28, 6, 10); // C: 40 px
  masks.push(rleEncode(d1, w, h));

  const d2 = new Uint8Array(w * h);
  paintBox(d2, w, 1, 15, 2, 8);
  paintBox(d2, w, 18, 28, 6, 10);
  masks.push(rleEncode(d2, w, h));

  const d3 = new Uint8Array(w * h);
  paintBox(d3, w, 1, 6, 2, 4);   // comp_1 continues P1 (10 px)
  paintBox(d3, w, 12, 28, 6, 10); // comp_2 flushes P1 -> A and merges {A, C}
  masks.push(rleEncode(d3, w, h));

  const { tracker, labels } = runSolidMasks(masks, true);
  const islands = tracker.getIslands();
  const a = islands.find(
    (i) => i.firstLayer === 1 && !i.isMergedPlaceholder && Math.abs((i.perLayerAreaMm2.get(1) ?? 0) - 0.36) < 1e-9
  )!;

  assert.equal(a.lastLayer, 3, 'A.lastLayer must stay 3 after same-layer split + flush');
  assert.ok(a.perLayerAreaMm2.has(3));

  const scanResults: ScanResults = {
    grid: { originX: 0, originZ: 0, width: w, height: h, px_mm: 0.1 },
    layers: [],
    firstHit: new Int16Array(w * h),
    lastHit: new Int16Array(w * h),
    baseFootprint: new Uint8Array(w * h),
    baseLabels: new Int32Array(w * h),
    compBase: new Int16Array(0),
    compTop: new Int16Array(0),
    islands,
    islandLabelsPerLayer: labels,
  };
  const expectedAreaSum = Array.from(a.perLayerAreaMm2.values()).reduce((s, v) => s + v, 0);
  assert.ok(
    Math.abs(calculateIslandVolume(a, scanResults, 1.0) - expectedAreaSum) < 1e-9,
    'calculateIslandVolume must include layer 3 for A'
  );
});

test('Phase D TS: same-layer sibling split ({B} branch + {A, B} merge) keeps B active', () => {
  const w = 24;
  const h = 12;
  const masks: RleMask[] = [];

  const d0 = new Uint8Array(w * h);
  paintBox(d0, w, 1, 5, 2, 6);   // A: 16 px
  paintBox(d0, w, 10, 15, 2, 10); // B: 40 px
  paintBox(d0, w, 18, 22, 7, 10); // C: 12 px
  masks.push(rleEncode(d0, w, h));

  const d1 = new Uint8Array(w * h);
  paintBox(d1, w, 1, 15, 2, 5);   // comp_merge at top
  paintBox(d1, w, 10, 15, 7, 10); // comp_branch continues B
  paintBox(d1, w, 18, 22, 7, 10); // C continues
  masks.push(rleEncode(d1, w, h));

  const { tracker: tL1 } = runSolidMasks(masks, false);
  const islL1 = tL1.getIslands();
  const bL1 = islL1.find((i) => i.firstLayer === 0 && Math.abs((i.perLayerAreaMm2.get(0) ?? 0) - 0.40) < 1e-9)!;
  const aL1 = islL1.find((i) => i.firstLayer === 0 && Math.abs((i.perLayerAreaMm2.get(0) ?? 0) - 0.16) < 1e-9)!;

  assert.equal(bL1.status, 'active', 'sibling B continuing on L=1 must stay active');
  assert.equal(bL1.lastLayer, 1);
  assert.equal(aL1.status, 'complete');
  assert.equal(aL1.lastLayer, 0);

  const d2 = new Uint8Array(w * h);
  paintBox(d2, w, 1, 15, 2, 5);
  paintBox(d2, w, 10, 22, 7, 10); // bridges {B, C}
  masks.push(rleEncode(d2, w, h));

  const { tracker: tL2 } = runSolidMasks(masks, false);
  assert.equal(
    tL2.getIslands().filter((i) => i.isMergedPlaceholder).length,
    2,
    'L=2 bridge between active branch B and C must open second PendingMerge'
  );
});

test('Phase D TS: floating L > 0 first layer (prevIl = null) stays ungrounded and computeIslandMarkers renders undefined isMergedPlaceholder', () => {
  const w = 24;
  const h = 10;
  const tracker = new IslandTracker(0.1, { minOverlapPx: 1, overlapNeighborhoodPx: 1, connectivity: 8 });

  const d1 = new Uint8Array(w * h);
  paintBox(d1, w, 1, 3, 2, 4);
  paintBox(d1, w, 10, 18, 2, 6);
  const m1 = rleEncode(d1, w, h);
  const r1 = rleLabelComponents(m1, 8);
  const il1 = tracker.processLayer(1, r1.labels, r1.components, null, m1);

  const d2 = new Uint8Array(w * h);
  paintBox(d2, w, 1, 18, 2, 6);
  const m2 = rleEncode(d2, w, h);
  const r2 = rleLabelComponents(m2, 8);
  tracker.processLayer(2, r2.labels, r2.components, il1, m2);

  assert.ok(
    tracker.getIslands().some((i) => i.isMergedPlaceholder),
    'layerIndex > 0 with prevIl=null must remain ungrounded and open PendingMerge'
  );

  // computeIslandMarkers with isMergedPlaceholder === undefined
  const mw = 4;
  const mh = 4;
  const l0 = new Int32Array(mw * mh);
  l0[0] = 1;
  const l1 = new Int32Array(mw * mh);
  l1[1] = 2;
  const islands: Island[] = [
    {
      id: 1,
      firstLayer: 0,
      lastLayer: 0,
      status: 'active',
      totalAreaMm2: 1,
      perLayerAreaMm2: new Map([[0, 1]]),
      childIds: [],
      centroidSumX: 0,
      centroidSumY: 0,
      centroidSumZ: 0,
      centroidCount: 1,
    },
    {
      id: 2,
      firstLayer: 1,
      lastLayer: 1,
      status: 'complete',
      totalAreaMm2: 1,
      perLayerAreaMm2: new Map([[1, 1]]),
      parentId: 1,
      childIds: [],
      centroidSumX: 1,
      centroidSumY: 0,
      centroidSumZ: 1,
      centroidCount: 1,
    },
  ];
  const scanResults: ScanResults = {
    grid: { originX: 0, originZ: 0, width: mw, height: mh, px_mm: 0.5 },
    layers: [],
    firstHit: new Int16Array(mw * mh),
    lastHit: new Int16Array(mw * mh),
    baseFootprint: new Uint8Array(mw * mh),
    baseLabels: new Int32Array(mw * mh),
    compBase: new Int16Array([-1, 0, 1]),
    compTop: new Int16Array([-1, 0, 1]),
    islands,
    islandLabelsPerLayer: [rleEncodeLabels(l0, mw, mh), rleEncodeLabels(l1, mw, mh)],
  };
  const markers = computeIslandMarkers(scanResults, { min: { z: 0 } }, 0.25);
  try {
    assert.deepEqual(
      markers.map((m) => m.id).sort((a, b) => a - b),
      [1, 2],
      'islands with isMergedPlaceholder === undefined must render'
    );
  } finally {
    markers.forEach((m) => m.geometry?.dispose());
  }
});

test('Phase D TS: TerritoryTracker resolveId cycle guard terminates on cyclic parentId', () => {
  const a: Island = {
    id: 1,
    firstLayer: 0,
    lastLayer: 0,
    status: 'active',
    totalAreaMm2: 1,
    perLayerAreaMm2: new Map([[0, 1]]),
    parentId: 2,
    childIds: [2],
    centroidSumX: 1,
    centroidSumY: 1,
    centroidSumZ: 0,
    centroidCount: 1,
    centroid: { x: 1, y: 1, z: 0 },
  };
  const b: Island = {
    id: 2,
    firstLayer: 0,
    lastLayer: 0,
    status: 'active',
    totalAreaMm2: 1,
    perLayerAreaMm2: new Map([[0, 1]]),
    parentId: 1,
    childIds: [1],
    centroidSumX: 2,
    centroidSumY: 1,
    centroidSumZ: 0,
    centroidCount: 1,
    centroid: { x: 2, y: 1, z: 0 },
  };
  const tt = new TerritoryTracker([a, b]);
  const w = 4;
  const h = 4;
  const grid = new Int32Array(w * h);
  grid[0] = 1;
  const res = tt.processLayer(rleEncodeLabels(grid, w, h), w, h, 0, null);
  assert.equal(res.labelMap.rows[0][2], 1);
});
