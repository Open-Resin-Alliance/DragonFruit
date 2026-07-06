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
export interface HotkeyBinding {
    key: string;
    modifier?: string; // 'ctrl', 'shift', 'alt', 'ctrl+shift', etc.
    description: string;
}

export interface HotkeyCategory {
    [actionName: string]: HotkeyBinding;
}

export interface HotkeyConfig {
    [categoryName: string]: HotkeyCategory;
}

// Default keybindings for application features.
// These are intended to be customizable by the user in the future.
export const DEFAULT_KEYBINDINGS: HotkeyConfig = {
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
        },
        KICKSTAND_PLACEMENT: {
            key: 'Control',
            description: 'Hold to enter Kickstand Placement Mode'
        },
        TEMP_SPOTLIGHT_HOLD: {
            key: 'p',
            description: 'Hold to temporarily enable Spotlight highlight in Support mode'
        },
        FORCE_PLACE_SUPPORT: {
            key: 'q',
            description: 'Hold to force placing support'
        },
        SPROUTED_PARENTING_LOCK: {
            key: 'w',
            description: 'Hold to enter Sprouted Leaf Fanning Mode'
        },
        TOGGLE_CONE_KNOT_SELECTION: {
            key: 'e',
            description: 'Press to toggle selection between support cone and parent base knot'
        }
    },
    CAMERA: {
        FOCUS_PICK: {
            key: 'f',
            description: 'Press to focus hovered point on selected model, else snap to best visible model'
        },
        TOGGLE_PROJECTION: {
            key: 'o',
            description: 'Toggle camera projection (Orthographic / Perspective)'
        },
        INTERIOR_VIEW: {
            key: 'x',
            description: 'Toggle Interior View Mode'
        }
    },
    CANVAS: {
        TOOL_SELECT: {
            key: 'q',
            description: 'Switch canvas tool to Select'
        },
        TOOL_MODIFY: {
            key: 'm',
            description: 'Switch canvas tool to Modify'
        },
        TOOL_SMOOTH: {
            key: 's',
            description: 'Switch canvas tool to Smooth'
        },
        TOOL_ARRANGE: {
            key: 'a',
            description: 'Switch canvas tool to Arrange'
        },
        TOOL_DUPLICATE: {
            key: 'd',
            description: 'Switch canvas tool to Duplicate'
        },
        SELECT_ALL: {
            key: 'a',
            modifier: 'ctrl',
            description: 'Select all visible models'
        },
        COPY: {
            key: 'c',
            modifier: 'ctrl',
            description: 'Copy selected model(s)'
        },
        PASTE: {
            key: 'v',
            modifier: 'ctrl',
            description: 'Paste copied model(s)'
        }
    },
    PRESETS: {
        SLOT_1: {
            key: '1',
            description: 'Pinned Slot 1'
        },
        SLOT_2: {
            key: '2',
            description: 'Pinned Slot 2'
        },
        SLOT_3: {
            key: '3',
            description: 'Pinned Slot 3'
        },
        SLOT_4: {
            key: '4',
            description: 'Pinned Slot 4'
        },
        SLOT_5: {
            key: '5',
            description: 'Pinned Slot 5'
        },
        SLOT_6: {
            key: '6',
            description: 'Pinned Slot 6'
        }
    },
    ROTATION: {
        SNAP_COARSE: {
            key: 'drag',
            modifier: 'meta',
            description: 'Snap rotation to 45° increments (Cmd/Ctrl + drag)'
        },
        SNAP_FINE: {
            key: 'drag',
            modifier: 'meta+shift',
            description: 'Snap rotation to 15° increments (Cmd/Ctrl + Shift + drag)'
        }
    },
    GLOBAL: {
        SAVE: {
            key: 's',
            modifier: 'ctrl',
            description: 'Save active scene'
        },
        SAVE_AS: {
            key: 's',
            modifier: 'ctrl+shift',
            description: 'Save active scene as…'
        }
    },
    DEBUG: {
        DIAGNOSTICS: {
            key: 'd',
            modifier: 'ctrl+shift',
            description: 'Toggle diagnostics modal'
        },
        FORCE_UPDATE: {
            key: 'u',
            modifier: 'ctrl+shift',
            description: 'Force mock update notification'
        },
        HISTORY: {
            key: 'c',
            modifier: 'ctrl+shift',
            description: 'Toggle history debug'
        },
        TRANSFORM: {
            key: 'x',
            modifier: 'ctrl+shift',
            description: 'Toggle transform debug overlay'
        },
        SLICE_METRICS: {
            key: 'a',
            modifier: 'ctrl+shift',
            description: 'Toggle slice metrics debug'
        },
        PRINT_MONITOR: {
            key: 'n',
            modifier: 'ctrl+shift',
            description: 'Toggle printing monitor debug'
        },
        PRINT_RTSP: {
            key: 'm',
            modifier: 'ctrl+shift',
            description: 'Toggle printing monitor RTSP debug'
        },
        TOGGLE_CAPS: {
            key: 'k',
            modifier: 'ctrl+shift',
            description: 'Toggle cross section caps debug panel'
        }
    },
    MESH: {
        INVERT_NORMALS: {
            key: 'n',
            modifier: 'alt',
            description: 'Invert selected model normals'
        }
    },
    NAVIGATION: {
        LAYER_UP: {
            key: 'arrowup',
            description: 'Navigate layer up'
        },
        LAYER_DOWN: {
            key: 'arrowdown',
            description: 'Navigate layer down'
        }
    },
    HOLE_PUNCH: {
        SELECT_ALL: {
            key: 'a',
            modifier: 'ctrl',
            description: 'Select all hole punches / items'
        }
    }
} as const;

