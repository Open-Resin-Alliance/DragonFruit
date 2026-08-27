import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import type { SupportState } from '../types';
import { footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';

/** A tip covers surface within this radius (mm) — mirrors ALREADY_SUPPORTED_RADIUS_MM. */
export const TIP_COVERAGE_RADIUS_MM = 3.0;
/** Region coverage fraction at which no gap-filling is needed. */
export const REGION_COVERAGE_TARGET = 0.95;
/** Minimum uncovered cluster area (mm²) worth filling. */
export const MIN_GAP_CLUSTER_MM2 = 2.0;
/** Max gap-fill passes per run. */
export const MAX_GAP_FILL_PASSES = 3;

/** Collect support-tip world positions from a support snapshot. */
export function collectSupportTips(snapshot: SupportState): Array<{ x: number; y: number; z: number }> {
    const tips: Array<{ x: number; y: number; z: number }> = [];
    const push = (pos?: { x: number; y: number; z: number }) => {
        if (pos) tips.push(pos);
    };
    for (const t of Object.values(snapshot.trunks)) push(t.contactCone?.pos);
    for (const b of Object.values(snapshot.branches)) push(b.contactCone?.pos);
    for (const l of Object.values(snapshot.leaves)) push(l.contactCone?.pos);
    for (const a of Object.values(snapshot.anchors)) push(a.contactCone?.pos);
    return tips;
}

/**
 * Fraction of an overhang region's projected footprint covered by tips
 * (each tip covers a disc of `radiusMm`). This is the footprint-aware
 * coverage the convergence loop iterates on — a region whose centroid is
 * covered but whose edges are exposed reads as under-covered.
 */
export function computeRegionCoverage(
    region: DetectedIsland,
    tips: Array<{ x: number; y: number; z: number }>,
    radiusMm: number = TIP_COVERAGE_RADIUS_MM,
): number {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return 0;
    if (tips.length === 0) return 0;

    const r2 = radiusMm * radiusMm;
    let covered = 0;
    for (let i = 0; i < voxels.count; i++) {
        const vx = footprintX(voxels, i);
        const vy = footprintY(voxels, i);
        let hit = false;
        for (const tip of tips) {
            const dx = vx - tip.x;
            const dy = vy - tip.y;
            if (dx * dx + dy * dy <= r2) {
                hit = true;
                break;
            }
        }
        if (hit) covered++;
    }
    return covered / voxels.count;
}

/**
 * Uncovered clusters of an overhang region's footprint (BFS over footprint
 * voxels not covered by any tip). Returns cluster centroids with the surface
 * Z of the nearest voxel in the cluster.
 */
export function findUncoveredClusters(
    region: DetectedIsland,
    tips: Array<{ x: number; y: number; z: number }>,
    radiusMm: number = TIP_COVERAGE_RADIUS_MM,
    minClusterMm2: number = MIN_GAP_CLUSTER_MM2,
): Array<{ x: number; y: number; z: number }> {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return [];
    if (tips.length === 0) {
        // No tips at all — a single cluster covering everything is not useful;
        // return [] so the caller's main grid handles the region instead.
        return [];
    }

    const r2 = radiusMm * radiusMm;
    const isCovered = (v: { x: number; y: number; z?: number }): boolean => {
        for (const tip of tips) {
            const dx = v.x - tip.x;
            const dy = v.y - tip.y;
            if (dx * dx + dy * dy <= r2) return true;
        }
        return false;
    };

    // Bucket uncovered voxels by coarse cell for neighbor search.
    const cellSize = Math.max(0.5, radiusMm / 2);
    const uncovered = new Map<string, Array<{ x: number; y: number; z?: number }>>();
    const cells: Array<{ x: number; y: number; z?: number }> = [];
    for (let i = 0; i < voxels.count; i++) {
        const v = { x: footprintX(voxels, i), y: footprintY(voxels, i), z: footprintZ(voxels, i) ?? undefined };
        if (isCovered(v)) continue;
        const key = `${Math.floor(v.x / cellSize)},${Math.floor(v.y / cellSize)}`;
        let bucket = uncovered.get(key);
        if (!bucket) {
            bucket = [];
            uncovered.set(key, bucket);
        }
        bucket.push(v);
        cells.push(v);
    }

    const visited = new Set<number>();
    const clusters: Array<{ x: number; y: number; z: number }> = [];
    // Voxels sit on a 0.25mm grid; exact integer cell key → index for O(1)
    // neighbor lookup (avoids indexOf-per-neighbor O(n²) on big regions).
    const indexByKey = new Map<string, number>();
    cells.forEach((v, i) => {
        indexByKey.set(`${Math.round(v.x * 4)},${Math.round(v.y * 4)}`, i);
    });

    for (let i = 0; i < cells.length; i++) {
        if (visited.has(i)) continue;
        // BFS over the voxel set (voxels are at 0.25mm spacing; neighbors are
        // within 0.5mm).
        const stack = [i];
        visited.add(i);
        const cluster: Array<{ x: number; y: number; z?: number }> = [];
        while (stack.length) {
            const idx = stack.pop()!;
            const v = cells[idx];
            cluster.push(v);
            const kx = Math.round(v.x * 4);
            const ky = Math.round(v.y * 4);
            for (let ddx = -1; ddx <= 1; ddx++) {
                for (let ddy = -1; ddy <= 1; ddy++) {
                    if (ddx === 0 && ddy === 0) continue;
                    const ni = indexByKey.get(`${kx + ddx},${ky + ddy}`);
                    if (ni === undefined || visited.has(ni)) continue;
                    visited.add(ni);
                    stack.push(ni);
                }
            }
        }

        const areaMm2 = cluster.length * 0.25 * 0.25;
        if (areaMm2 < minClusterMm2) continue;

        // Centroid + surface Z from the nearest voxel to the centroid.
        let sumX = 0;
        let sumY = 0;
        for (const v of cluster) {
            sumX += v.x;
            sumY += v.y;
        }
        const cx = sumX / cluster.length;
        const cy = sumY / cluster.length;
        let best: { x: number; y: number; z?: number } | null = null;
        let bestD2 = Infinity;
        for (const v of cluster) {
            const d2 = (v.x - cx) ** 2 + (v.y - cy) ** 2;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = v;
            }
        }
        clusters.push({ x: cx, y: cy, z: best?.z ?? 0 });
    }

    return clusters;
}

