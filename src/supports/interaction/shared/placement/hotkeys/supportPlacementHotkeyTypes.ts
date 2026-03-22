import type { HotkeyBinding } from '@/hotkeys/hotkeyConfig';

export type SupportPlacementFamily = 'none' | 'branchFamily' | 'leaf' | 'kickstand';
export type SupportPlacementOwner = 'none' | 'branch' | 'brace' | 'leaf' | 'kickstand';
export type SupportPlacementFirstClickTarget = 'none' | 'model' | 'support';

export interface SupportPlacementModifierState {
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
}

export interface SupportPlacementHotkeyBindings {
    branchFamily: HotkeyBinding;
    leaf: HotkeyBinding;
    kickstand: HotkeyBinding;
}

export interface ResolvedSupportPlacementHotkeyIntent {
    family: SupportPlacementFamily;
    requiredKeysHeld: boolean;
    releaseShouldCancel: boolean;
    bindingSource: HotkeyBinding | null;
    matches: {
        branchFamily: boolean;
        leaf: boolean;
        kickstand: boolean;
    };
}

export interface SupportPlacementRoutingState {
    branchHotkeyActive: boolean;
    branchAwaitingBase: boolean;
    leafHotkeyActive: boolean;
    leafAwaitingBase: boolean;
    braceHotkeyActive: boolean;
    braceAwaitingEnd: boolean;
    kickstandHotkeyActive: boolean;
}

export interface ResolvedSupportPlacementOwner {
    owner: SupportPlacementOwner;
    basedOnFirstClick: boolean;
    firstClickTarget: SupportPlacementFirstClickTarget;
    modelHoverOwner: 'none' | 'branch' | 'leaf';
    modelClickOwner: 'none' | 'branch' | 'leaf';
    supportHoverOwner: SupportPlacementOwner;
    supportClickOwner: SupportPlacementOwner;
    blocksDefaultModelPlacement: boolean;
    blocksDefaultSupportPlacement: boolean;
    intent: ResolvedSupportPlacementHotkeyIntent;
}
