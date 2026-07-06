import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { bracePlacementStore, useBracePlacementState } from './bracePlacementState';
import { useActionActive } from '@/hotkeys/hotkeyStore';

export function useBracePlacement() {
    const { isPlacementDisabled } = useInteractionStatus();
    const state = useBracePlacementState();

    const braceHotkeyActive = useActionActive('SUPPORTS', 'BRANCH_PLACEMENT');
    useEffect(() => {
        bracePlacementStore.setAltActive(braceHotkeyActive);
        if (!braceHotkeyActive) {
            bracePlacementStore.reset();
        }
    }, [braceHotkeyActive]);

    useEffect(() => {
        const handleEscape = (e: CustomEvent) => {
            if (e.detail.key === 'Escape' && state.stage === 'awaitingEnd') {
                bracePlacementStore.reset();
            }
        };
        window.addEventListener('app-hotkey-keydown', handleEscape as EventListener);
        return () => window.removeEventListener('app-hotkey-keydown', handleEscape as EventListener);
    }, [state.stage]);

    useEffect(() => {
        if (isPlacementDisabled && state.stage === 'idle') {
            bracePlacementStore.reset();
        }
    }, [isPlacementDisabled, state.stage]);

    return {
        altActive: state.altActive,
        isActive: state.isActive,
        stage: state.stage,
        preview: state.preview,
    };
}
