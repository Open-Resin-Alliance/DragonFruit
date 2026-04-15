#!/usr/bin/env npx tsx
/**
 * Compare Rust vs TypeScript island detection pipelines.
 *
 * Strategy: Use Rust-rasterized masks as ground truth input,
 * then run BOTH the Rust and TS scan+track pipelines on the same masks.
 * This isolates the scan/track/analyze logic from rasterization differences.
 *
 * Usage: npx tsx scripts/island-compare-rs-ts.ts /tmp/df-det-a
 *   (where /tmp/df-det-a is output from: dragonfruit-cli island full model.stl -o /tmp/df-det-a)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// RLE types (same as island-bench.ts)
// ---------------------------------------------------------------------------
type RleRow = Int32Array;
type RleMask = { rows: RleRow[]; width: number; height: number };
type RleLabelRow = Int32Array;
type RleLabels = { rows: RleLabelRow[]; width: number; height: number };
type ComponentInfo = {
  id: number; label: number; area_px: number; size: number;
  centroidSumX: number; centroidSumY: number;
};
type Island = {
  id: number; firstLayer: number; lastLayer: number;
  status: 'active' | 'complete'; totalAreaMm2: number;
  perLayerAreaMm2: Map<number, number>; parentId?: number;
  childIds: number[]; volumeMm3?: number; maxAreaMm2?: number;
  maxAreaLayer?: number; isMergedPlaceholder?: boolean;
  centroidSumX: number; centroidSumY: number; centroidSumZ: number;
  centroidCount: number;
  centroid?: { x: number; y: number; z: number };
  lastLayerCentroid?: { x: number; y: number; z: number };
};

// ---------------------------------------------------------------------------
// RLE functions (copied from island-bench.ts — the TS reference impl)
// ---------------------------------------------------------------------------
function rleIntersectDilated(a: RleMask, b: RleMask, buffer: number): RleMask {
  const { width, height } = a;
  const resultRows: RleRow[] = new Array(height);
  for (let y = 0; y < height; y++) {
    const aRow = a.rows[y];
    if (aRow.length === 0) { resultRows[y] = new Int32Array(0); continue; }
    const relevantBRows: RleRow[] = [];
    const startY = Math.max(0, y - buffer), endY = Math.min(height - 1, y + buffer);
    for (let by = startY; by <= endY; by++) if (b.rows[by].length > 0) relevantBRows.push(b.rows[by]);
    if (relevantBRows.length === 0) { resultRows[y] = new Int32Array(0); continue; }
    const bIntervals: { start: number; end: number }[] = [];
    for (const bRow of relevantBRows) {
      for (let i = 0; i < bRow.length; i += 2) {
        bIntervals.push({ start: Math.max(0, bRow[i] - buffer), end: Math.min(width, bRow[i] + bRow[i + 1] + buffer) });
      }
    }
    bIntervals.sort((p, q) => p.start - q.start);
    const mergedB: { start: number; end: number }[] = [];
    if (bIntervals.length > 0) {
      let curr = bIntervals[0];
      for (let i = 1; i < bIntervals.length; i++) {
        const next = bIntervals[i];
        if (next.start <= curr.end) curr.end = Math.max(curr.end, next.end);
        else { mergedB.push(curr); curr = next; }
      }
      mergedB.push(curr);
    }
    const resSpans: number[] = [];
    let bIdx = 0;
    for (let i = 0; i < aRow.length; i += 2) {
      const aStart = aRow[i], aEnd = aStart + aRow[i + 1];
      while (bIdx < mergedB.length && mergedB[bIdx].end <= aStart) bIdx++;
      let tempBIdx = bIdx;
      while (tempBIdx < mergedB.length && mergedB[tempBIdx].start < aEnd) {
        const bInt = mergedB[tempBIdx];
        const start = Math.max(aStart, bInt.start), end = Math.min(aEnd, bInt.end);
        if (start < end) {
          if (resSpans.length > 0 && resSpans[resSpans.length - 2] + resSpans[resSpans.length - 1] === start) resSpans[resSpans.length - 1] += end - start;
          else resSpans.push(start, end - start);
        }
        tempBIdx++;
      }
    }
    resultRows[y] = new Int32Array(resSpans);
  }
  return { rows: resultRows, width, height };
}

function rleSubtract(a: RleMask, b: RleMask): RleMask {
  const { width, height } = a;
  const resultRows: RleRow[] = new Array(height);
  for (let y = 0; y < height; y++) {
    const aRow = a.rows[y], bRow = b.rows[y];
    if (aRow.length === 0) { resultRows[y] = new Int32Array(0); continue; }
    if (bRow.length === 0) { resultRows[y] = aRow; continue; }
    const resSpans: number[] = [];
    let bIdx = 0;
    for (let i = 0; i < aRow.length; i += 2) {
      let currentStart = aRow[i];
      const currentEnd = currentStart + aRow[i + 1];
      while (bIdx < bRow.length && bRow[bIdx] + bRow[bIdx + 1] <= currentStart) bIdx += 2;
      let tempBIdx = bIdx;
      while (tempBIdx < bRow.length && bRow[tempBIdx] < currentEnd) {
        const bStart = bRow[tempBIdx], bEnd = bStart + bRow[tempBIdx + 1];
        if (bStart > currentStart) resSpans.push(currentStart, bStart - currentStart);
        currentStart = Math.max(currentStart, bEnd);
        tempBIdx += 2;
      }
      if (currentStart < currentEnd) resSpans.push(currentStart, currentEnd - currentStart);
    }
    resultRows[y] = new Int32Array(resSpans);
  }
  return { rows: resultRows, width, height };
}

function rleLabelComponents(mask: RleMask, connectivity: 4 | 8 = 4): { labels: RleLabels; components: ComponentInfo[] } {
  const { rows, width, height } = mask;
  const labelRows: RleLabelRow[] = new Array(height);
  const parent: number[] = [0], area: number[] = [0], sumX: number[] = [0], sumY: number[] = [0];
  let nextId = 1;
  function find(i: number): number { if (parent[i] === i) return i; parent[i] = find(parent[i]); return parent[i]; }
  function union(i: number, j: number) {
    const ri = find(i), rj = find(j);
    if (ri !== rj) { parent[rj] = ri; area[ri] += area[rj]; sumX[ri] += sumX[rj]; sumY[ri] += sumY[rj]; area[rj] = 0; sumX[rj] = 0; sumY[rj] = 0; }
  }
  function newLabel(a: number, sx: number, sy: number): number {
    const id = nextId++; parent[id] = id; area[id] = a; sumX[id] = sx; sumY[id] = sy; return id;
  }
  for (let y = 0; y < height; y++) {
    const row = rows[y], prevRow = y > 0 ? labelRows[y - 1] : null;
    const cur: number[] = [];
    for (let i = 0; i < row.length; i += 2) {
      const start = row[i], len = row[i + 1], end = start + len;
      const myId = newLabel(len, len * (start + (end - 1)) / 2, len * y);
      cur.push(start, len, myId);
      if (prevRow) {
        const expand = connectivity === 8 ? 1 : 0;
        const ss = start - expand, se = end + expand;
        for (let j = 0; j < prevRow.length; j += 3) {
          const ps = prevRow[j], pl = prevRow[j + 1], pid = prevRow[j + 2], pe = ps + pl;
          if (Math.max(ss, ps) < Math.min(se, pe)) union(myId, pid);
          if (ps >= se) break;
        }
      }
    }
    labelRows[y] = new Int32Array(cur);
  }
  const comps: ComponentInfo[] = [];
  const idMap = new Map<number, number>();
  let fid = 1;
  for (let y = 0; y < height; y++) {
    const row = labelRows[y];
    for (let i = 0; i < row.length; i += 3) {
      const root = find(row[i + 2]);
      let f = idMap.get(root);
      if (f === undefined) {
        f = fid++;
        idMap.set(root, f);
        comps.push({ id: f, label: f, area_px: area[root], size: area[root], centroidSumX: sumX[root], centroidSumY: sumY[root] });
      }
      row[i + 2] = f;
    }
  }
  return { labels: { rows: labelRows, width, height }, components: comps };
}

function scanLayer(current: RleMask, prev: RleMask | null, opts: { px_mm: number; support_buffer_mm: number; connectivity: 4 | 8 }) {
  let candidates: RleMask;
  if (!prev) { candidates = current; }
  else {
    const buf = Math.max(0, Math.round(opts.support_buffer_mm / opts.px_mm));
    candidates = rleSubtract(current, rleIntersectDilated(current, prev, buf));
  }
  const { labels, components } = rleLabelComponents(candidates, opts.connectivity);
  return { labels, components, solidMask: current };
}

// IslandTracker — same as island-bench.ts
class IslandTracker {
  private islands: Map<number, Island> = new Map();
  private nextId = 1;
  private px_mm: number;
  private minOverlapPx: number;
  private overlapNeighborhoodPx: number;
  private pendingMerges: Array<{ mergeLayer: number; candidateIds: number[]; mergedIslandId: number; overlapCounts: Map<number, number>; preMergeLabels: RleLabels }> = [];
  private readonly MERGE_EVAL_WINDOW = 30;
  constructor(px_mm: number, opts?: { minOverlapPx?: number; overlapNeighborhoodPx?: number }) {
    this.px_mm = px_mm;
    this.minOverlapPx = Math.max(1, opts?.minOverlapPx ?? 1);
    this.overlapNeighborhoodPx = Math.max(0, opts?.overlapNeighborhoodPx ?? 1);
  }
  processLayer(li: number, cl: RleLabels, cc: ComponentInfo[], pil: RleLabels | null, sm: RleMask): RleLabels {
    const { width, height } = cl;
    const ilr: Int32Array[] = new Array(height);
    if (!pil) {
      const m = new Map<number, number>();
      for (const c of cc) { const a = c.area_px * this.px_mm * this.px_mm; m.set(c.id, this.createIsland(li, a, c)); }
      for (let y = 0; y < height; y++) { const r = cl.rows[y], nr: number[] = []; for (let i = 0; i < r.length; i += 3) { const id = m.get(r[i + 2]) || 0; if (id > 0) nr.push(r[i], r[i + 1], id); } ilr[y] = new Int32Array(nr); }
    } else {
      const { labels: sl, components: sc } = rleLabelComponents(sm, 4);
      const m = new Map<number, number>();
      for (const comp of sc) {
        const ov = this.findOverlaps(comp.id, sl, pil);
        const prev = new Set<number>(); for (const [id, cnt] of ov) if (cnt >= this.minOverlapPx) prev.add(id);
        const active = new Set<number>(); for (const id of prev) { const isl = this.islands.get(id); if (isl && isl.status === 'active') active.add(id); }
        const rp = (sid: number): number => { let c = sid; const v = new Set<number>(); while (true) { if (v.has(c)) break; v.add(c); const i = this.islands.get(c); if (!i || i.parentId === undefined) break; c = i.parentId; } return c; };
        const a = comp.area_px * this.px_mm * this.px_mm;
        let aid: number;
        if (active.size === 0) {
          if (prev.size > 0) { aid = rp(prev.values().next().value as number); this.updateIsland(aid, li, a, comp); }
          else aid = this.createIsland(li, a, comp);
        } else if (active.size === 1) { aid = active.values().next().value as number; this.updateIsland(aid, li, a, comp); }
        else { const rs = new Set<number>(); for (const id of active) rs.add(rp(id)); aid = this.mergeIslands(li, rs, pil, a, comp); }
        m.set(comp.id, aid);
        this.trackMergeOverlaps(li, comp.id, sl, pil);
      }
      for (let y = 0; y < height; y++) { const r = sl.rows[y], nr: number[] = []; for (let i = 0; i < r.length; i += 3) { const id = m.get(r[i + 2]) || 0; if (id > 0) nr.push(r[i], r[i + 1], id); } ilr[y] = new Int32Array(nr); }
    }
    this.evalMerges(li);
    return { rows: ilr, width, height };
  }
  private findOverlaps(cid: number, sl: RleLabels, pil: RleLabels): Map<number, number> {
    const counts = new Map<number, number>();
    const { height } = sl;
    for (let y = 0; y < height; y++) {
      const sr = sl.rows[y]; if (sr.length === 0) continue;
      for (let i = 0; i < sr.length; i += 3) {
        if (sr[i + 2] !== cid) continue;
        const s = sr[i], e = s + sr[i + 1], ss = s - this.overlapNeighborhoodPx, se = e + this.overlapNeighborhoodPx;
        const ys = Math.max(0, y - this.overlapNeighborhoodPx), ye = Math.min(height - 1, y + this.overlapNeighborhoodPx);
        for (let py = ys; py <= ye; py++) {
          const pr = pil.rows[py]; if (pr.length === 0) continue;
          for (let j = 0; j < pr.length; j += 3) {
            const ps = pr[j], pe = ps + pr[j + 1], pid = pr[j + 2];
            const os = Math.max(ss, ps), oe = Math.min(se, pe);
            if (os < oe && pid > 0) counts.set(pid, (counts.get(pid) ?? 0) + (oe - os));
            if (ps >= se) break;
          }
        }
      }
    }
    return counts;
  }
  private trackMergeOverlaps(_li: number, cid: number, sl: RleLabels, _pil: RleLabels): void {
    if (this.pendingMerges.length === 0) return;
    for (const p of this.pendingMerges) {
      const ov = this.findOverlaps(cid, sl, p.preMergeLabels);
      for (const [id, cnt] of ov) if (p.overlapCounts.has(id)) p.overlapCounts.set(id, (p.overlapCounts.get(id) ?? 0) + cnt);
    }
  }
  private createIsland(li: number, a: number, c?: ComponentInfo): number {
    const id = this.nextId++;
    this.islands.set(id, { id, firstLayer: li, lastLayer: li, status: 'active', totalAreaMm2: a,
      perLayerAreaMm2: new Map([[li, a]]), childIds: [], maxAreaMm2: a, maxAreaLayer: li,
      centroidSumX: c?.centroidSumX ?? 0, centroidSumY: c?.centroidSumY ?? 0,
      centroidSumZ: c ? c.size * li : 0, centroidCount: c ? c.size : 0,
      lastLayerCentroid: c && c.size > 0 ? { x: c.centroidSumX / c.size, y: c.centroidSumY / c.size, z: li } : undefined,
    });
    return id;
  }
  private updateIsland(id: number, li: number, a: number, c?: ComponentInfo): void {
    const isl = this.islands.get(id); if (!isl) return;
    isl.lastLayer = li; isl.totalAreaMm2 += a; isl.perLayerAreaMm2.set(li, a);
    if (!isl.maxAreaMm2 || a > isl.maxAreaMm2) { isl.maxAreaMm2 = a; isl.maxAreaLayer = li; }
    if (c) { isl.centroidSumX += c.centroidSumX; isl.centroidSumY += c.centroidSumY; isl.centroidSumZ += c.size * li; isl.centroidCount += c.size;
      if (c.size > 0) isl.lastLayerCentroid = { x: c.centroidSumX / c.size, y: c.centroidSumY / c.size, z: li }; }
  }
  private mergeIslands(li: number, ids: Set<number>, pil: RleLabels, a: number, c?: ComponentInfo): number {
    const pre: RleLabels = { width: pil.width, height: pil.height, rows: pil.rows.map(r => new Int32Array(r)) };
    for (const id of ids) { const isl = this.islands.get(id); if (isl) { isl.status = 'complete'; isl.lastLayer = li - 1; } }
    const mid = this.createIsland(li, a, c);
    const mi = this.islands.get(mid)!; mi.isMergedPlaceholder = true;
    const oc = new Map<number, number>(); for (const id of ids) oc.set(id, 0);
    this.pendingMerges.push({ mergeLayer: li, candidateIds: Array.from(ids), mergedIslandId: mid, overlapCounts: oc, preMergeLabels: pre });
    return mid;
  }
  private evalMerges(cl: number): void {
    const tf: number[] = [];
    for (let i = 0; i < this.pendingMerges.length; i++) {
      const p = this.pendingMerges[i];
      if (cl - p.mergeLayer >= this.MERGE_EVAL_WINDOW) {
        let pid = 0, mx = -1;
        for (const [id, cnt] of p.overlapCounts) if (cnt > mx) { mx = cnt; pid = id; }
        for (const cid of p.candidateIds) if (cid !== pid) { const ch = this.islands.get(cid); if (ch) ch.parentId = pid; }
        const mi = this.islands.get(p.mergedIslandId); if (mi) mi.parentId = pid;
        const par = this.islands.get(pid);
        if (par && mi) {
          for (const cid of p.candidateIds) if (cid !== pid && !par.childIds.includes(cid)) par.childIds.push(cid);
          if (!par.childIds.includes(p.mergedIslandId)) par.childIds.push(p.mergedIslandId);
          par.lastLayer = mi.lastLayer; par.status = mi.status;
          for (const [l, a] of mi.perLayerAreaMm2) { par.perLayerAreaMm2.set(l, a); par.totalAreaMm2 += a; if (!par.maxAreaMm2 || a > par.maxAreaMm2) { par.maxAreaMm2 = a; par.maxAreaLayer = l; } }
          if (mi.centroidCount > 0) { par.centroidSumX += mi.centroidSumX; par.centroidSumY += mi.centroidSumY; par.centroidSumZ += mi.centroidSumZ; par.centroidCount += mi.centroidCount; }
          if (mi.lastLayerCentroid) par.lastLayerCentroid = { ...mi.lastLayerCentroid };
        }
        tf.push(i);
      }
    }
    for (let i = tf.length - 1; i >= 0; i--) this.pendingMerges.splice(tf[i], 1);
  }
  getIslands(): Island[] {
    const islands = Array.from(this.islands.values());
    for (const isl of islands) if (isl.centroidCount > 0) isl.centroid = { x: isl.centroidSumX / isl.centroidCount, y: isl.centroidSumY / isl.centroidCount, z: isl.centroidSumZ / isl.centroidCount };
    return islands;
  }
}

// ---------------------------------------------------------------------------
// Load Rust-generated masks from disk
// ---------------------------------------------------------------------------
function loadMaskJson(path: string): RleMask {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return {
    width: raw.width,
    height: raw.height,
    rows: raw.rows.map((r: number[]) => {
      // Convert from [start, length, start, length, ...] pairs
      const out: number[] = [];
      for (let i = 0; i < r.length; i += 2) {
        out.push(r[i], r[i + 1]);
      }
      return new Int32Array(out);
    }),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const rustDir = process.argv[2];
if (!rustDir) {
  console.error('Usage: npx tsx scripts/island-compare-rs-ts.ts <rust-island-output-dir>');
  console.error('  Run: dragonfruit-cli island full model.stl -o <dir>');
  process.exit(1);
}

const params = JSON.parse(readFileSync(join(rustDir, 'params.json'), 'utf-8'));
const numLayers = params.num_layers as number;
const px_mm = params.px_mm as number;
const layerHeight = params.layer_height_mm as number;
const bufferMm = params.support_buffer_mm as number;

console.log(`Loading ${numLayers} Rust-rasterized masks from ${rustDir}`);
console.log(`  grid: ${params.grid_width}x${params.grid_height}, px_mm=${px_mm}, layer_h=${layerHeight}, buffer=${bufferMm}`);

// Load all masks
const masks: RleMask[] = [];
for (let l = 0; l < numLayers; l++) {
  masks.push(loadMaskJson(join(rustDir, 'layers', `${String(l).padStart(3, '0')}.mask.rle.json`)));
}

// Run TS pipeline on Rust masks
console.log('\nRunning TS scan+track pipeline on Rust-rasterized masks...');
const tsT0 = performance.now();
const opts = { px_mm, support_buffer_mm: bufferMm, connectivity: 4 as 4 | 8, min_island_area_mm2: 0.0, layer_height_mm: layerHeight };

// Phase 1: per-layer scan
const tsLayers: ReturnType<typeof scanLayer>[] = [];
for (let i = 0; i < numLayers; i++) {
  tsLayers.push(scanLayer(masks[i], i > 0 ? masks[i - 1] : null, opts));
}

// Phase 2: island tracking
const tracker = new IslandTracker(px_mm, { minOverlapPx: params.min_overlap_px ?? 4, overlapNeighborhoodPx: params.overlap_neighborhood_px ?? 1 });
const tsIslandLabels: RleLabels[] = [];
for (let l = 0; l < numLayers; l++) {
  const il = tracker.processLayer(l, tsLayers[l].labels, tsLayers[l].components, l > 0 ? tsIslandLabels[l - 1] : null, tsLayers[l].solidMask);
  tsIslandLabels.push(il);
}
const tsIslands = tracker.getIslands();
for (const isl of tsIslands) { let v = 0; for (const a of isl.perLayerAreaMm2.values()) v += a * layerHeight; isl.volumeMm3 = v; }
const tsMs = performance.now() - tsT0;

// Load Rust results
const rustIslands: any[] = JSON.parse(readFileSync(join(rustDir, 'islands.json'), 'utf-8'));
const rustResult: any = JSON.parse(readFileSync(join(rustDir, 'result.json'), 'utf-8'));

// Also compare per-layer scan output
console.log('\n=== PER-LAYER SCAN COMPARISON ===');
let scanDiffLayers = 0;
let totalTsCandPx = 0;
let totalRsCandPx = 0;
for (let l = 0; l < numLayers; l++) {
  const tsCandPx = tsLayers[l].components.reduce((s, c) => s + c.area_px, 0);
  totalTsCandPx += tsCandPx;

  // Load Rust components for this layer
  try {
    const rsComps: any[] = JSON.parse(readFileSync(join(rustDir, 'layers', `${String(l).padStart(3, '0')}.components.json`), 'utf-8'));
    const rsCandPx = rsComps.reduce((s: number, c: any) => s + c.area_px, 0);
    totalRsCandPx += rsCandPx;
    if (tsCandPx !== rsCandPx) {
      scanDiffLayers++;
      if (scanDiffLayers <= 5) {
        console.log(`  layer ${l}: TS=${tsCandPx}px RS=${rsCandPx}px (delta=${tsCandPx - rsCandPx})`);
      }
    }
  } catch { /* layer file missing */ }
}
console.log(`Scan: ${scanDiffLayers}/${numLayers} layers differ`);
console.log(`  TS total candidate px: ${totalTsCandPx}`);
console.log(`  RS total candidate px: ${totalRsCandPx}`);
console.log(`  delta: ${totalTsCandPx - totalRsCandPx} (${((totalTsCandPx - totalRsCandPx) / Math.max(1, totalRsCandPx) * 100).toFixed(2)}%)`);

