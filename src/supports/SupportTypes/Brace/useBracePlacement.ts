import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { bracePlacementStore, useBracePlacementState } from './bracePlacementState';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';

export function useBracePlacement() {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'BRANCH_PLACEMENT');

    const { isPlacementDisabled } = useInteractionStatus();
    const state = useBracePlacementState();

    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, binding);
            if (matches) {
                e.preventDefault();
                bracePlacementStore.setAltActive(true);
            }
        };
        const up = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyUp(e, binding);
            if (matches) {
                e.preventDefault();
                bracePlacementStore.setAltActive(false);
                bracePlacementStore.reset();
            }
        };

        const blur = () => {
            // Losing focus can prevent keyup from firing. Treat it as a cancel.
            bracePlacementStore.setAltActive(false);
            bracePlacementStore.reset();
        };

        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', blur);
        };
    }, [binding]);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && state.stage === 'awaitingEnd') {
                bracePlacementStore.reset();
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
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
