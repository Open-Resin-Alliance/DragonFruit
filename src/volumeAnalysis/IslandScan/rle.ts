import { ComponentInfo, type Connectivity } from './types';

// RLE Row: [start, length, start, length, ...]
// Represents a single row of binary data.
export type RleRow = Int32Array;

/**
 * The one empty row, shared by every row that has no spans.
 *
 * A layer is 1814 rows tall and a scan is 5292 layers deep, so the naive
 * `new Int32Array(0)` per empty row produced 9.6 million typed arrays holding
 * half a megabyte of data between them — over a gigabyte of pure object and
 * buffer overhead, and most of the live object count.
 *
 * Sharing is safe because RLE rows are never written in place: every producer
 * builds a fresh row and assigns it. Structured clone preserves identity within
 * a message, so the sharing survives the trip from the worker.
 */
export const EMPTY_ROW: RleRow = new Int32Array(0);

// RLE Mask: Array of rows
export type RleMask = {
    rows: RleRow[];
    width: number;
    height: number;
};

// Labeled RLE Row: [start, length, id, start, length, id, ...]
export type RleLabelRow = Int32Array;

/**
 * The candidate (unsupported) voxels of one layer, as flat `[col, row]` pairs.
 *
 * The per-layer label RLE exists only to identify these — the caller throws it
 * away once it has them — so extracting here keeps the work on the worker and
 * leaves a payload proportional to the voxels instead of to the layer's area.
 * Shipping the RLE instead meant structured-cloning thousands of small
 * `Int32Array`s per layer on the receiving thread, ~2525 times a scan, which is
 * what starved the main thread for most of a 23 s scan.
 *
 * Two passes over the runs (count, then fill) so the result is one exact-sized
 * buffer rather than a growable array.
 */
export function candidateVoxelPairs(labels: RleLabels): Int32Array {
    let count = 0;
    for (const row of labels.rows) {
        if (!row) continue;
        for (let i = 0; i < row.length; i += 3) {
            if (row[i + 2] > 0) count += row[i + 1];
        }
    }
    const out = new Int32Array(count * 2);
    let at = 0;
    for (let y = 0; y < labels.rows.length; y++) {
        const row = labels.rows[y];
        if (!row) continue;
        for (let i = 0; i < row.length; i += 3) {
            if (row[i + 2] <= 0) continue;
            const start = row[i];
            const end = start + row[i + 1];
            for (let col = start; col < end; col++) {
                out[at++] = col;
                out[at++] = y;
            }
        }
    }
    return out;
}

export type RleLabels = {
    rows: RleLabelRow[];
    width: number;
    height: number;
};

/**
 * Encodes a binary grid into RLE format.
 */
export function rleEncode(data: Uint8Array, width: number, height: number): RleMask {
    const rows: RleRow[] = new Array(height);

    for (let y = 0; y < height; y++) {
        const rowSpans: number[] = [];
        let runStart = -1;
        const rowOffset = y * width;

        for (let x = 0; x < width; x++) {
            if (data[rowOffset + x]) {
                if (runStart === -1) runStart = x;
            } else {
                if (runStart !== -1) {
                    rowSpans.push(runStart, x - runStart);
                    runStart = -1;
                }
            }
        }
        if (runStart !== -1) {
            rowSpans.push(runStart, width - runStart);
        }
        rows[y] = rowSpans.length === 0 ? EMPTY_ROW : new Int32Array(rowSpans);
    }

    return { rows, width, height };
}

/**
 * Encodes a dense ID grid into RLE Label format.
 * Preserves the ID in each run: [start, length, id]
 */
export function rleEncodeLabels(data: Int32Array | Uint8Array, width: number, height: number): RleLabels {
    const rows: RleLabelRow[] = new Array(height);

    for (let y = 0; y < height; y++) {
        const rowSpans: number[] = [];
        let runStart = -1;
        let currentId = 0;
        const rowOffset = y * width;

        for (let x = 0; x < width; x++) {
            const id = data[rowOffset + x];

            if (id !== currentId) {
                // Change detected
                if (currentId !== 0 && runStart !== -1) {
                    // Close previous run
                    rowSpans.push(runStart, x - runStart, currentId);
                }

                // Start new run (if non-zero)
                if (id !== 0) {
                    runStart = x;
                } else {
                    runStart = -1;
                }
                currentId = id;
            }
        }

        // Close final run
        if (currentId !== 0 && runStart !== -1) {
            rowSpans.push(runStart, width - runStart, currentId);
        }

        rows[y] = rowSpans.length === 0 ? EMPTY_ROW : new Int32Array(rowSpans);
    }

    return { rows, width, height };
}

