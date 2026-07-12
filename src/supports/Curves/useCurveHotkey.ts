import { useEffect, useRef } from 'react';
import { curveInteractionStore } from './curveInteractionState';
import { useActionActive } from '@/hotkeys/hotkeyStore';
import { getSnapshot, toggleSegmentCurve } from '../state';

export function useCurveHotkey(mode: string) {
    void mode;
    const curveActive = useActionActive('SUPPORTS', 'CURVE_MODE');
    const wasActiveRef = useRef(false);

    useEffect(() => {
        if (curveActive) {
            curveInteractionStore.setIsActive(true);
            wasActiveRef.current = true;
        } else {
            curveInteractionStore.setIsActive(false);
            if (wasActiveRef.current) {
                wasActiveRef.current = false;
                const state = getSnapshot();
                if (state.selectedCategory === 'segment' && state.selectedId) {
                    toggleSegmentCurve(state.selectedId);
                } else if (state.selectedId && state.braces[state.selectedId]) {
                    toggleSegmentCurve(`braceSegment:${state.selectedId}`);
                }
            }
        }
    }, [curveActive]);
}