type ModifierKey = 'ctrl' | 'shift' | 'alt' | 'meta';

function normalizeKeyName(key?: string): string {
    const normalized = (key ?? '').trim().toLowerCase();
    if (normalized === 'control') return 'ctrl';
    if (normalized === 'altgraph') return 'alt';
    return normalized;
}

function parseModifier(modifier?: string): Set<ModifierKey> {
    if (!modifier) return new Set();
    const parts = modifier.split('+').map(p => normalizeKeyName(p)).filter(Boolean);
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
    const normalizedBindingKey = normalizeKeyName(binding.key);
    const normalizedEventKey = normalizeKeyName(e.key);
    if (normalizedBindingKey === 'alt') expectedMods.add('alt');
    if (normalizedBindingKey === 'ctrl') expectedMods.add('ctrl');
    if (normalizedBindingKey === 'shift') expectedMods.add('shift');
    if (normalizedBindingKey === 'meta') expectedMods.add('meta');

    const actualMods = getEventModifiers(e);

    const baseKeyMatches = normalizedBindingKey === 'alt'
        ? e.altKey
        : normalizedEventKey === normalizedBindingKey;

    return baseKeyMatches && setEquals(actualMods, expectedMods);
}

export function matchesConfiguredHotkeyUp(
    e: KeyboardEvent,
    binding: { key: string; modifier?: string }
): boolean {
    const expectedMods = parseModifier(binding.modifier);
    const normalizedBindingKey = normalizeKeyName(binding.key);
    const releasedKey = normalizeKeyName(e.key);

    const primaryReleased = normalizedBindingKey === 'alt'
        ? releasedKey === 'alt'
        : releasedKey === normalizedBindingKey;

    if (primaryReleased) return true;

    if (expectedMods.has('ctrl') && releasedKey === 'ctrl') return true;
    if (expectedMods.has('shift') && releasedKey === 'shift') return true;
    if (expectedMods.has('alt') && releasedKey === 'alt') return true;
    if (expectedMods.has('meta') && releasedKey === 'meta') return true;

    return false;
}
