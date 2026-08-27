import { footprintToPoints, footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import { cellKey } from '@/volumeAnalysis/Islands/spatialHashGrid2D';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import {
    computeRegionSpacing,
    buildBoundaryPoints,
    erodeFootprint,
    PERIMETER_SPACING_FLOOR_MM,
    MAX_GRID_CANDIDATES_PER_REGION,
} from './gridPlacement';

/** Footprint-mask pixels are emitted at 0.25 mm spacing; a point within this
 *  distance of a mask pixel counts as inside the region. */
const FOOTPRINT_TOLERANCE_MM = 0.25;

/** Bridson candidates per active point. */
const BRIDSON_CANDIDATES = 30;

/**
 * Shape metric for distribution dispatch: standard deviation of LOCAL surface
 * angle (degrees) over the region's footprint, from finite differences on
 * `surfaceZ` (0.25 mm voxel spacing).
 *
 * - Planar region (flat or uniformly tilted): local angle ≈ constant → std ≈ 0
 *   → the dynamic grid fits (clean rows, boundary ring).
 * - Organic/curved region (dome, saddle, rounded foot): local angle varies
 *   across the footprint → std high → Poisson disk (no lattice rows, uniform
 *   min-separation, follows curvature).
 *
 * Regions without surface-Z data (voxel-detected) read as planar. Pure and
 * deterministic — unit-tested.
 */
export function computeRegionFlatnessDeg(region: DetectedIsland): number {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count < 4) return 0;

    const indexByKey = new Map<number, number>();
    for (let i = 0; i < voxels.count; i++) {
        indexByKey.set(cellKey(Math.round(footprintX(voxels, i) * 4), Math.round(footprintY(voxels, i) * 4)), i);
    }

    const angles: number[] = [];
    for (let i = 0; i < voxels.count; i++) {
        const vz = footprintZ(voxels, i);
        if (vz == null) continue;
        const kx = Math.round(footprintX(voxels, i) * 4);
        const ky = Math.round(footprintY(voxels, i) * 4);
        let dzMax = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const ni = indexByKey.get(cellKey(kx + dx, ky + dy));
            if (ni === undefined) continue;
            const nz = footprintZ(voxels, ni);
            if (nz == null) continue;
            const dz = Math.abs(nz - vz);
            if (dz > dzMax) dzMax = dz;
        }
        if (dzMax > 0) angles.push((Math.atan2(dzMax, 0.25) * 180) / Math.PI);
    }

    if (angles.length === 0) return 0;
    const mean = angles.reduce((s, a) => s + a, 0) / angles.length;
    const variance = angles.reduce((s, a) => s + (a - mean) * (a - mean), 0) / angles.length;
    return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (per-region seed) — auto runs must reproduce for
