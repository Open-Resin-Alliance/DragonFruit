type NullableStringStateSetter = (
    next: string | null | ((prev: string | null) => string | null),
) => void;

type FrameRefLike = {
    current: number | null;
};

export function cancelPendingSceneHoverClearFrame(frameRef: FrameRefLike) {
    if (frameRef.current == null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
}

export function scheduleDeferredSceneHoverClear(
    frameRef: FrameRefLike,
    setSceneHoveredSupportId: NullableStringStateSetter,
    emitSupportModelPointerHover: (modelId: string | null) => void,
) {
    if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        clearSceneHoveredSupportAndModelHover(setSceneHoveredSupportId, emitSupportModelPointerHover);
    });
}

export function clearSceneHoveredSupportAndModelHover(
    setSceneHoveredSupportId: NullableStringStateSetter,
    emitSupportModelPointerHover: (modelId: string | null) => void,
) {
    setSceneHoveredSupportId((prev) => (prev === null ? prev : null));
    emitSupportModelPointerHover(null);
}

export function clearImmediateModelHover(
    setImmediateModelHoverId: NullableStringStateSetter,
) {
    setImmediateModelHoverId((prev) => (prev === null ? prev : null));
}

export function commitSceneHoveredSupportAndModelHover(
    nextSupportId: string | null,
    modelId: string | null,
    setSceneHoveredSupportId: NullableStringStateSetter,
    emitSupportModelPointerHover: (modelId: string | null) => void,
) {
    setSceneHoveredSupportId((prev) => (prev === nextSupportId ? prev : nextSupportId));
    emitSupportModelPointerHover(modelId);
}
