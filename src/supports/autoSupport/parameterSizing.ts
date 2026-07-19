import type { CandidatePoint } from './types';
import type { SupportSettings } from '../Settings/types';

/** Override values for buildTrunkData's overrides parameter. */
export interface SizeOverrides {
    shaftDiameterMm?: number;
    tipContactDiameterMm?: number;
    tipBodyDiameterMm?: number;
    tipLengthMm?: number;
    rootsDiameterMm?: number;
}

/**
 * Compute support size parameters based on island geometry.
 *
 * @param candidate - The candidate point to size supports for
 * @param totalSupportedAreaMm2 - Total area this support carries
 *   (for core trunks: sum of own area + all satellites; for standalone: own area)
 * @param zHeight - Z-height above build plate (mm)
 * @param settings - Current support settings (for base values)
 */
export function sizeParameters(
    candidate: CandidatePoint,
    totalSupportedAreaMm2: number,
    zHeight: number,
    settings: SupportSettings,
): SizeOverrides {
    const area = Math.max(totalSupportedAreaMm2, 0.01);
    const referenceArea = 1.0; // mm² reference for scaling

    // Shaft diameter: scales with sqrt(area), 1.0x to 2.5x base
    const shaftScale = clamp(Math.sqrt(area / referenceArea), 1.0, 2.5);
    const shaftDiameterMm = settings.shaft.diameterMm * shaftScale;

    // Tip contact diameter: scales with sqrt(island area), 0.8x to 1.5x base
    const tipScale = clamp(
        Math.sqrt(candidate.islandAreaMm2 / Math.max(referenceArea * 0.5, 0.01)),
        0.8,
        1.5,
    );
    const tipContactDiameterMm = settings.tip.contactDiameterMm * tipScale;
    const tipBodyDiameterMm = settings.tip.bodyDiameterMm * tipScale;

    // Tip length: slightly longer for taller supports, 0.9x to 1.3x base
    const lengthScale = clamp(1.0 + (zHeight - 10) / 100, 0.9, 1.3);
    const tipLengthMm = settings.tip.lengthMm * lengthScale;

    // Root diameter: scales with sqrt(area), 1.0x to 2.0x base
    const rootScale = clamp(Math.sqrt(area / referenceArea), 1.0, 2.0);
    const rootsDiameterMm = settings.roots.diameterMm * rootScale;

    return {
        shaftDiameterMm: Number(shaftDiameterMm.toFixed(3)),
        tipContactDiameterMm: Number(tipContactDiameterMm.toFixed(3)),
        tipBodyDiameterMm: Number(tipBodyDiameterMm.toFixed(3)),
        tipLengthMm: Number(tipLengthMm.toFixed(3)),
        rootsDiameterMm: Number(rootsDiameterMm.toFixed(3)),
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
