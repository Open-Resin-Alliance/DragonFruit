import { useEffect } from 'react';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { kickstandPlacementStore, useKickstandPlacementState } from './kickstandPlacementState';
import { canResolveSupportPlacementBindingFromModifierState, getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';

export function useKickstandPlacement() {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'KICKSTAND_PLACEMENT');

    const { isGizmoActive } = useInteractionStatus();
    const state = useKickstandPlacementState();

    useEffect(() => {
        const modifierResolvable = canResolveSupportPlacementBindingFromModifierState(binding);

        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, binding);

            if (matches) {
                e.preventDefault();
                kickstandPlacementStore.setHotkeyActive(true);
            }
        };

        const up = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyUp(e, binding);

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
            const bindingHeld = isSupportPlacementBindingSatisfiedByModifierState(binding, getSupportPlacementModifierState(e));
            if (modifierResolvable && snapshot.hotkeyActive && !bindingHeld) {
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
    }, [binding]);

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
