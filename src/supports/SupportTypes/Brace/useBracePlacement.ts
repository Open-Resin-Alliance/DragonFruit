import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { bracePlacementStore, useBracePlacementState } from './bracePlacementState';
import { useActionActive } from '@/hotkeys/hotkeyStore';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';

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

    useEscapeToClose(state.stage === 'awaitingEnd', () => bracePlacementStore.reset());

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
