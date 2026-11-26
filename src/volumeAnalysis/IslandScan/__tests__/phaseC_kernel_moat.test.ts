import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';

import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import { scanLayer } from '@/volumeAnalysis/IslandScan/island';
import { IslandTracker } from '@/volumeAnalysis/IslandScan/islandTracker';
import {
  rleDecode,
  rleEncode,
  rleIntersectDilated,
  rleLabelComponents,
  type RleMask,
} from '@/volumeAnalysis/IslandScan/rle';
import { dispatchScanlineWorkerMessage } from '@/volumeAnalysis/IslandScan/scanlineScan.worker';
import { detectVoxelIslands } from '@/volumeAnalysis/Islands/detect';

after(() => {
  disposeEventLoopChannel();
});

function makeMask(width: number, height: number, fill = 0): Uint8Array {
  const data = new Uint8Array(width * height);
  if (fill) data.fill(fill);
  return data;
}

/** Build non-indexed world-space triangles (9 floats/tri) for an axis-aligned box. */
function buildBoxPositions(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): Float32Array {
  const geom = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
  geom.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const nonIndexed = geom.toNonIndexed();
  const out = new Float32Array(nonIndexed.getAttribute('position').array as Float32Array);
  geom.dispose();
  nonIndexed.dispose();
  return out;
}

function concatPositions(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function withInlineWorker<T>(
  fn: (sentMessages: unknown[]) => Promise<T>,
): Promise<T> {
  const origWorker = (globalThis as { Worker?: unknown }).Worker;
  const sentMessages: unknown[] = [];
  class InlineScanlineWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.add(cb);
    }
    removeEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.delete(cb);
    }
    postMessage(msg: unknown) {
      sentMessages.push(msg);
      dispatchScanlineWorkerMessage(msg as Parameters<typeof dispatchScanlineWorkerMessage>[0], (payload) => {
        const evt = { data: payload } as MessageEvent;
        for (const cb of [...this.listeners]) cb(evt);
      });
    }
    terminate() {}
  }
  (globalThis as { Worker?: unknown }).Worker = InlineScanlineWorker;
  try {
    return await fn(sentMessages);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }
}

