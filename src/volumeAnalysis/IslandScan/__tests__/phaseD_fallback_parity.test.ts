import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';

import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import { scanLayer } from '@/volumeAnalysis/IslandScan/island';
import {
  EMPTY_ROW,
  markDetachedAndRescueCandidates,
  packCandidateLayerRuns,
  rleDecode,
  rleEncode,
  rleLabelComponents,
  rleSubtract,
  rleIntersectDilated,
} from '@/volumeAnalysis/IslandScan/rle';
import { dispatchScanlineWorkerMessage } from '@/volumeAnalysis/IslandScan/scanlineScan.worker';
import type { ComponentInfo } from '@/volumeAnalysis/IslandScan/types';
import { detectVoxelIslands } from '@/volumeAnalysis/Islands/detect';

after(() => {
  disposeEventLoopChannel();
});

function makeMask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height);
}

function paintRect(
  data: Uint8Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      data[y * width + x] = 1;
    }
  }
}

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

async function withInlineWorker<T>(fn: () => Promise<T>): Promise<T> {
  const origWorker = (globalThis as { Worker?: unknown }).Worker;
  class InlineScanlineWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.add(cb);
    }
    removeEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.delete(cb);
    }
    postMessage(msg: unknown) {
      dispatchScanlineWorkerMessage(msg as Parameters<typeof dispatchScanlineWorkerMessage>[0], (payload) => {
        const evt = { data: payload } as MessageEvent;
        for (const cb of [...this.listeners]) cb(evt);
      });
    }
    terminate() {}
  }
  (globalThis as { Worker?: unknown }).Worker = InlineScanlineWorker;
  try {
    return await fn();
  } finally {
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }
}

test('FLD-06: markDetachedAndRescueCandidates rescues wall-halo clipped runs and honors 8-conn vs 4-conn diagonal bridge', () => {
  const w = 10;
  const h = 6;

  // 1. Wall-halo rescue: wall at cols 0..1 on prev & current; detached bar at cols 4..5, rows 1..2.
  // With B = 5, Dilate(prev, 5) covers cols 0..6 and clips cols 4..5 out of candidateMask,
  // leaving candidateMask rows empty (sharing EMPTY_ROW). Rescue must restore cols 4..5 without mutating EMPTY_ROW.
  const prevData = makeMask(w, h);
  paintRect(prevData, w, 0, 2, 0, 5);
  const prevSolid = rleEncode(prevData, w, h);

  const curData = makeMask(w, h);
  paintRect(curData, w, 0, 2, 0, 5);
  paintRect(curData, w, 4, 6, 1, 3);
  const current = rleEncode(curData, w, h);

  const supported = rleIntersectDilated(current, prevSolid, 5);
  const candMask = rleSubtract(current, supported);
  assert.equal(rleDecode(candMask).reduce((s, v) => s + v, 0), 0, 'precondition: B=5 halo clips detached bar');

  const labeled = rleLabelComponents(candMask, 8);
  assert.equal(labeled.components.length, 0);

  markDetachedAndRescueCandidates(current, prevSolid, candMask, labeled.labels, labeled.components, 8);
  assert.equal(EMPTY_ROW.length, 0, 'EMPTY_ROW must never be mutated in place');
  assert.equal(labeled.components.length, 1, 'wall-halo rescue must restore detached bar');
  assert.equal(labeled.components[0].area_px, 4);
  assert.equal(labeled.components[0].isDetached, true);

  // Also verify via scanLayer directly
  const scanRes = scanLayer(current, prevSolid, { px_mm: 1, support_buffer_mm: 5, connectivity: 8 });
  assert.equal(scanRes.components.length, 1);
  assert.equal(scanRes.components[0].isDetached, true);

  // First layer (!prev) marks all components detached
  const firstLayerRes = scanLayer(prevSolid, null, { px_mm: 1, support_buffer_mm: 5, connectivity: 8 });
  assert.equal(firstLayerRes.components.length, 1);
  assert.equal(firstLayerRes.components[0].isDetached, true);

  // 2. 8-conn diagonal bridge vs 4-conn separation on enclosing solid component
  // prev has anchor at (1, 1); current has (1, 2) [4-conn bridge] + (2, 3) [diagonal to (1,2), >1 away from (1,1)]
  const pDiag = makeMask(6, 6);
  pDiag[1 * 6 + 1] = 1;
  const prevDiagRle = rleEncode(pDiag, 6, 6);

  const cDiag = makeMask(6, 6);
  cDiag[2 * 6 + 1] = 1;
  cDiag[3 * 6 + 2] = 1;
  const curDiagRle = rleEncode(cDiag, 6, 6);

  const res8 = scanLayer(curDiagRle, prevDiagRle, { px_mm: 1, support_buffer_mm: 0, connectivity: 8 });
  assert.equal(res8.components.length, 1, '8-conn unions (1,2) and (2,3) into one CantileverFringe');
  assert.equal(res8.components[0].isDetached, false);

  const res4 = scanLayer(curDiagRle, prevDiagRle, { px_mm: 1, support_buffer_mm: 0, connectivity: 4 });
  assert.equal(res4.components.length, 2, '4-conn separates (1,2) and (2,3) into 2 candidate components');
  const diagTip4 = res4.components.find((c) => c.isDetached === true);
  const bridgeBase4 = res4.components.find((c) => c.isDetached === false);
  assert.ok(diagTip4 && bridgeBase4, '4-conn must keep (1,2) attached and (2,3) detached');
});

