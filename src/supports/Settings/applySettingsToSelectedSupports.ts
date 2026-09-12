import { getSelectedSupportIds } from '@/supports/interaction/supportMultiSelection';
import {
    applySettingsToSupportTarget,
    beginSupportStateBatch,
    endSupportStateBatch,
    getSnapshot,
    resolveEditableSupportTarget,
    type EditableSupportTarget,
} from '@/supports/state';
import { EDITABLE_SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
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
            // A selected id may be an editable entity directly. The resolver
            // only takes that path when the snapshot's category matches, which
            // it cannot for every id in a multi-selection.
            const direct = EDITABLE_SUPPORT_TYPES.find(
                (descriptor) => (snapshot[descriptor.location.key] as Record<string, unknown>)[id],
            );
            const target: EditableSupportTarget | null = direct
                ? { kind: direct.id, id }
                : resolveEditableSupportTarget(id, snapshot.selectedCategory ?? undefined);
            if (target) {
                applySettingsToSupportTarget(target, settings);
            }
        }
    } finally {
        endSupportStateBatch();
    }
}
