import assert from 'node:assert/strict';
import test from 'node:test';
import { hotkeyStore, isKeyPressedSync, isActionActiveSync } from '../hotkeyStore';
import { setupHotkeyListeners } from '../HotkeyRegistryManager';

// Mock global window and HTMLElement if running in Node.js without DOM
const listeners = new Map<string, Set<Function>>();
if (typeof global.window === 'undefined') {
    (global as any).window = {
        addEventListener(event: string, callback: Function) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event)!.add(callback);
        },
        removeEventListener(event: string, callback: Function) {
            listeners.get(event)?.delete(callback);
        },
        dispatchEvent(event: any) {
            const type = event.type || event;
            const detail = event.detail || {};
            listeners.get(type)?.forEach(cb => cb({ type, detail }));
            return true;
        }
    };
    (global as any).CustomEvent = class {
        type: string;
        detail: any;
        constructor(type: string, options?: any) {
            this.type = type;
            this.detail = options?.detail;
        }
    };
    (global as any).HTMLElement = class {
        tagName: string;
        isContentEditable: boolean;
        constructor(tagName: string, isContentEditable: boolean = false) {
            this.tagName = tagName;
            this.isContentEditable = isContentEditable;
        }
        closest() {
            return null;
        }
    };
}

function dispatchWindowEvent(event: string, detail: any) {
    listeners.get(event)?.forEach(cb => cb(detail));
}

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

test('Hotkey Registry: ignores keys when typing in input or textarea', () => {
    hotkeyStore.getState().clearKeys();
    const cleanup = setupHotkeyListeners();
    
    // Create targets
    const inputTarget = new (global as any).HTMLElement('INPUT');
    const textareaTarget = new (global as any).HTMLElement('TEXTAREA');
    const divTarget = new (global as any).HTMLElement('DIV');

    // Keydown on input target
    dispatchWindowEvent('keydown', { key: 'a', target: inputTarget });
    assert.equal(isKeyPressedSync('a'), false, 'Keypress on input should be ignored');

    // Keydown on textarea target
    dispatchWindowEvent('keydown', { key: 'b', target: textareaTarget });
    assert.equal(isKeyPressedSync('b'), false, 'Keypress on textarea should be ignored');

    // Keydown on regular div target
    dispatchWindowEvent('keydown', { key: 'c', target: divTarget });
    assert.equal(isKeyPressedSync('c'), true, 'Keypress on div should not be ignored');

    cleanup();
});

test('Hotkey Registry: clears all active keys on window blur', () => {
    hotkeyStore.getState().clearKeys();
    const cleanup = setupHotkeyListeners();

    const divTarget = new (global as any).HTMLElement('DIV');

    // Press keys
    dispatchWindowEvent('keydown', { key: 'w', target: divTarget });
    dispatchWindowEvent('keydown', { key: 'Shift', target: divTarget });
    assert.equal(isKeyPressedSync('w'), true);
    assert.equal(isKeyPressedSync('Shift'), true);

    // Trigger blur
    dispatchWindowEvent('blur', {});
    
    // Expect store to be cleared
    assert.equal(isKeyPressedSync('w'), false, 'Keys should be cleared on blur');
    assert.equal(isKeyPressedSync('Shift'), false, 'Keys should be cleared on blur');

    cleanup();
});

