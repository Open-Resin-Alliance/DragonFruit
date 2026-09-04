import { MaterialAntiAliasingSettings } from '@/features/profiles/profileStore';
import { resolveEffectiveAaSettings } from '@/features/slicing/resolveEffectiveAaSettings';

/**
 * Resolves the total penetration distance for support contact tips into the model.
 * 
 * @param settings The AA settings from the active material profile
 * @param layerHeightMm The Z layer height in mm
 * @param pixelPitchMm The X pixel pitch in mm
 * @param pixelPitchYMm The Y pixel pitch in mm (defaults to pixelPitchMm)
 * @returns The calculated offset in mm
 */
export function calculateTipOffset(
    settings: MaterialAntiAliasingSettings,
    layerHeightMm: number,
    pixelPitchMm: number,
    pixelPitchYMm: number = pixelPitchMm
): number {
    const resolved = resolveEffectiveAaSettings(settings, layerHeightMm, pixelPitchMm, pixelPitchYMm);
    return Number(resolved.tipOffsetMm.toFixed(3));
}

