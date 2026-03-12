import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { kickstandPlacementStore, useKickstandPlacementState } from './kickstandPlacementState';

export function useKickstandPlacement() {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'KICKSTAND_PLACEMENT');
    const KICKSTAND_KEY = binding.key;
    const KICKSTAND_MODIFIER = binding.modifier;

    const { isGizmoActive } = useInteractionStatus();
    const state = useKickstandPlacementState();

    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, {
                key: KICKSTAND_KEY,
                modifier: KICKSTAND_MODIFIER,
            });

            if (matches) {
                e.preventDefault();
                kickstandPlacementStore.setHotkeyActive(true);
            }
        };

        const up = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyUp(e, {
                key: KICKSTAND_KEY,
                modifier: KICKSTAND_MODIFIER,
            });

            if (matches) {
                e.preventDefault();
                kickstandPlacementStore.setHotkeyActive(false);
            }
        };

        const blur = () => {
            kickstandPlacementStore.setHotkeyActive(false);
        };

        const pointerMove = (e: PointerEvent) => {
            const snapshot = kickstandPlacementStore.getSnapshot();
            if (snapshot.hotkeyActive && !e.ctrlKey) {
                kickstandPlacementStore.setHotkeyActive(false);
            }
        };

        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        document.addEventListener('keyup', up, true);
        window.addEventListener('blur', blur);
        window.addEventListener('pointermove', pointerMove, true);

        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            document.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', blur);
            window.removeEventListener('pointermove', pointerMove, true);
        };
    }, [KICKSTAND_KEY, KICKSTAND_MODIFIER]);

    useEffect(() => {
        if (isGizmoActive && state.hotkeyActive) {
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
