import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_KEYBINDINGS } from '../../../hotkeys/hotkeyConfig';
import {
    hotkeyStore,
    isActionActiveSync,
} from '../../../hotkeys/hotkeyStore';
import { getSupportTypeDescriptor, SIDEBAR_PANEL_TYPE_IDS } from '../../supportTypeRegistry';
import type { SidebarPanel } from '../../Settings/sidebarPanels';
import { shouldRunAutoBracingHotkey } from '../autoBracingHotkey';

/**
 * The page the bracing hotkey belongs to: the first sidebar panel whose type
 * declares the flag, asked of the registry rather than spelled out, so renaming
 * that type stays a registry-only edit.
 */
const BRACING_PANEL: SidebarPanel = (() => {
    const panel = SIDEBAR_PANEL_TYPE_IDS.find(
        (typeId) => getSupportTypeDescriptor(typeId).hasAutoBracingHotkey,
    );
    assert.ok(panel, 'a sidebar panel type must declare hasAutoBracingHotkey');
    return panel;
})();

/** Another page the sidebar offers, one that declares no bracing hotkey. */
const OTHER_PANEL: SidebarPanel = (() => {
    const panel = SIDEBAR_PANEL_TYPE_IDS.find(
        (typeId) => !getSupportTypeDescriptor(typeId).hasAutoBracingHotkey,
    );
    assert.ok(panel, 'a sidebar panel type must not declare hasAutoBracingHotkey');
    return panel;
})();

test('auto bracing runs only on the initial press while its expanded page is active', () => {
    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: BRACING_PANEL,
        curvePageVisible: false,
        modalOpen: false,
    }), true);

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: true,
        sidebarExpanded: true,
        activeSupportKind: BRACING_PANEL,
        curvePageVisible: false,
        modalOpen: false,
    }), false, 'key repeat must not rerun auto bracing');
});

test('auto bracing ignores presses outside its visible settings context', () => {
    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: false,
        activeSupportKind: BRACING_PANEL,
        curvePageVisible: false,
        modalOpen: false,
    }), false, 'a collapsed Support Studio must not handle the shortcut');

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: OTHER_PANEL,
        curvePageVisible: false,
        modalOpen: false,
    }), false, 'another Support Studio page must not handle the shortcut');

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: BRACING_PANEL,
        curvePageVisible: true,
        modalOpen: false,
    }), false, 'the curve page must not inherit the Bracing shortcut');

    assert.equal(shouldRunAutoBracingHotkey({
        active: true,
        wasActive: false,
        sidebarExpanded: true,
        activeSupportKind: BRACING_PANEL,
        curvePageVisible: false,
        modalOpen: true,
    }), false, 'a modal must suppress actions on the obscured Bracing page');
});

test('G activates auto bracing without taking over the existing B or Q bindings', () => {
    const originalState = hotkeyStore.getState();

    try {
        hotkeyStore.setState({
            activeKeys: new Set<string>(),
            config: DEFAULT_KEYBINDINGS,
        });
        hotkeyStore.getState().pressKey('g');

        assert.equal(isActionActiveSync('SUPPORTS', 'AUTO_BRACING'), true);
        assert.equal(isActionActiveSync('SUPPORTS', 'FORCE_PLACE_SUPPORT'), false);
        assert.equal(isActionActiveSync('CANVAS', 'TOOL_SELECT'), false);

        hotkeyStore.getState().releaseKey('g');
        hotkeyStore.getState().pressKey('b');

        assert.equal(isActionActiveSync('SUPPORTS', 'AUTO_BRACING'), false);
        assert.equal(isActionActiveSync('SUPPORTS', 'FORCE_PLACE_SUPPORT'), false);
        assert.equal(isActionActiveSync('CANVAS', 'TOOL_SELECT'), false);

        hotkeyStore.getState().releaseKey('b');
        hotkeyStore.getState().pressKey('q');

        assert.equal(isActionActiveSync('SUPPORTS', 'AUTO_BRACING'), false);
        assert.equal(isActionActiveSync('SUPPORTS', 'FORCE_PLACE_SUPPORT'), true);
        assert.equal(isActionActiveSync('CANVAS', 'TOOL_SELECT'), true);
    } finally {
        hotkeyStore.setState({
            activeKeys: originalState.activeKeys,
            config: originalState.config,
        });
    }
});
