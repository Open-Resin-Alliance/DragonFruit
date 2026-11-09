import type { SegmentPreviewTypeId, SupportTypeId } from '../supportTypeRegistry';
import type { BracePreviewData } from '../SupportTypes/Brace/bracePlacementState';
import type { SupportData } from './SupportBuilder';

/**
 * The live placement preview for each type that has one. Two shapes, per the
 * registry's `previewShape`: a whole provisional support, or a bare
 * start-to-end pair with no model contact.
 */
export type SupportPlacementPreviews =
    & Partial<Record<Exclude<SupportTypeId, SegmentPreviewTypeId>, SupportData | null>>
    & Partial<Record<SegmentPreviewTypeId, BracePreviewData | null>>;

/** Stable identity, so a missing map does not re-run the memos reading it. */
export const EMPTY_PLACEMENT_PREVIEWS: SupportPlacementPreviews = Object.freeze({});

/** Which placement modes are live. A type absent from the map has none. */
export type SupportPlacementActive = Partial<Record<SupportTypeId, boolean>>;

/** Stable identity, so a missing map does not re-run the memos reading it. */
export const EMPTY_PLACEMENT_ACTIVE: SupportPlacementActive = Object.freeze({});