/**
 * Decodes RLE format back to binary grid.
 */
export function rleDecode(mask: RleMask): Uint8Array {
    const { rows, width, height } = mask;
    const data = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        const row = rows[y];
        const rowOffset = y * width;
        for (let i = 0; i < row.length; i += 2) {
            const start = row[i];
            const len = row[i + 1];
            for (let j = 0; j < len; j++) {
                data[rowOffset + start + j] = 1;
            }
        }
    }

    return data;
}

/**
 * Computes Intersection of A and Dilated(B).
 * Result = A AND Dilate(B, buffer)
 * Used to find "Supported" regions.
 */
export function rleIntersectDilated(a: RleMask, b: RleMask, buffer: number): RleMask {
    if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
        const outWidth = Math.max(0, a.width);
        const outHeight = Math.max(0, a.height);
        return { rows: new Array<RleRow>(outHeight).fill(EMPTY_ROW), width: outWidth, height: outHeight };
    }

    const { width, height } = a;
    const r = Number.isNaN(buffer) ? 0 : Math.max(0, Math.trunc(buffer));
    const rSq = r * r;
    const resultRows: RleRow[] = new Array(height);

    for (let y = 0; y < height; y++) {
        const aRow = a.rows[y];
        if (!aRow || aRow.length === 0) {
            resultRows[y] = EMPTY_ROW;
            continue;
        }

        // Gather intervals from B rows within Euclidean L2 radius r around y,
        // expanding each span horizontally by dx = floor(sqrt(r^2 - dy^2)).
        const startY = Math.max(0, y - r);
        const endY = Math.min(b.height - 1, y + r);
        const bIntervals: { start: number; end: number }[] = [];

        for (let by = startY; by <= endY; by++) {
            const bRow = b.rows[by];
            if (!bRow || bRow.length === 0) continue;

            const dy = by - y;
            const dx = Math.floor(Math.sqrt(rSq - dy * dy));

            for (let i = 0; i < bRow.length; i += 2) {
                const s = Math.max(0, bRow[i] - dx);
                const e = Math.min(width, bRow[i] + bRow[i + 1] + dx);
                if (s < e) {
                    bIntervals.push({ start: s, end: e });
                }
            }
        }

        if (bIntervals.length === 0) {
            resultRows[y] = EMPTY_ROW;
            continue;
        }

        // Sort and merge B intervals
        bIntervals.sort((p, q) => p.start - q.start);

        const mergedB: { start: number; end: number }[] = [];
        let curr = bIntervals[0];
        for (let i = 1; i < bIntervals.length; i++) {
            const next = bIntervals[i];
            if (next.start <= curr.end) {
                curr.end = Math.max(curr.end, next.end);
            } else {
                mergedB.push(curr);
                curr = next;
            }
        }
        mergedB.push(curr);

        // Now intersect aRow with mergedB
        const resSpans: number[] = [];
        let bIdx = 0;

        for (let i = 0; i < aRow.length; i += 2) {
            const aStart = aRow[i];
            const aEnd = aStart + aRow[i + 1];

            // Advance bIdx
            while (bIdx < mergedB.length && mergedB[bIdx].end <= aStart) {
                bIdx++;
            }

            let tempBIdx = bIdx;
            while (tempBIdx < mergedB.length && mergedB[tempBIdx].start < aEnd) {
                const bInt = mergedB[tempBIdx];
                const start = Math.max(aStart, bInt.start);
                const end = Math.min(aEnd, bInt.end);

                if (start < end) {
                    // Append run, merging if adjacent
                    if (resSpans.length > 0 && resSpans[resSpans.length - 2] + resSpans[resSpans.length - 1] === start) {
                        resSpans[resSpans.length - 1] += (end - start);
                    } else {
                        resSpans.push(start, end - start);
                    }
                }
                tempBIdx++;
            }
        }

        resultRows[y] = resSpans.length === 0 ? EMPTY_ROW : new Int32Array(resSpans);
    }

    return { rows: resultRows, width, height };
}

