import { type Mask } from './types';
import { type Pt2, boundsOfLoops } from './geometry';
import { type OrientedSegment2D } from '@/components/analysis/Slice2D';

interface ActiveEdge {
    x: number;
    slope: number;
    wind: number;
    endExclusive: number;
}

interface RowSpan {
    start: number;
    endExclusive: number;
}

function compareEdgeX(a: number, b: number): number {
    const aFin = Number.isFinite(a);
    const bFin = Number.isFinite(b);
    if (aFin && bFin) return a - b;
    if (aFin) return -1;
    if (bFin) return 1;
    return 0;
}

function makeRowSpan(x0: number, x1: number, width: number): RowSpan | null {
    const a = Math.max(0, Math.min(x0, x1));
    const b = Math.min(width, Math.max(x0, x1));
    if (b <= a) return null;

    const startPx = Math.ceil(a - 0.5);
    const endPxExclusive = Math.ceil(b - 0.5);
    if (endPxExclusive <= startPx || endPxExclusive <= 0 || startPx >= width) {
        return null;
    }

    const start = Math.max(0, startPx);
    const endExclusive = Math.min(width, endPxExclusive);
    if (endExclusive <= start) return null;

    return { start, endExclusive };
}

function spansOverlapPx(a: RowSpan[], b: RowSpan[]): number {
    let total = 0;
    let j = 0;
    for (let i = 0; i < a.length; i++) {
        const sa = a[i];
        while (j < b.length && b[j].endExclusive <= sa.start) {
            j++;
        }
        let k = j;
        while (k < b.length && b[k].start < sa.endExclusive) {
            const lo = Math.max(sa.start, b[k].start);
            const hi = Math.min(sa.endExclusive, b[k].endExclusive);
            if (hi > lo) {
                total += hi - lo;
            }
            k++;
        }
    }
    return total;
}

function spansTotalPx(spans: RowSpan[]): number {
    let total = 0;
    for (let i = 0; i < spans.length; i++) {
        total += spans[i].endExclusive - spans[i].start;
    }
    return total;
}

function collapseSubpixelPairs(activeEdges: ActiveEdge[]): ActiveEdge[] | null {
    let hasSubpixelPair = false;
    for (let i = 0; i + 1 < activeEdges.length; i++) {
        const p0 = activeEdges[i];
        const p1 = activeEdges[i + 1];
        if (
            Number.isFinite(p0.x) &&
            Number.isFinite(p1.x) &&
            p0.wind + p1.wind === 0 &&
            p1.x - p0.x < 1.0
        ) {
            hasSubpixelPair = true;
            break;
        }
    }
    if (!hasSubpixelPair) return null;

    const collapsed: ActiveEdge[] = [];
    for (let i = 0; i < activeEdges.length; i++) {
        const edge = activeEdges[i];
        const prev = collapsed.length > 0 ? collapsed[collapsed.length - 1] : null;
        if (
            prev !== null &&
            Number.isFinite(prev.x) &&
            Number.isFinite(edge.x) &&
            prev.wind + edge.wind === 0 &&
            edge.x - prev.x < 1.0
        ) {
            collapsed.pop();
        } else {
            collapsed.push(edge);
        }
    }
    return collapsed;
}

