import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';

import {
  BucketedSlicer,
  computeLoopsAtY,
  computeLoopsAtZ,
  computeLoopsFromPositions,
  computeSegmentsFromPositions,
  polygonArea,
  type OrientedSegment2D,
} from '@/components/analysis/Slice2D';
import {
  rasterizeLoopsScanline,
  rasterizeLoopsToExistingGridScanline,
  rasterizeSegmentsScanline,
  rasterizeSegmentsToExistingGridScanline,
} from '@/volumeAnalysis/IslandScan/scanline';
import {
  rasterizeLoopsToExistingGrid,
  rasterizeLoopsToMask,
} from '@/volumeAnalysis/IslandScan/raster';
import { dispatchScanlineWorkerMessage } from '@/volumeAnalysis/IslandScan/scanlineScan.worker';
import { dispatchIslandScanWorkerMessage } from '@/volumeAnalysis/IslandScan/islandScan.worker';
import { VOXEL_OFFSET_Y, type ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { computeIslandMarkers, computeSeedMarkers } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { generateMeshFromRLE } from '@/volumeAnalysis/VoxelSystem/RleMeshing';
import {
  candidateVoxelPairs,
  rleDecode,
  rleEncode,
  rleEncodeLabels,
  type RleLabels,
  type RleMask,
} from '@/volumeAnalysis/IslandScan/rle';
import { detectVoxelIslands } from '@/volumeAnalysis/Islands/detect';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import type { Mask } from '@/volumeAnalysis/IslandScan/types';

after(() => {
  disposeEventLoopChannel();
});

/** Build non-indexed world-space triangles (9 floats/tri) for an axis-aligned box. */
function buildBoxPositions(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  invertWinding = false,
): Float32Array {
  const geom = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
  geom.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const nonIndexed = geom.toNonIndexed();
  const src = new Float32Array(nonIndexed.getAttribute('position').array as Float32Array);
  geom.dispose();
  nonIndexed.dispose();
  if (!invertWinding) return src;

  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 9) {
    out[i] = src[i];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i + 2];
    out[i + 3] = src[i + 6];
    out[i + 4] = src[i + 7];
    out[i + 5] = src[i + 8];
    out[i + 6] = src[i + 3];
    out[i + 7] = src[i + 4];
    out[i + 8] = src[i + 5];
  }
  return out;
}

/** Reflect positions across X (`det < 0`) and swap triangle vertices (1,2) per MIR-06. */
function mirrorXWithWindingFlip(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 9) {
    out[i] = -positions[i];
    out[i + 1] = positions[i + 1];
    out[i + 2] = positions[i + 2];
    out[i + 3] = -positions[i + 6];
    out[i + 4] = positions[i + 7];
    out[i + 5] = positions[i + 8];
    out[i + 6] = -positions[i + 3];
    out[i + 7] = positions[i + 4];
    out[i + 8] = positions[i + 5];
  }
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

function makeMaskRef(width: number, height: number, originX: number, originZ: number, px_mm = 1.0): Mask {
  return {
    data: new Uint8Array(width * height),
    width,
    height,
    originX,
    originZ,
    px_mm,
  };
}

function signedArea2D(loop: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    area += loop[j].x * loop[i].y - loop[i].x * loop[j].y;
  }
  return area * 0.5;
}

function buildDiamondPrismPositions(cx: number, cy: number, radius: number, minZ: number, maxZ: number): Float32Array {
  const pts: Array<[number, number]> = [
    [cx + radius, cy],
    [cx, cy + radius],
    [cx - radius, cy],
    [cx, cy - radius],
  ];
  const tris: number[] = [];
  const pushTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  pushTri([pts[0][0], pts[0][1], minZ], [pts[2][0], pts[2][1], minZ], [pts[1][0], pts[1][1], minZ]);
  pushTri([pts[0][0], pts[0][1], minZ], [pts[3][0], pts[3][1], minZ], [pts[2][0], pts[2][1], minZ]);
  pushTri([pts[0][0], pts[0][1], maxZ], [pts[1][0], pts[1][1], maxZ], [pts[2][0], pts[2][1], maxZ]);
  pushTri([pts[0][0], pts[0][1], maxZ], [pts[2][0], pts[2][1], maxZ], [pts[3][0], pts[3][1], maxZ]);

  for (let i = 0; i < 4; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % 4];
    pushTri([x0, y0, minZ], [x1, y1, minZ], [x1, y1, maxZ]);
    pushTri([x0, y0, minZ], [x1, y1, maxZ], [x0, y0, maxZ]);
  }
  return new Float32Array(tris);
}

/**
 * Build a box [minX,maxX]x[minY,maxY]x[0,4] whose 4 side walls share mid-height
 * vertices sitting directly on `splitZ` (reproducing GitHub #1017 / MIR-07).
 */
function buildVertexSplitBoxPositions(
  splitZ: number,
  minX = 0,
  maxX = 10,
  minY = 0,
  maxY = 10,
): Float32Array {
  const tris: number[] = [];
  const pushTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };

  pushTri([minX, minY, 0], [minX, maxY, 0], [maxX, maxY, 0]);
  pushTri([minX, minY, 0], [maxX, maxY, 0], [maxX, minY, 0]);
  pushTri([minX, minY, 4], [maxX, minY, 4], [maxX, maxY, 4]);
  pushTri([minX, minY, 4], [maxX, maxY, 4], [minX, maxY, 4]);

  const corners: Array<[number, number]> = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % 4];
    const mid: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, splitZ];
    const aBot: [number, number, number] = [x0, y0, 0];
    const bBot: [number, number, number] = [x1, y1, 0];
    const bTop: [number, number, number] = [x1, y1, 4];
    const aTop: [number, number, number] = [x0, y0, 4];
    pushTri(aBot, bBot, mid);
    pushTri(bBot, bTop, mid);
    pushTri(bTop, aTop, mid);
    pushTri(aTop, aBot, mid);
  }
  return new Float32Array(tris);
}

