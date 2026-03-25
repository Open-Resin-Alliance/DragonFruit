import { selectSupportIds } from './selectionController';
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
    selectSupportIds(ids);
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
