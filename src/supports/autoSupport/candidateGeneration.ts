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
    // Note: grounded/plate-contact filtering is handled upstream by the
    // Islands panel's Plate toggle — filteredIslands already reflects it.
    const eligible = islands.filter(island => {
        // Minima islands don't have area — they represent sharp geometric
        // features that need support regardless of size.
        const isMinima = island.source === 'minima' && island.class === 'minimaOnly';
        if (!isMinima) {
            const area = island.areaMm2 ?? 0;
            if (area < settings.minIslandAreaMm2) return false;
        }
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
    // Minima islands don't have an area — use a default so they get
    // scored and prioritized alongside voxel islands.
    const area = island.areaMm2 ?? (island.source === 'minima' ? 0.05 : 0);
    const z = island.baseZ;
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
        priority: 0, // computed later
    };
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
 * Candidates within tipInfluenceRadiusMm (3D distance) of a higher-priority
 * candidate are removed. The Z axis participates so vertically stacked
 * overhangs at the same XY (staircases, shelves) keep their own supports
 * instead of being merged into one.
 */
export function deduplicateCandidates(
    candidates: CandidatePoint[],
    settings: AutoSupportSettings,
): CandidatePoint[] {
    if (candidates.length <= 1) return candidates;

    const radius = settings.tipInfluenceRadiusMm;
    if (radius <= 0) return [...candidates].sort((a, b) => b.priority - a.priority);
    const radiusSq = radius * radius;
    const cellSize = radius;

    // Bucket by XY cell. Any candidate within `radius` of a cell's contents
    // lives in that cell or one of its 8 neighbors.
    const grid = new Map<string, CandidatePoint[]>();
    const cellOf = (c: CandidatePoint): string => {
        const cx = Math.round(c.tipPos.x / cellSize);
        const cy = Math.round(c.tipPos.y / cellSize);
        return `${cx},${cy}`;
    };
    for (const c of candidates) {
        const key = cellOf(c);
        const bucket = grid.get(key);
        if (bucket) {
            bucket.push(c);
        } else {
            grid.set(key, [c]);
        }
    }

    const sorted = [...candidates].sort((a, b) => b.priority - a.priority);
    const retained: CandidatePoint[] = [];

    for (const c of sorted) {
        const [cxStr, cyStr] = cellOf(c).split(',');
        const cx = parseInt(cxStr);
        const cy = parseInt(cyStr);

        let duplicate = false;
        for (let dx = -1; dx <= 1 && !duplicate; dx++) {
            for (let dy = -1; dy <= 1 && !duplicate; dy++) {
                const bucket = grid.get(`${cx + dx},${cy + dy}`);
                if (!bucket) continue;
                for (const r of retained) {
                    // Only candidates bucketed here can be this close.
                    if (!bucket.some((rr) => rr.id === r.id)) continue;
                    const ddx = c.tipPos.x - r.tipPos.x;
                    const ddy = c.tipPos.y - r.tipPos.y;
                    const ddz = c.tipPos.z - r.tipPos.z;
                    if (ddx * ddx + ddy * ddy + ddz * ddz <= radiusSq) {
                        duplicate = true;
                        break;
                    }
                }
            }
        }

        if (!duplicate) retained.push(c);
    }

    return retained.sort((a, b) => b.priority - a.priority);
}
