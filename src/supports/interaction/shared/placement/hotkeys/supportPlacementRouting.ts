import {
    resolveSupportPlacementHotkeyIntent,
} from './supportPlacementHotkeyResolver';
import type {
    ResolvedSupportPlacementOwner,
    SupportPlacementHotkeyBindings,
    SupportPlacementModifierState,
    SupportPlacementRoutingState,
} from './supportPlacementHotkeyTypes';

export interface SupportPlacementRoutingInput {
    bindings: SupportPlacementHotkeyBindings;
    modifierState: SupportPlacementModifierState;
    state: SupportPlacementRoutingState;
}

export function resolveSupportPlacementRouting(
    input: SupportPlacementRoutingInput,
): ResolvedSupportPlacementOwner {
    const intent = resolveSupportPlacementHotkeyIntent(input.bindings, input.modifierState);
    const branchFamilyActive = input.state.branchHotkeyActive || input.state.braceHotkeyActive || intent.family === 'branchFamily';
    const leafActive = input.state.leafHotkeyActive || intent.family === 'leaf';
    const kickstandActive = input.state.kickstandHotkeyActive || intent.family === 'kickstand';

    if (input.state.braceAwaitingEnd) {
        return {
            owner: 'brace',
            basedOnFirstClick: true,
            firstClickTarget: 'support',
            modelHoverOwner: 'none',
            modelClickOwner: 'none',
            supportHoverOwner: 'brace',
            supportClickOwner: 'brace',
            blocksDefaultModelPlacement: true,
            blocksDefaultSupportPlacement: true,
            intent,
        };
    }

    if (input.state.leafAwaitingBase) {
        return {
            owner: 'leaf',
            basedOnFirstClick: true,
            firstClickTarget: 'model',
            modelHoverOwner: 'none',
            modelClickOwner: 'none',
            supportHoverOwner: 'leaf',
            supportClickOwner: 'leaf',
            blocksDefaultModelPlacement: true,
            blocksDefaultSupportPlacement: true,
            intent,
        };
    }

    if (input.state.branchAwaitingBase) {
        return {
            owner: 'branch',
            basedOnFirstClick: true,
            firstClickTarget: 'model',
            modelHoverOwner: 'branch',
            modelClickOwner: 'branch',
            supportHoverOwner: 'branch',
            supportClickOwner: 'branch',
            blocksDefaultModelPlacement: true,
            blocksDefaultSupportPlacement: true,
            intent,
        };
    }

    if (leafActive) {
        return {
            owner: 'leaf',
            basedOnFirstClick: false,
            firstClickTarget: 'none',
            modelHoverOwner: 'leaf',
            modelClickOwner: 'leaf',
            supportHoverOwner: 'leaf',
            supportClickOwner: 'leaf',
            blocksDefaultModelPlacement: true,
            blocksDefaultSupportPlacement: true,
            intent,
        };
    }

    if (branchFamilyActive) {
        return {
            owner: 'none',
            basedOnFirstClick: true,
            firstClickTarget: 'none',
            modelHoverOwner: 'branch',
            modelClickOwner: 'branch',
            supportHoverOwner: 'brace',
            supportClickOwner: 'brace',
            blocksDefaultModelPlacement: true,
            blocksDefaultSupportPlacement: true,
            intent,
        };
    }

    if (kickstandActive) {
        return {
            owner: 'kickstand',
            basedOnFirstClick: false,
            firstClickTarget: 'support',
            modelHoverOwner: 'none',
            modelClickOwner: 'none',
            supportHoverOwner: 'kickstand',
            supportClickOwner: 'kickstand',
            blocksDefaultModelPlacement: true,
            blocksDefaultSupportPlacement: true,
            intent,
        };
    }

    return {
        owner: 'none',
        basedOnFirstClick: false,
        firstClickTarget: 'none',
        modelHoverOwner: 'none',
        modelClickOwner: 'none',
        supportHoverOwner: 'none',
        supportClickOwner: 'none',
        blocksDefaultModelPlacement: false,
        blocksDefaultSupportPlacement: false,
        intent,
    };
}
