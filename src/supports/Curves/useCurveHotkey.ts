import { useEffect } from 'react';
import { curveInteractionStore } from './curveInteractionState';
import { DEFAULT_KEYBINDINGS } from '@/hotkeys/hotkeyConfig';
import { getSnapshot, toggleSegmentCurve } from '../state';

export function useCurveHotkey(mode: string) {
    useEffect(() => {
        // Only enable in support mode? Or globally?
        // Presumably support mode.
        // if (mode !== 'support') return; // Uncomment if restricted to support mode

        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

            if (e.key.toLowerCase() === DEFAULT_KEYBINDINGS.SUPPORTS.CURVE_MODE.key && !e.repeat) {
                curveInteractionStore.setIsActive(true);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === DEFAULT_KEYBINDINGS.SUPPORTS.CURVE_MODE.key) {
                curveInteractionStore.setIsActive(false);

                // Toggle Selected Segment on release
                const state = getSnapshot();
                if (state.selectedCategory === 'segment' && state.selectedId) {
                    toggleSegmentCurve(state.selectedId);
                } else if (state.selectedId && state.braces[state.selectedId]) {
                    toggleSegmentCurve(`braceSegment:${state.selectedId}`);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            curveInteractionStore.setIsActive(false);
        };
    }, [mode]);
}
