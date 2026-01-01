// Centralized configuration for application hotkeys

// Universal hotkeys are hardcoded system standards and are not intended to be customizable.
export const UNIVERSAL_HOTKEYS = {
    DELETE: {
        keys: ['Delete', 'Backspace'],
        description: 'Delete selected item'
    },
    UNDO: {
        key: 'z',
        modifier: 'ctrl', // or meta
        description: 'Undo last action'
    },
    REDO: {
        key: 'z',
        modifier: 'ctrl+shift',
        description: 'Redo last action'
    }
} as const;

// Default keybindings for application features.
// These are intended to be customizable by the user in the future.
export const DEFAULT_KEYBINDINGS = {
    SUPPORTS: {
        JOINT_CREATION: {
            key: 'j',
            description: 'Hold to enter Joint Creation Mode'
        },
        CURVE_MODE: {
            key: 'c',
            description: 'Hold to create curved segment when moving joint'
        },
        BRANCH_PLACEMENT: {
            key: 'Alt',
            description: 'Hold to enter Branch Placement Mode'
        },
        LEAF_PLACEMENT: {
            key: 'Alt',
            modifier: 'ctrl',
            description: 'Hold to enter Leaf Placement Mode'
        }
    },
    CAMERA: {
        FOCUS_PICK: {
            key: 'f',
            description: 'Press to refocus the camera at the mouse cursor (over model)'
        }
    }
} as const;

type ModifierKey = 'ctrl' | 'shift' | 'alt' | 'meta';

function parseModifier(modifier?: string): Set<ModifierKey> {
    if (!modifier) return new Set();
    const parts = modifier.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
    const mods = new Set<ModifierKey>();
    for (const p of parts) {
        if (p === 'ctrl') mods.add('ctrl');
        else if (p === 'shift') mods.add('shift');
        else if (p === 'alt') mods.add('alt');
        else if (p === 'meta') mods.add('meta');
    }
    return mods;
}

function getEventModifiers(e: KeyboardEvent): Set<ModifierKey> {
    const mods = new Set<ModifierKey>();
    if (e.ctrlKey) mods.add('ctrl');
    if (e.shiftKey) mods.add('shift');
    if (e.altKey) mods.add('alt');
    if (e.metaKey) mods.add('meta');
    return mods;
}

function setEquals<T>(a: Set<T>, b: Set<T>) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

export function matchesConfiguredHotkeyDown(
    e: KeyboardEvent,
    binding: { key: string; modifier?: string }
): boolean {
    const expectedMods = parseModifier(binding.modifier);
    if (binding.key.toLowerCase() === 'alt') expectedMods.add('alt');
    if (binding.key.toLowerCase() === 'control') expectedMods.add('ctrl');
    if (binding.key.toLowerCase() === 'shift') expectedMods.add('shift');
    if (binding.key.toLowerCase() === 'meta') expectedMods.add('meta');

    const actualMods = getEventModifiers(e);

    const baseKeyMatches = binding.key.toLowerCase() === 'alt'
        ? e.altKey
        : e.key.toLowerCase() === binding.key.toLowerCase();

    return baseKeyMatches && setEquals(actualMods, expectedMods);
}

export function matchesConfiguredHotkeyUp(
    e: KeyboardEvent,
    binding: { key: string; modifier?: string }
): boolean {
    const expectedMods = parseModifier(binding.modifier);
    const releasedKey = e.key;

    const primaryReleased = binding.key.toLowerCase() === 'alt'
        ? releasedKey === 'Alt'
        : releasedKey.toLowerCase() === binding.key.toLowerCase();

    if (primaryReleased) return true;

    if (expectedMods.has('ctrl') && releasedKey === 'Control') return true;
    if (expectedMods.has('shift') && releasedKey === 'Shift') return true;
    if (expectedMods.has('alt') && releasedKey === 'Alt') return true;
    if (expectedMods.has('meta') && releasedKey === 'Meta') return true;

    return false;
}