test('FLD-01: Y-asymmetric & det<0 mirrored air cavities stay hollow, with exact +1/-1 wind signs', () => {
  // Asymmetric inner pocket [6, 14] x [2, 8] -> rows 12..17 on 20x20 grid (0, -20)
  const outer = buildBoxPositions(0, 20, 0, 20, 0, 10, false);
  const inner = buildBoxPositions(6, 14, 2, 8, 2, 8, true);
  const positions = concatPositions(outer, inner);

  // Explicitly assert wind sign & signed loop orientation so a global +1<->-1 flip cannot pass
  const outerSegs = computeSegmentsFromPositions(outer, 4.0);
  const leftOuter = outerSegs.filter((s) => Math.abs(s.x1) < 1e-6 && Math.abs(s.x2) < 1e-6);
  const rightOuter = outerSegs.filter((s) => Math.abs(s.x1 - 20) < 1e-6 && Math.abs(s.x2 - 20) < 1e-6);
  assert.ok(leftOuter.length > 0 && leftOuter.every((s) => s.wind === 1), 'outer -X wall must have wind = +1');
  assert.ok(rightOuter.length > 0 && rightOuter.every((s) => s.wind === -1), 'outer +X wall must have wind = -1');

  const innerSegs = computeSegmentsFromPositions(inner, 4.0);
  const leftInner = innerSegs.filter((s) => Math.abs(s.x1 - 6) < 1e-6 && Math.abs(s.x2 - 6) < 1e-6);
  const rightInner = innerSegs.filter((s) => Math.abs(s.x1 - 14) < 1e-6 && Math.abs(s.x2 - 14) < 1e-6);
  assert.ok(leftInner.length > 0 && leftInner.every((s) => s.wind === -1), 'inverted inner -X wall must have wind = -1');
  assert.ok(rightInner.length > 0 && rightInner.every((s) => s.wind === 1), 'inverted inner +X wall must have wind = +1');

  const slicer = new BucketedSlicer(positions, 5.0);
  const segs = slicer.sliceSegments(4.0);
  const segMask = rasterizeSegmentsToExistingGridScanline(segs, makeMaskRef(20, 20, 0, -20, 1.0));

  const loops = computeLoopsFromPositions(positions, 4.0).map((l) => l.map((v) => ({ x: v.x, y: v.y })));
  const scanlineLoopMask = rasterizeLoopsScanline(loops, 1.0, 0);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const rawGeomLoops = computeLoopsAtZ(geom, 4.0);
  assert.equal(rawGeomLoops.length, 2);
  const areas = rawGeomLoops.map(signedArea2D).sort((a, b) => a - b);
  assert.ok(Math.abs(areas[0] - -48) < 1e-3, `inner inverted loop signed area expected -48, got ${areas[0]}`);
  assert.ok(Math.abs(areas[1] - 400) < 1e-3, `outer loop signed area expected +400, got ${areas[1]}`);

  const geomLoops = rawGeomLoops.map((l) => l.map((v) => ({ x: v.x, y: v.y })));
  const pointInPolyMask = rasterizeLoopsToExistingGrid(geomLoops, makeMaskRef(20, 20, 0, -20, 1.0));
  const tightPointInPolyMask = rasterizeLoopsToMask(geomLoops, 1.0, 0);
  geom.dispose();

  // Y-up computeLoopsAtY with asymmetric Z in [2, 8] -> 2D y in [-8, -2] -> rows 12..17
  const yOuter = buildBoxPositions(0, 20, 0, 10, 0, 20, false);
  const yInner = buildBoxPositions(6, 14, 2, 8, 2, 8, true);
  const geomY = new THREE.BufferGeometry();
  geomY.setAttribute('position', new THREE.BufferAttribute(concatPositions(yOuter, yInner), 3));
  const yLoops = computeLoopsAtY(geomY, 4.0).map((l) => l.map((v) => ({ x: v.x, y: v.y })));
  geomY.dispose();
  const yMask = rasterizeLoopsToExistingGridScanline(yLoops, makeMaskRef(20, 20, 0, -20, 1.0));

  for (const [label, mask] of [
    ['sliceSegments+scanline', segMask],
    ['computeLoopsFromPositions+rasterizeLoopsScanline', scanlineLoopMask],
    ['computeLoopsAtZ+raster.ts', pointInPolyMask],
    ['computeLoopsAtZ+rasterizeLoopsToMask', tightPointInPolyMask],
    ['computeLoopsAtY+scanline', yMask],
  ] as const) {
    assert.equal(mask.width, 20, `${label} width`);
    assert.equal(mask.height, 20, `${label} height`);
    assert.equal(mask.originX, 0, `${label} originX`);
    assert.equal(mask.originZ, -20, `${label} originZ`);

    let solidCount = 0;
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        const inCavity = row >= 12 && row <= 17 && col >= 6 && col <= 13;
        const expected = inCavity ? 0 : 1;
        assert.equal(mask.data[row * 20 + col], expected, `${label}: pixel (${col},${row}) expected ${expected}`);
        solidCount += mask.data[row * 20 + col];
      }
    }
    assert.equal(solidCount, 352, `${label}: outer solid ring must contain 400 - 48 = 352 pixels`);
  }

  // Mirrored (det < 0) X-reflected mesh with flipped triangle winding keeps inner pocket hollow
  const mirrored = mirrorXWithWindingFlip(positions);
  const mirrorSlicer = new BucketedSlicer(mirrored, 5.0);
  const mirrorSegMask = rasterizeSegmentsToExistingGridScanline(
    mirrorSlicer.sliceSegments(4.0),
    makeMaskRef(20, 20, -20, -20, 1.0),
  );
  const mirrorLoopMask = rasterizeLoopsToExistingGrid(
    computeLoopsFromPositions(mirrored, 4.0).map((l) => l.map((v) => ({ x: v.x, y: v.y }))),
    makeMaskRef(20, 20, -20, -20, 1.0),
  );
  for (const [label, mask] of [
    ['mirrored det<0 sliceSegments', mirrorSegMask],
    ['mirrored det<0 raster.ts', mirrorLoopMask],
  ] as const) {
    let solidCount = 0;
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        // Original x in [6,14] mirrors to [-14,-6] -> cols 6..13 on originX=-20
        const inCavity = row >= 12 && row <= 17 && col >= 6 && col <= 13;
        assert.equal(mask.data[row * 20 + col], inCavity ? 0 : 1, `${label}: (${col},${row})`);
        solidCount += mask.data[row * 20 + col];
      }
    }
    assert.equal(solidCount, 352, `${label}: mirrored hollow ring solid count`);
  }
});

