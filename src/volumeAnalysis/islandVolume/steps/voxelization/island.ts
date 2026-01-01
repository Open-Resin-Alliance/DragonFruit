import { type RasterScanOptions, type ComponentInfo } from './types';
import {
    type RleMask,
    type RleLabels,
    rleIntersectDilated,
    rleSubtract,
    rleLabelComponents
} from './rle';

// Re-export RLE types for use in other modules
export { type RleMask, type RleLabels } from './rle';

/**
 * Scans a layer using RLE operations to identify island candidates.
 * 
 * Logic:
 * 1. Supported = CurrentLayer AND Dilate(PrevLayer, buffer)
 * 2. Candidates = CurrentLayer MINUS Supported
 * 3. Labels = ConnectedComponents(Candidates)
 * 
 * @param current - Current layer mask (RLE)
 * @param prev - Previous layer mask (RLE) or null
 * @param opts - Scan options
 */
export function scanLayer(
    current: RleMask,
    prev: RleMask | null,
    opts: RasterScanOptions
): { labels: RleLabels; components: ComponentInfo[]; solidMask: RleMask } {

    let islandCandidates: RleMask;

    if (!prev) {
        // First layer: everything is a candidate (no support below)
        islandCandidates = current;
    } else {
        // Calculate support buffer in pixels
        const supportBufferPx = Math.max(0, Math.round(opts.support_buffer_mm / opts.px_mm));

        // Find supported regions: Current AND Dilated(Prev)
        const supported = rleIntersectDilated(current, prev, supportBufferPx);

        // Find unsupported regions (candidates): Current MINUS Supported
        islandCandidates = rleSubtract(current, supported);
    }

    // Label connected components of candidates
    const { labels, components } = rleLabelComponents(
        islandCandidates,
        opts.connectivity ?? 4
    );

    return { labels, components, solidMask: current };
}
