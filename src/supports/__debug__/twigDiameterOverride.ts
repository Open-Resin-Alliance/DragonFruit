// =============================================================================
// TEMPORARY DEBUG MODULE — REMOVE WHEN TWIG PER-END DIAMETER UI IS BUILT
// =============================================================================
// Lets us test leaf-base taper along a tapered twig without yet having proper
// per-disk diameter editing on existing twigs. Override applies to disk B of
// NEWLY-CREATED twigs only (disk A keeps using the global tip.contactDiameterMm).
//
// To remove this debug feature:
//   1. Delete the entire src/supports/__debug__/ folder.
//   2. Revert the small block in src/supports/SupportTypes/Twig/twigBuilder.ts
//      that reads `getTwigDiskBOverrideMm()`.
//   3. Remove the <TwigDebugOverrideCard /> mount from SceneCanvas.tsx.
// =============================================================================

let twigDiskBOverrideMm: number | null = null;
const listeners = new Set<() => void>();

export function getTwigDiskBOverrideMm(): number | null {
    return twigDiskBOverrideMm;
}

export function setTwigDiskBOverrideMm(value: number | null): void {
    twigDiskBOverrideMm = value;
    for (const listener of listeners) listener();
}

export function subscribeTwigDiskBOverride(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
