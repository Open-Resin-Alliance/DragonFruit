import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_KEYBINDINGS } from '../../../hotkeys/hotkeyConfig';
import {
    hotkeyStore,
    isActionActiveSync,
} from '../../../hotkeys/hotkeyStore';
import { shouldRunAutoBracingHotkey } from '../autoBracingHotkey';

test('auto bracing runs only on the initial press while its expanded page is active', () => {
    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: 'stick',
        curvePageVisible: false,
        modalOpen: false,
    }), true);

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: true,
        sidebarExpanded: true,
        activeSupportKind: 'stick',
        curvePageVisible: false,
        modalOpen: false,
    }), false, 'key repeat must not rerun auto bracing');
});

test('auto bracing ignores presses outside its visible settings context', () => {
    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: false,
        activeSupportKind: 'stick',
        curvePageVisible: false,
        modalOpen: false,
    }), false, 'a collapsed Support Studio must not handle the shortcut');

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: 'trunk',
        curvePageVisible: false,
        modalOpen: false,
    }), false, 'another Support Studio page must not handle the shortcut');

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: 'stick',
        curvePageVisible: true,
        modalOpen: false,
    }), false, 'the curve page must not inherit the Bracing shortcut');

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: 'stick',
        curvePageVisible: false,
        modalOpen: true,
    }), false, 'a modal must suppress actions on the obscured Bracing page');
});

test('the Q shortcut preserves the existing Q bindings', () => {
    const originalState = hotkeyStore.getState();

    try {
        hotkeyStore.setState({
            activeKeys: new Set<string>(),
            config: DEFAULT_KEYBINDINGS,
        });
        hotkeyStore.getState().pressKey('q');

        assert.equal(isActionActiveSync('SUPPORTS', 'AUTO_BRACING'), true);
        assert.equal(isActionActiveSync('SUPPORTS', 'FORCE_PLACE_SUPPORT'), true);
        assert.equal(isActionActiveSync('CANVAS', 'TOOL_SELECT'), true);
    } finally {
        hotkeyStore.setState({
            activeKeys: originalState.activeKeys,
            config: originalState.config,
        });
    }
});
