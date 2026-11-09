import type { ModelMeshModifiers } from './types';

/** Panel-only hollowing metadata is not geometry waiting to be baked. */
export function hasHollowingToBake(modifiers: ModelMeshModifiers | undefined): boolean {
    const hollowing = modifiers?.hollowing;
    return Boolean(
        hollowing?.enabled && !hollowing.bakedIntoGeometry
        && hollowing.sourcePositionsBase64
        && Number.isInteger(hollowing.sourcePositionCount)
        && (hollowing.sourcePositionCount ?? 0) > 0,
    );
}

/**
 * Warn before support generation about unapplied holes and source-backed hollowing.
 * A flags-only panel draft has no hollowing source to bake at slice time.
 */
export function getUnappliedModifiers(modifiers: ModelMeshModifiers | undefined): {
    holePunches: boolean;
    hollowing: boolean;
} {
    const punches = modifiers?.holePunches;
    return {
        holePunches: Boolean(punches && punches.length > 0 && !modifiers?.holePunchesBakedIntoGeometry),
        hollowing: hasHollowingToBake(modifiers),
    };
}
