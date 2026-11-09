import { registerSegmentPreviewBatchBuilder, segmentPreviewTypesMissingBuilder } from './seam';
import { buildBracePlacementPreviewBatch } from '../SupportTypes/Brace/bracePreviewBatch';
import type { BracePreviewData } from '../SupportTypes/Brace/bracePlacementState';
import { SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * Wires each type's preview geometry into the segment-preview seam. Loaded by
 * the renderer, not the store, which is still initialising when registrations run.
 */

/** The type declaring the segment preview shape, read off the registry. */
const [segmentPreviewTypeId] = SUPPORT_TYPES
    .filter((descriptor) => descriptor.previewShape === 'segment')
    .map((descriptor) => descriptor.id);
if (!segmentPreviewTypeId) {
    throw new Error('no support type declares `previewShape: \'segment\'`, so there is no builder to register.');
}

registerSegmentPreviewBatchBuilder<BracePreviewData>(segmentPreviewTypeId, buildBracePlacementPreviewBatch);

// A segment-preview type with no builder draws nothing, silently.
const missingPreviewBuilders = segmentPreviewTypesMissingBuilder();
if (missingPreviewBuilders.length > 0) {
    throw new Error(
        `segment-preview types have no registered batch builder: ${missingPreviewBuilders.join(', ')}. `
        + 'Register one above.',
    );
}