/**
 * Computes A MINUS B.
 * Result = A AND NOT B
 */
export function rleSubtract(a: RleMask, b: RleMask): RleMask {
    const { width, height } = a;
    const resultRows: RleRow[] = new Array(height);

    for (let y = 0; y < height; y++) {
        const aRow = a.rows[y];
        const bRow = b.rows[y];

        if (aRow.length === 0) {
            resultRows[y] = EMPTY_ROW;
            continue;
        }
        if (bRow.length === 0) {
            resultRows[y] = aRow; // Copy? Or ref is fine if immutable
            continue;
        }

        const resSpans: number[] = [];
        let bIdx = 0;

        for (let i = 0; i < aRow.length; i += 2) {
            let currentStart = aRow[i];
            const currentEnd = currentStart + aRow[i + 1];

            // Skip B runs that end before current A run
            while (bIdx < bRow.length && bRow[bIdx] + bRow[bIdx + 1] <= currentStart) {
                bIdx += 2;
            }

            // Check overlaps
            let tempBIdx = bIdx;
            while (tempBIdx < bRow.length && bRow[tempBIdx] < currentEnd) {
                const bStart = bRow[tempBIdx];
                const bEnd = bStart + bRow[tempBIdx + 1];

                if (bStart > currentStart) {
                    // Add gap before B
                    resSpans.push(currentStart, bStart - currentStart);
                }

                currentStart = Math.max(currentStart, bEnd);
                tempBIdx += 2;
            }

            if (currentStart < currentEnd) {
                resSpans.push(currentStart, currentEnd - currentStart);
            }
        }

        resultRows[y] = new Int32Array(resSpans);
    }

    return { rows: resultRows, width, height };
}

/**
 * Connected Components Labeling on RLE Mask.
 * Returns labeled RLE and component info.
 */
export function rleLabelComponents(mask: RleMask, connectivity: 4 | 8 = 8): { labels: RleLabels, components: ComponentInfo[] } {
    const { rows, width, height } = mask;
    const labelRows: RleLabelRow[] = new Array(height);

    // Union-Find structure
    const parent: number[] = [0]; // 1-based IDs
    const area: number[] = [0];
    const sumX: number[] = [0];
    const sumY: number[] = [0];
    let nextId = 1;

    function find(i: number): number {
        if (parent[i] === i) return i;
        parent[i] = find(parent[i]);
        return parent[i];
    }

    function union(i: number, j: number) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            parent[rootJ] = rootI;
            area[rootI] += area[rootJ];
            sumX[rootI] += sumX[rootJ];
            sumY[rootI] += sumY[rootJ];
            area[rootJ] = 0; // Optional, just to be clean
            sumX[rootJ] = 0;
            sumY[rootJ] = 0;
        }
    }

    function newLabel(initialArea: number, initialSumX: number, initialSumY: number): number {
        const id = nextId++;
        parent[id] = id;
        area[id] = initialArea;
        sumX[id] = initialSumX;
        sumY[id] = initialSumY;
        return id;
    }

    // First pass: assign temporary labels and merge connected runs
    // We store temp labels directly in labelRows

    for (let y = 0; y < height; y++) {
        const row = rows[y];
        const prevRow = y > 0 ? labelRows[y - 1] : null;
        const currentRowLabels: number[] = [];

        for (let i = 0; i < row.length; i += 2) {
            const start = row[i];
            const len = row[i + 1];
            const end = start + len;

            // Calculate sums for this run
            // Sum of x in [start, end-1] = len * (start + (end - 1)) / 2
            const runSumX = len * (start + (end - 1)) / 2;
            const runSumY = len * y;

            // Create new label for this run
            const myId = newLabel(len, runSumX, runSumY);
            currentRowLabels.push(start, len, myId);

            // Check connectivity with previous row
            if (prevRow) {
                // Find overlapping runs in prevRow
                // Connectivity 4: overlap > 0
                // Connectivity 8: overlap or touch (including diagonals)
                // Actually, for RLE, 8-way means checking [start-1, end+1] vs [pStart, pEnd]
                // 4-way means checking [start, end] vs [pStart, pEnd]

                const expand = connectivity === 8 ? 1 : 0;
                const searchStart = start - expand;
                const searchEnd = end + expand;

                for (let j = 0; j < prevRow.length; j += 3) {
                    const pStart = prevRow[j];
                    const pLen = prevRow[j + 1];
                    const pId = prevRow[j + 2];
                    const pEnd = pStart + pLen;

                    // Check overlap
                    if (Math.max(searchStart, pStart) < Math.min(searchEnd, pEnd)) {
                        union(myId, pId);
                    }

                    // Optimization: break if passed
                    if (pStart >= searchEnd) break;
                }
            }
        }

        labelRows[y] = new Int32Array(currentRowLabels);
    }

    // Second pass: resolve labels and build component list
    const finalComponents: ComponentInfo[] = [];
    const idMap = new Map<number, number>(); // Root ID -> Final Component ID

    // Re-map IDs to be sequential 1..N
    let finalNextId = 1;

    for (let y = 0; y < height; y++) {
        const row = labelRows[y];
        for (let i = 0; i < row.length; i += 3) {
            const oldId = row[i + 2];
            const rootId = find(oldId);

            let finalId = idMap.get(rootId);
            if (finalId === undefined) {
                finalId = finalNextId++;
                idMap.set(rootId, finalId);
                finalComponents.push({
                    id: finalId,
                    label: finalId,
                    area_px: area[rootId],
                    size: area[rootId],
                    centroidSumX: sumX[rootId],
                    centroidSumY: sumY[rootId]
                });
            }

            row[i + 2] = finalId;
        }
    }

    return { labels: { rows: labelRows, width, height }, components: finalComponents };
}

