import { type Mask } from './types';
import { type Pt2, boundsOfLoops } from './geometry';

/**
 * Edge structure for Scanline Rasterization
 */
interface Edge {
    yMax: number;   // Maximum Y coordinate of the edge
    x: number;      // Current X coordinate (starts at x of yMin)
    slope: number;  // Inverse slope (dx/dy)
    next: Edge | null; // Linked list for Edge Table buckets
}

/**
 * Rasterize polygons using the Scanline algorithm.
 * Significantly faster than point-in-polygon for complex geometry.
 * 
 * @param loops - Array of polygon loops (array of points)
 * @param px_mm - Pixel size in mm
 * @param paddingMm - Optional padding around the bounds
 */
export function rasterizeLoopsScanline(loops: Pt2[][], px_mm: number, paddingMm = 0): Mask {
    // 1. Calculate bounds and grid dimensions
    const b = boundsOfLoops(loops);
    const minX = b.minX - paddingMm;
    const maxX = b.maxX + paddingMm;
    const minY = b.minY - paddingMm;
    const maxY = b.maxY + paddingMm;

    const width = Math.max(1, Math.ceil((maxX - minX) / px_mm));
    const height = Math.max(1, Math.ceil((maxY - minY) / px_mm));

    const originX = minX + px_mm * 0.5;
    const originY = minY + px_mm * 0.5; // originZ in Mask corresponds to Y here

    const data = new Uint8Array(width * height);

    for (const loop of loops) {
        const len = loop.length;
        if (len < 3) continue;

        const edgeTable: Array<Edge | null> = new Array(height).fill(null);

        for (let i = 0; i < len; i++) {
            const p1 = loop[i];
            const p2 = loop[(i + 1) % len];

            const x1 = (p1.x - originX) / px_mm;
            const y1 = (p1.y - originY) / px_mm;
            const x2 = (p2.x - originX) / px_mm;
            const y2 = (p2.y - originY) / px_mm;

            if (Math.abs(y1 - y2) < 1e-6) continue;

            let yMin = y1, yMax = y2, xVal = x1;
            if (y1 > y2) {
                yMin = y2;
                yMax = y1;
                xVal = x2;
            }

            const slope = (x2 - x1) / (y2 - y1);
            const startRow = Math.ceil(yMin);
            const endRow = Math.ceil(yMax);

            if (startRow >= height || endRow < 0) continue;

            const validStartRow = Math.max(0, startRow);
            const initialX = xVal + slope * (validStartRow - yMin);

            if (validStartRow < height) {
                const edge: Edge = {
                    yMax: yMax,
                    x: initialX,
                    slope: slope,
                    next: edgeTable[validStartRow]
                };
                edgeTable[validStartRow] = edge;
            }
        }

        let activeEdgeList: Edge | null = null;

        for (let y = 0; y < height; y++) {
            let edge = edgeTable[y];
            while (edge) {
                const next = edge.next;
                edge.next = activeEdgeList;
                activeEdgeList = edge;
                edge = next;
            }

            let prev: Edge | null = null;
            let curr = activeEdgeList;
            while (curr) {
                if (y >= curr.yMax) {
                    if (prev) prev.next = curr.next;
                    else activeEdgeList = curr.next;
                } else {
                    prev = curr;
                }
                curr = curr.next;
            }

            const sortedEdges: Edge[] = [];
            curr = activeEdgeList;
            while (curr) {
                sortedEdges.push(curr);
                curr = curr.next;
            }
            sortedEdges.sort((a, b) => a.x - b.x);

            for (let i = 0; i < sortedEdges.length; i += 2) {
                if (i + 1 >= sortedEdges.length) break;

                const e1 = sortedEdges[i];
                const e2 = sortedEdges[i + 1];

                let startX = Math.ceil(e1.x - 0.5);
                let endX = Math.ceil(e2.x - 0.5);

                if (startX < 0) startX = 0;
                if (endX > width) endX = width;

                if (startX < endX) {
                    const rowOffset = y * width;
                    for (let x = startX; x < endX; x++) {
                        data[rowOffset + x] = 1;
                    }
                }
            }

            curr = activeEdgeList;
            while (curr) {
                curr.x += curr.slope;
                curr = curr.next;
            }
        }
    }

    return { data, width, height, originX, originZ: originY, px_mm };
}

/**
 * Rasterize loops into an existing grid reference (resizing not supported, assumes same grid).
 */
export function rasterizeLoopsToExistingGridScanline(loops: Pt2[][], ref: Mask): Mask {
    const { width, height, originX, originZ, px_mm } = ref;
    const data = new Uint8Array(width * height);
    const originXCenter = originX + px_mm * 0.5;
    const originY = originZ + px_mm * 0.5;

    for (const loop of loops) {
        const len = loop.length;
        if (len < 3) continue;

        const edgeTable: Array<Edge | null> = new Array(height).fill(null);

        for (let i = 0; i < len; i++) {
            const p1 = loop[i];
            const p2 = loop[(i + 1) % len];

            const x1 = (p1.x - originX) / px_mm;
            const y1 = (p1.y - originY) / px_mm;
            const x2 = (p2.x - originX) / px_mm;
            const y2 = (p2.y - originY) / px_mm;

            if (Math.abs(y1 - y2) < 1e-6) continue;

            let yMin = y1, yMax = y2, xVal = x1;
            if (y1 > y2) { yMin = y2; yMax = y1; xVal = x2; }

            const slope = (x2 - x1) / (y2 - y1);
            const startRow = Math.ceil(yMin);
            const validStartRow = Math.max(0, startRow);
            const initialX = xVal + slope * (validStartRow - yMin);

            if (validStartRow < height) {
                const edge: Edge = { yMax, x: initialX, slope, next: edgeTable[validStartRow] };
                edgeTable[validStartRow] = edge;
            }
        }

        let activeEdgeList: Edge | null = null;

        for (let y = 0; y < height; y++) {
            let edge = edgeTable[y];
            while (edge) {
                const next = edge.next;
                edge.next = activeEdgeList;
                activeEdgeList = edge;
                edge = next;
            }

            let prev: Edge | null = null;
            let curr = activeEdgeList;
            while (curr) {
                if (y >= curr.yMax) {
                    if (prev) prev.next = curr.next;
                    else activeEdgeList = curr.next;
                } else {
                    prev = curr;
                }
                curr = curr.next;
            }

            const sortedEdges: Edge[] = [];
            curr = activeEdgeList;
            while (curr) {
                sortedEdges.push(curr);
                curr = curr.next;
            }
            sortedEdges.sort((a, b) => a.x - b.x);

            for (let i = 0; i < sortedEdges.length; i += 2) {
                if (i + 1 >= sortedEdges.length) break;

                const e1 = sortedEdges[i];
                const e2 = sortedEdges[i + 1];

                let startX = Math.ceil(e1.x - 0.5);
                let endX = Math.ceil(e2.x - 0.5);

                if (startX < 0) startX = 0;
                if (endX > width) endX = width;

                if (startX < endX) {
                    const rowOffset = y * width;
                    for (let x = startX; x < endX; x++) {
                        data[rowOffset + x] = 1;
                    }
                }
            }

            curr = activeEdgeList;
            while (curr) {
                curr.x += curr.slope;
                curr = curr.next;
            }
        }
    }

    return { data, width, height, originX, originZ, px_mm };
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
