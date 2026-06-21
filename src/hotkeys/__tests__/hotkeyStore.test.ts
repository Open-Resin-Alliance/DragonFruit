import assert from 'node:assert/strict';
import test from 'node:test';
import { hotkeyStore, isKeyPressedSync } from '../hotkeyStore';

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
