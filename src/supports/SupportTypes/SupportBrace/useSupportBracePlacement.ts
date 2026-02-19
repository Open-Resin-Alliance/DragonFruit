import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { supportBracePlacementStore, useSupportBracePlacementState } from './supportBracePlacementState';

export function useSupportBracePlacement() {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'SUPPORT_BRACE_PLACEMENT');
    const SUPPORT_BRACE_KEY = binding.key;
    const SUPPORT_BRACE_MODIFIER = binding.modifier;

    const { isGizmoActive } = useInteractionStatus();
    const state = useSupportBracePlacementState();

    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, {
                key: SUPPORT_BRACE_KEY,
                modifier: SUPPORT_BRACE_MODIFIER,
            });

            if (matches) {
                e.preventDefault();
                supportBracePlacementStore.setHotkeyActive(true);
            }
        };

        const up = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyUp(e, {
                key: SUPPORT_BRACE_KEY,
                modifier: SUPPORT_BRACE_MODIFIER,
            });

            if (matches) {
                e.preventDefault();
                supportBracePlacementStore.setHotkeyActive(false);
            }
        };

        const blur = () => {
            supportBracePlacementStore.setHotkeyActive(false);
        };

        const pointerMove = (e: PointerEvent) => {
            const snapshot = supportBracePlacementStore.getSnapshot();
            if (snapshot.hotkeyActive && !e.ctrlKey) {
                supportBracePlacementStore.setHotkeyActive(false);
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
    }, [SUPPORT_BRACE_KEY, SUPPORT_BRACE_MODIFIER]);

    useEffect(() => {
        if (isGizmoActive && state.hotkeyActive) {
            supportBracePlacementStore.setHotkeyActive(false);
        }
    }, [isGizmoActive, state.hotkeyActive]);

    return {
        hotkeyActive: state.hotkeyActive,
        isActive: state.isActive,
        previewData: state.previewData,
        snapTarget: state.snapTarget,
    };
}
