import assert from 'node:assert/strict';
import test from 'node:test';
import { stripStaleActions } from '../HotkeyContext';
import type { HotkeyConfig } from '../hotkeyConfig';

const defaults = {
    CANVAS: {
        TOOL_MODIFY: { key: 'm', description: 'Switch canvas tool to Transform' },
        TOOL_ARRANGE: { key: 'a', description: 'Switch canvas tool to Duplicate' },
    },
} satisfies HotkeyConfig;

test('A stored binding keeps the user key and takes the current description', () => {
    // Regression: descriptions were merged in verbatim from localStorage, so a
    // renamed tool kept its old name in Settings → Hotkeys on every profile that
    // had ever stored a config, while the tool rail showed the new one.
    const cleaned = stripStaleActions(defaults, {
        CANVAS: {
            TOOL_MODIFY: { key: 't', description: 'Switch canvas tool to Modify' },
        },
    });
    assert.equal(cleaned.CANVAS.TOOL_MODIFY.key, 't', 'a rebound key survives');
    assert.equal(
        cleaned.CANVAS.TOOL_MODIFY.description,
        'Switch canvas tool to Transform',
        'the description comes from the defaults, not from the stored copy',
    );
});

test('Stale actions and categories are dropped', () => {
    const cleaned = stripStaleActions(defaults, {
        CANVAS: {
            TOOL_MODIFY: { key: 'm', description: 'Switch canvas tool to Transform' },
            GONE: { key: 'g', description: 'Retired action' },
        },
        RETIRED_CATEGORY: { WHATEVER: { key: 'w', description: 'Retired category' } },
    });
    assert.deepEqual(Object.keys(cleaned), ['CANVAS'], 'a category with no defaults is dropped');
    assert.deepEqual(Object.keys(cleaned.CANVAS), ['TOOL_MODIFY'], 'an action with no defaults is dropped');
});

test('A stored value with nothing usable leaves the default binding in charge', () => {
    const cleaned = stripStaleActions(defaults, { CANVAS: { TOOL_MODIFY: 'm' } });
    assert.equal(
        cleaned.CANVAS.TOOL_MODIFY.key,
        undefined,
        'a malformed binding contributes no key, so the default key survives the merge',
    );

    assert.deepEqual(stripStaleActions(defaults, undefined), {}, 'an absent config yields nothing to merge');
});
