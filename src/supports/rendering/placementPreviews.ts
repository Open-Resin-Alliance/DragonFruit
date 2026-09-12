import type { SegmentPreviewTypeId, SupportTypeId } from '../supportTypeRegistry';
import type { BracePreviewData } from '../SupportTypes/Brace/bracePlacementState';
import type { SupportData } from './SupportBuilder';

/**
 * The live placement preview for each type that has one, keyed by type.
 *
 * Two shapes, declared on the registry as `previewShape`: most types preview a
 * whole provisional support, while a segment-shaped preview is a bare
 * start-to-end pair with no model contact and nothing to report. Consumers
 * that measure contacts or read an error consult `previewTypesByPriority`
 * rather than excluding a type by name.
 */
export type SupportPlacementPreviews =
    & Partial<Record<Exclude<SupportTypeId, SegmentPreviewTypeId>, SupportData | null>>
    & Partial<Record<SegmentPreviewTypeId, BracePreviewData | null>>;

/** Stable identity, so a missing map does not re-run the memos reading it. */
export const EMPTY_PLACEMENT_PREVIEWS: SupportPlacementPreviews = Object.freeze({});