// undo/history equality and tests.
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string → PRNG seed. */
function hashSeed(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// Poisson-disk placement — the anchor treatment
// ---------------------------------------------------------------------------

/**
 * Poisson-disk placement for overhang regions.
 *
 * The anchor layer of a fully-supported print — the model's lowest contact
 * patches — is load-bearing: peel initiates at the region boundary and the
 * peel front propagates inward, so the perimeter engages first and takes the
 * instantaneous spike. The dynamic grid is the wrong tool there: an
 * axis-aligned lattice leaves diagonal gaps (√2× the spacing), forms aligned
 * rows that read as peel lines, and does not hug curved boundaries.
 *
 * This sampler places:
 *  - a guaranteed PERIMETER RING on the footprint boundary at
 *    `perimeterSpacing` (interior × anchorPerimeterFactor — tighter; the dense
 *    edge skirt that takes the first peel spike);
 *  - a Poisson-disk INFILL at `interiorSpacing` (the shared region spacing,
 *    see computeRegionSpacing) — uniform min-separation, no rows, no holes.
 *
 * Anchor regions (in `anchorIds`) also BYPASS the grid area threshold — a
 * small foot is still load-bearing and must be densified, not single-supported.
 *
 * Deterministic (seeded PRNG per region). Emits the same CandidatePoint
 * contract as the grid phase (gridPoint: true, region surface normal/Z) so
 * placement, coverage, and fanning run unchanged.
 */
export function generatePoissonCandidates(
    overhangIslands: DetectedIsland[],
    settings: AutoSupportSettings,
    anchorScaleById: ReadonlyMap<string, number>,
    anchorIds: ReadonlySet<string>,
): CandidatePoint[] {
    const candidates: CandidatePoint[] = [];

    for (const island of overhangIslands) {
        if (island.source !== 'overhang') continue;
        const area = island.areaMm2 ?? 0;
        const isAnchor = anchorIds.has(island.id);
        if (area < settings.gridAreaThresholdMm2 && !isAnchor) continue;

        const anchorScale = anchorScaleById.get(island.id) ?? 1;
        const interiorSpacing = computeRegionSpacing(island, settings, anchorScale)
            * (settings.poissonSpacingFactor ?? 1);
        const perimeterSpacing = Math.max(
            PERIMETER_SPACING_FLOOR_MM,
            interiorSpacing * (isAnchor ? (settings.anchorPerimeterFactor ?? 0.8) : 1),
        );

        const voxels = island.contactVoxels;
        if (!voxels || voxels.count === 0) continue;

        // Footprint bbox + spatial hash for containment / nearest-voxel Z.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const cellSize = Math.max(interiorSpacing, 1.0);
        const hash = new Map<string, Array<{ x: number; y: number; z?: number }>>();
        for (let vi = 0; vi < voxels.count; vi++) {
            // The bucket keeps point objects, but only for the duration of this
            // placement run — the footprint itself stays packed.
            const p = { x: footprintX(voxels, vi), y: footprintY(voxels, vi), z: footprintZ(voxels, vi) ?? undefined };
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
            const cx = Math.floor(p.x / cellSize);
            const cy = Math.floor(p.y / cellSize);
            const key = `${cx},${cy}`;
            let bucket = hash.get(key);
            if (!bucket) {
                bucket = [];
                hash.set(key, bucket);
            }
            bucket.push({ x: p.x, y: p.y, z: p.z });
        }

        const minZ = island.baseZ;
        const tolSq = FOOTPRINT_TOLERANCE_MM * FOOTPRINT_TOLERANCE_MM;
        const surfaceNormal = island.surfaceNormal ?? { x: 0, y: 0, z: -1 };

        const surfaceAt = (x: number, y: number): { z: number } | null => {
            const gx = Math.floor(x / cellSize);
            const gy = Math.floor(y / cellSize);
            let bestD2 = Infinity;
            let bestZ = minZ;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const bucket = hash.get(`${gx + dx},${gy + dy}`);
                    if (!bucket) continue;
                    for (const p of bucket) {
                        const ddx = x - p.x;
                        const ddy = y - p.y;
                        const d2 = ddx * ddx + ddy * ddy;
                        if (d2 <= tolSq && d2 < bestD2) {
                            bestD2 = d2;
                            if (p.z != null) bestZ = p.z;
                        }
                    }
                }
            }
            return bestD2 <= tolSq ? { z: bestZ } : null;
        };

        const rand = mulberry32(hashSeed(island.id));

        // Accepted points + the Bridson background grid (cell = r/√2).
        type Sample = { x: number; y: number; z: number; kind: 'perimeter' | 'infill' };
        const accepted: Sample[] = [];
        const gridCell = interiorSpacing / Math.SQRT2;
        const bg = new Map<string, number>();
        const minDistSq = interiorSpacing * interiorSpacing;

        const canAccept = (x: number, y: number): boolean => {
            const kx = Math.floor(x / gridCell);
            const ky = Math.floor(y / gridCell);
            for (let dx = -2; dx <= 2; dx++) {
                for (let dy = -2; dy <= 2; dy++) {
                    const idx = bg.get(`${kx + dx},${ky + dy}`);
                    if (idx === undefined) continue;
                    const p = accepted[idx];
                    const ddx = x - p.x;
                    const ddy = y - p.y;
                    if (ddx * ddx + ddy * ddy < minDistSq) return false;
                }
            }
            return true;
        };

        const insert = (s: Sample): void => {
            accepted.push(s);
            bg.set(`${Math.floor(s.x / gridCell)},${Math.floor(s.y / gridCell)}`, accepted.length - 1);
        };

        // 1. Perimeter ring — guaranteed retained (denser than the interior).
        //    Generated on the ERODED footprint so the contact disc sits fully
        //    on the surface, not half past the region edge (half in air).
        const voxelPoints = footprintToPoints(voxels);
        const eroded = erodeFootprint(voxelPoints);
        for (const b of buildBoundaryPoints(eroded.length > 0 ? eroded : voxelPoints, perimeterSpacing, minZ)) {
            insert({ x: b.x, y: b.y, z: b.z, kind: 'perimeter' });
        }

        // 2. Interior Poisson-disk infill (Bridson). Seeds: the region
        //    centroid (if inside) plus every perimeter point, so interior
        //    candidates generate inward from the boundary.
        const active: number[] = [];
        for (let i = 0; i < accepted.length; i++) active.push(i);
        const centroidZ = surfaceAt((minX + maxX) / 2, (minY + maxY) / 2);
        if (centroidZ) {
            insert({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: centroidZ.z, kind: 'infill' });
            active.push(accepted.length - 1);
        }

        while (active.length > 0 && accepted.length < MAX_GRID_CANDIDATES_PER_REGION) {
            const pos = Math.floor(rand() * active.length);
            const p = accepted[active[pos]];
            let placed = false;
            for (let k = 0; k < BRIDSON_CANDIDATES; k++) {
                const angle = rand() * Math.PI * 2;
                const dist = interiorSpacing * (1 + rand());
                const cx = p.x + Math.cos(angle) * dist;
                const cy = p.y + Math.sin(angle) * dist;
                const s = surfaceAt(cx, cy);
                if (!s || !canAccept(cx, cy)) continue;
                insert({ x: cx, y: cy, z: s.z, kind: 'infill' });
                active.push(accepted.length - 1);
                placed = true;
                break;
            }
            if (!placed) {
                active[pos] = active[active.length - 1];
                active.pop();
            }
        }

        // 3. Cap: keep every perimeter point, subsample the infill evenly if
        //    the cap was hit (never silently denser than MAX_GRID_CANDIDATES).
        const perimCount = accepted.reduce((n, s) => n + (s.kind === 'perimeter' ? 1 : 0), 0);
        const infillCount = accepted.length - perimCount;
        const infillStride = accepted.length > MAX_GRID_CANDIDATES_PER_REGION
            ? Math.max(1, Math.ceil(infillCount / Math.max(1, MAX_GRID_CANDIDATES_PER_REGION - perimCount)))
            : 1;

        let infillSeen = 0;
        for (const s of accepted) {
            if (s.kind === 'infill') {
                infillSeen++;
                if (infillStride > 1 && infillSeen % infillStride !== 0) continue;
            }
            candidates.push({
                id: `${s.kind === 'perimeter' ? 'perim' : 'poisson'}-${island.id}-${s.x.toFixed(2)}-${s.y.toFixed(2)}`,
                tipPos: { x: s.x, y: s.y, z: s.z },
                tipNormal: surfaceNormal,
                modelId: '',
                source: 'overhang',
                islandAreaMm2: settings.areaPerSupportMm2,
                zHeight: s.z,
                priority: 0,
                gridPoint: true,
                anchorPoint: isAnchor,
            });
        }
    }

    return candidates;
}
