import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { footprintX, footprintY, footprintZ } from '../../volumeAnalysis/Islands/voxelFootprint';

/**
 * Paper-aligned, simulation-free support densification (Cao et al. 2025,
 * "Auto-support", DOI 10.1080/17452759.2025.2466189).
 *
 * The paper does not iterate full physics: it simulates a handful of
 * representative layers, turns the support traction into a density field, and
 * then optimises support *positions* geometrically (capacity-constrained
 * circle covering + a CVT-like energy). This module is the geometric half:
 * extra contacts are chosen from the tip force deficit and a Gaussian
 * traction-density field, without another frame/force solve.
 *
 * `selectForceCoveragePoints` is a greedy, farthest-point approximation of the
 * paper's CVT: each step takes the footprint cell with the largest
 * `density × distance-to-nearest-existing-or-chosen` value. That spreads new
 * contacts over the high-traction area (the paper's `E_f` term) while keeping
 * them away from each other and from existing tips (the coverage term),
 * instead of stacking a second contact on the over-budget cell.
 */

export const FORCE_COVERING_DEFAULTS = {
    /** Gaussian spread of one tip's traction (mm). */
    sigmaMm: 2.0,
    /** Cap a single tip's weight so one outlier cannot dominate the field. */
    maxTipWeight: 4,
    /** Plan spacing between a new contact and any existing/chosen contact (mm). */
    minSpacingMm: 1.6,
} as const;

/** Additional contacts needed to carry `deficitN` at the tip's break capacity. */
export function forceDrivenContactCount(deficitN: number, capacityN: number): number {
    if (!(deficitN > 0) || !(capacityN > 0)) return 0;
    return Math.max(1, Math.ceil(deficitN / capacityN));
}

export interface ForceCoveringSeed {
    x: number;
    y: number;
    demandN: number;
    capacityN: number;
}

export interface ForceCoveringPoint {
    x: number;
    y: number;
    z: number;
    /** Density × separation at selection time; for deterministic tests/reporting. */
    score: number;
}

export interface ForceCoveringOptions {
    sigmaMm?: number;
    minSpacingMm?: number;
    maxTipWeight?: number;
}

/**
 * Choose up to `count` new contacts over an island footprint from the traction
 * field. Cells inside `minSpacingMm` of an existing tip are not candidates, so
 * the result is additive to the current forest.
 */
export function selectForceCoveragePoints(
    island: DetectedIsland,
    seeds: readonly ForceCoveringSeed[],
    existingTips: ReadonlyArray<{ x: number; y: number }>,
    count: number,
    options: ForceCoveringOptions = {},
): ForceCoveringPoint[] {
    if (count <= 0) return [];
    const sigma = Math.max(0.1, options.sigmaMm ?? FORCE_COVERING_DEFAULTS.sigmaMm);
    const minSpacing = Math.max(0, options.minSpacingMm ?? FORCE_COVERING_DEFAULTS.minSpacingMm);
    const maxWeight = Math.max(1, options.maxTipWeight ?? FORCE_COVERING_DEFAULTS.maxTipWeight);
    const twoSigmaSq = 2 * sigma * sigma;

    const voxels = island.contactVoxels;
    if (!voxels || voxels.count === 0) {
        // No footprint: place at the strongest seed, or the island contact.
        const best = seeds[0];
        return best
            ? [{ x: best.x, y: best.y, z: island.contact.z, score: 1 }]
            : [{ x: island.contact.x, y: island.contact.y, z: island.contact.z, score: 0 }];
    }

    const countCells = voxels.count;
    const density = new Float64Array(countCells);
    for (let i = 0; i < countCells; i++) {
        const x = footprintX(voxels, i);
        const y = footprintY(voxels, i);
        let value = 0;
        for (const seed of seeds) {
            const weight = Math.min(maxWeight, seed.capacityN > 0 ? Math.max(1, seed.demandN / seed.capacityN) : 1);
            const dx = x - seed.x;
            const dy = y - seed.y;
            value += weight * Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
        }
        density[i] = value;
    }

    const chosen: ForceCoveringPoint[] = [];
    const nearestMm = new Float64Array(countCells).fill(Number.POSITIVE_INFINITY);
    for (let i = 0; i < countCells; i++) {
        const x = footprintX(voxels, i);
        const y = footprintY(voxels, i);
        let best = Number.POSITIVE_INFINITY;
        for (const tip of existingTips) {
            const dx = x - tip.x;
            const dy = y - tip.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        nearestMm[i] = Math.sqrt(best);
    }

    const used = new Uint8Array(countCells);
    for (let pick = 0; pick < count; pick++) {
        let bestIndex = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < countCells; i++) {
            if (used[i] || nearestMm[i] < minSpacing) continue;
            const score = density[i] * nearestMm[i];
            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) break;
        used[bestIndex] = 1;
        const x = footprintX(voxels, bestIndex);
        const y = footprintY(voxels, bestIndex);
        const z = footprintZ(voxels, bestIndex) ?? island.baseZ;
        chosen.push({ x, y, z, score: bestScore });
        for (let i = 0; i < countCells; i++) {
            const dx = footprintX(voxels, i) - x;
            const dy = footprintY(voxels, i) - y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < nearestMm[i]) nearestMm[i] = d;
        }
    }
    return chosen;
}
