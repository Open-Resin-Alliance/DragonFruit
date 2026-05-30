import { useEffect } from 'react';
import { curveInteractionStore } from './curveInteractionState';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { getSnapshot, toggleSegmentCurve } from '../state';

export function useCurveHotkey(mode: string) {
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'CURVE_MODE');
    useEffect(() => {
        if (mode !== 'support' && mode !== 'supportPainter') return;

        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

            const matchesKey = e.key.toLowerCase() === binding.key.toLowerCase();
            const matchesModifier = mode === 'supportPainter' ? e.shiftKey : !e.shiftKey;

            if (matchesKey && matchesModifier && !e.repeat) {
                curveInteractionStore.setIsActive(true);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === binding.key.toLowerCase()) {
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
    }, [mode, binding]);
}
