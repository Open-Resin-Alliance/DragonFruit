/**
 * Module-level store for the active cross-section clip bounds.
 *
 * Updated by SceneCanvas when clipUpper/clipLower props change.
 * Read by BranchPlacementController (and any other code that does
 * independent raycasting) to skip hits on clipped geometry.
 */

let _clipLower: number | null = null;
let _clipUpper: number | null = null;

export function setClipBounds(lower: number | null | undefined, upper: number | null | undefined): void {
    _clipLower = lower ?? null;
    _clipUpper = upper ?? null;
}

export function getClipBounds(): { clipLower: number | null; clipUpper: number | null } {
    return { clipLower: _clipLower, clipUpper: _clipUpper };
}