test('FLD-06: 4-conn separates diagonal solid tip into isDetached while 8-conn chains through sibling bridge', () => {
  // prev has pixel at (1, 1).
  // current has (1, 1) [supported], (1, 2) [4-conn solid bridge to (1,1)], and (2, 3) [8-conn diagonal to (1,2),
  // Chebyshev distance 2 from (1,1) so 0 direct bridge to prev].
  const p = makeMask(6, 6);
  p[1 * 6 + 1] = 1;
  const prevRle = rleEncode(p, 6, 6);

  const c = makeMask(6, 6);
  c[1 * 6 + 1] = 1;
  c[2 * 6 + 1] = 1;
  c[3 * 6 + 2] = 1;
  const curRle = rleEncode(c, 6, 6);

  // Under B=0: (1,1) is supported; candidates are (1,2) and (2,3).
  // Under 8-conn: (1,2) and (2,3) merge into 1 candidate & 1 solid component touching (1,1) -> isDetached = false.
  const res8 = scanLayer(curRle, prevRle, { px_mm: 1, support_buffer_mm: 0, connectivity: 8 });
  assert.equal(res8.components.length, 1);
  assert.equal(res8.components[0].isDetached, false);

  // Under 4-conn: (2,3) is a separate 4-conn solid component with 0 Chebyshev-1 bridge to (1,1) -> isDetached = true!
  const res4 = scanLayer(curRle, prevRle, { px_mm: 1, support_buffer_mm: 0, connectivity: 4 });
  assert.equal(res4.components.length, 2);
  const detachedComp = res4.components.find((comp) => comp.isDetached === true);
  const attachedComp = res4.components.find((comp) => comp.isDetached === false);
  assert.ok(detachedComp, 'expected 4-conn diagonal tip (2,3) to be isDetached=true');
  assert.ok(attachedComp, 'expected 4-conn adjacent pixel (1,2) to be isDetached=false');

  // Verify packCandidateLayerRuns encoding
  const packed = packCandidateLayerRuns(res4.labels, res4.components);
  assert.equal(packed.candidateRuns.length % 4, 0);
  assert.equal(packed.candidateRuns.length, 8);
  assert.equal(packed.componentDetached[detachedComp.id], 1);
  assert.equal(packed.componentDetached[attachedComp.id], 0);
});