// Compare island results
console.log('\n=== ISLAND TRACKING COMPARISON ===');
const tsReal = tsIslands.filter(i => !i.isMergedPlaceholder);
const rsReal = rustIslands.filter((i: any) => !i.is_merged_placeholder);

console.log(`  TS: ${tsIslands.length} total, ${tsReal.length} real`);
console.log(`  RS: ${rustIslands.length} total, ${rsReal.length} real`);
console.log(`  TS time: ${tsMs.toFixed(0)}ms`);

// Sort both by total_area descending and compare top islands
const tsSorted = tsReal.sort((a, b) => (b.totalAreaMm2) - (a.totalAreaMm2));
const rsSorted = rsReal.sort((a: any, b: any) => (b.total_area_mm2) - (a.total_area_mm2));

console.log(`\nTop 15 islands by area:`);
console.log(`${'#'.padStart(3)} | ${'TS area'.padStart(10)} ${'TS layers'.padStart(12)} | ${'RS area'.padStart(10)} ${'RS layers'.padStart(12)} | ${'match?'.padStart(6)}`);
console.log('-'.repeat(75));

let matchCount = 0;
for (let i = 0; i < Math.min(15, Math.max(tsSorted.length, rsSorted.length)); i++) {
  const ts = tsSorted[i];
  const rs = rsSorted[i];
  const tsArea = ts ? ts.totalAreaMm2.toFixed(1) : '---';
  const tsLayers = ts ? `${ts.firstLayer}-${ts.lastLayer}` : '---';
  const rsArea = rs ? rs.total_area_mm2.toFixed(1) : '---';
  const rsLayers = rs ? `${rs.first_layer}-${rs.last_layer}` : '---';

  const areaMatch = ts && rs && Math.abs(ts.totalAreaMm2 - rs.total_area_mm2) < 0.01;
  const layerMatch = ts && rs && ts.firstLayer === rs.first_layer && ts.lastLayer === rs.last_layer;
  const match = areaMatch && layerMatch ? '  YES' : '   NO';
  if (areaMatch && layerMatch) matchCount++;

  console.log(`${String(i + 1).padStart(3)} | ${tsArea.padStart(10)} ${tsLayers.padStart(12)} | ${rsArea.padStart(10)} ${rsLayers.padStart(12)} | ${match}`);
}

console.log(`\nMatched: ${matchCount}/${Math.min(15, Math.max(tsSorted.length, rsSorted.length))} top islands`);

// Total area comparison
const tsTotalArea = tsReal.reduce((s, i) => s + i.totalAreaMm2, 0);
const rsTotalArea = rsReal.reduce((s: number, i: any) => s + i.total_area_mm2, 0);
console.log(`\nTotal area: TS=${tsTotalArea.toFixed(1)}mm² RS=${rsTotalArea.toFixed(1)}mm² delta=${(tsTotalArea - rsTotalArea).toFixed(1)}mm²`);
