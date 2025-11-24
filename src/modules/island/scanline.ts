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

    // 2. Build Edge Table (ET)
    // ET is an array of linked lists, one for each scanline (row)
    // We use pixel coordinates (integer Y) for the table index
    const edgeTable: Array<Edge | null> = new Array(height).fill(null);

    for (const loop of loops) {
        const len = loop.length;
        if (len < 3) continue;

        for (let i = 0; i < len; i++) {
            const p1 = loop[i];
            const p2 = loop[(i + 1) % len];

            // Convert to pixel coordinates (relative to origin)
            // We use center-sampling logic: pixel (c, r) corresponds to x = originX + c*px, y = originY + r*px
            // So to convert world P to pixel P': P' = (P - origin) / px
            const x1 = (p1.x - originX) / px_mm;
            const y1 = (p1.y - originY) / px_mm;
            const x2 = (p2.x - originX) / px_mm;
            const y2 = (p2.y - originY) / px_mm;

            // Ignore horizontal edges (they don't intersect scanlines)
            if (Math.abs(y1 - y2) < 1e-6) continue;

            // Determine min/max Y for the edge
            let yMin = y1, yMax = y2, xVal = x1;
            if (y1 > y2) {
                yMin = y2;
                yMax = y1;
                xVal = x2;
            }

            // Calculate inverse slope (dx/dy)
            const slope = (x2 - x1) / (y2 - y1);

            // Determine scanline range
            // We process scanlines at integer Y indices (0, 1, 2...)
            // An edge starts affecting scanlines at ceil(yMin)
            const scanlineStart = Math.ceil(yMin - 0.5); // Adjust for pixel center sampling? 
            // Actually, since our grid Y is at originY + r*px, and we mapped y1/y2 relative to that,
            // integer Y values 0, 1, 2... correspond exactly to the scanlines.
            // However, we need to be careful about edges that start exactly on a scanline vs between.
            // Standard rule: include top edge, exclude bottom edge (or vice versa) to avoid double counting.
            // Here we'll use: include if yMin < scanline <= yMax

            const startRow = Math.ceil(yMin);
            const endRow = Math.ceil(yMax); // Exclusive upper bound for processing

            if (startRow >= height || endRow < 0) continue;

            // Clip to grid height
            const validStartRow = Math.max(0, startRow);

            // Calculate initial X at the first valid scanline
            // x = xVal + slope * (validStartRow - yMin)
            const initialX = xVal + slope * (validStartRow - yMin);

            // Add to Edge Table at the starting row
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
    }

    // 3. Process Scanlines
    let activeEdgeList: Edge | null = null;

    for (let y = 0; y < height; y++) {
        // A. Move edges from ET[y] to AEL
        let edge = edgeTable[y];
        while (edge) {
            const next = edge.next;
            edge.next = activeEdgeList;
            activeEdgeList = edge;
            edge = next;
        }

        // B. Remove finished edges from AEL (where y >= yMax)
        // We use y + 0.5 or just y? The scanline is at integer y.
        // If an edge ends at y=5.2, it crosses scanline 5. If it ends at 4.8, it doesn't cross 5.
        // So we keep edges where y < yMax.
        let prev: Edge | null = null;
        let curr = activeEdgeList;
        while (curr) {
            if (y >= curr.yMax) {
                // Remove
                if (prev) prev.next = curr.next;
                else activeEdgeList = curr.next;
            } else {
                prev = curr;
            }
            curr = curr.next;
        }

        // C. Sort AEL by X
        // Simple bubble sort or insertion sort for linked list (list is usually small)
        // For simplicity/performance, let's convert to array, sort, and rebuild list?
        // Actually, array is faster for sorting.
        const sortedEdges: Edge[] = [];
        curr = activeEdgeList;
        while (curr) {
            sortedEdges.push(curr);
            curr = curr.next;
        }
        sortedEdges.sort((a, b) => a.x - b.x);

        // D. Fill spans
        // Apply winding rule (Odd-Even): fill between pairs (0-1, 2-3...)
        for (let i = 0; i < sortedEdges.length; i += 2) {
            if (i + 1 >= sortedEdges.length) break;

            const e1 = sortedEdges[i];
            const e2 = sortedEdges[i + 1];

            // Fill pixels from ceil(e1.x) to floor(e2.x)
            // e.g. x1=2.5 (pixel 3), x2=5.5 (pixel 5) -> fill 3, 4, 5
            // e.g. x1=2.1 (pixel 3), x2=2.9 (pixel 2) -> empty

            let startX = Math.ceil(e1.x);
            let endX = Math.ceil(e2.x); // Exclusive? 
            // Standard rasterization: center sampling.
            // Pixel c is inside if x1 <= c < x2 ? 
            // Let's stick to: fill pixels whose centers are between edges.
            // Center of pixel c is at integer c (since we normalized coords).
            // So we need c > e1.x and c < e2.x ?
            // Actually, standard is: inclusive start, exclusive end?
            // Let's use: start = ceil(e1.x - 0.5)? No.
            // Let's assume standard center sampling:
            // Pixel center is at integer coordinate.
            // If edge is at 2.5, pixel 2 is left (out), pixel 3 is right (in).
            // So start pixel index = Math.ceil(e1.x - 0.5)? 
            // Wait, we mapped pixel centers to integers 0, 1, 2...
            // So if edge is at 2.5, it is between pixel 2 and 3.
            // So range is [ceil(2.5), floor(5.5)] -> [3, 5] -> pixels 3, 4, 5.
            // If edge is at 3.0 (exactly on pixel center), boundary rules apply.
            // Let's use Math.round for robustness or ceil for strictness.
            // Using Math.ceil(e1.x) to start, and Math.ceil(e2.x) as end (exclusive) is common.

            startX = Math.ceil(e1.x - 0.5); // Pixel centers are integers. If edge > pixel_center, pixel is out.
            endX = Math.ceil(e2.x - 0.5);

            // Clamp to width
            if (startX < 0) startX = 0;
            if (endX > width) endX = width;

            if (startX < endX) {
                const rowOffset = y * width;
                // data.fill(1, rowOffset + startX, rowOffset + endX); // TypedArray.fill is fast
                for (let x = startX; x < endX; x++) {
                    data[rowOffset + x] = 1;
                }
            }
        }

        // E. Update X for next scanline
        curr = activeEdgeList;
        while (curr) {
            curr.x += curr.slope;
            curr = curr.next;
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
    const originY = originZ; // map Z to Y for algorithm

    // 2. Build Edge Table (ET)
    const edgeTable: Array<Edge | null> = new Array(height).fill(null);

    for (const loop of loops) {
        const len = loop.length;
        if (len < 3) continue;

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
    }

    // 3. Process Scanlines
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