test('FLD-01b: defective-row matched-pair leak repair exercises orphan edges, interior collapseSubpixelPairs, and gapSignature', () => {
  // Part A: Box [4, 14] x [-16, -4] (cols 4..13, rows 4..15)
  // - Row 8 (2D y in [-12, -11]): orphan +1 edge outside left wall at x = 2.2
  // - Row 10 (2D y in [-10, -9]): interior subpixel opposite-wind pair (8.2, -1), (8.6, +1)
  //   with open.length > 0 plus trailing orphan (16.2, +1), so ONLY collapseSubpixelPairs
  //   prevents a spurious gap at col = 8!
  const defectiveSegments: OrientedSegment2D[] = [
    { x1: 4, y1: -16, x2: 4, y2: -4, wind: 1 },
    { x1: 14, y1: -16, x2: 14, y2: -4, wind: -1 },
    { x1: 2.2, y1: -11.8, x2: 2.2, y2: -10.8, wind: 1 },
    { x1: 8.2, y1: -9.8, x2: 8.2, y2: -8.8, wind: -1 },
    { x1: 8.6, y1: -9.8, x2: 8.6, y2: -8.8, wind: 1 },
    { x1: 16.2, y1: -9.8, x2: 16.2, y2: -8.8, wind: 1 },
  ];

  const repaired = rasterizeSegmentsToExistingGridScanline(defectiveSegments, makeMaskRef(20, 20, 0, -20, 1.0));
  for (let row = 0; row < 20; row++) {
    const rowInBox = row >= 4 && row <= 15;
    for (let col = 0; col < 20; col++) {
      const expected = rowInBox && col >= 4 && col <= 13 ? 1 : 0;
      assert.equal(repaired.data[row * 20 + col], expected, `repaired pixel (${col},${row})`);
    }
  }

  // Part B: gapSignature (wLeft < 0 && wRight > 0) in air gap between two bars [2, 6] and [12, 16]
  // Row 10 injects (7.2, -1) and (10.8, +1) inside the gap -> must NOT bridge cols 6..11.
  const twoBarsWithGapGlitch: OrientedSegment2D[] = [
    { x1: 2, y1: -16, x2: 2, y2: -4, wind: 1 },
    { x1: 6, y1: -16, x2: 6, y2: -4, wind: -1 },
    { x1: 12, y1: -16, x2: 12, y2: -4, wind: 1 },
    { x1: 16, y1: -16, x2: 16, y2: -4, wind: -1 },
    { x1: 7.2, y1: -9.8, x2: 7.2, y2: -8.8, wind: -1 },
    { x1: 10.8, y1: -9.8, x2: 10.8, y2: -8.8, wind: 1 },
  ];
  const gapRepaired = rasterizeSegmentsToExistingGridScanline(twoBarsWithGapGlitch, makeMaskRef(20, 20, 0, -20, 1.0));
  for (let row = 0; row < 20; row++) {
    const inY = row >= 4 && row <= 15;
    for (let col = 0; col < 20; col++) {
      const inBars = inY && ((col >= 2 && col <= 5) || (col >= 12 && col <= 15));
      assert.equal(gapRepaired.data[row * 20 + col], inBars ? 1 : 0, `gapSignature pixel (${col},${row})`);
    }
  }
});

