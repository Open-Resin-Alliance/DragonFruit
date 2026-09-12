import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSupportPlacementRouting, routeModelPlacementHit } from '../interaction/shared/placement/hotkeys/supportPlacementRouting';
import { MODEL_SURFACE_GESTURE_BY_TYPE, MODEL_SURFACE_GESTURE_TYPES, SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportPlacementHotkeyBindings, SupportPlacementModifierState, SupportPlacementRoutingState } from '../interaction/shared/placement/hotkeys/supportPlacementHotkeyTypes';

const defaultBindings: SupportPlacementHotkeyBindings = {
    branchFamily: { key: 'Alt', description: '' },
    leaf: { key: 'Alt', modifier: 'ctrl', description: '' },
    kickstand: { key: 'Control', description: '' }
};

const defaultModifierState: SupportPlacementModifierState = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false
};

const defaultRoutingState: SupportPlacementRoutingState = {
    branchHotkeyActive: false,
    braceHotkeyActive: false,
    leafHotkeyActive: false,
    kickstandHotkeyActive: false,
    braceAwaitingEnd: false,
    leafAwaitingBase: false,
    branchAwaitingBase: false
};

test('resolveSupportPlacementRouting behaviour', () => {
    // 1. Idle state
    const resIdle = resolveSupportPlacementRouting({
        bindings: defaultBindings,
        modifierState: defaultModifierState,
        state: defaultRoutingState
    });
    assert.equal(resIdle.blocksDefaultModelPlacement, false);
    assert.equal(resIdle.blocksDefaultSupportPlacement, false);
    assert.equal(resIdle.owner, 'none');

    // 2. Leaf active via hotkey
    const resLeafHotkey = resolveSupportPlacementRouting({
        bindings: defaultBindings,
        modifierState: defaultModifierState,
        state: { ...defaultRoutingState, leafHotkeyActive: true }
    });
    assert.equal(resLeafHotkey.blocksDefaultModelPlacement, true);
    assert.equal(resLeafHotkey.blocksDefaultSupportPlacement, true);
    assert.equal(resLeafHotkey.owner, 'leaf');

    // 3. Kickstand active via Ctrl key modifier
    const resKickstand = resolveSupportPlacementRouting({
        bindings: defaultBindings,
        modifierState: { ...defaultModifierState, ctrlKey: true },
        state: defaultRoutingState
    });
    assert.equal(resKickstand.blocksDefaultModelPlacement, true);
    assert.equal(resKickstand.blocksDefaultSupportPlacement, true);
    assert.equal(resKickstand.owner, 'kickstand');
    assert.equal(resKickstand.supportClickOwner, 'kickstand');
});


test('the derived owner list covers exactly the flagged types', () => {
    assert.deepEqual(
        [...MODEL_SURFACE_GESTURE_TYPES].sort(),
        SUPPORT_TYPES.filter((d) => d.claimsModelSurfaceGestures).map((d) => d.id).sort(),
    );
});
