import type { Vec3 } from '@/supports/types';
import type { BracePreviewData } from '@/supports/SupportTypes/Brace/bracePlacementState';
import type { SupportData } from '@/supports/rendering/SupportBuilder';
import type { ResolvedPlacementPreview } from './previewTypes';
import { EMPTY_RESOLVED_PLACEMENT_PREVIEW } from './previewTypes';

export interface PlacementPreviewResolverInput {
    visible: boolean;
    tipPosition?: Vec3 | null;
    hoverDotPosition?: Vec3 | null;
    supportPreviewData?: SupportData | null;
    bracePreviewData?: BracePreviewData | null;
    snapped: boolean;
}

export function resolvePlacementPreview(input: PlacementPreviewResolverInput): ResolvedPlacementPreview {
    if (!input.visible) {
        return EMPTY_RESOLVED_PLACEMENT_PREVIEW;
    }

    if (input.supportPreviewData || input.bracePreviewData) {
        return {
            mode: input.snapped ? 'snappedPreview' : 'freePreview',
            tipPosition: input.tipPosition ?? null,
            hoverDotPosition: input.hoverDotPosition ?? null,
            supportPreviewData: input.supportPreviewData ?? null,
            bracePreviewData: input.bracePreviewData ?? null,
        };
    }

    if (input.tipPosition) {
        return {
            ...EMPTY_RESOLVED_PLACEMENT_PREVIEW,
            mode: 'tipMarker',
            tipPosition: input.tipPosition,
        };
    }

    if (input.hoverDotPosition) {
        return {
            ...EMPTY_RESOLVED_PLACEMENT_PREVIEW,
            mode: 'hoverDot',
            hoverDotPosition: input.hoverDotPosition,
        };
    }

    return EMPTY_RESOLVED_PLACEMENT_PREVIEW;
}
