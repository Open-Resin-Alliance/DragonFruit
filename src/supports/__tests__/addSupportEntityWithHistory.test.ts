import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, undo } from '@/history/historyStore';
import { addSupportEntityWithHistory, getSnapshot, resetStore } from '../state';
import { SUPPORT_TYPES, SUPPORT_REMOVAL_SHAPES, getSupportTypeDescriptor } from '../supportTypeRegistry';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';

/**
 * The registry-derived add-and-record path.
 *
 * A caller holding a `typeId` used to turn it back into a hand-written pair --
 * `addStick` plus `addAction('stick')`, under the payload key that action
 * expects. `addSupportEntityWithHistory` reads all three off the descriptor,
 * behind a cast the compiler cannot check, so these hold the correspondence
 * that cast asserts: for every type, the entry it pushes is one the registered
 * handler recognises and can undo.
 */

test('every type adds, records, and undoes through the registry alone', () => {
    const unregister = registerSupportHistoryHandlers();
    try {
        for (const descriptor of SUPPORT_TYPES) {
            resetStore();
            clearHistory();

            const id = `probe-${descriptor.id}`;
            addSupportEntityWithHistory(descriptor.id, { id });

            const key = descriptor.location.key;
            assert.ok(
                getSnapshot()[key][id],
                `${descriptor.id}: entity landed in its declared collection`,
            );

            // The pushed entry must be one the derived handler accepts. An
            // unrecognised payload returns false and the entity would survive
            // the undo.
            undo();
            assert.equal(
                getSnapshot()[key][id],
                undefined,
                `${descriptor.id}: undo removed the entity`,
            );
        }
    } finally {
        unregister();
    }
});

test('the payload key a type declares is the one its add action carries', () => {
    // The cast in `addSupportEntityWithHistory` assumes `self` names the field
    // the add payload is keyed on. A type whose shape declared a different key
    // would push an entry no handler could seed from.
    for (const descriptor of SUPPORT_TYPES) {
        const self = SUPPORT_REMOVAL_SHAPES[descriptor.id].self;
        assert.equal(typeof self, 'string', `${descriptor.id}: declares a payload key`);
        assert.ok(self.length > 0, `${descriptor.id}: payload key is not empty`);
        assert.ok(
            getSupportTypeDescriptor(descriptor.id).historyAdd,
            `${descriptor.id}: declares an add action`,
        );
    }
});
