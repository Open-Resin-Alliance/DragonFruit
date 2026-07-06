import type { HotkeyBinding } from '@/hotkeys/hotkeyConfig';
import type {
    ResolvedSupportPlacementHotkeyIntent,
    SupportPlacementHotkeyBindings,
    SupportPlacementModifierState,
} from './supportPlacementHotkeyTypes';

const EMPTY_MODIFIER_STATE: SupportPlacementModifierState = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
};

type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta';

function normalizeKeyName(key?: string): string {
    const normalized = (key ?? '').trim().toLowerCase();
    if (normalized === 'control') return 'ctrl';
    if (normalized === 'altgraph') return 'alt';
    return normalized;
}

function isModifierName(value: string): value is ModifierName {
    return value === 'ctrl' || value === 'alt' || value === 'shift' || value === 'meta';
}

function parseBindingModifiers(binding: HotkeyBinding): Set<ModifierName> {
    const modifiers = new Set<ModifierName>();

    const parts = (binding.modifier ?? '')
        .split('+')
        .map((part) => normalizeKeyName(part))
        .filter(Boolean);

    for (const part of parts) {
        if (isModifierName(part)) {
            modifiers.add(part);
        }
    }

    const normalizedKey = normalizeKeyName(binding.key);
    if (isModifierName(normalizedKey)) {
        modifiers.add(normalizedKey);
    }

    return modifiers;
}

function getModifierCount(state: SupportPlacementModifierState): number {
    let count = 0;
    if (state.ctrlKey) count += 1;
    if (state.altKey) count += 1;
    if (state.shiftKey) count += 1;
    if (state.metaKey) count += 1;
    return count;
}

function hasModifier(state: SupportPlacementModifierState, modifier: ModifierName): boolean {
    if (modifier === 'ctrl') return state.ctrlKey;
    if (modifier === 'alt') return state.altKey;
    if (modifier === 'shift') return state.shiftKey;
    return state.metaKey;
}

export function resolveSupportPlacementHotkeyBindings(
    getHotkey: (category: string, action: string) => HotkeyBinding,
): SupportPlacementHotkeyBindings {
    return {
        branchFamily: getHotkey('SUPPORTS', 'BRANCH_PLACEMENT'),
        leaf: getHotkey('SUPPORTS', 'LEAF_PLACEMENT'),
        kickstand: getHotkey('SUPPORTS', 'KICKSTAND_PLACEMENT'),
    };
}

export function getSupportPlacementModifierState(source: unknown): SupportPlacementModifierState {
    if (!source || typeof source !== 'object') {
        return EMPTY_MODIFIER_STATE;
    }

    const candidate = source as {
        ctrlKey?: unknown;
        altKey?: unknown;
        shiftKey?: unknown;
        metaKey?: unknown;
        nativeEvent?: {
            ctrlKey?: unknown;
            altKey?: unknown;
            shiftKey?: unknown;
            metaKey?: unknown;
        };
    };

    return {
        ctrlKey: Boolean(candidate.ctrlKey || candidate.nativeEvent?.ctrlKey),
        altKey: Boolean(candidate.altKey || candidate.nativeEvent?.altKey),
        shiftKey: Boolean(candidate.shiftKey || candidate.nativeEvent?.shiftKey),
        metaKey: Boolean(candidate.metaKey || candidate.nativeEvent?.metaKey),
    };
}

export function canResolveSupportPlacementBindingFromModifierState(binding: HotkeyBinding): boolean {
    const normalizedKey = normalizeKeyName(binding.key);
    return isModifierName(normalizedKey);
}

export function isSupportPlacementBindingSatisfiedByModifierState(
    binding: HotkeyBinding,
    modifierState: SupportPlacementModifierState,
): boolean {
    if (!canResolveSupportPlacementBindingFromModifierState(binding)) {
        return false;
    }

    const requiredModifiers = parseBindingModifiers(binding);
    if (requiredModifiers.size !== getModifierCount(modifierState)) {
        return false;
    }

    for (const modifier of requiredModifiers) {
        if (!hasModifier(modifierState, modifier)) {
            return false;
        }
    }

    return true;
}

export function resolveSupportPlacementHotkeyIntent(
    bindings: SupportPlacementHotkeyBindings,
    modifierState: SupportPlacementModifierState,
): ResolvedSupportPlacementHotkeyIntent {
    const matches = {
        branchFamily: isSupportPlacementBindingSatisfiedByModifierState(bindings.branchFamily, modifierState),
        leaf: isSupportPlacementBindingSatisfiedByModifierState(bindings.leaf, modifierState),
        kickstand: isSupportPlacementBindingSatisfiedByModifierState(bindings.kickstand, modifierState),
    };

    if (matches.leaf) {
        return {
            family: 'leaf',
            requiredKeysHeld: true,
            releaseShouldCancel: false,
            bindingSource: bindings.leaf,
            matches,
        };
    }

    if (matches.branchFamily) {
        return {
            family: 'branchFamily',
            requiredKeysHeld: true,
            releaseShouldCancel: false,
            bindingSource: bindings.branchFamily,
            matches,
        };
    }

    if (matches.kickstand) {
        return {
            family: 'kickstand',
            requiredKeysHeld: true,
            releaseShouldCancel: false,
            bindingSource: bindings.kickstand,
            matches,
        };
    }

    return {
        family: 'none',
        requiredKeysHeld: false,
        releaseShouldCancel: false,
        bindingSource: null,
        matches,
    };
}