test('NBR-02: rleIntersectDilated uses Euclidean L2 disk and guards non-positive dimensions', () => {
  // buffer = 1 around (5, 1): 5-pixel cross only; diagonal corners (4,0),(6,0),(4,2),(6,2) excluded
  const a10 = rleEncode(makeMask(10, 10, 1), 10, 10);
  const b1 = makeMask(10, 10);
  b1[1 * 10 + 5] = 1;
  const dilated1 = rleDecode(rleIntersectDilated(a10, rleEncode(b1, 10, 10), 1));

  const expectedCross = new Set(['5,0', '4,1', '5,1', '6,1', '5,2']);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const exp = expectedCross.has(`${x},${y}`) ? 1 : 0;
      assert.equal(dilated1[y * 10 + x], exp, `buffer=1 pixel (${x},${y}) expected ${exp}`);
    }
  }
  for (const [cx, cy] of [[4, 0], [6, 0], [4, 2], [6, 2]]) {
    assert.equal(dilated1[cy * 10 + cx], 0, `buffer=1 diagonal corner (${cx},${cy}) must be unsupported`);
  }

  // scanLayer with support_buffer_mm = 1, px_mm = 1 leaves diagonal corner (4,0) unsupported
  const currCorner = makeMask(10, 10);
  currCorner[0 * 10 + 4] = 1;
  const cornerScan = scanLayer(
    rleEncode(currCorner, 10, 10),
    rleEncode(b1, 10, 10),
    { px_mm: 1, support_buffer_mm: 1 },
  );
  assert.equal(cornerScan.components.length, 1, 'diagonal corner (4,0) at r=1 must remain unsupported');

  // buffer = 5 around (0, 0): (3,4) supported (3^2+4^2=25), (4,4) NOT supported (4^2+4^2=32 > 25)
  const bOrigin = makeMask(10, 10);
  bOrigin[0] = 1;
  const dilated5 = rleDecode(rleIntersectDilated(a10, rleEncode(bOrigin, 10, 10), 5));
  assert.equal(dilated5[4 * 10 + 3], 1, '(3,4) has L2^2 = 25 <= 25 -> supported');
  assert.equal(dilated5[3 * 10 + 4], 1, '(4,3) has L2^2 = 25 <= 25 -> supported');
  assert.equal(dilated5[4 * 10 + 4], 0, '(4,4) has L2^2 = 32 > 25 -> NOT supported');
  assert.equal(dilated5[0 * 10 + 5], 1, '(5,0) has L2^2 = 25 <= 25 -> supported');
  assert.equal(dilated5[1 * 10 + 5], 0, '(5,1) has L2^2 = 26 > 25 -> NOT supported');

  // Non-positive dimensions & negative buffer guards
  const emptyWidth: RleMask = { rows: [], width: 0, height: 4 };
  const guardedA = rleIntersectDilated(emptyWidth, a10, 2);
  assert.equal(guardedA.width, 0);
  assert.equal(guardedA.height, 4);
  assert.equal(guardedA.rows.length, 4);

  const emptyB: RleMask = { rows: [], width: 0, height: 0 };
  const guardedB = rleDecode(rleIntersectDilated(a10, emptyB, 2));
  assert.equal(guardedB.reduce((s, v) => s + v, 0), 0);

  const negBuf = rleDecode(rleIntersectDilated(a10, rleEncode(bOrigin, 10, 10), -3));
  assert.equal(negBuf[0], 1);
  assert.equal(negBuf.reduce((s, v) => s + v, 0), 1);

  // Mismatched mask heights and r = 0 identity
  const shortB = rleEncode(makeMask(10, 2, 1), 10, 2);
  const mismatched = rleDecode(rleIntersectDilated(a10, shortB, 1));
  assert.equal(mismatched.slice(0, 30).reduce((s, v) => s + v, 0), 30, 'rows 0..2 covered by r=1 of rows 0..1');
  assert.equal(mismatched.slice(30).reduce((s, v) => s + v, 0), 0, 'rows 3..9 uncovered');
});

test('C2 rollback: detectVoxelIslands restores 26/6-conn without indiscriminate B+1 moat bridging while keeping connectivity=8 default', async () => {
  await withInlineWorker(async (sentMessages) => {
    // Two disconnected floating boxes on adjacent layers separated by a 5 px XY gap:
    // pxMm=0.05, supportBufferMm=0.25 -> bufferPx=5, B+1=6.
    // Box A: x=[0.00, 0.20] (cols 0..3), z=[0.20, 0.25] (L=4)
    // Box B: x=[0.45, 0.65] (cols 9..12), z=[0.25, 0.30] (L=5)
    // Distance between col 3 and col 9 is 6 px (<= B+1), so 7b25979d1's 3D-BFS merged them;
    // accb8b002 rollback keeps them separate (2 islands).
    const splitPositions = concatPositions(
      buildBoxPositions(0.00, 0.20, 0.00, 0.20, 0.20, 0.25),
      buildBoxPositions(0.45, 0.65, 0.00, 0.20, 0.25, 0.30),
    );
    const splitBbox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.65, 0.20, 0.30),
    );

    const separateIslands = await detectVoxelIslands(
      { positions: splitPositions, bbox: splitBbox },
      0.05,
      { pxMm: 0.05, supportBufferMm: 0.25, minAreaMm2: 0.01 },
    );
    assert.equal(separateIslands.length, 2, 'disconnected floating boxes separated by B+1 gap must remain 2 islands');

    // Verify default connectivity=8 and explicit connectivity=4 are forwarded to scanLayer workers
    const defaultLayerMsgs = sentMessages.filter(
      (m): m is { type: string; opts: { connectivity: 4 | 8 } } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'layer',
    );
    assert.ok(defaultLayerMsgs.length > 0);
    assert.equal(defaultLayerMsgs[0].opts.connectivity, 8, 'default detectVoxelIslands connectivity must remain 8');

    // Diagonal 3D connectivity across layers (L=4 and L=5 sharing a 3D corner):
    // 26-conn (default) merges into 1 island, 6-conn (diagonal3D: false) separates into 2 islands.
    const diag3dPositions = concatPositions(
      buildBoxPositions(0.00, 0.05, 0.00, 0.05, 0.20, 0.25),
      buildBoxPositions(0.05, 0.10, 0.05, 0.10, 0.25, 0.30),
    );
    const diag3dBbox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.10, 0.10, 0.30),
    );

    const conn26 = await detectVoxelIslands(
      { positions: diag3dPositions, bbox: diag3dBbox },
      0.05,
      { pxMm: 0.05, supportBufferMm: 0, minAreaMm2: 0.001 },
    );
    assert.equal(conn26.length, 1, 'default diagonal3D merges corner-touching layers via 26-conn');

    sentMessages.length = 0;
    const conn6 = await detectVoxelIslands(
      { positions: diag3dPositions, bbox: diag3dBbox },
      0.05,
      { pxMm: 0.05, supportBufferMm: 0, connectivity: 4, diagonal3D: false, minAreaMm2: 0.001 },
    );
    assert.equal(conn6.length, 2, 'diagonal3D=false separates corner-touching layers via 6-conn');
    const explicit4Msgs = sentMessages.filter(
      (m): m is { type: string; opts: { connectivity: 4 | 8 } } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'layer',
    );
    assert.equal(explicit4Msgs[0].opts.connectivity, 4, 'explicit connectivity=4 forwarded to scanLayer');
  });
});

