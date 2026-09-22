import type { PlacementPreviewBatch } from '../supportPlacementPreviewMath';
import { SUPPORT_TYPES, type SupportTypeId } from '../supportTypeRegistry';

/**
 * Where a type declaring `previewShape: 'segment'` registers the batch its
 * placement preview draws.
 */

/** Supplied by the caller: the seam loads before the settings store exists. */
export interface SegmentPreviewContext {
    /** The thickest shaft the type's builder will produce. */
    maxShaftDiameterMm: number;
}

type SegmentPreviewBatchBuilder = (
    id: string,
    preview: never,
    context: SegmentPreviewContext,
) => PlacementPreviewBatch | null;

const SEGMENT_BATCH_BUILDERS = new Map<SupportTypeId, SegmentPreviewBatchBuilder>();

/** Called once per type from its own folder's registration module. */
export function registerSegmentPreviewBatchBuilder<P>(
    typeId: SupportTypeId,
    build: (id: string, preview: P, context: SegmentPreviewContext) => PlacementPreviewBatch | null,
): void {
    SEGMENT_BATCH_BUILDERS.set(typeId, build as SegmentPreviewBatchBuilder);
}

/** Segment-shaped types that registered no builder, so their preview draws nothing. */
export function segmentPreviewTypesMissingBuilder(): readonly SupportTypeId[] {
    return SUPPORT_TYPES
        .filter((descriptor) => descriptor.previewShape === 'segment')
        .filter((descriptor) => !SEGMENT_BATCH_BUILDERS.has(descriptor.id))
        .map((descriptor) => descriptor.id);
}

/** The preview batch for a segment-shaped type, or null when it registered none. */
export function buildSegmentPreviewBatch(
    typeId: SupportTypeId,
    id: string,
    preview: unknown,
    context: SegmentPreviewContext,
): PlacementPreviewBatch | null {
    const build = SEGMENT_BATCH_BUILDERS.get(typeId);
    if (!build) return null;
    return (build as unknown as (batchId: string, value: unknown, ctx: SegmentPreviewContext) => PlacementPreviewBatch | null)(id, preview, context);
}
