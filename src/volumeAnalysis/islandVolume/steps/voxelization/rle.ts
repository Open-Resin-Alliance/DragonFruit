import { ComponentInfo } from './types';

// RLE Row: [start, length, start, length, ...]
// Represents a single row of binary data.
export type RleRow = Int32Array;

// RLE Mask: Array of rows
export type RleMask = {
    rows: RleRow[];
    width: number;
    height: number;
};

// Labeled RLE Row: [start, length, id, start, length, id, ...]
export type RleLabelRow = Int32Array;

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
        rows[y] = new Int32Array(rowSpans);
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

        rows[y] = new Int32Array(rowSpans);
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
    const { width, height } = a;
    const resultRows: RleRow[] = new Array(height);

    // Optimization: Pre-calculate dilated bounds for B rows?
    // Or just iterate.

    for (let y = 0; y < height; y++) {
        const aRow = a.rows[y];
        if (aRow.length === 0) {
            resultRows[y] = new Int32Array(0);
            continue;
        }

        // Gather relevant rows from B (y +/- buffer)
        // We treat B as if every run is expanded by 'buffer' in X and Y.
        // So a run in B at 'by' covers Y range [by - buffer, by + buffer].
        // Conversely, for current Y, we look at B rows in [y - buffer, y + buffer].

        const relevantBRows: RleRow[] = [];
        const startY = Math.max(0, y - buffer);
        const endY = Math.min(height - 1, y + buffer);

        for (let by = startY; by <= endY; by++) {
            if (b.rows[by].length > 0) {
                relevantBRows.push(b.rows[by]);
            }
        }

        if (relevantBRows.length === 0) {
            resultRows[y] = new Int32Array(0);
            continue;
        }

        // Intersect 'aRow' with the union of 'relevantBRows' (dilated horizontally)
        // We can merge relevantBRows into a single sorted list of intervals, merging overlaps,
        // and expanding each by 'buffer'.

        const bIntervals: { start: number, end: number }[] = [];
        for (const bRow of relevantBRows) {
            for (let i = 0; i < bRow.length; i += 2) {
                // Dilate horizontally
                bIntervals.push({
                    start: Math.max(0, bRow[i] - buffer),
                    end: Math.min(width, bRow[i] + bRow[i + 1] + buffer)
                });
            }
        }

        // Sort and merge B intervals
        bIntervals.sort((p, q) => p.start - q.start);

        const mergedB: { start: number, end: number }[] = [];
        if (bIntervals.length > 0) {
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
        }

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

        resultRows[y] = new Int32Array(resSpans);
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
            resultRows[y] = new Int32Array(0);
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
export function rleLabelComponents(mask: RleMask, connectivity: 4 | 8 = 4): { labels: RleLabels, components: ComponentInfo[] } {
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
        let pIdx = 0; // Pointer for prevRow optimization

        for (let i = 0; i < row.length; i += 2) {
            const start = row[i];
            const len = row[i + 1];
            const end = start + len;

            // Calculate sums for this run
            const runSumX = len * (start + (end - 1)) / 2;
            const runSumY = len * y;

            // Create new label for this run
            const myId = newLabel(len, runSumX, runSumY);
            currentRowLabels.push(start, len, myId);

            // Check connectivity with previous row
            if (prevRow) {
                const expand = connectivity === 8 ? 1 : 0;
                const searchStart = start - expand;
                const searchEnd = end + expand;

                // OPTIMIZATION: Use sliding pointer pIdx to avoid O(N^2)
                // Advance pIdx to skip runs that end before searchStart
                while (pIdx < prevRow.length) {
                    const pStart = prevRow[pIdx];
                    const pLen = prevRow[pIdx + 1];
                    const pEnd = pStart + pLen;
                    if (pEnd <= searchStart) {
                        pIdx += 3; // label rows are [start, len, id]
                    } else {
                        break;
                    }
                }

                // Check overlaps starting from pIdx
                let tempIdx = pIdx;
                while (tempIdx < prevRow.length) {
                    const pStart = prevRow[tempIdx];
                    // const pLen = prevRow[tempIdx + 1]; // Unused
                    const pId = prevRow[tempIdx + 2];

                    if (pStart >= searchEnd) break; // Passed the window

                    // Overlap confirmed by loop bounds (since we skipped non-overlapping left ones)
                    union(myId, pId);

                    tempIdx += 3;
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