function lowerBoundStrictlyGreater(arr: number[], value: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= value) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function buildRowSpansMatched(
    activeEdges: ActiveEdge[],
    width: number,
    entryWind: number,
): { spans: RowSpan[]; matchedPairCount: number } {
    const open: number[] = [];
    const pairs: Array<[number, number]> = [];
    const orphans: Array<[number, number]> = [];

    let edgeIndex = 0;
    while (edgeIndex < activeEdges.length) {
        const edge = activeEdges[edgeIndex];
        if (!Number.isFinite(edge.x)) break;

        let w = edge.wind * entryWind;
        if (w === -1 && open.length === 0) {
            const nextEntry =
                edgeIndex + 1 < activeEdges.length &&
                Number.isFinite(activeEdges[edgeIndex + 1].x) &&
                activeEdges[edgeIndex + 1].wind * entryWind === 1 &&
                activeEdges[edgeIndex + 1].x > edge.x
                    ? activeEdges[edgeIndex + 1]
                    : null;

            if (nextEntry !== null) {
                let nextExit: ActiveEdge | null = null;
                for (let k = edgeIndex + 2; k < activeEdges.length; k++) {
                    const cand = activeEdges[k];
                    if (Number.isFinite(cand.x) && cand.wind * entryWind < 0) {
                        nextExit = cand;
                        break;
                    }
                }
                if (nextExit !== null && nextEntry.x - edge.x < nextExit.x - nextEntry.x) {
                    edgeIndex += 2;
                    continue;
                }
            }
        }

        while (w > 0) {
            open.push(edge.x);
            w -= 1;
        }
        while (w < 0) {
            w += 1;
            if (open.length > 0) {
                const xLeft = open.pop()!;
                if (edge.x > xLeft) {
                    pairs.push([xLeft, edge.x]);
                }
            } else {
                orphans.push([edge.x, -1]);
            }
        }
        edgeIndex += 1;
    }

    for (let i = 0; i < open.length; i++) {
        orphans.push([open[i], 1]);
    }
    orphans.sort((a, b) => a[0] - b[0]);

    const matchedPairCount = pairs.length;
    const matchedXs: number[] = new Array(pairs.length * 2);
    for (let i = 0; i < pairs.length; i++) {
        matchedXs[i * 2] = pairs[i][0];
        matchedXs[i * 2 + 1] = pairs[i][1];
    }
    matchedXs.sort((a, b) => a - b);

    for (let i = 0; i + 1 < orphans.length; i += 2) {
        const [xLeft, wLeft] = orphans[i];
        const [xRight, wRight] = orphans[i + 1];
        const gapSignature = wLeft < 0 && wRight > 0;
        const firstInside = lowerBoundStrictlyGreater(matchedXs, xLeft);
        const crossesMatchedFill = firstInside < matchedXs.length && matchedXs[firstInside] < xRight;
        if (!gapSignature && !crossesMatchedFill && xRight > xLeft) {
            pairs.push([xLeft, xRight]);
        }
    }

    if (pairs.length === 0) {
        return { spans: [], matchedPairCount };
    }

    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const spans: RowSpan[] = [];
    let curA = pairs[0][0];
    let curB = pairs[0][1];
    for (let i = 1; i < pairs.length; i++) {
        const [a, b] = pairs[i];
        if (a <= curB) {
            if (b > curB) curB = b;
        } else {
            const span = makeRowSpan(curA, curB, width);
            if (span) spans.push(span);
            curA = a;
            curB = b;
        }
    }
    const lastSpan = makeRowSpan(curA, curB, width);
    if (lastSpan) spans.push(lastSpan);

    return { spans, matchedPairCount };
}

function buildRowSpansNonZeroCtx(
    activeEdges: ActiveEdge[],
    width: number,
    prevSpans: RowSpan[],
): RowSpan[] {
    if (activeEdges.length < 2) return [];

    const spans: RowSpan[] = [];
    let winding = 0;
    let closureWinding = 0;
    let minWinding = 0;
    let maxWinding = 0;
    const n = activeEdges.length;

    for (let i = 0; i < n - 1; i++) {
        const xLeft = activeEdges[i].x;
        if (!Number.isFinite(xLeft)) break;

        const w = activeEdges[i].wind;
        winding += w;
        closureWinding += w;
        if (closureWinding < minWinding) minWinding = closureWinding;
        if (closureWinding > maxWinding) maxWinding = closureWinding;

        if (winding === 0) continue;

        const xRight = activeEdges[i + 1].x;
        if (!Number.isFinite(xRight)) break;

        const span = makeRowSpan(xLeft, xRight, width);
        if (span) spans.push(span);
    }

    const lastEdge = activeEdges[n - 1];
    if (Number.isFinite(lastEdge.x)) {
        closureWinding += lastEdge.wind;
        if (closureWinding < minWinding) minWinding = closureWinding;
        if (closureWinding > maxWinding) maxWinding = closureWinding;
    }

    if (closureWinding !== 0 || (minWinding < 0 && maxWinding > 0)) {
        const edges = collapseSubpixelPairs(activeEdges) ?? activeEdges;
        const pos = buildRowSpansMatched(edges, width, 1);
        const neg = buildRowSpansMatched(edges, width, -1);

        const posOverlap = spansOverlapPx(pos.spans, prevSpans);
        const negOverlap = spansOverlapPx(neg.spans, prevSpans);

        const choosePos =
            posOverlap !== negOverlap
                ? posOverlap > negOverlap
                : pos.matchedPairCount !== neg.matchedPairCount
                  ? pos.matchedPairCount > neg.matchedPairCount
                  : spansTotalPx(pos.spans) <= spansTotalPx(neg.spans);

        return choosePos ? pos.spans : neg.spans;
    }

    return spans;
}

