import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { footprintBounds } from '../../volumeAnalysis/Islands/voxelFootprint';
import { computeRegionCoverage } from './coverage';

/**
 * First-cross-section ("island start") support recipe.
 *
 * Why this exists. Placement is overhang/area-driven: a candidate must clear
 * the perimeter/infill area floors or the 1.5 mm² gap-cluster floor, and the
 * generic dedupe drops anything within 3 mm in 3D of an existing contact. A
 * start is the opposite shape: it is the first cross-section of a detached
 * island, it has nothing below it, and its peel-initiation patch is often a
 * sub-5% corner that the overhang coverage target (95%) is designed to leave
 * alone. A start with too few contacts prints as a pancake: the first layers
 * peel off the plate before the island's own cross-section can carry anything.
 *
 * The recipe is deliberately separate from the overhang constants: one start
 * contact may be enough for a 0.3 mm² speck, but a 20 mm² flat start needs a
 * three-point base, and its coverage must be effectively complete, not 95%.
 */
export const START_SUPPORT_CONSTANTS = {
    /** A footprint at or below this is a speck: one contact carries it. */
    tinyMaxAreaMm2: 0.5,
    /** A footprint at or below this is small: two contacts form a base. */
    smallMaxAreaMm2: 3,
    tinyMinContacts: 1,
    smallMinContacts: 2,
    /** Anything larger needs a three-point base; a single trunk is a pancake. */
    largeMinContacts: 3,
    /** Starts are peel-initiation surfaces; the overhang 95% target is not enough. */
    coverageTarget: 0.99,
    /** Contacts on the same cross-section only. One layer (0.05 mm) plus snap/drift. */
    sameLayerBandMm: 0.25,
    /** Coverage discs: small footprint, dense patch; large footprint, wider base. */
    tinyRadiusMm: 1.2,
    smallRadiusMm: 1.8,
    largeRadiusMm: 2.5,
    /** Passes the start filler may run before it gives up. */
    maxPasses: 3,
} as const;

export interface StartRecipe {
    minContacts: number;
    coverageRadiusMm: number;
    coverageTarget: number;
}

/** The typed "this is an island start" marker decision. */
export function isStartIsland(island: DetectedIsland): boolean {
    if (island.startIsland !== undefined) return island.startIsland;
    // `isDetached` is the voxel scan's own "0-bridge to layer L-1 or L=0"
    // answer, and `contactVoxels`/`contact` are the BIRTH footprint, so the
    // detached island is the lowest connected cross-section by construction.
    return island.source === 'voxel' && island.isDetached === true;
}

/** Stamp every island so placement, reporting and tests share one definition. */
export function markStartIslands(islands: DetectedIsland[]): DetectedIsland[] {
    return islands.map((island) =>
        island.startIsland === undefined
            ? { ...island, startIsland: isStartIsland(island) }
            : island);
}

export function startRecipeForArea(areaMm2: number): StartRecipe {
    const c = START_SUPPORT_CONSTANTS;
    if (areaMm2 <= c.tinyMaxAreaMm2) {
        return { minContacts: c.tinyMinContacts, coverageRadiusMm: c.tinyRadiusMm, coverageTarget: c.coverageTarget };
    }
    if (areaMm2 <= c.smallMaxAreaMm2) {
        return { minContacts: c.smallMinContacts, coverageRadiusMm: c.smallRadiusMm, coverageTarget: c.coverageTarget };
    }
    return { minContacts: c.largeMinContacts, coverageRadiusMm: c.largeRadiusMm, coverageTarget: c.coverageTarget };
}

/** Tips that belong to the same cross-section as the start (same Z band). */
export function sameLayerStartTips<T extends { x: number; y: number; z: number }>(
    tips: readonly T[],
    baseZ: number,
    bandMm: number = START_SUPPORT_CONSTANTS.sameLayerBandMm,
): T[] {
    return tips.filter((tip) => Math.abs(tip.z - baseZ) <= bandMm);
}

/** Footprint area of a start, with a sensible fallback for point-only islands. */
export function startFootprintAreaMm2(island: DetectedIsland): number {
    if (island.areaMm2 && island.areaMm2 > 0) return island.areaMm2;
    const voxels = island.contactVoxels;
    if (voxels && voxels.count > 0) return voxels.count * 0.25 * 0.25;
    return 0.01;
}



/** Contacts that can actually touch this footprint (bbox padded by the disc). */
export function countIslandContacts(
    island: DetectedIsland,
    tips: ReadonlyArray<{ x: number; y: number; z: number }>,
    radiusMm: number,
): number {
    const bounds = island.contactVoxels ? footprintBounds(island.contactVoxels) : null;
    let contacts = 0;
    for (const tip of tips) {
        if (bounds) {
            if (tip.x >= bounds.minX - radiusMm && tip.x <= bounds.maxX + radiusMm
                && tip.y >= bounds.minY - radiusMm && tip.y <= bounds.maxY + radiusMm) {
                contacts += 1;
            }
        } else if (Math.hypot(tip.x - island.contact.x, tip.y - island.contact.y) <= radiusMm * 1.5) {
            contacts += 1;
        }
    }
    return contacts;
}

export interface StartSupportStatus {
    areaMm2: number;
    contacts: number;
    coverage: number;
    uncoveredAreaMm2: number;
    minContacts: number;
    pancakeRisk: boolean;
}

/** Recipe compliance for one start at the current draft. */
export function assessStartSupport(
    island: DetectedIsland,
    tips: ReadonlyArray<{ x: number; y: number; z: number }>,
    mesh?: unknown,
): StartSupportStatus {
    const areaMm2 = startFootprintAreaMm2(island);
    const recipe = startRecipeForArea(areaMm2);
    const sameLayer = sameLayerStartTips(tips, island.baseZ);
    const contacts = countIslandContacts(island, sameLayer, recipe.coverageRadiusMm);
    const voxels = island.contactVoxels;
    const coverage = voxels && voxels.count > 0
        ? computeRegionCoverage(island, sameLayer, recipe.coverageRadiusMm, mesh as never)
        : contacts > 0 ? 1 : 0;
    return {
        areaMm2,
        contacts,
        coverage,
        uncoveredAreaMm2: areaMm2 * Math.max(0, 1 - coverage),
        minContacts: recipe.minContacts,
        pancakeRisk: contacts < recipe.minContacts || coverage < recipe.coverageTarget,
    };
}
