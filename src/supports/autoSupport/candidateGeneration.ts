import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';

/**
 * Convert detected islands into auto-support candidate points.
 * Filters out already-supported, grounded, and too-small islands.
 * Scores candidates by priority and sorts descending.
 */
export function generateCandidates(
    islands: DetectedIsland[],
    settings: AutoSupportSettings,
): CandidatePoint[] {
    if (!islands || islands.length === 0) return [];

    // Filter
    const eligible = islands.filter(island => {
        if (island.supported === true) return false;
        if (island.grounded === true) return false;
        const area = island.areaMm2 ?? 0;
        if (area < settings.minIslandAreaMm2) return false;
        return true;
    });

    // Map to candidates
    const candidates = eligible.map(island => candidateFromIsland(island));

    // Score and sort
    if (candidates.length === 0) return [];

    const maxZ = Math.max(...candidates.map(c => c.zHeight), 1);
    const maxArea = Math.max(...candidates.map(c => c.islandAreaMm2), 0.01);
    for (const c of candidates) {
        c.priority = computePriority(c, maxZ, maxArea, settings);
    }

    candidates.sort((a, b) => b.priority - a.priority);
    return candidates;
}

/**
 * Create a CandidatePoint from a single DetectedIsland.
 * The modelId and tipNormal are left as placeholders — the caller
 * must fill them in before building supports.
 */
export function candidateFromIsland(island: DetectedIsland): CandidatePoint {
    const area = island.areaMm2 ?? 0;
    const z = island.baseZ;
    const overhangAngle = estimateOverhangAngle(island);
    const source: CandidatePoint['source'] =
        island.class === 'intersection' ? 'intersection' : island.source;

    return {
        id: island.id,
        tipPos: {
            x: island.contact.x,
            y: island.contact.y,
            z: island.contact.z,
        },
        tipNormal: { x: 0, y: 0, z: -1 }, // placeholder — caller raycasts for real normal
        modelId: '', // placeholder — caller fills in
        source,
        islandAreaMm2: area,
        zHeight: z,
        overhangAngleDeg: overhangAngle,
        priority: 0, // computed later
    };
}

/**
 * Estimate overhang angle from horizontal in degrees.
 * Uses layer span and area to approximate: flatter overhangs have
 * larger area relative to their layer span.
 * Falls back to 45° if insufficient data.
 */
export function estimateOverhangAngle(island: DetectedIsland): number {
    const area = island.areaMm2;
    const span = island.layerSpan;
    if (area != null && area > 0 && span != null && span[1] > span[0]) {
        const layerCount = span[1] - span[0];
        if (layerCount > 0) {
            const layerHeightMm = 0.05; // typical resin layer height
            const totalHeight = layerCount * layerHeightMm;
            const equivalentRadius = Math.sqrt(area / Math.PI);
            if (equivalentRadius > 0) {
                const angleRad = Math.atan2(totalHeight, equivalentRadius);
                const angleDeg = 90 - (angleRad * 180) / Math.PI;
                return Math.min(90, Math.max(15, angleDeg));
            }
        }
    }
    return 45; // default
}

/**
 * Compute placement priority score.
 * Higher = more urgent to place supports.
 * Weight: 60% area, 30% Z-height (lower = more urgent), 10% source bonus.
 */
function computePriority(
    c: CandidatePoint,
    maxZ: number,
    maxArea: number,
    settings: AutoSupportSettings,
): number {
    const areaScore = (c.islandAreaMm2 / Math.max(maxArea, 0.01)) * 0.6;
    const zScore = (1 - c.zHeight / Math.max(maxZ, 1)) * 0.3;
    const sourceScore = c.source === 'intersection' ? 0.1 : 0;
    let priority = areaScore + zScore + sourceScore;
    if (settings.prioritizeIntersection && c.source === 'intersection') {
        priority *= 1.5;
    }
    return priority;
}

/**
 * Deduplicate candidates using a spatial hash grid.
 * Candidates within tipInfluenceRadiusMm of a higher-priority candidate
 * are removed.
 */
export function deduplicateCandidates(
    candidates: CandidatePoint[],
    settings: AutoSupportSettings,
): CandidatePoint[] {
    if (candidates.length <= 1) return candidates;

    const cellSize = settings.tipInfluenceRadiusMm;
    const grid = new Map<string, CandidatePoint[]>();

    // Bucket by cell
    for (const c of candidates) {
        const cx = Math.round(c.tipPos.x / cellSize);
        const cy = Math.round(c.tipPos.y / cellSize);
        const key = `${cx},${cy}`;
        const bucket = grid.get(key);
        if (bucket) {
            bucket.push(c);
        } else {
            grid.set(key, [c]);
        }
    }

    const retained = new Set<string>();
    const allCells = [...grid.entries()];

    // Within each cell, keep only the highest-priority candidate
    for (const [, cellCandidates] of allCells) {
        cellCandidates.sort((a, b) => b.priority - a.priority);
        retained.add(cellCandidates[0].id);
    }

    // Cross-cell dedup: check adjacent cells
    const radiusSq = cellSize * cellSize;
    for (const [key, cellCandidates] of allCells) {
        const [cxStr, cyStr] = key.split(',');
        const cx = parseInt(cxStr);
        const cy = parseInt(cyStr);

        const keeper = cellCandidates[0];
        if (!retained.has(keeper.id)) continue;

        // Check 8 neighbor cells
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const neighborKey = `${cx + dx},${cy + dy}`;
                const neighbors = grid.get(neighborKey);
                if (!neighbors) continue;

                for (const neighbor of neighbors) {
                    if (!retained.has(neighbor.id)) continue;
                    const distSq =
                        (keeper.tipPos.x - neighbor.tipPos.x) ** 2 +
                        (keeper.tipPos.y - neighbor.tipPos.y) ** 2;
                    if (distSq <= radiusSq) {
                        // Remove the lower-priority one
                        if (keeper.priority >= neighbor.priority) {
                            retained.delete(neighbor.id);
                        } else {
                            retained.delete(keeper.id);
                        }
                    }
                }
            }
        }
    }

    return candidates
        .filter(c => retained.has(c.id))
        .sort((a, b) => b.priority - a.priority);
}