test('FLD-06: scanlineScan.worker candidatesOnly returns and transfers { candidatePairs, candidateRuns, componentDetached }', () => {
  // Grounded pillar [0..2]x[0..2]x[0..3] with top overhang [0..5]x[0..2]x[1..3]
  // plus separate detached floating box [0..2]x[4..6]x[1..3]
  const positions = concatPositions(
    buildBoxPositions(0, 2, 0, 2, 0, 3),
    buildBoxPositions(0, 5, 0, 2, 1, 3),
    buildBoxPositions(0, 2, 4, 6, 1, 3),
  );
  dispatchScanlineWorkerMessage({ type: 'init', positions }, () => {});

  const responses: Array<{ payload: { type: 'done'; result: Record<string, unknown> }; transfer?: Transferable[] }> = [];
  dispatchScanlineWorkerMessage(
    {
      type: 'layer',
      z: 1.5,
      layerHeightMm: 1.0,
      gridRef: { originX: 0, originZ: -6, width: 6, height: 6, px_mm: 1.0 },
      opts: { px_mm: 1.0, support_buffer_mm: 1.0, connectivity: 8 },
      candidatesOnly: true,
    },
    (payload, transfer) => responses.push({ payload, transfer }),
  );

  assert.equal(responses.length, 1);
  const res = responses[0].payload.result;
  assert.ok(res.candidatePairs instanceof Int32Array);
  assert.ok(res.candidateRuns instanceof Int32Array);
  assert.ok(res.componentDetached instanceof Uint8Array);

  const pairs = res.candidatePairs as Int32Array;
  const runs = res.candidateRuns as Int32Array;
  const detached = res.componentDetached as Uint8Array;

  assert.deepEqual(responses[0].transfer, [pairs.buffer, runs.buffer, detached.buffer]);
  assert.ok(runs.length > 0 && runs.length % 4 === 0);

  const detachedFlagsByComp = new Map<number, number>();
  for (let i = 0; i < runs.length; i += 4) {
    const compId = runs[i + 3];
    assert.ok(compId > 0);
    detachedFlagsByComp.set(compId, detached[compId]);
  }
  const flagValues = Array.from(detachedFlagsByComp.values()).sort();
  assert.deepEqual(flagValues, [0, 1], 'must distinguish CantileverFringe (0) from Detached (1)');
});

test('FLD-06: detectVoxelIslands preserves multi-prong scalloped saddle tips at true L=2 and L=3 birth layers', async () => {
  // pxMm = 1, layerHeightMm = 1, supportBufferMm = 0:
  // idx=2 slices zTop=3.0+1e-6 / zBot=2.0+1e-6; idx=3 slices zTop=4.0+1e-6; idx=5 slices zTop=6.0+1e-6.
  // Prong A starts at L=2 (x=[0,1], z=[2.5,7]), steps to x=[0,2] at L=3 and x=[0,3] at L=4.
  // Prong B starts at L=3 (x=[5,6], z=[3.5,7]), steps to x=[4,6] at L=4.
  // At L=5 (z=[5.5,7]), bridge x=[3,4] produces candidate col=3 connecting both prongs!
  const positions = concatPositions(
    buildBoxPositions(0, 1, 0, 1, 2.5, 7),
    buildBoxPositions(1, 2, 0, 1, 3.5, 7),
    buildBoxPositions(2, 3, 0, 1, 4.5, 7),
    buildBoxPositions(5, 6, 0, 1, 3.5, 7),
    buildBoxPositions(4, 5, 0, 1, 4.5, 7),
    buildBoxPositions(3, 4, 0, 1, 5.5, 7),
  );
  const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 1, 7));

  const islands = await withInlineWorker(() =>
    detectVoxelIslands({ positions, bbox }, 1.0, { pxMm: 1.0, supportBufferMm: 0, minAreaMm2: 0.1 }),
  );

  assert.equal(islands.length, 2, 'scalloped two-prong saddle must yield 2 distinct islands');
  const byZ = [...islands].sort((a, b) => a.baseZ - b.baseZ);

  assert.equal(byZ[0].baseZ, 2.0);
  assert.equal(byZ[0].rawBaseZ, 2.0);
  assert.equal(byZ[0].contact.x, 0.5);
  assert.deepEqual(byZ[0].layerSpan, [2, 5]);
  assert.deepEqual(Array.from(byZ[0].contactVoxels!.xy), [0.5, 0.5]);

  assert.equal(byZ[1].baseZ, 3.0);
  assert.equal(byZ[1].rawBaseZ, 3.0);
  assert.equal(byZ[1].contact.x, 5.5);
  assert.deepEqual(byZ[1].layerSpan, [3, 4]);
  assert.deepEqual(Array.from(byZ[1].contactVoxels!.xy), [5.5, 0.5]);
});