/**
 * Rasterize oriented 2D segments into an existing grid reference using
 * non-zero winding with defective-row matched-pair leak repair.
 */
export function rasterizeSegmentsToExistingGridScanline(segments: OrientedSegment2D[], ref: Mask): Mask {
    const { width, height, originX, originZ, px_mm } = ref;
    const data = new Uint8Array(width * height);
    if (width <= 0 || height <= 0 || px_mm <= 0 || segments.length === 0) {
        return { data, width, height, originX, originZ, px_mm };
    }

    const edgeTable: Array<ActiveEdge[] | null> = new Array(height).fill(null);

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.wind === 0) continue;

        const gx1 = (seg.x1 - originX) / px_mm;
        const gy1 = (seg.y1 - originZ) / px_mm;
        const gx2 = (seg.x2 - originX) / px_mm;
        const gy2 = (seg.y2 - originZ) / px_mm;

        const dy = gy2 - gy1;
        if (Math.abs(dy) < 1e-8) continue;

        const yMin = gy1 < gy2 ? gy1 : gy2;
        const yMax = gy1 < gy2 ? gy2 : gy1;
        const xAtYMin = gy1 < gy2 ? gx1 : gx2;
        const slope = (gx2 - gx1) / dy;

        const startRow = Math.ceil(yMin - 0.5);
        const endExclusive = Math.ceil(yMax - 0.5);
        const clampedStart = Math.max(0, startRow);
        const clampedEnd = Math.min(height, endExclusive);

        if (clampedStart >= clampedEnd || clampedStart >= height) continue;

        const ySample = clampedStart + 0.5;
        const initialX = xAtYMin + slope * (ySample - yMin);
        const bucket = edgeTable[clampedStart];
        const edge: ActiveEdge = {
            x: initialX,
            slope,
            wind: seg.wind,
            endExclusive: clampedEnd,
        };
        if (bucket === null) {
            edgeTable[clampedStart] = [edge];
        } else {
            bucket.push(edge);
        }
    }

    let activeEdges: ActiveEdge[] = [];
    let prevSpans: RowSpan[] = [];

    for (let y = 0; y < height; y++) {
        if (activeEdges.length > 0) {
            let writeIdx = 0;
            for (let i = 0; i < activeEdges.length; i++) {
                const edge = activeEdges[i];
                if (edge.endExclusive > y) {
                    activeEdges[writeIdx++] = edge;
                }
            }
            activeEdges.length = writeIdx;
        }

        const starting = edgeTable[y];
        if (starting !== null) {
            for (let i = 0; i < starting.length; i++) {
                activeEdges.push(starting[i]);
            }
        }

        if (activeEdges.length === 0) {
            prevSpans = [];
            continue;
        }

        activeEdges.sort((a, b) => compareEdgeX(a.x, b.x));

        const spans = buildRowSpansNonZeroCtx(activeEdges, width, prevSpans);
        const rowOffset = y * width;
        for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            data.fill(1, rowOffset + span.start, rowOffset + span.endExclusive);
        }

        prevSpans = spans;
        for (let i = 0; i < activeEdges.length; i++) {
            activeEdges[i].x += activeEdges[i].slope;
        }
    }

    return { data, width, height, originX, originZ, px_mm };
}

/**
 * Rasterize oriented 2D segments into a tight-bounded mask using Scanline winding.
 */
