import assert from 'node:assert/strict';
import test from 'node:test';
import { getSupportPlacementModifierState } from '../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';

test('getSupportPlacementModifierState modifier resolution', () => {
    // 1. Candidate is not an object or null
    assert.deepEqual(getSupportPlacementModifierState(null), {
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
    });

    // 2. Candidate has undefined modifiers but nativeEvent has modifiers
    const res1 = getSupportPlacementModifierState({
        nativeEvent: {
            ctrlKey: true,
            altKey: false,
            shiftKey: true,
            metaKey: false,
        }
    });
    assert.deepEqual(res1, {
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
    });

    // 3. Candidate has false modifiers and nativeEvent has true modifiers (Regression test case)
    const res2 = getSupportPlacementModifierState({
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        nativeEvent: {
            ctrlKey: true,
            altKey: false,
            shiftKey: true,
            metaKey: false,
        }
    });
    assert.deepEqual(res2, {
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
    });

    // 4. Candidate has true modifiers and nativeEvent has false modifiers
    const res3 = getSupportPlacementModifierState({
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
        nativeEvent: {
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            metaKey: false,
        }
    });
    assert.deepEqual(res3, {
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
    });
});