test('FLD-06: sloped CantileverFringe chains across B+1 with peakAreaMm2 > areaMm2 while adjacent isDetached needle stays separate', async () => {
  // pxMm = 0.1, layerHeightMm = 0.1, supportBufferMm = 0.2 -> B = 2 px, B+1 = 3 px.
  // Grounded stem: x=[0, 1.0], y=[0.6, 1.0], z=[0, 0.4]
  // L=1 (zTop=0.2+1e-6, zBot=0.1+1e-6): step cantilever to x=[0, 1.3], y=[0.6, 1.0] -> candidate col 12 (width 1 px * 4 rows = 4 px = 0.04 mm^2)
  // L=2 (zTop=0.3+1e-6, zBot=0.2+1e-6): step cantilever to x=[0, 2.0], y=[0.6, 1.0] -> candidate cols 15..19 (dx=3 = B+1, 5*4 = 20 px = 0.20 mm^2)
  // L=2 detached needle inside B+1: x=[1.1, 1.2], y=[0.2, 0.4], z=[0.25, 0.4] (2 px gap in Y from y=[0.6,1.0], clipped by B=2 halo!)
  const positions = concatPositions(
    buildBoxPositions(0.0, 1.0, 0.6, 1.0, 0.0, 0.4),
    buildBoxPositions(1.0, 1.3, 0.6, 1.0, 0.15, 0.4),
    buildBoxPositions(1.3, 2.0, 0.6, 1.0, 0.25, 0.4),
    buildBoxPositions(1.1, 1.2, 0.2, 0.4, 0.25, 0.4),
  );
  const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2.0, 1.0, 0.4));

  const islands = await withInlineWorker(() =>
    detectVoxelIslands({ positions, bbox }, 0.1, { pxMm: 0.1, supportBufferMm: 0.2, minAreaMm2: 0.01 }),
  );

  assert.equal(islands.length, 2, 'CantileverFringe + adjacent detached needle inside B+1 must remain 2 islands');
  const fringe = islands.find((i) => !i.isDetached);
  const needle = islands.find((i) => i.isDetached);
  assert.ok(fringe, 'CantileverFringe island must exist');
  assert.ok(needle, 'Detached needle island must exist');

  assert.equal(fringe.layerSpan?.[0], 1);
  assert.equal(fringe.layerSpan?.[1], 2);
  assert.ok((fringe.peakAreaMm2 ?? 0) > (fringe.areaMm2 ?? 0), 'peakAreaMm2 must exceed base areaMm2 across B+1 chaining');
  assert.ok(Math.abs((fringe.areaMm2 ?? 0) - 0.04) < 1e-6);
  assert.ok(Math.abs((fringe.peakAreaMm2 ?? 0) - 0.20) < 1e-6);

  assert.equal(needle.layerSpan?.[0], 2);
  assert.equal(needle.isDetached, true);
});

