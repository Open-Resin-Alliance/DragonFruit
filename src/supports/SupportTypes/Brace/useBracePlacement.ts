import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { bracePlacementStore, useBracePlacementState } from './bracePlacementState';
import { DEFAULT_KEYBINDINGS, matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';

const BRACE_KEY = DEFAULT_KEYBINDINGS.SUPPORTS.BRANCH_PLACEMENT.key;

export function useBracePlacement() {
    const { isPlacementDisabled } = useInteractionStatus();
    const state = useBracePlacementState();

    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, { key: BRACE_KEY }) || e.key === BRACE_KEY;
            if (matches) {
                e.preventDefault();
                bracePlacementStore.setAltActive(true);
            }
        };
        const up = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyUp(e, { key: BRACE_KEY }) || e.key === BRACE_KEY;
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
    }, []);

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