/**
 * Decodes RLE Labels back to dense integer grid.
 */
export function rleDecodeLabels(labels: RleLabels): Int32Array {
    const { rows, width, height } = labels;
    const data = new Int32Array(width * height);

    for (let y = 0; y < height; y++) {
        const row = rows[y];
        const rowOffset = y * width;
        for (let i = 0; i < row.length; i += 3) {
            const start = row[i];
            const len = row[i + 1];
            const id = row[i + 2];
            for (let j = 0; j < len; j++) {
                data[rowOffset + start + j] = id;
            }
        }
    }

    return data;
}

/**
 * Classify each candidate component on layer `L > 0` as `Detached` vs
 * `CantileverFringe` via 1D run-level union-find over `current` (`S_L`),
 * testing Chebyshev-1 bridging `[start - 1, end + 1)` across
 * `prevSolid.rows[max(0, y - 1)..min(prevHeight - 1, y + 1)]`, and rescue
 * any detached solid runs clipped out of `candidateMask` by an adjacent
 * wall's `B`-px dilation halo.
 */
export function markDetachedAndRescueCandidates(
    current: RleMask,
    prevSolid: RleMask,
    candidateMask: RleMask,
    labels: RleLabels,
    components: ComponentInfo[],
    connectivity: Connectivity = 8,
): void {
    const height = Math.max(0, Math.min(current.height, current.rows.length));
    if (height === 0) {
        for (const comp of components) {
            comp.isDetached = false;
        }
        return;
    }

    const prevHeight = Math.max(0, Math.min(prevSolid.height, prevSolid.rows.length));
    const expand = connectivity === 8 ? 1 : 0;

    const parent: number[] = [];
    const hasBridge: number[] = [];
    const rowRunOffset = new Int32Array(height);

    function find(i: number): number {
        while (parent[i] !== i) {
            const p = parent[i];
            parent[i] = parent[p];
            i = parent[i];
        }
        return i;
    }

    function runBridgesPrevChebyshev1(y: number, start: number, end: number): boolean {
        if (prevHeight === 0) return false;
        const pyStart = Math.max(0, y - 1);
        const pyEnd = Math.min(prevHeight - 1, y + 1);
        if (pyStart > pyEnd) return false;
        const searchStart = start - 1;
        const searchEnd = end + 1;

        for (let py = pyStart; py <= pyEnd; py++) {
            const pRow = prevSolid.rows[py];
            if (!pRow || pRow.length === 0) continue;
            for (let j = 0; j < pRow.length; j += 2) {
                const pStart = pRow[j];
                if (pStart >= searchEnd) break;
                const pEnd = pStart + pRow[j + 1];
                if (Math.max(searchStart, pStart) < Math.min(searchEnd, pEnd)) {
                    return true;
                }
            }
        }
        return false;
    }

    for (let y = 0; y < height; y++) {
        rowRunOffset[y] = parent.length;
        const row = current.rows[y];
        if (!row || row.length === 0) continue;

        for (let i = 0; i < row.length; i += 2) {
            const start = row[i];
            const len = row[i + 1];
            const end = start + len;
            const myId = parent.length;
            parent.push(myId);
            hasBridge.push(runBridgesPrevChebyshev1(y, start, end) ? 1 : 0);

            if (y > 0) {
                const prevRow = current.rows[y - 1];
                if (prevRow && prevRow.length > 0) {
                    const prevOff = rowRunOffset[y - 1];
                    const searchStart = start - expand;
                    const searchEnd = end + expand;

                    for (let pi = 0, pRunIdx = 0; pi < prevRow.length; pi += 2, pRunIdx++) {
                        const pStart = prevRow[pi];
                        if (pStart >= searchEnd) break;
                        const pEnd = pStart + prevRow[pi + 1];
                        if (Math.max(searchStart, pStart) < Math.min(searchEnd, pEnd)) {
                            const ri = find(myId);
                            const rj = find(prevOff + pRunIdx);
                            if (ri !== rj) {
                                parent[rj] = ri;
                                hasBridge[ri] |= hasBridge[rj];
                            }
                        }
                    }
                }
            }
        }
    }

    if (parent.length === 0) {
        for (const comp of components) {
            comp.isDetached = false;
        }
        return;
    }

    let anyDetached = false;
    for (let i = 0; i < parent.length; i++) {
        const root = find(i);
        parent[i] = root;
        if (!hasBridge[root]) {
            anyDetached = true;
        }
    }

    if (!anyDetached) {
        for (const comp of components) {
            comp.isDetached = false;
        }
        return;
    }

    while (candidateMask.rows.length < height) {
        candidateMask.rows.push(EMPTY_ROW);
    }

    const isIntervalCovered = (candRow: RleRow, start: number, end: number): boolean => {
        let cur = start;
        for (let j = 0; j < candRow.length; j += 2) {
            const cStart = candRow[j];
            const cEnd = cStart + candRow[j + 1];
            if (cEnd <= cur) continue;
            if (cStart > cur) return false;
            cur = Math.max(cur, cEnd);
            if (cur >= end) return true;
        }
        return cur >= end;
    };

    let rescued = false;
    for (let y = 0; y < height; y++) {
        const curRow = current.rows[y];
        if (!curRow || curRow.length === 0) continue;
        const off = rowRunOffset[y];
        const candRow = candidateMask.rows[y] ?? EMPTY_ROW;
        let needsRowMerge = false;
        for (let i = 0, runIdx = 0; i < curRow.length; i += 2, runIdx++) {
            const root = parent[off + runIdx];
            const s = curRow[i];
            if (!hasBridge[root] && !isIntervalCovered(candRow, s, s + curRow[i + 1])) {
                needsRowMerge = true;
                break;
            }
        }
        if (needsRowMerge) {
            rescued = true;
            const intervals: Array<[number, number]> = [];
            for (let j = 0; j < candRow.length; j += 2) {
                intervals.push([candRow[j], candRow[j] + candRow[j + 1]]);
            }
            for (let i = 0, runIdx = 0; i < curRow.length; i += 2, runIdx++) {
                const root = parent[off + runIdx];
                if (!hasBridge[root]) {
                    intervals.push([curRow[i], curRow[i] + curRow[i + 1]]);
                }
            }
            intervals.sort((a, b) => a[0] - b[0]);
            const mergedSpans: number[] = [];
            if (intervals.length > 0) {
                let curStart = intervals[0][0];
                let curEnd = intervals[0][1];
                for (let k = 1; k < intervals.length; k++) {
                    const s = intervals[k][0];
                    const e = intervals[k][1];
                    if (s <= curEnd) {
                        if (e > curEnd) curEnd = e;
                    } else {
                        mergedSpans.push(curStart, curEnd - curStart);
                        curStart = s;
                        curEnd = e;
                    }
                }
                mergedSpans.push(curStart, curEnd - curStart);
            }
            // Assign a fresh Int32Array so shared EMPTY_ROW is never mutated in place.
            candidateMask.rows[y] = mergedSpans.length === 0 ? EMPTY_ROW : new Int32Array(mergedSpans);
        }
    }

    if (rescued) {
        const relabeled = rleLabelComponents(candidateMask, connectivity);
        labels.rows = relabeled.labels.rows;
        labels.width = relabeled.labels.width;
        labels.height = relabeled.labels.height;
        components.length = 0;
        for (const c of relabeled.components) components.push(c);
    }

    for (const comp of components) {
        comp.isDetached = false;
    }
    if (components.length === 0) return;

    let sequentialIds = true;
    for (let idx = 0; idx < components.length; idx++) {
        if (components[idx].id !== idx + 1) {
            sequentialIds = false;
            break;
        }
    }
    const idLookup = sequentialIds ? null : new Map<number, number>();
    if (idLookup) {
        for (let idx = 0; idx < components.length; idx++) {
            idLookup.set(components[idx].id, idx);
        }
    }

    const alignHeight = Math.min(height, labels.rows.length);
    for (let y = 0; y < alignHeight; y++) {
        const curRow = current.rows[y];
        const labRow = labels.rows[y];
        if (!curRow || curRow.length === 0 || !labRow || labRow.length === 0) continue;

        const off = rowRunOffset[y];
        const curRunCount = curRow.length >> 1;
        let ci = 0;

        for (let li = 0; li < labRow.length; li += 3) {
            const lId = labRow[li + 2];
            if (lId <= 0) continue;
            const lStart = labRow[li];
            const lEnd = lStart + labRow[li + 1];

            while (ci < curRunCount && curRow[ci * 2] + curRow[ci * 2 + 1] <= lStart) {
                ci++;
            }
            let tci = ci;
            let detached = false;
            while (tci < curRunCount && curRow[tci * 2] < lEnd) {
                const root = parent[off + tci];
                if (!hasBridge[root]) {
                    detached = true;
                    break;
                }
                tci++;
            }
            if (detached) {
                if (sequentialIds) {
                    const comp = components[lId - 1];
                    if (comp) comp.isDetached = true;
                } else {
                    const idx = idLookup!.get(lId);
                    if (idx !== undefined) {
                        components[idx].isDetached = true;
                    }
                }
            }
        }
    }
}