test('FLD-06: pre-merge noise speck < minAreaMm2 is rejected despite merging into wide bridge while < minAreaMm2 isDetached tip survives', async () => {
  // Mock inline worker returning exact candidateRuns + componentDetached per layer.
  // pxMm = 0.05 -> 1 px = 0.0025 mm^2, minAreaMm2 = 0.02 (needs >= 8 px).
  const origWorker = (globalThis as { Worker?: unknown }).Worker;
  class SyntheticRunsWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.add(cb);
    }
    removeEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.delete(cb);
    }
    postMessage(msg: { type: string; z?: number }) {
      if (msg.type !== 'layer') return;
      const layerIdx = Math.round((msg.z ?? 0) / 0.1) - 1;
      let candidateRuns = new Int32Array(0);
      let componentDetached = new Uint8Array(0);
      if (layerIdx === 1) {
        // Comp 1: 1 px speck at (2, 2), non-detached (0.0025 mm^2 < 0.02)
        // Comp 2: 10 px prong at (6..15, 2), non-detached (0.025 mm^2 >= 0.02)
        // Comp 3: 1 px detached tip at (2, 8), isDetached = 1 (0.0025 mm^2 < 0.02)
        candidateRuns = Int32Array.from([
          2, 2, 1, 1,
          2, 6, 10, 2,
          8, 2, 1, 3,
        ]);
        componentDetached = Uint8Array.from([0, 0, 0, 1]);
      } else if (layerIdx === 2) {
        // Comp 1: 20 px wide saddle bridge at (2..21, 2), non-detached (0.05 mm^2 >= 0.02),
        // merging L=1 speck (ancestor!) and L=1 prong B.
        candidateRuns = Int32Array.from([2, 2, 20, 1]);
        componentDetached = Uint8Array.from([0, 0]);
      }
      const candidatePairs = new Int32Array(0);
      const evt = {
        data: {
          type: 'done',
          result: { candidatePairs, candidateRuns, componentDetached },
        },
      } as MessageEvent;
      for (const cb of [...this.listeners]) cb(evt);
    }
    terminate() {}
  }
  (globalThis as { Worker?: unknown }).Worker = SyntheticRunsWorker;

  try {
    const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.5, 1.0, 0.3));
    const islands = await detectVoxelIslands(
      { positions: new Float32Array(0), bbox },
      0.1,
      { pxMm: 0.05, supportBufferMm: 0.25, minAreaMm2: 0.02 },
    );

    // Speck (0.0025 mm^2) must be rejected because preMergeMaxAreaMm2 freezes at 0.0025 before bridge!
    // Prong B (0.025 mm^2) and Detached tip (isDetached=true, 0.0025 mm^2) must survive.
    assert.equal(islands.length, 2, 'must keep Prong B and Detached tip while rejecting pre-merge speck');
    const detachedTip = islands.find((i) => i.isDetached);
    const prongB = islands.find((i) => !i.isDetached);
    assert.ok(detachedTip, 'tiny isDetached tip < minAreaMm2 must survive');
    assert.ok(prongB, 'Prong B >= minAreaMm2 must survive');
    assert.ok(Math.abs((detachedTip.areaMm2 ?? 0) - 0.0025) < 1e-6);
    assert.ok(Math.abs((prongB.areaMm2 ?? 0) - 0.025) < 1e-6);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }
});