test('FLD-02: single self-overlapping loop, nested same-winding solids, and pinch vertices stay exact', () => {
  // 1. Single self-overlapping CCW polygon loop spanning ([2,12] x [-14,-4]) U ([8,16] x [-12,-4])
  // Overlap region [8,12] x [-12,-4] has winding = +2 (fails even-odd XOR on BOTH raster.ts and scanline.ts!)
  const selfOverlappingSingleLoop = [[
    { x: 2, y: -14 },
    { x: 12, y: -14 },
    { x: 12, y: -4 },
    { x: 8, y: -4 },
    { x: 8, y: -12 },
    { x: 16, y: -12 },
    { x: 16, y: -4 },
    { x: 2, y: -4 },
  ]];
  const singleScanGrid = rasterizeLoopsToExistingGridScanline(selfOverlappingSingleLoop, makeMaskRef(20, 20, 0, -20, 1.0));
  const singleScanTight = rasterizeLoopsScanline(selfOverlappingSingleLoop, 1.0, 0);
  const singlePipGrid = rasterizeLoopsToExistingGrid(selfOverlappingSingleLoop, makeMaskRef(20, 20, 0, -20, 1.0));
  const singlePipTight = rasterizeLoopsToMask(selfOverlappingSingleLoop, 1.0, 0);

  for (const [label, mask] of [
    ['singleLoop+scanlineGrid', singleScanGrid],
    ['singleLoop+raster.ts', singlePipGrid],
  ] as const) {
    for (let row = 0; row < 20; row++) {
      const y2d = -20 + row + 0.5;
      for (let col = 0; col < 20; col++) {
        const x = col + 0.5;
        const inA = x >= 2 && x < 12 && y2d >= -14 && y2d < -4;
        const inB = x >= 8 && x < 16 && y2d >= -12 && y2d < -4;
        assert.equal(mask.data[row * 20 + col], inA || inB ? 1 : 0, `${label}: (${col},${row})`);
      }
    }
  }
  assert.equal(singleScanTight.width, 14);
  assert.equal(singleScanTight.height, 10);
  assert.equal(singlePipTight.width, 14);
  assert.equal(singlePipTight.height, 10);
  assert.equal(
    singleScanTight.data.reduce((s, v) => s + v, 0),
    singlePipTight.data.reduce((s, v) => s + v, 0),
  );

  // 2. Shared-vertex L-fold + nested same-winding solid interior (3D pipeline via BucketedSlicer & Slice2D)
  const sharedA = buildBoxPositions(2, 12, 3, 15, 0, 2);
  const sharedB = buildBoxPositions(2, 18, 3, 9, 0, 2);
  const lFoldPositions = concatPositions(sharedA, sharedB);
  const lFoldSlicer = new BucketedSlicer(lFoldPositions, 5.0);
  const lFoldSegMask = rasterizeSegmentsToExistingGridScanline(
    lFoldSlicer.sliceSegments(1.0),
    makeMaskRef(20, 20, 0, -20, 1.0),
  );
  const lFoldLoopMask = rasterizeLoopsToExistingGridScanline(
    computeSegmentsFromPositions(lFoldPositions, 1.0).length > 0
      ? lFoldSlicer.slice(1.0).map((l) => l.map((v) => ({ x: v.x, y: v.y })))
      : [],
    makeMaskRef(20, 20, 0, -20, 1.0),
  );
  for (const [label, mask] of [
    ['shared-vertex L-fold sliceSegments', lFoldSegMask],
    ['shared-vertex L-fold slice loops', lFoldLoopMask],
  ] as const) {
    for (let row = 0; row < 20; row++) {
      const worldY = 20 - (row + 0.5);
      for (let col = 0; col < 20; col++) {
        const worldX = col + 0.5;
        const inSolid =
          (worldX >= 2 && worldX < 12 && worldY >= 3 && worldY <= 15) ||
          (worldX >= 2 && worldX < 18 && worldY >= 3 && worldY <= 9);
        assert.equal(mask.data[row * 20 + col], inSolid ? 1 : 0, `${label}: (${col},${row})`);
      }
    }
  }

  // Nested concentric same-winding outer [0,20] + inner [6,14]x[2,8] (outward + outward -> +2 stays solid)
  const sameWindPos = concatPositions(
    buildBoxPositions(0, 20, 0, 20, 0, 2, false),
    buildBoxPositions(6, 14, 2, 8, 0, 2, false),
  );
  const sameWindMask = rasterizeSegmentsToExistingGridScanline(
    computeSegmentsFromPositions(sameWindPos, 1.0),
    makeMaskRef(20, 20, 0, -20, 1.0),
  );
  assert.equal(sameWindMask.data.reduce((s, v) => s + v, 0), 400, 'same-winding +2 core must remain 100% solid');

  // 3. Kissing pinch-vertex diamonds at (8, 10) and (12, 10) sharing (10, 10)
  const pinchPositions = concatPositions(
    buildDiamondPrismPositions(8, 10, 2, 0, 2),
    buildDiamondPrismPositions(12, 10, 2, 0, 2),
  );
  const pinchSlicer = new BucketedSlicer(pinchPositions, 5.0);
  const pinchSegMask = rasterizeSegmentsToExistingGridScanline(
    pinchSlicer.sliceSegments(1.0),
    makeMaskRef(20, 20, 0, -20, 1.0),
  );
  const pinchLoopMask = rasterizeLoopsToExistingGridScanline(
    pinchSlicer.slice(1.0).map((l) => l.map((v) => ({ x: v.x, y: v.y }))),
    makeMaskRef(20, 20, 0, -20, 1.0),
  );

  for (const [label, mask] of [
    ['pinch sliceSegments', pinchSegMask],
    ['pinch slice loops', pinchLoopMask],
  ] as const) {
    for (let row = 0; row < 20; row++) {
      const worldY = 20 - (row + 0.5);
      const dy = Math.abs(worldY - 10);
      const halfSpan = 2 - dy;
      for (let col = 0; col < 20; col++) {
        const worldX = col + 0.5;
        const inLeft = halfSpan > 0 && worldX >= 8 - halfSpan && worldX < 8 + halfSpan;
        const inRight = halfSpan > 0 && worldX >= 12 - halfSpan && worldX < 12 + halfSpan;
        assert.equal(mask.data[row * 20 + col], inLeft || inRight ? 1 : 0, `${label}: (${col},${row})`);
      }
    }
  }
});

