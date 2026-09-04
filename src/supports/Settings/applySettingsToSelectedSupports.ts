import { getSelectedSupportIds } from '@/supports/interaction/supportMultiSelection';
import {
    applySettingsToSupportTarget,
    beginSupportStateBatch,
    endSupportStateBatch,
    getSnapshot,
    resolveEditableSupportTarget,
    type EditableSupportTarget,
} from '@/supports/state';
import type { SupportSettings } from './types';

export function applySettingsToSelectedSupports(settings: SupportSettings): void {
    const snapshot = getSnapshot();
    const selectedIds = getSelectedSupportIds();
    const idsToApply = selectedIds.length > 0
        ? selectedIds
        : (snapshot.selectedId ? [snapshot.selectedId] : []);

    if (idsToApply.length === 0) return;

    beginSupportStateBatch();
    try {
        for (const id of idsToApply) {
            let target: EditableSupportTarget | null = null;
            if (snapshot.trunks[id]) {
                target = { kind: 'trunk', id };
            } else if (snapshot.branches[id]) {
                target = { kind: 'branch', id };
            } else if (snapshot.leaves[id]) {
                target = { kind: 'leaf', id };
            } else {
                target = resolveEditableSupportTarget(id, snapshot.selectedCategory ?? undefined);
            }
            if (target) {
                applySettingsToSupportTarget(target, settings);
            }
        }
    } finally {
        endSupportStateBatch();
    }
}
