import { footprintToPoints, footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import {
    OVERHANG_SELF_SUPPORT_ANGLE_DEG,
    GRID_SPACING_MIN_FACTOR,
    GRID_SPACING_MAX_FACTOR,
} from './constants';

/** Footprint-mask pixels are emitted at 0.25 mm spacing; a grid point within
 *  this distance of a mask pixel counts as inside the region. */
const FOOTPRINT_TOLERANCE_MM = 0.25;

/**
 * Boundary voxels of a region's footprint (mask voxel with a missing
 * 8-neighbor), in deterministic loop order (sorted by angle around the
 * footprint centroid), sub-sampled at `spacing` intervals. Used by the
 * boundary-fill pass: the dynamic grid's outer ring covers straight edges
 * exactly; fill only where the boundary curves away from the lattice
 * (corners, holes, rotated edges) and no grid point is within `spacing`.
 */
export function buildBoundaryPoints(
    voxels: Array<{ x: number; y: number; z?: number }>,
    spacing: number,
    fallbackZ: number,
): Array<{ x: number; y: number; z: number }> {
    if (voxels.length === 0) return [];
    const set = new Set<string>();
    let sumX = 0;
    let sumY = 0;
    for (const v of voxels) {
        set.add(`${Math.round(v.x * 4)},${Math.round(v.y * 4)}`);
        sumX += v.x;
        sumY += v.y;
    }
    const cx = sumX / voxels.length;
    const cy = sumY / voxels.length;

    const boundary: Array<{ x: number; y: number; z?: number }> = [];
    for (const v of voxels) {
        const kx = Math.round(v.x * 4);
        const ky = Math.round(v.y * 4);
        let onEdge = false;
        for (let dx = -1; dx <= 1 && !onEdge; dx++) {
            for (let dy = -1; dy <= 1 && !onEdge; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (!set.has(`${kx + dx},${ky + dy}`)) onEdge = true;
            }
        }
        if (onEdge) boundary.push(v);
    }
    if (boundary.length === 0) return [];

    boundary.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const step = Math.max(1, Math.round(spacing / 0.25));
    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < boundary.length; i += step) {
        pts.push({ x: boundary[i].x, y: boundary[i].y, z: boundary[i].z ?? fallbackZ });
    }
    return pts;
}

/** Absolute floor on grid/poisson spacing (mm) — no combination of factors may
 *  push past proven commercial practice (heaviest documented preset ≈ 1.5 mm). */
export const GRID_SPACING_FLOOR_MM = 1.2;

/** Perimeter contact inset (mm): a support centered ON the region boundary
 *  hangs half its contact disc past the edge — half attached to air. The
 *  perimeter ring (and grid outer ring / boundary fill) is generated on the
 *  footprint ERODED by this amount (1 mask pixel = 0.25 mm): covers the max
 *  standard tip-contact radius (anchor 0.4 mm → 0.2 mm) plus a 0.05 mm
 *  margin — fully on the surface, not over-inset. */
export const PERIMETER_CONTACT_INSET_MM = 0.25;

/** Mask pixels eroded per side = PERIMETER_CONTACT_INSET_MM / 0.25. */
const PERIMETER_ERODE_PIXELS = 1;

/**
 * Interior voxels of a footprint: mask pixels whose 2-pixel neighborhood is
 * fully present (morphological erosion). The region shrunken so a support
 * centered on its boundary keeps its whole contact disc on the surface.
 * Erosion (not centroid offsetting) so concave edges and holes inset in the
 * correct local direction. Empty for regions thinner than the inset — callers
 * fall back to the raw boundary.
 */
export function erodeFootprint(voxels: Array<{ x: number; y: number; z?: number }>): Array<{ x: number; y: number; z?: number }> {
    const set = new Set<string>();
    for (const p of voxels) set.add(`${Math.round(p.x * 4)},${Math.round(p.y * 4)}`);
    const interior: Array<{ x: number; y: number; z?: number }> = [];
    for (const p of voxels) {
        const kx = Math.round(p.x * 4);
        const ky = Math.round(p.y * 4);
        let all = true;
        for (let dx = -PERIMETER_ERODE_PIXELS; dx <= PERIMETER_ERODE_PIXELS && all; dx++) {
            for (let dy = -PERIMETER_ERODE_PIXELS; dy <= PERIMETER_ERODE_PIXELS && all; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (!set.has(`${kx + dx},${ky + dy}`)) all = false;
            }
        }
        if (all) interior.push(p);
    }
    return interior;
}

/** Floor on the Poisson PERIMETER ring spacing (mm). The perimeter is
 *  deliberately tighter than the interior (edge supports engage peel first);
 *  this floor is the only thing stopping it from fusing. */
export const PERIMETER_SPACING_FLOOR_MM = 1.0;

