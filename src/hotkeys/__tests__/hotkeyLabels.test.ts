import assert from 'node:assert/strict';
import test from 'node:test';
import { getBindingTokens, toKeyLabel, toModifierLabel } from '../hotkeyLabels';

// Regression: the Settings tab labelled a `ctrl` binding "Ctrl" on every platform,
// while hotkeyStore resolves that same binding to Cmd on macOS — so the UI showed
// Ctrl+Z for a shortcut that only fired on Cmd+Z.
test('Modifier labels follow the platform primary modifier', () => {
    assert.equal(toModifierLabel('ctrl', 'Cmd'), 'Cmd', 'macOS resolves ctrl bindings to Cmd');
    assert.equal(toModifierLabel('ctrl', 'Ctrl'), 'Ctrl');

    // `meta` is Cmd on macOS and the Windows/Super key elsewhere.
    assert.equal(toModifierLabel('meta', 'Cmd'), 'Cmd');
    assert.equal(toModifierLabel('meta', 'Ctrl'), 'Meta');

    // Platform-independent modifiers are untouched, casing and padding normalised.
    assert.equal(toModifierLabel('shift', 'Cmd'), 'Shift');
    assert.equal(toModifierLabel(' ALT ', 'Cmd'), 'Alt');
});

test('Key labels stay readable', () => {
    assert.equal(toKeyLabel('z'), 'Z', 'single characters are upper-cased');
    assert.equal(toKeyLabel(' '), 'Space');
    assert.equal(toKeyLabel('Backspace'), 'Backspace', 'named keys are left alone');
});

test('Binding tokens list modifiers before the key', () => {
    assert.deepEqual(
        getBindingTokens({ key: 'z', modifier: 'ctrl+shift', description: 'Redo' }, 'Cmd'),
        ['Cmd', 'Shift', 'Z'],
        'macOS renders Ctrl+Shift+Z as Cmd Shift Z',
    );
    assert.deepEqual(
        getBindingTokens({ key: 'z', modifier: 'ctrl+shift', description: 'Redo' }, 'Ctrl'),
        ['Ctrl', 'Shift', 'Z'],
    );
    assert.deepEqual(
        getBindingTokens({ key: 'Backspace', description: 'Delete selected item' }, 'Cmd'),
        ['Backspace'],
        'a binding with no modifier is a single keycap',
    );
});