test('MIR-07 (#1017): vertex on zSlice, indexed & empty BufferGeometry, and defensive empty/zero guards', () => {
  // Asymmetric [1, 11] x [2, 9] x [0, 4] in padded 20x20 grid (originX = -4, originZ = -15) -> cols 5..14, rows 6..12 (70 px).
  // Use splitZ = 1.0 (exact in Float32Array) with sliceZ = 1.0 - 1e-5 so zSlice === 1.000000 === splitZ bit-exact.
  const sliceZ = 1.0 - 1e-5;
  const positions = buildVertexSplitBoxPositions(1.0, 1, 11, 2, 9);

  const slicer = new BucketedSlicer(positions, 5.0);
  const segs = slicer.sliceSegments(sliceZ);
  const segMask = rasterizeSegmentsToExistingGridScanline(segs, makeMaskRef(20, 20, -4, -15, 1.0));

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const loops = computeLoopsAtZ(geom, sliceZ).map((l) => l.map((v) => ({ x: v.x, y: v.y })));
  const loopMask = rasterizeLoopsToExistingGridScanline(loops, makeMaskRef(20, 20, -4, -15, 1.0));
  geom.dispose();

  const posLoops = computeLoopsFromPositions(positions, sliceZ).map((l) => l.map((v) => ({ x: v.x, y: v.y })));
  const posLoopMask = rasterizeLoopsToExistingGridScanline(posLoops, makeMaskRef(20, 20, -4, -15, 1.0));

  for (const [label, mask] of [
    ['sliceSegments', segMask],
    ['computeLoopsAtZ', loopMask],
    ['computeLoopsFromPositions', posLoopMask],
  ] as const) {
    let solidCount = 0;
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        const inside = col >= 5 && col <= 14 && row >= 6 && row <= 12;
        assert.equal(mask.data[row * 20 + col], inside ? 1 : 0, `${label}: (${col},${row})`);
        solidCount += mask.data[row * 20 + col];
      }
    }
    assert.equal(solidCount, 70, `${label}: asymmetric 10x7 vertex-split box solid pixel count`);
  }

  // Indexed BoxGeometry (not .toNonIndexed()) in computeLoopsAtZ and computeLoopsAtY
  const indexedBox = new THREE.BoxGeometry(8, 6, 4);
  assert.ok(indexedBox.getIndex() !== null, 'BoxGeometry must remain indexed');
  const indexedZLoops = computeLoopsAtZ(indexedBox, 0.5);
  assert.equal(indexedZLoops.length, 1, 'indexed BoxGeometry Z slice must yield 1 loop');
  assert.ok(Math.abs(polygonArea(indexedZLoops[0]) - 48) < 1e-4, 'indexed BoxGeometry Z cross-section = 8x6');
  const indexedYLoops = computeLoopsAtY(indexedBox, 0.5);
  assert.equal(indexedYLoops.length, 1, 'indexed BoxGeometry Y slice must yield 1 loop');
  assert.ok(Math.abs(polygonArea(indexedYLoops[0]) - 32) < 1e-4, 'indexed BoxGeometry Y cross-section = 8x4');
  indexedBox.dispose();

  // Empty & invalid parameter guards
  const emptyGeom = new THREE.BufferGeometry();
  assert.deepEqual(computeLoopsAtZ(emptyGeom, 0), []);
  assert.deepEqual(computeLoopsAtY(emptyGeom, 0), []);
  emptyGeom.dispose();

  const emptySlicer = new BucketedSlicer(new Float32Array(0), 5.0);
  assert.deepEqual(emptySlicer.slice(0), []);
  assert.deepEqual(emptySlicer.sliceSegments(0), []);
  assert.equal(rasterizeSegmentsScanline([], 0.5, 0).width, 1);
  assert.equal(rasterizeLoopsScanline([], 0.5, 0).width, 1);
  assert.equal(rasterizeLoopsToMask([], 0.5, 0).width, 1);
  assert.equal(rasterizeSegmentsToExistingGridScanline([], makeMaskRef(0, 4, 0, 0, 0.5)).data.length, 0);
  assert.equal(rasterizeLoopsToExistingGrid([], makeMaskRef(4, 4, 0, 0, 0)).data.every((v) => v === 0), true);
});

