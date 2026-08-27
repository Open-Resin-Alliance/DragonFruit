import { selectSupportIds } from './selectionController';
import { getSelectedSupportIds } from '@/supports/interaction/supportMultiSelection';
import {
    setMarqueeSelectionActive,
    setMarqueeSelectionCandidateIds,
} from './resolvedSelectionStore';

export function beginSupportMarqueeSelection() {
    setMarqueeSelectionActive(true);
    setMarqueeSelectionCandidateIds([]);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('support-marquee-selection-active', {
            detail: { active: true },
        }));
    }
}

export function updateSupportMarqueeCandidates(ids: string[]) {
    setMarqueeSelectionCandidateIds(ids);
}

export function commitSupportMarqueeSelection(ids: string[]) {
    // A marquee only ever adds, as CAD applications do: a drag that catches
    // nothing leaves the selection alone rather than clearing it.
    if (ids.length === 0) {
        endSupportMarqueeSelection();
        return;
    }

    const merged = Array.from(new Set([...getSelectedSupportIds(), ...ids]));
    selectSupportIds(merged);
    setMarqueeSelectionCandidateIds(ids);
    endSupportMarqueeSelection();
}

export function endSupportMarqueeSelection() {
    setMarqueeSelectionActive(false);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('support-marquee-selection-end'));
    }
}

export function clearSupportMarqueeSelection() {
    setMarqueeSelectionCandidateIds([]);
    endSupportMarqueeSelection();
}