test('FLD-06: same-layer saddle sibling continuation stays active, legacy candidatePairs-only fallback works, and edge guards hold', async () => {
  // 1. Edge guards in markDetachedAndRescueCandidates: height=0, empty current, non-sequential comp IDs
  const emptyMask: { rows: Int32Array[]; width: number; height: number } = { rows: [], width: 4, height: 0 };
  const dummyComp: ComponentInfo[] = [{ id: 5, label: 5, area_px: 1, size: 1, centroidSumX: 0, centroidSumY: 0 }];
  markDetachedAndRescueCandidates(
    emptyMask,
    emptyMask,
    emptyMask,
    { rows: [], width: 4, height: 0 },
    dummyComp,
    8,
  );
  assert.equal(dummyComp[0].isDetached, false);

  // Non-sequential component IDs (e.g., id = 7) alignment on detached component
  const pEmpty = rleEncode(makeMask(4, 2), 4, 2);
  const cOne = makeMask(4, 2);
  cOne[1 * 4 + 2] = 1;
  const cMask = rleEncode(cOne, 4, 2);
  const customLabels = { rows: [EMPTY_ROW, new Int32Array([2, 1, 7])], width: 4, height: 2 };
  const customComps: ComponentInfo[] = [{ id: 7, label: 7, area_px: 1, size: 1, centroidSumX: 2, centroidSumY: 1 }];
  markDetachedAndRescueCandidates(cMask, pEmpty, rleEncode(cOne, 4, 2), customLabels, customComps, 8);
  assert.equal(customComps[0].isDetached, true);

  // 2. Deferred sibling completion + legacy candidatePairs-only fallback
  const origWorker = (globalThis as { Worker?: unknown }).Worker;
  class SplitSiblingRunsWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.add(cb);
    }
    removeEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.delete(cb);
    }
    postMessage(msg: { type: string; z?: number }) {
      if (msg.type !== 'layer') return;
      const layerIdx = Math.round((msg.z ?? 0) / 1.0) - 1;
      let candidateRuns = new Int32Array(0);
      let componentDetached = new Uint8Array(0);
      if (layerIdx === 1) {
        // Born at L=1 (prevIslandRows === null on L=1, yet detached=0 -> CantileverFringe):
        // Comp 1 at (y=0, x=1), Comp 2 at (y=1, x=5)
        candidateRuns = Int32Array.from([
          0, 1, 1, 1,
          1, 5, 1, 2,
        ]);
        componentDetached = Uint8Array.from([0, 0, 0]);
      } else if (layerIdx === 2) {
        // Comp 1 merges Island 1 (0, 1) and Island 2 (1, 5) across y=0 [1..5] (dy=1 to (1,5)),
        // while Comp 2 continues Island 2 separately at (y=2, x=5) (dy=1 to (1,5), dy=2 from y=0)!
        // Because Comp 2 updates Island 2 on L=2, Island 2 must NOT be truncated to lastLayer=1.
        candidateRuns = Int32Array.from([
          0, 1, 5, 1,
          2, 5, 1, 2,
        ]);
        componentDetached = Uint8Array.from([0, 0, 0]);
      } else if (layerIdx === 3) {
        // Continues Island 2 at (y=2, x=5) -> proves Island 2 stayed 'active' at L=2!
        candidateRuns = Int32Array.from([2, 5, 1, 1]);
        componentDetached = Uint8Array.from([0, 0]);
      }
      const evt = {
        data: {
          type: 'done',
          result: { candidatePairs: new Int32Array(0), candidateRuns, componentDetached },
        },
      } as MessageEvent;
      for (const cb of [...this.listeners]) cb(evt);
    }
    terminate() {}
  }

  (globalThis as { Worker?: unknown }).Worker = SplitSiblingRunsWorker;
  try {
    const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(7, 4, 4));
    const islands = await detectVoxelIslands(
      { positions: new Float32Array(0), bbox },
      1.0,
      { pxMm: 1.0, supportBufferMm: 0, minAreaMm2: 0.1 },
    );
    assert.equal(islands.length, 2);
    assert.equal(islands[0].isDetached, false);
    assert.deepEqual(islands[0].layerSpan, [1, 2]);
    assert.deepEqual(islands[1].layerSpan, [1, 3], 'same-layer continued sibling must remain active through L=3');
  } finally {
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }

  // 3. Legacy mock worker returning only candidatePairs (without candidateRuns)
  class LegacyPairsOnlyWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.add(cb);
    }
    removeEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.delete(cb);
    }
    postMessage(msg: { type: string; z?: number }) {
      if (msg.type !== 'layer') return;
      const layerIdx = Math.round((msg.z ?? 0) / 1.0) - 1;
      const candidatePairs = layerIdx === 0 ? Int32Array.from([1, 1, 2, 1]) : new Int32Array(0);
      const evt = {
        data: { type: 'done', result: { candidatePairs } },
      } as MessageEvent;
      for (const cb of [...this.listeners]) cb(evt);
    }
    terminate() {}
  }
  (globalThis as { Worker?: unknown }).Worker = LegacyPairsOnlyWorker;
  try {
    const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 4, 2));
    const islands = await detectVoxelIslands(
      { positions: new Float32Array(0), bbox },
      1.0,
      { pxMm: 1.0, supportBufferMm: 0, minAreaMm2: 0.1 },
    );
    assert.equal(islands.length, 1);
    assert.equal(islands[0].areaMm2, 2.0);
    assert.equal(islands[0].isDetached, true);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }
});