test('NBR-04: non-unit px_mm sub-voxel alignment, VOXEL_OFFSET_Y = 0.5, markers, RLE meshing, detectVoxelIslands, and BucketedSlicer Z_TOL', async () => {
  // Sub-pixel box [2.1, 2.4] x [5.6, 5.9] x [0, 1] on padded grid origin=(1.5, -7.0), px_mm=0.5:
  // ONLY col=1 (center x=2.25) and row=2 (center y=5.75) match!
  // On pre-Phase-B raster.ts, corner (col*px, row*px) = (2.0, -6.0) missed [2.1, 2.4] x [-5.9, -5.6].
  const subVoxelPos = buildBoxPositions(2.1, 2.4, 5.6, 5.9, 0, 1);
  const slicer = new BucketedSlicer(subVoxelPos, 5.0);
  const segs = slicer.sliceSegments(0.5);
  const loops = computeLoopsFromPositions(subVoxelPos, 0.5).map((l) => l.map((v) => ({ x: v.x, y: v.y })));

  const segGridMask = rasterizeSegmentsToExistingGridScanline(segs, makeMaskRef(6, 6, 1.5, -7.0, 0.5));
  const loopGridMask = rasterizeLoopsToExistingGridScanline(loops, makeMaskRef(6, 6, 1.5, -7.0, 0.5));
  const pipGridMask = rasterizeLoopsToExistingGrid(loops, makeMaskRef(6, 6, 1.5, -7.0, 0.5));

  for (const [label, mask] of [
    ['rasterizeSegmentsToExistingGridScanline', segGridMask],
    ['rasterizeLoopsToExistingGridScanline', loopGridMask],
    ['rasterizeLoopsToExistingGrid', pipGridMask],
  ] as const) {
    assert.equal(mask.data[2 * 6 + 1], 1, `${label}: pixel (col=1,row=2) must be ON`);
    assert.equal(mask.data.reduce((s, v) => s + v, 0), 1, `${label}: exact single pixel ON`);
  }

  for (const [label, tightMask] of [
    ['rasterizeSegmentsScanline', rasterizeSegmentsScanline(segs, 0.5, 0)],
    ['rasterizeLoopsScanline', rasterizeLoopsScanline(loops, 0.5, 0)],
    ['rasterizeLoopsToMask', rasterizeLoopsToMask(loops, 0.5, 0)],
  ] as const) {
    assert.equal(tightMask.width, 1, `${label} width`);
    assert.equal(tightMask.height, 1, `${label} height`);
    assert.ok(Math.abs(tightMask.originX - 2.1) < 1e-5, `${label} originX`);
    assert.ok(Math.abs(tightMask.originZ - -5.9) < 1e-5, `${label} originZ`);
    assert.equal(tightMask.data[0], 1, `${label} tight pixel (0,0)`);
  }

  assert.equal(VOXEL_OFFSET_Y, 0.5);

  // Asymmetric px_mm = 0.5, layerHeightMm = 0.25, zOffset = 1.25, col = 1, row = 2, layer = 3:
  // x = 1.5 + (1 + 0.5)*0.5 = 2.25, y = -(-7.0 + (2 + 0.5)*0.5) = 5.75, z = 1.25 + (3 + 0.5)*0.25 = 2.125
  const grid = { originX: 1.5, originZ: -7.0, width: 6, height: 6, px_mm: 0.5 };
  const labelGrid = new Int32Array(36);
  labelGrid[2 * 6 + 1] = 1;
  const rleLabels = rleEncodeLabels(labelGrid, 6, 6);
  const solidMaskRle = rleEncode(Uint8Array.from(labelGrid), 6, 6);

  const scanResults: ScanResults = {
    grid,
    layers: [
      { islandMaskRle: solidMaskRle, islandCount: 0, islandLabels: rleEncodeLabels(new Int32Array(36), 6, 6) },
      { islandMaskRle: solidMaskRle, islandCount: 0, islandLabels: rleEncodeLabels(new Int32Array(36), 6, 6) },
      { islandMaskRle: solidMaskRle, islandCount: 0, islandLabels: rleEncodeLabels(new Int32Array(36), 6, 6) },
      { islandMaskRle: solidMaskRle, islandCount: 1, islandLabels: rleLabels },
    ],
    firstHit: new Int16Array(36).fill(-1),
    lastHit: new Int16Array(36).fill(-1),
    baseFootprint: new Uint8Array(36),
    baseLabels: new Int32Array(36),
    compBase: new Int16Array([-1, 3]),
    compTop: new Int16Array([-1, 3]),
    islands: [
      {
        id: 1,
        firstLayer: 3,
        lastLayer: 3,
        status: 'complete',
        totalAreaMm2: 0.25,
        perLayerAreaMm2: new Map([[3, 0.25]]),
        childIds: [],
        centroidSumX: 2.25,
        centroidSumY: 5.75,
        centroidSumZ: 2.125,
        centroidCount: 1,
        seedVoxel: { x: 1, y: 2, z: 3 },
      },
    ],
    islandLabelsPerLayer: [
      rleEncodeLabels(new Int32Array(36), 6, 6),
      rleEncodeLabels(new Int32Array(36), 6, 6),
      rleEncodeLabels(new Int32Array(36), 6, 6),
      rleLabels,
    ],
  };

  const islandMarkers = computeIslandMarkers(scanResults, { min: { z: 1.25 } }, 0.25);
  assert.equal(islandMarkers.length, 1);
  assert.equal(islandMarkers[0].centerX, 2.25);
  assert.equal(islandMarkers[0].centerY, 5.75);
  assert.ok(islandMarkers[0].geometry, 'island marker must carry geometry');
  const imBox = new THREE.Box3().setFromBufferAttribute(
    islandMarkers[0].geometry.getAttribute('position') as THREE.BufferAttribute,
  );
  assert.deepEqual([imBox.min.x, imBox.min.y], [2.0, 5.5]);
  assert.deepEqual([imBox.max.x, imBox.max.y], [2.5, 6.0]);
  islandMarkers.forEach((m) => m.geometry?.dispose());

  const seedMarkers = computeSeedMarkers(scanResults, { min: { z: 1.25 } }, 0.25);
  assert.equal(seedMarkers.length, 1);
  assert.equal(seedMarkers[0].centerX, 2.25);
  assert.equal(seedMarkers[0].centerY, 5.75);
  assert.equal(seedMarkers[0].baseZ, 2.125);
  assert.ok(seedMarkers[0].geometry, 'seed marker must carry geometry');
  const smBox = new THREE.Box3().setFromBufferAttribute(
    seedMarkers[0].geometry.getAttribute('position') as THREE.BufferAttribute,
  );
  assert.deepEqual([smBox.min.x, smBox.min.y, smBox.min.z], [2.0, 5.5, 2.0]);
  assert.deepEqual([smBox.max.x, smBox.max.y, smBox.max.z], [2.5, 6.0, 2.25]);
  seedMarkers.forEach((m) => m.geometry?.dispose());

  const rleGeoms = generateMeshFromRLE(1, scanResults.islandLabelsPerLayer, grid, 0.25, 1.25, 3, 3);
  assert.equal(rleGeoms.length, 1);
  const rleBox = new THREE.Box3().setFromBufferAttribute(rleGeoms[0].getAttribute('position') as THREE.BufferAttribute);
  assert.deepEqual([rleBox.min.x, rleBox.min.y, rleBox.min.z], [2.0, 5.5, 2.0]);
  assert.deepEqual([rleBox.max.x, rleBox.max.y, rleBox.max.z], [2.5, 6.0, 2.25]);
  rleGeoms.forEach((g) => g.dispose());

  // detectVoxelIslands end-to-end with non-unit pxMm=0.5, layerHeightMm=0.25, padded col=1, row=2
  const detectPositions = concatPositions(
    buildBoxPositions(1.5, 2.0, 4.0, 4.5, 0, 1.5),
    buildBoxPositions(2.0, 2.5, 5.5, 6.0, 0.6, 1.5),
  );
  const origWorker = (globalThis as { Worker?: unknown }).Worker;
  class InlineScanlineWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, fn: (e: MessageEvent) => void) {
      this.listeners.add(fn);
    }
    removeEventListener(_type: string, fn: (e: MessageEvent) => void) {
      this.listeners.delete(fn);
    }
    postMessage(msg: unknown) {
      dispatchScanlineWorkerMessage(msg as Parameters<typeof dispatchScanlineWorkerMessage>[0], (payload) => {
        const evt = { data: payload } as MessageEvent;
        for (const fn of [...this.listeners]) fn(evt);
      });
    }
    terminate() {}
  }
  (globalThis as { Worker?: unknown }).Worker = InlineScanlineWorker;
  try {
    const detected = await detectVoxelIslands(
      {
        positions: detectPositions,
        bbox: new THREE.Box3(new THREE.Vector3(1.5, 4.0, 0), new THREE.Vector3(4.5, 7.0, 1.5)),
      },
      0.25,
      { pxMm: 0.5, supportBufferMm: 0, minAreaMm2: 0.1 },
    );
    assert.equal(detected.length, 1);
    assert.equal(detected[0].contact.x, 2.25);
    assert.equal(detected[0].contact.y, 5.75);
    assert.deepEqual(Array.from(detected[0].contactVoxels!.xy), [2.25, 5.75]);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }

  // Genuine pre-Phase-B Red BucketedSlicer Z_TOL tests:
  // (a) triMinZ = 5.000002 starts in bucket 1 while z = 4.999995 (zSlice = 5.000005) looked in bucket 0 pre-Phase-B
  const anchor = buildBoxPositions(0, 1, 0, 1, 0, 10);
  const seamBox = buildBoxPositions(2, 6, 2, 6, 5.000002, 6.0);
  const zTolSlicer = new BucketedSlicer(concatPositions(anchor, seamBox), 5.0);
  const seamSegMask = rasterizeSegmentsToExistingGridScanline(
    zTolSlicer.sliceSegments(4.999995),
    makeMaskRef(8, 8, 0, -8, 1.0),
  );
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const inAnchor = col === 0 && row === 7;
      const inSeam = col >= 2 && col <= 5 && row >= 2 && row <= 5;
      assert.equal(seamSegMask.data[row * 8 + col], inAnchor || inSeam ? 1 : 0, `Z_TOL seam (${col},${row})`);
    }
  }
  assert.equal(zTolSlicer.slice(4.999995).length, 2, 'slice(4.999995) across bucket 5.0 must return both loops');

  // (b) z = -0.000005 -> zSlice = +0.000005 >= minZ=0 (pre-Phase-B checked z < minZ and returned [])
  assert.equal(zTolSlicer.slice(-0.000005).length, 1, 'slice(-0.000005) within Z_TOL of minZ must hit anchor');
  assert.ok(zTolSlicer.sliceSegments(-0.000005).length >= 2, 'sliceSegments(-0.000005) must hit anchor');

  // (c) Non-zero minZ = 1.25: bucket 1 starts at 6.25; seamBox2 starts at 6.250002 and is sliced at z = 6.249994
  const anchor2 = buildBoxPositions(0, 1, 0, 1, 1.25, 11.25);
  const seamBox2 = buildBoxPositions(2, 6, 2, 6, 6.250002, 8.0);
  const offsetSlicer = new BucketedSlicer(concatPositions(anchor2, seamBox2), 5.0);
  assert.equal(offsetSlicer.slice(6.249994).length, 2, 'non-zero minZ bucket seam must return both loops');
});

