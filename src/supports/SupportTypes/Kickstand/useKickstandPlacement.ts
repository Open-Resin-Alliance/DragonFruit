import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { kickstandPlacementStore, useKickstandPlacementState } from './kickstandPlacementState';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { useActionActive } from '@/hotkeys/hotkeyStore';

export function useKickstandPlacement() {
    const { isGizmoActive } = useInteractionStatus();
    const state = useKickstandPlacementState();
    const hotkeyActive = useActionActive('SUPPORTS', 'KICKSTAND_PLACEMENT');

    useEffect(() => {
        if (hotkeyActive) {
            // Kickstand placement should be usable immediately even if a joint
            // was selected from prior editing. Clear selection to avoid preview suppression.
            clearSupportSelection();
        }
        kickstandPlacementStore.setHotkeyActive(hotkeyActive);
    }, [hotkeyActive]);

    useEffect(() => {
        if (!state.hotkeyActive) return;
        if (typeof window === 'undefined') return;

        const w = window as any;
        const gizmoDragging = !!w.__jointGizmoDragging || !!w.__knotGizmoDragging || !!w.__bezierGizmoDragging;

        // Only cancel kickstand placement when a gizmo is actively being dragged,
        // not merely because a joint is selected.
        if (gizmoDragging) {
            kickstandPlacementStore.setHotkeyActive(false);
        }
    }, [isGizmoActive, state.hotkeyActive]);

    return {
        hotkeyActive: state.hotkeyActive,
        isActive: state.isActive,
        previewData: state.previewData,
        snapTarget: state.snapTarget,
    };
}
