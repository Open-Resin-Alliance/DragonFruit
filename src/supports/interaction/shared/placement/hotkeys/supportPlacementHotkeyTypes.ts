import type * as THREE from 'three';
import type { ModelSurfaceGestureTypeId, SupportTypeId } from '../../../../supportTypeRegistry';
import type { HotkeyBinding } from '@/hotkeys/hotkeyConfig';

export type SupportPlacementFamily = 'none' | 'branchFamily' | 'leaf' | 'kickstand';
/**
 * Which placement a pointer gesture belongs to.
 *
 * Drawn from `SupportTypeId` rather than spelled out, so renaming a type in the
 * registry renames it here. Only the types with a placement mode appear; the
 * set is held by `supportPlacementRouting.test.ts`.
 */
export type SupportPlacementOwner = 'none' | Extract<SupportTypeId, 'branch' | 'brace' | 'leaf' | 'kickstand'>;
/** Model-surface gestures route to the types that declare they claim them. */
export type SupportModelPlacementOwner = 'none' | ModelSurfaceGestureTypeId;

/**
 * The model-face half of a placement hook. Every claiming type exposes it with
 * the same signature, so the router's owner can index a table of them.
 */
export interface SupportModelPlacementHandlers {
    onModelHover: (hit: THREE.Intersection | null) => void;
    onModelClick: (hit: THREE.Intersection | null) => void;
}
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
    modelHoverOwner: SupportModelPlacementOwner;
    modelClickOwner: SupportModelPlacementOwner;
    supportHoverOwner: SupportPlacementOwner;
    supportClickOwner: SupportPlacementOwner;
    blocksDefaultModelPlacement: boolean;
    blocksDefaultSupportPlacement: boolean;
    intent: ResolvedSupportPlacementHotkeyIntent;
}
