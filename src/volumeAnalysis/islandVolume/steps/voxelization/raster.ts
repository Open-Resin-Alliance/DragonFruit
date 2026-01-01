import { type Mask } from './types';
import { type Pt2, boundsOfLoops } from './geometry';

/**
 * Calculates the X-coordinates where the scanline at `y` intersects the polygon loops.
 * Returns a sorted array of x-coordinates.
 */
function getScanlineIntersections(loops: Pt2[][], y: number): number[] {
    const intersections: number[] = [];
    for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const pi = loop[i];
            const pj = loop[j];

            // Check if the edge spans the scanline y (ray casting rule)
            // We use >= and < to handle vertices on the scanline exactly once per crossing
            if ((pi.y < y && pj.y >= y) || (pj.y < y && pi.y >= y)) {
                // Calculate X intersection
                // x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                const x = pi.x + (y - pi.y) * (pj.x - pi.x) / (pj.y - pi.y);
                intersections.push(x);
            }
        }
    }
    // Sort x-coordinates ascending
    return intersections.sort((a, b) => a - b);
}

export function rasterizeLoopsToExistingGrid(loops: Pt2[][], ref: Mask): Mask {
    const { width, height, originX, originZ, px_mm } = ref;
    const data = new Uint8Array(width * height);

    // Scan every row
    for (let row = 0; row < height; row++) {
        // Y-coordinate of the pixel centers in this row
        const y = originZ + row * px_mm;

        const intersections = getScanlineIntersections(loops, y);

        // Fill pixels between pairs of intersections (even-odd rule)
        for (let i = 0; i < intersections.length; i += 2) {
            const xEnter = intersections[i];
            // Safety check for odd number of intersections (shouldn't happen for valid loops)
            const xExit = (i + 1 < intersections.length) ? intersections[i + 1] : xEnter;

            // Determine column range where pixel center is between xEnter and xExit
            // center_col = originX + col * px_mm
            // condition: xEnter <= center_col <= xExit (Conservative/Inclusive)

            // col >= (xEnter - originX) / px_mm  --> ceil
            const cStart = Math.max(0, Math.ceil((xEnter - originX) / px_mm));

            // col <= (xExit - originX) / px_mm   --> floor
            const cEnd = Math.min(width - 1, Math.floor((xExit - originX) / px_mm));

            if (cStart <= cEnd) {
                // Fill the span
                data.fill(1, row * width + cStart, row * width + cEnd + 1);
            }
        }
    }

    return { data, width, height, originX, originZ, px_mm };
}

export function rasterizeLoopsToMask(loops: Pt2[][], px_mm: number, paddingMm = 0): Mask {
    const b = boundsOfLoops(loops);
    const minX = b.minX - paddingMm;
    const maxX = b.maxX + paddingMm;
    const minY = b.minY - paddingMm;
    const maxY = b.maxY + paddingMm;
    const width = Math.max(1, Math.ceil((maxX - minX) / px_mm));
    const height = Math.max(1, Math.ceil((maxY - minY) / px_mm));

    // Center the grid such that (0,0) pixel is at minX + half_pixel?
    // Consistently use the same logic as existingGrid:
    // originX/Y is the center of the 0,0 pixel.
    const originX = minX + px_mm * 0.5;
    const originZ = minY + px_mm * 0.5; // (originZ maps to Y in 2D)

    // Create the mask structure
    const mask: Mask = {
        data: new Uint8Array(width * height),
        width,
        height,
        originX,
        originZ,
        px_mm
    };

    // Reuse the rasterizer logic
    // (Note: we could optimize by inlining to avoid re-creating the mask object, but this is cleaner)
    return rasterizeLoopsToExistingGrid(loops, mask);
}
