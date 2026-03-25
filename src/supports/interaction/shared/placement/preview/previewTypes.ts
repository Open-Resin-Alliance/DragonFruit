import type { Vec3 } from '@/supports/types';
import type { BracePreviewData } from '@/supports/SupportTypes/Brace/bracePlacementState';
import type { SupportData } from '@/supports/rendering/SupportBuilder';

export type PlacementPreviewMode =
    | 'hidden'
    | 'hoverDot'
    | 'tipMarker'
    | 'snappedPreview'
    | 'freePreview';

export interface ResolvedPlacementPreview {
    mode: PlacementPreviewMode;
    hoverDotPosition: Vec3 | null;
    tipPosition: Vec3 | null;
    supportPreviewData: SupportData | null;
    bracePreviewData: BracePreviewData | null;
}

export const EMPTY_RESOLVED_PLACEMENT_PREVIEW: ResolvedPlacementPreview = {
    mode: 'hidden',
    hoverDotPosition: null,
    tipPosition: null,
    supportPreviewData: null,
    bracePreviewData: null,
};
