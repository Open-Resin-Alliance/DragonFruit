import assert from 'node:assert/strict';
import test from 'node:test';
import { hotkeyStore, isKeyPressedSync, isActionActiveSync } from '../hotkeyStore';

test('Store key tracking failing test', () => {
    hotkeyStore.getState().clearKeys();
    
    // Simulate press
    hotkeyStore.getState().pressKey('w');
    
    // Assert check fails if store not updated
    assert.equal(isKeyPressedSync('w'), true, 'Key w must be pressed');
});

test('Store key tracking passing test', () => {
    hotkeyStore.getState().clearKeys();
    assert.equal(isKeyPressedSync('w'), false);
    
    hotkeyStore.getState().pressKey('w');
    assert.equal(isKeyPressedSync('w'), true);
    
    hotkeyStore.getState().releaseKey('w');
    assert.equal(isKeyPressedSync('w'), false);
});

test('Overlap resolution: Ctrl+Alt leaf activates and Alt branch suppresses', () => {
    hotkeyStore.getState().clearKeys();
    
    // 1. Press Alt only
    hotkeyStore.getState().pressKey('Alt');
    
    assert.equal(isActionActiveSync('SUPPORTS', 'BRANCH_PLACEMENT'), true, 'Alt press should activate BRANCH_PLACEMENT');
    assert.equal(isActionActiveSync('SUPPORTS', 'LEAF_PLACEMENT'), false, 'Alt press should not activate LEAF_PLACEMENT');
    
    // 2. Press Alt and Control (Ctrl+Alt)
    hotkeyStore.getState().pressKey('Control');
    
    assert.equal(isActionActiveSync('SUPPORTS', 'LEAF_PLACEMENT'), true, 'Ctrl+Alt press should activate LEAF_PLACEMENT');
    assert.equal(isActionActiveSync('SUPPORTS', 'BRANCH_PLACEMENT'), false, 'Ctrl+Alt press should suppress BRANCH_PLACEMENT');
});

