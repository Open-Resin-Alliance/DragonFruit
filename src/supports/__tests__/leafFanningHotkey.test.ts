import assert from 'node:assert/strict';
import test from 'node:test';
import { leafPlacementStore } from '../SupportTypes/Leaf/leafPlacementState';

test('LeafPlacementStore hotkey active state transitions', () => {
    // Reset state first
    leafPlacementStore.reset();
    
    // Initial state: all inactive
    let snapshot = leafPlacementStore.getSnapshot();
    assert.equal(snapshot.sproutParentingLockHeld, false);
    assert.equal(snapshot.hotkeyActive, false);
    assert.equal(snapshot.stage, 'idle');
    assert.equal(leafPlacementStore.isActive(), false);

    // Test fanning hotkey hold 'w' makes isActive true (Passing test for fix)
    leafPlacementStore.setSproutParentingLockHeld(true);
    snapshot = leafPlacementStore.getSnapshot();
    assert.equal(snapshot.sproutParentingLockHeld, true);
    assert.equal(leafPlacementStore.isActive(), true);

    // Releasing 'w' makes isActive false again
    leafPlacementStore.setSproutParentingLockHeld(false);
    assert.equal(leafPlacementStore.isActive(), false);

    // Test other state combinations that should trigger isActive
    leafPlacementStore.setHotkeyActive(true);
    assert.equal(leafPlacementStore.isActive(), true);
    leafPlacementStore.setHotkeyActive(false);

    leafPlacementStore.setStage('awaitingBase');
    assert.equal(leafPlacementStore.isActive(), true);
    leafPlacementStore.setStage('idle');

    // Clean up
    leafPlacementStore.reset();
});

test('LeafPlacementStore expected failing test case without fix', () => {
    leafPlacementStore.reset();
    
    // Set sproutParentingLockHeld to true
    leafPlacementStore.setSproutParentingLockHeld(true);
    
    // Assert that isActive returns true when ONLY sproutParentingLockHeld is held.
    // If the fix is reverted or not present, this assertion would fail because isActive() would return false.
    const active = leafPlacementStore.isActive();
    
    assert.equal(active, true, 'isActive must be true when sproutParentingLockHeld is true');
    
    leafPlacementStore.reset();
});
