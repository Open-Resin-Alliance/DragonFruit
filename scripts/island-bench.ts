#!/usr/bin/env npx tsx
/**
 * Island detection speed benchmark (TypeScript).
 * Mirrors the Rust island_bench cases for direct comparison.
 *
 * Usage: npx tsx scripts/island-bench.ts
 */

// ---------------------------------------------------------------------------
// RLE types & functions (copied from island-debug-export.ts to avoid bundler)
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

function rleEncode(data: Uint8Array, width: number, height: number): RleMask {
  const rows: RleRow[] = new Array(height);
  for (let y = 0; y < height; y++) {
    const rowSpans: number[] = [];
    let runStart = -1;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (data[rowOffset + x]) {
        if (runStart === -1) runStart = x;
      } else {
        if (runStart !== -1) { rowSpans.push(runStart, x - runStart); runStart = -1; }
      }
    }
    if (runStart !== -1) rowSpans.push(runStart, width - runStart);
    rows[y] = new Int32Array(rowSpans);
  }
  return { rows, width, height };
}

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

// ---------------------------------------------------------------------------
// IslandTracker (same as island-debug-export.ts)
// ---------------------------------------------------------------------------
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
      for (let y = 0; y < height; y++) {
        const r = cl.rows[y], nr: number[] = [];
        for (let i = 0; i < r.length; i += 3) { const id = m.get(r[i + 2]) || 0; if (id > 0) nr.push(r[i], r[i + 1], id); }
        ilr[y] = new Int32Array(nr);
      }
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
      for (let y = 0; y < height; y++) {
        const r = sl.rows[y], nr: number[] = [];
        for (let i = 0; i < r.length; i += 3) { const id = m.get(r[i + 2]) || 0; if (id > 0) nr.push(r[i], r[i + 1], id); }
        ilr[y] = new Int32Array(nr);
      }
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
    this.islands.set(id, {
      id, firstLayer: li, lastLayer: li, status: 'active', totalAreaMm2: a,
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
    if (c) {
      isl.centroidSumX += c.centroidSumX; isl.centroidSumY += c.centroidSumY;
      isl.centroidSumZ += c.size * li; isl.centroidCount += c.size;
      if (c.size > 0) isl.lastLayerCentroid = { x: c.centroidSumX / c.size, y: c.centroidSumY / c.size, z: li };
    }
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
// Full pipeline (matches Rust run_island_scan)
// ---------------------------------------------------------------------------
function runIslandScan(masks: RleMask[], opts: { px_mm: number; support_buffer_mm: number; connectivity: 4 | 8; min_island_area_mm2: number; layer_height_mm: number }) {
  const n = masks.length;
  // Phase 1: per-layer scan
  const lrs: ReturnType<typeof scanLayer>[] = [];
  for (let i = 0; i < n; i++) lrs.push(scanLayer(masks[i], i > 0 ? masks[i - 1] : null, opts));

  // Phase 2: island tracking
  const tracker = new IslandTracker(opts.px_mm, { minOverlapPx: 1, overlapNeighborhoodPx: 1 });
  const ilpl: RleLabels[] = [];
  for (let l = 0; l < n; l++) {
    const il = tracker.processLayer(l, lrs[l].labels, lrs[l].components, l > 0 ? ilpl[l - 1] : null, lrs[l].solidMask);
    ilpl.push(il);
  }
  const islands = tracker.getIslands();
  for (const isl of islands) { let v = 0; for (const a of isl.perLayerAreaMm2.values()) v += a * opts.layer_height_mm; isl.volumeMm3 = v; }
  const filtered = islands.filter(i => !i.isMergedPlaceholder && (i.maxAreaMm2 ?? 0) >= opts.min_island_area_mm2);
  return { islands: filtered, islandLabelsPerLayer: ilpl };
}

// ---------------------------------------------------------------------------
// Mask generators (same as Rust)
// ---------------------------------------------------------------------------
function genSolidBlock(w: number, h: number, layers: number, x0: number, y0: number, x1: number, y1: number): RleMask[] {
  return Array.from({ length: layers }, () => {
    const d = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[y * w + x] = 1;
    return rleEncode(d, w, h);
  });
}

function genTwoBlocksMerging(w: number, h: number, layers: number): RleMask[] {
  const mid = Math.floor(w / 2), gap = 4;
  return Array.from({ length: layers }, (_, l) => {
    const d = new Uint8Array(w * h);
    const h4 = Math.floor(h / 4), h34 = Math.floor(3 * h / 4);
    for (let y = h4; y < h34; y++) { for (let x = 2; x < mid - gap; x++) d[y * w + x] = 1; for (let x = mid + gap; x < w - 2; x++) d[y * w + x] = 1; }
    if (l > layers * 0.6) for (let y = Math.floor(h / 2) - 1; y < Math.floor(h / 2) + 1; y++) for (let x = 2; x < w - 2; x++) d[y * w + x] = 1;
    return rleEncode(d, w, h);
  });
}

function genManyIslands(w: number, h: number, layers: number, count: number): RleMask[] {
  const n = Math.ceil(Math.sqrt(count)), dx = Math.floor(w / n), dy = Math.floor(h / n), pad = 2;
  return Array.from({ length: layers }, () => {
    const d = new Uint8Array(w * h);
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
      const x0 = ix * dx + pad, y0 = iy * dy + pad, x1 = (ix + 1) * dx - pad, y1 = (iy + 1) * dy - pad;
      for (let y = y0; y < Math.min(y1, h); y++) for (let x = x0; x < Math.min(x1, w); x++) d[y * w + x] = 1;
    }
    return rleEncode(d, w, h);
  });
}

function pixelCount(masks: RleMask[]): number {
  let total = 0;
  for (const m of masks) for (const r of m.rows) for (let i = 0; i < r.length; i += 2) total += r[i + 1];
  return total;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------
type BenchCase = { name: string; masks: RleMask[]; numLayers: number; width: number; height: number };

const cases: BenchCase[] = [
  { name: 'small_single_block (100x100, 50L)', width: 100, height: 100, numLayers: 50, masks: genSolidBlock(100, 100, 50, 10, 10, 90, 90) },
  { name: 'medium_single_block (500x500, 200L)', width: 500, height: 500, numLayers: 200, masks: genSolidBlock(500, 500, 200, 50, 50, 450, 450) },
  { name: 'large_single_block (1920x1080, 500L)', width: 1920, height: 1080, numLayers: 500, masks: genSolidBlock(1920, 1080, 500, 100, 100, 1820, 980) },
  { name: 'medium_merge (500x500, 200L)', width: 500, height: 500, numLayers: 200, masks: genTwoBlocksMerging(500, 500, 200) },
  { name: 'many_islands_25 (500x500, 100L)', width: 500, height: 500, numLayers: 100, masks: genManyIslands(500, 500, 100, 25) },
  { name: 'stress_100_islands (1920x1080, 100L)', width: 1920, height: 1080, numLayers: 100, masks: genManyIslands(1920, 1080, 100, 100) },
];

const opts = { px_mm: 0.05, support_buffer_mm: 0.1, connectivity: 4 as 4 | 8, min_island_area_mm2: 0.0001, layer_height_mm: 0.05 };

console.log('Island Detection Speed Benchmark (TypeScript)');
console.log('==============================================\n');

for (const c of cases) {
  // Warmup
  runIslandScan(c.masks, opts);

  // Timed (3 iters, best)
  let best = Infinity;
  let result: ReturnType<typeof runIslandScan> | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = runIslandScan(c.masks, opts);
    const elapsed = performance.now() - t0;
    if (elapsed < best) { best = elapsed; result = r; }
  }

  const totalPx = pixelCount(c.masks);
  const layersPerSec = c.numLayers / (best / 1000);
  const mpxPerSec = totalPx / (best / 1000) / 1_000_000;

  console.log(c.name);
  console.log(`  ${best.toFixed(3).padStart(8)} ms  |  ${layersPerSec.toFixed(0)} layers/s  |  ${mpxPerSec.toFixed(1)} Mpx/s  |  ${result!.islands.length} islands\n`);
}