/** Per-region candidate cap: the placement pipeline pathfinds every candidate
 *  synchronously, so densification must never silently exceed this. */
export const MAX_GRID_CANDIDATES_PER_REGION = 800;

/**
 * Target spacing for a region — the shared density formula used by the grid
 * phase (and later the Poisson sampler). Empirical curve, no load model:
 *
 *   spacing = max(floor, √areaPerSupport × (flat + angleT × (relax − flat)) × anchor)
 *   flat    = flatDensityBoost × (threshold / area)^suctionAreaExponent   (area > threshold)
 *
 * - Angle term: flat ceilings (0°) densest, slopes at the self-support angle
 *   sparsest — direction from peel physics (force ∝ cross-section), values are
 *   calibration knobs.
 * - Suction term: large shallow ceilings densify sublinearly with projected
 *   area (peel grows with cross-section; direction physical, curve empirical).
 * - Anchor term: per-contact-patch anchor bands (anchorBands.ts) densify the
 *   first-printed underside of a fully-supported print.
 */
export function computeRegionSpacing(
    island: DetectedIsland,
    settings: AutoSupportSettings,
    anchorScale: number,
): number {
    const baseSpacing = Math.sqrt(Math.max(settings.areaPerSupportMm2, 0.5));
    const selfSupportAngleDeg = settings.overhangSelfSupportAngleDeg
        ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG;
    const angleT = Math.min(1, Math.max(0,
        (island.overhangAngleDeg ?? 0) / selfSupportAngleDeg));
    const minFactor = settings.flatDensityBoost ?? GRID_SPACING_MIN_FACTOR;
    const maxFactor = settings.slopeRelaxFactor ?? GRID_SPACING_MAX_FACTOR;

    if (anchorScale < 1) {
        // Anchor regions: the anchor factor OWNS the flat-end density — it
        // replaces flatDensityBoost and the suction area scale, so the user's
        // preset density is respected instead of three sub-1 factors
        // compounding into the floor (observed over-supply: light preset
        // crushed to the 1.2 mm floor). The anchor treatment's extra density
        // comes from the Poisson perimeter ring and the threshold bypass,
        // not from stacking spacing factors.
        const anchorFlat = settings.anchorSpacingFactor ?? minFactor;
        const spacing = baseSpacing * (anchorFlat + angleT * (maxFactor - anchorFlat));
        return Math.max(GRID_SPACING_FLOOR_MM, spacing);
    }

    const area = island.areaMm2 ?? 0;
    const threshold = settings.gridAreaThresholdMm2;
    const exponent = settings.suctionAreaExponent ?? 0;
    const areaScale = exponent > 0 && area > threshold
        ? Math.pow(threshold / area, exponent)
        : 1;

    const flatFactor = minFactor * areaScale;
    const spacing = baseSpacing
        * (flatFactor + angleT * (maxFactor - flatFactor));
    return Math.max(GRID_SPACING_FLOOR_MM, spacing);
}

/**
 * Density-grid placement (redesign step 3 — the grid phase).
 *
 * Large flat overhang regions get a DYNAMIC-SPACING grid: the target spacing
 * (√areaPerSupportMm2 × an angle factor) is adjusted per axis so the grid
 * spans the region's full footprint with integer rows/columns — never cut off
 * by a leftover margin. The spacing factor is angle-aware: flat anchor
 * surfaces (0° — a model's feet/underside) grid at 0.7× spacing (≈2× the
 * supports), slopes at the self-support threshold (45°) at 1.3× (≈0.6×). The
 * outer ring lands exactly on the region bbox boundary, so straight edges are
 * supported by the grid itself; a boundary-fill pass adds supports only where
 * the boundary curves away from the lattice (corners, holes, rotated edges)
 * and no grid point is within `spacing`.
 *
 * Each point is:
 *  - contained: only points inside the region's footprint mask are emitted;
 *  - given the region's TRUE surface Z (from the classifier's per-pixel
 *    `surfaceZ`, interpolated on the region's own triangles);
 *  - a standalone trunk candidate (`gridPoint: true`).
 *
 * From there the regular placement pipeline takes over unchanged:
 * `buildTrunkData` (SmartPlacementV2) pathfinds the shaft to the plate, and
 * `decideGridPlacement` commits it.
 *
 * Regions below `gridAreaThresholdMm2` are skipped — they get a single
 * support via the regular per-island candidate path (the region phase).
 */
