import { footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import type { Vec3 } from '../types';

/** Longest free span the coverage proxy distinguishes (mm). */
export const MAX_FREE_SPAN_MM = 10;
/** Span at which a footprint yields to bending rather than to coverage alone. */
export const HIGH_LEVERAGE_SPAN_MM = 4;

const SPAN_BUCKET_MM = MAX_FREE_SPAN_MM;
const PLATE_EPSILON_MM = 0.5;

function bucketKey(cx: number, cy: number): number {
    return (cx + 4096) * 8192 + (cy + 4096);
}

/**
 * Plan-distance index over holding tips. One bucket is `MAX_FREE_SPAN_MM` on a
 * side, so a cell's 3×3 neighbourhood always contains every tip within the cap
 * and the probe is nine lookups regardless of forest density.
 */
export class HoldingTipIndex {
    private readonly buckets = new Map<number, Vec3[]>();

    constructor(tips: readonly Vec3[]) {
        for (const tip of tips) {
            const key = bucketKey(Math.floor(tip.x / SPAN_BUCKET_MM), Math.floor(tip.y / SPAN_BUCKET_MM));
            const bucket = this.buckets.get(key);
            if (bucket) bucket.push(tip);
            else this.buckets.set(key, [tip]);
        }
    }

    /** Plan distance to the nearest tip at or below `zMm`, capped at `MAX_FREE_SPAN_MM`. */
    nearestBelow(x: number, y: number, zMm: number): number {
        const cx = Math.floor(x / SPAN_BUCKET_MM);
        const cy = Math.floor(y / SPAN_BUCKET_MM);
        let best = MAX_FREE_SPAN_MM * MAX_FREE_SPAN_MM;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const bucket = this.buckets.get(bucketKey(cx + dx, cy + dy));
                if (!bucket) continue;
                for (const tip of bucket) {
                    if (tip.z > zMm + PLATE_EPSILON_MM) continue;
                    const ddx = x - tip.x;
                    const ddy = y - tip.y;
                    const d2 = ddx * ddx + ddy * ddy;
                    if (d2 < best) best = d2;
                }
            }
        }
        return Math.min(MAX_FREE_SPAN_MM, Math.sqrt(best));
    }
}

/** Worst plan distance from any footprint cell to a holding tip below it. */
export function freeSpanForRegion(region: DetectedIsland, index: HoldingTipIndex, fallbackZ: number): number {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return MAX_FREE_SPAN_MM;
    let worst = 0;
    for (let i = 0; i < voxels.count; i++) {
        const x = footprintX(voxels, i);
        const y = footprintY(voxels, i);
        const z = footprintZ(voxels, i) ?? fallbackZ;
        const span = index.nearestBelow(x, y, z);
        if (span > worst) {
            worst = span;
            if (worst >= MAX_FREE_SPAN_MM) break;
        }
    }
    return worst;
}

/** The footprint cell furthest from any holding tip below it. */
export function longestFreeSpanCell(
    region: DetectedIsland,
    index: HoldingTipIndex,
    fallbackZ: number,
): { cell: { x: number; y: number; z: number }; spanMm: number } | null {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return null;
    let best: { cell: { x: number; y: number; z: number }; spanMm: number } | null = null;
    for (let i = 0; i < voxels.count; i++) {
        const x = footprintX(voxels, i);
        const y = footprintY(voxels, i);
        const z = footprintZ(voxels, i) ?? fallbackZ;
        const spanMm = index.nearestBelow(x, y, z);
        if (!best || spanMm > best.spanMm) best = { cell: { x, y, z }, spanMm };
    }
    return best;
}
