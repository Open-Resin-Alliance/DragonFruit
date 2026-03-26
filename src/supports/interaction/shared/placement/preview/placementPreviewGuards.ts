export interface PlacementPreviewGuardInput {
    active: boolean;
    hardDisabled: boolean;
    suppressedByMode: boolean;
    stageAllowsPreview: boolean;
}

export function shouldHidePlacementPreview(input: PlacementPreviewGuardInput) {
    if (!input.active) return true;
    if (input.hardDisabled) return true;
    if (input.suppressedByMode) return true;
    if (!input.stageAllowsPreview) return true;
    return false;
}