export function generateGridCandidates(
    overhangIslands: DetectedIsland[],
    settings: AutoSupportSettings,
    anchorScaleById?: ReadonlyMap<string, number>,
    minAreaBypassIds?: ReadonlySet<string>,
): CandidatePoint[] {
    const baseSpacing = Math.sqrt(Math.max(settings.areaPerSupportMm2, 0.5));
    if (baseSpacing <= 0) return [];
    const threshold = settings.gridAreaThresholdMm2;

    const candidates: CandidatePoint[] = [];

    for (const island of overhangIslands) {
        if (island.source !== 'overhang') continue;
        const area = island.areaMm2 ?? 0;
        // Anchor regions (in-band) bypass the grid threshold — a small foot is
        // still a load-bearing anchor and must be densified, not single-supported.
        if (area < threshold && !minAreaBypassIds?.has(island.id)) continue;

        // Density factors: angle (flat = densest, self-support slope =
        // sparsest), suction area scaling, and the per-patch anchor band.
        const anchorScale = anchorScaleById?.get(island.id) ?? 1;
        let spacing = computeRegionSpacing(island, settings, anchorScale);

        const voxels = island.contactVoxels;
        if (!voxels || voxels.count === 0) continue;

        // Footprint bbox + spatial hash for containment / nearest-voxel Z.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const cellSize = Math.max(spacing, 1.0);
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

        // Resolve the region surface Z at a point via the nearest footprint
        // voxel. Returns null when the point is outside the region.
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

        const emitPoint = (x: number, y: number, z: number, kind: 'grid' | 'fill') => {
            candidates.push({
                id: `${kind}-${island.id}-${x.toFixed(2)}-${y.toFixed(2)}`,
                tipPos: { x, y, z },
                tipNormal: surfaceNormal,
                modelId: '',
                source: 'overhang',
                islandAreaMm2: settings.areaPerSupportMm2,
                zHeight: z,
                priority: 0,
                gridPoint: true,
                anchorPoint: anchorScale < 1,
            });
        };

        // Dynamic spacing: adjust per axis so the grid spans the full region
        // with integer rows/columns — never cut off by a leftover margin.
        // The lattice and boundary fill are INSET by the contact radius so a
        // support never hangs half its contact disc past the region edge.
        const width = maxX - minX;
        const height = maxY - minY;
        const inset = PERIMETER_CONTACT_INSET_MM;
        const spanX = Math.max(0.5, width - 2 * inset);
        const spanY = Math.max(0.5, height - 2 * inset);

        // Candidate-cap guard: densification must never produce more than
        // MAX_GRID_CANDIDATES_PER_REGION points per region (each one is
        // pathfinded synchronously). On overflow, fall back to the base
        // angle-only spacing (no anchor, no suction), then subsample evenly
        // if it still overflows — never silently denser than the cap.
        let stride = 1;
        const estimate = (Math.floor(spanX / spacing) + 2) * (Math.floor(spanY / spacing) + 2);
        if (estimate > MAX_GRID_CANDIDATES_PER_REGION) {
            spacing = computeRegionSpacing(island, { ...settings, suctionAreaExponent: 0 }, 1);
            const baseEstimate = (Math.floor(spanX / spacing) + 2) * (Math.floor(spanY / spacing) + 2);
            if (baseEstimate > MAX_GRID_CANDIDATES_PER_REGION) {
                stride = Math.ceil(baseEstimate / MAX_GRID_CANDIDATES_PER_REGION);
            }
        }

        const nx = Math.max(1, Math.round(spanX / spacing));
        const ny = Math.max(1, Math.round(spanY / spacing));
        const spacingX = spanX / nx;
        const spacingY = spanY / ny;
        const gridSpacing = Math.max(spacingX, spacingY);

        const lattice: Array<{ x: number; y: number; z: number }> = [];
        for (let i = 0; i <= nx; i += stride) {
            for (let j = 0; j <= ny; j += stride) {
                const x = minX + inset + i * spacingX;
                const y = minY + inset + j * spacingY;
                const s = surfaceAt(x, y);
                if (s) {
                    const pt = { x, y, z: s.z };
                    lattice.push(pt);
                    emitPoint(x, y, s.z, 'grid');
                }
            }
        }

        // Boundary-fill: where the boundary curves away from the lattice
        // (corners, holes, rotated edges) and no grid point is within
        // `gridSpacing`, add a support on the ERODED boundary — the contact
        // disc stays fully on the surface.
        const spacingSq = gridSpacing * gridSpacing;
        const voxelPoints = footprintToPoints(voxels);
        const eroded = erodeFootprint(voxelPoints);
        const boundary = buildBoundaryPoints(eroded.length > 0 ? eroded : voxelPoints, spacing * stride, minZ);
        for (const b of boundary) {
            let covered = false;
            for (const p of lattice) {
                const dx = b.x - p.x;
                const dy = b.y - p.y;
                if (dx * dx + dy * dy <= spacingSq) {
                    covered = true;
                    break;
                }
            }
            if (!covered) emitPoint(b.x, b.y, b.z, 'fill');
        }
    }

    return candidates;
}