/**
 * Pack labeled candidate runs as flat `[y, start, length, compId, ...]` (4 ints/run)
 * alongside a compact `componentDetached` flag array indexed by `compId`.
 */
export function packCandidateLayerRuns(
    labels: RleLabels,
    components: ComponentInfo[],
): { candidateRuns: Int32Array; componentDetached: Uint8Array } {
    let runCount = 0;
    let maxCompId = 0;

    for (const comp of components) {
        if (comp.id > maxCompId) maxCompId = comp.id;
    }

    for (let y = 0; y < labels.rows.length; y++) {
        const row = labels.rows[y];
        if (!row || row.length === 0) continue;
        for (let i = 0; i < row.length; i += 3) {
            const compId = row[i + 2];
            if (compId > 0) {
                runCount += 1;
                if (compId > maxCompId) maxCompId = compId;
            }
        }
    }

    const candidateRuns = new Int32Array(runCount * 4);
    let at = 0;
    for (let y = 0; y < labels.rows.length; y++) {
        const row = labels.rows[y];
        if (!row || row.length === 0) continue;
        for (let i = 0; i < row.length; i += 3) {
            const compId = row[i + 2];
            if (compId <= 0) continue;
            candidateRuns[at++] = y;
            candidateRuns[at++] = row[i];
            candidateRuns[at++] = row[i + 1];
            candidateRuns[at++] = compId;
        }
    }

    const componentDetached = new Uint8Array(maxCompId + 1);
    for (const comp of components) {
        if (comp.id > 0 && comp.isDetached === true) {
            componentDetached[comp.id] = 1;
        }
    }

    return { candidateRuns, componentDetached };
}
