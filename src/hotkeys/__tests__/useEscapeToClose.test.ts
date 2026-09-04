import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEscapeHandler } from '../useEscapeToClose';

// The registry attaches its capture-phase listener to `window` on the first
// registration, so a minimal stand-in has to exist by then.
type FakeHotkeyEvent = { type: string; detail: { key: string }; stopImmediatePropagation: () => void };
type FakeListener = (event: FakeHotkeyEvent) => void;

const listeners = new Map<string, Set<FakeListener>>();
if (typeof globalThis.window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            addEventListener(type: string, callback: FakeListener) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type)!.add(callback);
            },
            removeEventListener(type: string, callback: FakeListener) {
                listeners.get(type)?.delete(callback);
            },
        },
    });
}

function pressKey(key: string) {
    let stopped = false;
    const event: FakeHotkeyEvent = {
        type: 'app-hotkey-keydown',
        detail: { key },
        stopImmediatePropagation: () => { stopped = true; },
    };
    for (const callback of Array.from(listeners.get('app-hotkey-keydown') ?? [])) {
        callback(event);
        if (stopped) break;
    }
    return stopped;
}

test('Escape closes the top-most registered dialog only', () => {
    const closed: string[] = [];
    const unregisterParent = registerEscapeHandler(() => closed.push('parent'));
    const unregisterChild = registerEscapeHandler(() => closed.push('child'));

    pressKey('Escape');
    assert.deepEqual(closed, ['child'], 'only the last registration reacts');

    unregisterChild();
    pressKey('Escape');
    assert.deepEqual(closed, ['child', 'parent'], 'the parent takes over once the child unregisters');

    unregisterParent();
});

test('Other keys are ignored', () => {
    let closeCount = 0;
    const unregister = registerEscapeHandler(() => { closeCount += 1; });

    pressKey('Enter');
    assert.equal(closeCount, 0);

    unregister();
});

test('A registration without a handler swallows Escape', () => {
    const closed: string[] = [];
    const unregisterDialog = registerEscapeHandler(() => closed.push('dialog'));
    const unregisterBlocking = registerEscapeHandler(undefined);

    const stopped = pressKey('Escape');
    assert.equal(stopped, true, 'the press is consumed');
    assert.deepEqual(closed, [], 'nothing behind the blocking modal closes');

    unregisterBlocking();
    unregisterDialog();
});

test('Escape is left alone once every dialog is closed', () => {
    const unregister = registerEscapeHandler(() => {});
    unregister();

    assert.equal(pressKey('Escape'), false, 'no listener consumes the press');
});
