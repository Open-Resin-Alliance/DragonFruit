import {
    cancelPendingSceneHoverClearFrame,
    clearSceneHoveredSupportAndModelHover,
    commitSceneHoveredSupportAndModelHover,
    scheduleDeferredSceneHoverClear,
} from './sceneHoverReset';
import { shouldSuppressSceneBatchedSupportHover } from './supportHoverResolver';

type NullableStringStateSetter = (
    next: string | null | ((prev: string | null) => string | null),
) => void;

type FrameRefLike = {
    current: number | null;
};

export type SceneHoverWriteDecision =
    | { type: 'none' }
    | { type: 'clear'; reason: 'suppressed-for-other-support' | 'primitive-suppressed' | 'interaction-suppressed' | 'selection-changed' | 'selected-primitive-suppressed' }
    | { type: 'commit'; supportId: string | null; modelId: string | null }
    | { type: 'schedule-clear' };

interface SceneBatchedSupportHoverDecisionInput {
    supportId: string | null | undefined;
    modelId: string | null | undefined;
    selectedCategory: string | null | undefined;
    selectedPrimitiveHoverActive: boolean;
    primitiveHoverOnSelectedSupport: boolean;
    selectedSupportIdSet: ReadonlySet<string>;
    hoverSuppressed: boolean;
    selectedPrimitiveSupportId?: string | null;
}

interface SceneBatchedShaftHoverDecisionInput extends SceneBatchedSupportHoverDecisionInput {
    primitiveHoverSuppressesSceneShaftHover: boolean;
}

function shouldClearSceneBatchedHoverForOtherSupport(
    input: Pick<
        SceneBatchedSupportHoverDecisionInput,
        'supportId' | 'selectedCategory' | 'selectedPrimitiveHoverActive' | 'primitiveHoverOnSelectedSupport' | 'selectedSupportIdSet' | 'selectedPrimitiveSupportId'
    >,
) {
    return shouldSuppressSceneBatchedSupportHover(
        input.supportId,
        input.selectedCategory,
        input.selectedPrimitiveHoverActive,
        input.primitiveHoverOnSelectedSupport,
        input.selectedSupportIdSet,
        input.selectedPrimitiveSupportId ?? null,
    );
}

export function resolveSceneBatchedSupportHoverWriteDecision(
    input: SceneBatchedSupportHoverDecisionInput,
): SceneHoverWriteDecision {
    const suppressForOtherSupport = shouldClearSceneBatchedHoverForOtherSupport(input);

    if (suppressForOtherSupport) {
        return { type: 'clear', reason: 'suppressed-for-other-support' };
    }

    if (input.hoverSuppressed) {
        return { type: 'clear', reason: 'interaction-suppressed' };
    }

    return {
        type: 'commit',
        supportId: input.supportId ?? null,
        modelId: input.modelId ?? null,
    };
}

export function resolveSceneBatchedShaftHoverWriteDecision(
    input: SceneBatchedShaftHoverDecisionInput,
): SceneHoverWriteDecision {
    const suppressForOtherSupport = shouldClearSceneBatchedHoverForOtherSupport(input);

    if (suppressForOtherSupport) {
        return { type: 'clear', reason: 'suppressed-for-other-support' };
    }

    if (input.primitiveHoverSuppressesSceneShaftHover) {
        return { type: 'clear', reason: 'primitive-suppressed' };
    }

    if (input.hoverSuppressed) {
        return { type: 'clear', reason: 'interaction-suppressed' };
    }

    return {
        type: 'commit',
        supportId: input.supportId ?? null,
        modelId: input.modelId ?? null,
    };
}

export function resolveSceneBatchedShaftPointerOutWriteDecision(
    hoverSuppressed: boolean,
): SceneHoverWriteDecision {
    if (hoverSuppressed) return { type: 'none' };
    return { type: 'schedule-clear' };
}

export function shouldClearSceneHoverForSelectionChange(
    previousSelectionKey: string,
    nextSelectionKey: string,
    sceneHoveredSupportId: string | null,
) {
    return previousSelectionKey !== nextSelectionKey && sceneHoveredSupportId !== null;
}

export function shouldClearSceneHoverForSelectedPrimitiveSuppression(
    selectedPrimitiveHoverActive: boolean,
    suppressSupportHoverForSelectedKnotSupport: boolean,
    suppressSupportHoverForSelectedJointSupport: boolean = false,
) {
    return selectedPrimitiveHoverActive || suppressSupportHoverForSelectedKnotSupport || suppressSupportHoverForSelectedJointSupport;
}

export function applySceneHoverWriteDecision(
    decision: SceneHoverWriteDecision,
    frameRef: FrameRefLike,
    setSceneHoveredSupportId: NullableStringStateSetter,
    emitSupportModelPointerHover: (modelId: string | null) => void,
) {
    if (decision.type === 'none') return;

    if (decision.type === 'clear') {
        clearSceneHoveredSupportAndModelHover(setSceneHoveredSupportId, emitSupportModelPointerHover);
        return;
    }

    if (decision.type === 'schedule-clear') {
        scheduleDeferredSceneHoverClear(frameRef, setSceneHoveredSupportId, emitSupportModelPointerHover);
        return;
    }

    cancelPendingSceneHoverClearFrame(frameRef);
    commitSceneHoveredSupportAndModelHover(
        decision.supportId,
        decision.modelId,
        setSceneHoveredSupportId,
        emitSupportModelPointerHover,
    );
}