/**
 * Build gap-fill candidates for under-covered overhang regions: standalone
 * trunk candidates (gridPoint) at uncovered footprint cluster centroids,
 * using the region's surface normal so placement skips the wrong-face raycast.
 */
export function buildGapFillCandidates(
    overhangIslands: DetectedIsland[],
    settings: AutoSupportSettings,
    tips: Array<{ x: number; y: number; z: number }>,
): CandidatePoint[] {
    const out: CandidatePoint[] = [];
    const coverageTarget = (settings.coverageTargetPercent ?? 95) / 100;
    for (const region of overhangIslands) {
        if (region.source !== 'overhang') continue;
        if (!region.contactVoxels || region.contactVoxels.count === 0) continue;
        if (computeRegionCoverage(region, tips) >= coverageTarget) continue;

        const clusters = findUncoveredClusters(region, tips);
        for (const c of clusters) {
            out.push({
                id: `gap-${region.id}-${c.x.toFixed(2)}-${c.y.toFixed(2)}`,
                tipPos: { x: c.x, y: c.y, z: c.z },
                tipNormal: region.surfaceNormal ?? { x: 0, y: 0, z: -1 },
                modelId: '',
                source: 'overhang',
                islandAreaMm2: settings.areaPerSupportMm2,
                zHeight: c.z,
                priority: 0,
                gridPoint: true,
            });
        }
    }
    return out;
}
