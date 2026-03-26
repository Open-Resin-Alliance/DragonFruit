import type {
    HoverSuppressionReason,
    HoverSource,
} from './hoverTypes';

export interface HoverSuppressionInput {
    activeSource: HoverSource;
    isGizmoActive: boolean;
    orbitActive: boolean;
    marqueeActive: boolean;
    interactionDisabled: boolean;
}

export function resolveHoverSuppressionReason(input: HoverSuppressionInput): HoverSuppressionReason | null {
    if (input.isGizmoActive) return 'gizmo-active';
    if (input.interactionDisabled) return 'interaction-disabled';
    if (input.orbitActive) return 'orbit-active';
    if (input.marqueeActive) return 'marquee-active';
    return null;
}
