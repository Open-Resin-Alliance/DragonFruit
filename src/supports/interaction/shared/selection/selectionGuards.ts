import type { SelectionBlockedReason } from './selectionTypes';

export interface SelectionGuardInput {
    gizmoActive: boolean;
    placementActive: boolean;
    marqueeActive: boolean;
}

export function resolveSelectionBlockedReason(input: SelectionGuardInput): SelectionBlockedReason | null {
    if (input.gizmoActive) return 'gizmo-active';
    if (input.placementActive) return 'placement-active';
    if (input.marqueeActive) return 'marquee-active';
    return null;
}