test('Worker parity: both scanlineScan.worker and islandScan.worker reject hollow interior fill, match RLE/coordinates, and handle omitted gridRef & start', () => {
  const hollowPositions = concatPositions(
    buildBoxPositions(0, 20, 0, 20, 0, 10, false),
    buildBoxPositions(6, 14, 6, 14, 2, 8, true),
  );
  const hollowGrid = { originX: 0, originZ: -20, width: 20, height: 20, px_mm: 1.0 };

  dispatchScanlineWorkerMessage({ type: 'init', positions: hollowPositions }, () => {});
  dispatchIslandScanWorkerMessage({ type: 'init', positions: hollowPositions }, () => {});

  // At z=5.0 over z=4.0: zero candidates / zero new islands inside hollow interior
  const scanlineMid: Array<{ result: { candidatePairs?: Int32Array } }> = [];
  dispatchScanlineWorkerMessage(
    {
      type: 'layer',
      z: 5.0,
      layerHeightMm: 1.0,
      gridRef: hollowGrid,
      opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
      candidatesOnly: true,
    },
    (payload) => scanlineMid.push(payload as (typeof scanlineMid)[number]),
  );
  assert.equal(scanlineMid[0].result.candidatePairs!.length, 0);

  const islandMid: Array<{ result: { islandCount: number; solidMaskRle: RleMask } }> = [];
  dispatchIslandScanWorkerMessage(
    {
      type: 'layer',
      z: 5.0,
      layerHeightMm: 1.0,
      gridRef: hollowGrid,
      opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
    },
    (payload) => islandMid.push(payload as (typeof islandMid)[number]),
  );
  assert.equal(islandMid[0].result.islandCount, 0);
  assert.equal(rleDecode(islandMid[0].result.solidMaskRle).reduce((s, v) => s + v, 0), 336);

  // At z=8.5 over z=7.5 (roof closes over 8x8 [6..14] pocket): verify EXACT [6..13]x[6..13] coordinates
  const expectedCoords = new Set<string>();
  for (let row = 6; row <= 13; row++) {
    for (let col = 6; col <= 13; col++) {
      expectedCoords.add(`${col}:${row}`);
    }
  }

  const scanlineRoof: Array<{ result: { candidatePairs?: Int32Array } }> = [];
  dispatchScanlineWorkerMessage(
    {
      type: 'layer',
      z: 8.5,
      layerHeightMm: 1.0,
      gridRef: hollowGrid,
      opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
      candidatesOnly: true,
    },
    (payload) => scanlineRoof.push(payload as (typeof scanlineRoof)[number]),
  );
  const slCoords = new Set<string>();
  const slPairs = scanlineRoof[0].result.candidatePairs!;
  for (let i = 0; i < slPairs.length; i += 2) {
    slCoords.add(`${slPairs[i]}:${slPairs[i + 1]}`);
  }
  assert.deepEqual(slCoords, expectedCoords, 'scanlineScan.worker roof candidates must match exact [6..13]x[6..13]');

  const islandRoof: Array<{
    result: { islandCount: number; islandLabelsRle: RleLabels; components: Array<{ area_px: number }> };
  }> = [];
  dispatchIslandScanWorkerMessage(
    {
      type: 'layer',
      z: 8.5,
      layerHeightMm: 1.0,
      gridRef: hollowGrid,
      opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
    },
    (payload) => islandRoof.push(payload as (typeof islandRoof)[number]),
  );
  assert.equal(islandRoof[0].result.islandCount, 1);
  assert.equal(islandRoof[0].result.components[0].area_px, 64);
  const islPairs = candidateVoxelPairs(islandRoof[0].result.islandLabelsRle);
  const islCoords = new Set<string>();
  for (let i = 0; i < islPairs.length; i += 2) {
    islCoords.add(`${islPairs[i]}:${islPairs[i + 1]}`);
  }
  assert.deepEqual(islCoords, expectedCoords, 'islandScan.worker roof island must match exact [6..13]x[6..13]');

  // Test gridRef omitted (`undefined`) fallback across both workers
  const noGridA: Array<{ result: { solidMaskRle: RleMask; islandCount: number } }> = [];
  const noGridB: Array<{ result: { solidMaskRle: RleMask; islandCount: number } }> = [];
  dispatchScanlineWorkerMessage(
    {
      type: 'layer',
      z: 5.0,
      layerHeightMm: 1.0,
      opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
    },
    (payload) => noGridA.push(payload as unknown as (typeof noGridA)[number]),
  );
  dispatchIslandScanWorkerMessage(
    {
      type: 'layer',
      z: 5.0,
      layerHeightMm: 1.0,
      opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
    },
    (payload) => noGridB.push(payload as (typeof noGridB)[number]),
  );
  assert.equal(noGridA[0].result.solidMaskRle.width, 20);
  assert.deepEqual(rleDecode(noGridA[0].result.solidMaskRle), rleDecode(noGridB[0].result.solidMaskRle));

  // #1017 vertex-split column: middle vertex at splitZ = 1.0 with sliceZ = 1.0 - 1e-5 (zSlice === 1.0 exact)
  const splitPositions = buildVertexSplitBoxPositions(1.0);
  const splitGrid = { originX: 0, originZ: -10, width: 10, height: 10, px_mm: 1.0 };
  dispatchScanlineWorkerMessage({ type: 'init', positions: splitPositions }, () => {});
  dispatchIslandScanWorkerMessage({ type: 'init', positions: splitPositions }, () => {});

  for (const z of [1.0 - 1e-5, 1.5]) {
    const slFull: Array<{ result: { candidatePairs?: Int32Array; solidMaskRle?: RleMask; islandCount?: number } }> = [];
    dispatchScanlineWorkerMessage(
      {
        type: 'layer',
        z,
        layerHeightMm: 0.5,
        gridRef: splitGrid,
        opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
        candidatesOnly: false,
      },
      (payload) => slFull.push(payload as (typeof slFull)[number]),
    );
    assert.equal(slFull[0].result.islandCount, 0, `scanlineScan.worker full z=${z}: 0 mid-air islands`);
    assert.equal(rleDecode(slFull[0].result.solidMaskRle!).reduce((s, v) => s + v, 0), 100, `scanlineScan.worker full z=${z}: 100 solid px`);

    const islandResps: Array<{ result: { islandCount: number; solidMaskRle: RleMask } }> = [];
    dispatchIslandScanWorkerMessage(
      {
        type: 'layer',
        z,
        layerHeightMm: 0.5,
        gridRef: splitGrid,
        opts: { px_mm: 1.0, support_buffer_mm: 0, connectivity: 4 },
      },
      (payload) => islandResps.push(payload as (typeof islandResps)[number]),
    );
    assert.equal(islandResps[0].result.islandCount, 0, `islandScan.worker z=${z}: 0 mid-air islands`);
    assert.deepEqual(
      rleDecode(islandResps[0].result.solidMaskRle),
      rleDecode(slFull[0].result.solidMaskRle!),
      `z=${z}: full solidMaskRle parity between both workers`,
    );
  }

  // Test `start` message on islandScan.worker
  const startResps: Array<{ result: { solidMask: RleMask; components: Array<{ area_px: number }> } }> = [];
  const curDense = new Uint8Array(16);
  curDense.fill(1, 5, 7);
  dispatchIslandScanWorkerMessage(
    {
      type: 'start',
      current: { data: curDense, width: 4, height: 4 },
      prev: null,
      opts: { px_mm: 0.5, support_buffer_mm: 0, connectivity: 4 },
    },
    (payload) => startResps.push(payload as (typeof startResps)[number]),
  );
  assert.equal(startResps[0].result.components.length, 1);
  assert.equal(startResps[0].result.components[0].area_px, 2);
});
