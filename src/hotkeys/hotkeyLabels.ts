import type { HotkeyBinding } from './hotkeyConfig';

// Turning a binding into keycaps is display-only, but it must agree with how the
// store resolves that binding at runtime: hotkeyStore maps a configured `ctrl`
// onto the platform's primary modifier, which is Cmd on macOS. Labelling it
// "Ctrl" there would advertise a shortcut that does not exist.
export function toModifierLabel(modifier: string, primaryModifierLabel: string): string {
    const normalized = modifier.trim().toLowerCase();
    if (normalized === 'ctrl') return primaryModifierLabel;
    if (normalized === 'shift') return 'Shift';
    if (normalized === 'alt') return 'Alt';
    // `meta` is physically Cmd on macOS, and the Windows/Super key elsewhere.
    if (normalized === 'meta') return primaryModifierLabel === 'Cmd' ? 'Cmd' : 'Meta';
    return modifier;
}

export function toKeyLabel(key: string): string {
    // Space first: it is one character long, so an upper-case pass would render it
    // as a blank keycap and the branch below would never be reached.
    if (key === ' ') return 'Space';
    if (key.length === 1) return key.toUpperCase();
    return key;
}

export function getBindingTokens(binding: HotkeyBinding, primaryModifierLabel: string): string[] {
    const modifierTokens = binding.modifier
        ? binding.modifier.split('+').map((modifier) => toModifierLabel(modifier, primaryModifierLabel))
        : [];
    return [...modifierTokens, toKeyLabel(binding.key)];
}