test('Pointer/mouse events interception in placement modes on canvas', () => {
    hotkeyStore.getState().clearKeys();
    const cleanup = setupHotkeyListeners();

    const canvasTarget = new (global as any).HTMLElement('CANVAS');
    const buttonTarget = new (global as any).HTMLElement('BUTTON');

    // 1. When no placement mode is active, canvas click should not be swallowed
    let pointerEvent = { target: canvasTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('pointerdown', pointerEvent);
    assert.equal(pointerEvent.stopPropagationCalled, false, 'Should not swallow canvas pointerdown if no placement mode active');

    // 2. Activate LEAF_PLACEMENT (requires Ctrl+Alt)
    hotkeyStore.getState().pressKey('Control');
    hotkeyStore.getState().pressKey('Alt');
    assert.equal(isActionActiveSync('SUPPORTS', 'LEAF_PLACEMENT'), true);

    // Canvas click should NOT be swallowed
    pointerEvent = { target: canvasTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('pointerdown', pointerEvent);
    assert.equal(pointerEvent.stopPropagationCalled, false, 'Should not swallow canvas pointerdown in LEAF_PLACEMENT');

    let mouseEvent = { target: canvasTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('mousedown', mouseEvent);
    assert.equal(mouseEvent.stopPropagationCalled, false, 'Should not swallow canvas mousedown in LEAF_PLACEMENT');

    // Button click should NOT be swallowed
    let buttonPointerEvent = { target: buttonTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('pointerdown', buttonPointerEvent);
    assert.equal(buttonPointerEvent.stopPropagationCalled, false, 'Should not swallow button pointerdown in LEAF_PLACEMENT');

    // 3. Clear keys and activate BRANCH_PLACEMENT (requires Alt only)
    hotkeyStore.getState().clearKeys();
    hotkeyStore.getState().pressKey('Alt');
    assert.equal(isActionActiveSync('SUPPORTS', 'BRANCH_PLACEMENT'), true);

    pointerEvent = { target: canvasTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('pointerdown', pointerEvent);
    assert.equal(pointerEvent.stopPropagationCalled, false, 'Should not swallow canvas pointerdown in BRANCH_PLACEMENT');

    // 4. Clear keys and activate KICKSTAND_PLACEMENT (requires Control only)
    hotkeyStore.getState().clearKeys();
    hotkeyStore.getState().pressKey('Control');
    assert.equal(isActionActiveSync('SUPPORTS', 'KICKSTAND_PLACEMENT'), true);

    pointerEvent = { target: canvasTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('pointerdown', pointerEvent);
    assert.equal(pointerEvent.stopPropagationCalled, false, 'Should not swallow canvas pointerdown in KICKSTAND_PLACEMENT');

    // 5. Clear keys and activate SPROUTED_PARENTING_LOCK (requires w only)
    hotkeyStore.getState().clearKeys();
    hotkeyStore.getState().pressKey('w');
    assert.equal(isActionActiveSync('SUPPORTS', 'SPROUTED_PARENTING_LOCK'), true);

    pointerEvent = { target: canvasTarget, stopPropagationCalled: false, stopPropagation() { this.stopPropagationCalled = true; } };
    dispatchWindowEvent('pointerdown', pointerEvent);
    assert.equal(pointerEvent.stopPropagationCalled, false, 'Should not swallow canvas pointerdown in SPROUTED_PARENTING_LOCK');

    cleanup();
});

test('Newly migrated configurations: GLOBAL, DEBUG, MESH, NAVIGATION, PRESETS, HOLE_PUNCH', () => {
    hotkeyStore.getState().clearKeys();

    // 1. GLOBAL.SAVE (Ctrl+S)
    hotkeyStore.getState().pressKey('Control');
    hotkeyStore.getState().pressKey('s');
    assert.equal(isActionActiveSync('GLOBAL', 'SAVE'), true);
    hotkeyStore.getState().clearKeys();

    // 2. DEBUG hotkeys (Ctrl+Shift+D/C/X/A/N/M/K)
    hotkeyStore.getState().pressKey('Control');
    hotkeyStore.getState().pressKey('Shift');
    hotkeyStore.getState().pressKey('d');
    assert.equal(isActionActiveSync('DEBUG', 'DIAGNOSTICS'), true);
    hotkeyStore.getState().releaseKey('d');

    hotkeyStore.getState().pressKey('c');
    assert.equal(isActionActiveSync('DEBUG', 'HISTORY'), true);
    hotkeyStore.getState().releaseKey('c');

    hotkeyStore.getState().pressKey('x');
    assert.equal(isActionActiveSync('DEBUG', 'TRANSFORM'), true);
    hotkeyStore.getState().releaseKey('x');

    hotkeyStore.getState().pressKey('a');
    assert.equal(isActionActiveSync('DEBUG', 'SLICE_METRICS'), true);
    hotkeyStore.getState().releaseKey('a');

    hotkeyStore.getState().pressKey('n');
    assert.equal(isActionActiveSync('DEBUG', 'PRINT_MONITOR'), true);
    hotkeyStore.getState().releaseKey('n');

    hotkeyStore.getState().pressKey('m');
    assert.equal(isActionActiveSync('DEBUG', 'PRINT_RTSP'), true);
    hotkeyStore.getState().releaseKey('m');

    hotkeyStore.getState().pressKey('k');
    assert.equal(isActionActiveSync('DEBUG', 'TOGGLE_CAPS'), true);
    hotkeyStore.getState().clearKeys();

    // 3. MESH.INVERT_NORMALS (Alt+N)
    hotkeyStore.getState().pressKey('Alt');
    hotkeyStore.getState().pressKey('n');
    assert.equal(isActionActiveSync('MESH', 'INVERT_NORMALS'), true);
    hotkeyStore.getState().clearKeys();

    // 4. NAVIGATION.LAYER_UP/DOWN (ArrowUp/Down)
    hotkeyStore.getState().pressKey('ArrowUp');
    assert.equal(isActionActiveSync('NAVIGATION', 'LAYER_UP'), true);
    hotkeyStore.getState().clearKeys();

    hotkeyStore.getState().pressKey('ArrowDown');
    assert.equal(isActionActiveSync('NAVIGATION', 'LAYER_DOWN'), true);
    hotkeyStore.getState().clearKeys();

    // 5. HOLE_PUNCH.SELECT_ALL (Ctrl+A)
    hotkeyStore.getState().pressKey('Control');
    hotkeyStore.getState().pressKey('a');
    assert.equal(isActionActiveSync('HOLE_PUNCH', 'SELECT_ALL'), true);
    hotkeyStore.getState().clearKeys();

    // 6. PRESETS.SLOT_1 to SLOT_6 (1 to 6)
    hotkeyStore.getState().pressKey('1');
    assert.equal(isActionActiveSync('PRESETS', 'SLOT_1'), true);
    hotkeyStore.getState().clearKeys();

    hotkeyStore.getState().pressKey('6');
    assert.equal(isActionActiveSync('PRESETS', 'SLOT_6'), true);
    hotkeyStore.getState().clearKeys();
});