test('NBR-03: rleLabelComponents and IslandTracker default to 8-conn, respect 4-conn, and use Euclidean overlap disk', () => {
  // Oblique staircase: [0,10) on row 5 and [10,20) on row 6
  const stairData = makeMask(25, 12);
  for (let x = 0; x < 10; x++) stairData[5 * 25 + x] = 1;
  for (let x = 10; x < 20; x++) stairData[6 * 25 + x] = 1;
  const stairMask = rleEncode(stairData, 25, 12);

  const defaultLabeled = rleLabelComponents(stairMask);
  assert.equal(defaultLabeled.components.length, 1, 'rleLabelComponents default must be 8-connectivity');
  assert.equal(rleLabelComponents(stairMask, 8).components.length, 1);
  assert.equal(rleLabelComponents(stairMask, 4).components.length, 2);

  // IslandTracker solid-component connectivity: default 8 vs explicit 4
  const baseData = makeMask(25, 12);
  for (let x = 0; x < 10; x++) baseData[5 * 25 + x] = 1;
  const baseMask = rleEncode(baseData, 25, 12);
  const baseLabeled = rleLabelComponents(baseMask, 8);

  const emptyCand = rleLabelComponents(rleEncode(makeMask(25, 12), 25, 12), 8);

  const trackerDefault = new IslandTracker(1.0, { overlapNeighborhoodPx: 0 });
  const l0Default = trackerDefault.processLayer(0, baseLabeled.labels, baseLabeled.components, null, baseMask);
  trackerDefault.processLayer(1, emptyCand.labels, emptyCand.components, l0Default, stairMask);
  assert.equal(trackerDefault.getIslands().length, 1, 'IslandTracker default connectivity=8 keeps staircase as 1 island');

  const tracker4 = new IslandTracker(1.0, { overlapNeighborhoodPx: 0, connectivity: 4 });
  const l0Four = tracker4.processLayer(0, baseLabeled.labels, baseLabeled.components, null, baseMask);
  tracker4.processLayer(1, emptyCand.labels, emptyCand.components, l0Four, stairMask);
  assert.equal(tracker4.getIslands().length, 2, 'IslandTracker connectivity=4 splits staircase at layer 1 into 2 islands');

  // IslandTracker Euclidean overlapNeighborhoodPx (buffer = 5): (3,4) overlaps, (4,4) does not
  const seed0Data = makeMask(10, 10);
  seed0Data[0] = 1; // (0,0)
  const seed0Mask = rleEncode(seed0Data, 10, 10);
  const seed0Labeled = rleLabelComponents(seed0Mask, 8);

  const pt34Data = makeMask(10, 10);
  pt34Data[4 * 10 + 3] = 1; // (3,4): 3^2+4^2 = 25 <= 25
  const pt34Mask = rleEncode(pt34Data, 10, 10);
  const pt34Cand = rleLabelComponents(pt34Mask, 8);

  const trackerHit = new IslandTracker(1.0, { minOverlapPx: 1, overlapNeighborhoodPx: 5 });
  const hitL0 = trackerHit.processLayer(0, seed0Labeled.labels, seed0Labeled.components, null, seed0Mask);
  trackerHit.processLayer(1, pt34Cand.labels, pt34Cand.components, hitL0, pt34Mask);
  assert.equal(trackerHit.getIslands().length, 1, '(3,4) within Euclidean r=5 must continue island 1');
  assert.equal(trackerHit.getIslands()[0].lastLayer, 1);

  const pt44Data = makeMask(10, 10);
  pt44Data[4 * 10 + 4] = 1; // (4,4): 4^2+4^2 = 32 > 25
  const pt44Mask = rleEncode(pt44Data, 10, 10);
  const pt44Cand = rleLabelComponents(pt44Mask, 8);

  const trackerMiss = new IslandTracker(1.0, { minOverlapPx: 1, overlapNeighborhoodPx: 5 });
  const missL0 = trackerMiss.processLayer(0, seed0Labeled.labels, seed0Labeled.components, null, seed0Mask);
  trackerMiss.processLayer(1, pt44Cand.labels, pt44Cand.components, missL0, pt44Mask);
  assert.equal(trackerMiss.getIslands().length, 2, '(4,4) outside Euclidean r=5 must NOT overlap island 1');

  // dy/dx asymmetry: (5,0) offset from (5,5) is at (10,5) [25<=25], (-5,1) at (0,6) [26>25]
  const seedCenterData = makeMask(12, 12);
  seedCenterData[5 * 12 + 5] = 1;
  const seedCenterMask = rleEncode(seedCenterData, 12, 12);
  const seedCenterLbl = rleLabelComponents(seedCenterMask, 8);
  const asymData = makeMask(12, 12);
  asymData[5 * 12 + 10] = 1;
  asymData[6 * 12 + 0] = 1;
  const asymMask = rleEncode(asymData, 12, 12);
  const asymLbl = rleLabelComponents(asymMask, 8);
  const trackerAsym = new IslandTracker(1.0, { minOverlapPx: 1, overlapNeighborhoodPx: 5 });
  const asymL0 = trackerAsym.processLayer(0, seedCenterLbl.labels, seedCenterLbl.components, null, seedCenterMask);
  trackerAsym.processLayer(1, asymLbl.labels, asymLbl.components, asymL0, asymMask);
  assert.equal(trackerAsym.getIslands().length, 2, 'Euclidean (dx=5,dy=0) merges while (dx=-5,dy=1) stays separate');

  // Mismatched prev_island_labels.height < solid_labels.height never throws
  const prevShortMask = rleEncode(makeMask(4, 2, 1), 4, 2);
  const prevShortLbl = rleLabelComponents(prevShortMask, 8);
  const solidTallMask = rleEncode(makeMask(4, 6, 1), 4, 6);
  const solidTallLbl = rleLabelComponents(solidTallMask, 8);
  const trackerTall = new IslandTracker(1.0, { minOverlapPx: 1, overlapNeighborhoodPx: 2 });
  const tl0 = trackerTall.processLayer(0, prevShortLbl.labels, prevShortLbl.components, null, prevShortMask);
  trackerTall.processLayer(1, solidTallLbl.labels, solidTallLbl.components, tl0, solidTallMask);
  assert.equal(trackerTall.getIslands().length, 1);
});