export function rasterizeSegmentsScanline(segments: OrientedSegment2D[], px_mm: number, paddingMm = 0): Mask {
    if (segments.length === 0) {
        return { data: new Uint8Array(1), width: 1, height: 1, originX: 0, originZ: 0, px_mm };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        if (s.x1 < minX) minX = s.x1;
        if (s.x1 > maxX) maxX = s.x1;
        if (s.x2 < minX) minX = s.x2;
        if (s.x2 > maxX) maxX = s.x2;
        if (s.y1 < minY) minY = s.y1;
        if (s.y1 > maxY) maxY = s.y1;
        if (s.y2 < minY) minY = s.y2;
        if (s.y2 > maxY) maxY = s.y2;
    }

    minX -= paddingMm;
    maxX += paddingMm;
    minY -= paddingMm;
    maxY += paddingMm;

    const width = Math.max(1, Math.ceil((maxX - minX) / px_mm));
    const height = Math.max(1, Math.ceil((maxY - minY) / px_mm));

    return rasterizeSegmentsToExistingGridScanline(segments, {
        data: new Uint8Array(width * height),
        width,
        height,
        originX: minX,
        originZ: minY,
        px_mm,
    });
}

/**
 * Rasterize polygons using the Scanline algorithm.
 *
 * @param loops - Array of polygon loops (array of points)
 * @param px_mm - Pixel size in mm
 * @param paddingMm - Optional padding around the bounds
 */
export function rasterizeLoopsScanline(loops: Pt2[][], px_mm: number, paddingMm = 0): Mask {
    if (loops.length === 0) {
        return { data: new Uint8Array(1), width: 1, height: 1, originX: 0, originZ: 0, px_mm };
    }
    const b = boundsOfLoops(loops);
    const minX = b.minX - paddingMm;
    const maxX = b.maxX + paddingMm;
    const minY = b.minY - paddingMm;
    const maxY = b.maxY + paddingMm;

    const width = Math.max(1, Math.ceil((maxX - minX) / px_mm));
    const height = Math.max(1, Math.ceil((maxY - minY) / px_mm));

    return rasterizeLoopsToExistingGridScanline(loops, {
        data: new Uint8Array(width * height),
        width,
        height,
        originX: minX,
        originZ: minY,
        px_mm,
    });
}

/**
 * Rasterize loops into an existing grid reference (resizing not supported, assumes same grid).
 */
export function rasterizeLoopsToExistingGridScanline(loops: Pt2[][], ref: Mask): Mask {
    const segments: OrientedSegment2D[] = [];
    for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        const len = loop.length;
        if (len < 3) continue;
        for (let i = 0; i < len; i++) {
            const p1 = loop[i];
            const p2 = loop[(i + 1) % len];
            if (Math.abs(p2.y - p1.y) < 1e-8) continue;
            segments.push({
                x1: p1.x,
                y1: p1.y,
                x2: p2.x,
                y2: p2.y,
                wind: p2.y < p1.y ? 1 : -1,
            });
        }
    }
    return rasterizeSegmentsToExistingGridScanline(segments, ref);
}

/**
 * Compresses a binary mask (Uint8Array) into a Sparse Run-Length Encoded format.
 * Format: [start_index, length, start_index, length, ...]
 * Only stores the "ON" (non-zero) segments.
 */
export function rleEncode(data: Uint8Array): Int32Array {
    const spans: number[] = [];
    let inRun = false;
    let runStart = 0;

    for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) {
            if (!inRun) {
                inRun = true;
                runStart = i;
            }
        } else {
            if (inRun) {
                inRun = false;
                spans.push(runStart, i - runStart);
            }
        }
    }
    // Close final run
    if (inRun) {
        spans.push(runStart, data.length - runStart);
    }

    return new Int32Array(spans);
}

/**
 * Decompresses a Sparse RLE buffer back into a binary mask.
 */
export function rleDecode(encoded: Int32Array, size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < encoded.length; i += 2) {
        const start = encoded[i];
        const len = encoded[i + 1];
        data.fill(1, start, start + len);
    }
    return data;
}
