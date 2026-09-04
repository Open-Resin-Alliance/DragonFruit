import { footprintToPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import * as THREE from 'three';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import {
    OVERHANG_SELF_SUPPORT_ANGLE_DEG,
    GRID_SPACING_MIN_FACTOR,
    GRID_SPACING_MAX_FACTOR,
} from './constants';
import type { AutoSupportSettings } from './settings';

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

/** Surface sampler: resolve a footprint point to its surface Z, or null when
 *  the point lies outside the region. */
export type SurfaceSampler = (x: number, y: number) => { z: number } | null;

const _surfaceRaycaster = new THREE.Raycaster();
const DOUBLE_SIDED_SURFACE_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/**
 * Triangle-accurate surface sampler for one region: an upward raycast from
 * just below the region's base, accepted only when the hit face belongs to
 * that region (`triangleIds`, same indexing as IslandOverhangOverlay).
 * Containment and Z are exact mesh quantities — the 0.25 mm voxel
 * quantization of the fallback disappears. Returns null when the mesh or the
 * region's triangle list is unavailable; callers fall back to the voxel
 * sampler.
 *
 * Upward direction matches resolveSurfaceNormal in autoPlace (support
 * contacts sit on undersides); the faceIndex filter makes occluding geometry
 * above or below the region irrelevant, and the double-sided material swap
 * keeps mixed-orientation regions fully reachable.
 */
export function createTriangleSurfaceAt(
    island: DetectedIsland,
    mesh?: THREE.Mesh,
): SurfaceSampler | null {
    const ids = island.triangleIds;
    if (!mesh || !ids || ids.length === 0) return null;
    const triSet = new Set(ids);
    return (x: number, y: number): { z: number } | null => {
        _surfaceRaycaster.set(
            new THREE.Vector3(x, y, island.baseZ - 2),
            new THREE.Vector3(0, 0, 1),
        );
        const originalMaterial = mesh.material;
        mesh.material = DOUBLE_SIDED_SURFACE_MATERIAL;
        try {
            for (const hit of _surfaceRaycaster.intersectObject(mesh, false)) {
                if (hit.faceIndex != null && triSet.has(hit.faceIndex)) {
                    return { z: hit.point.z };
                }
            }
        } finally {
            mesh.material = originalMaterial;
        }
        return null;
    };
}

/**
 * Voxel fallback sampler: the nearest footprint voxel within 0.25 mm
 * supplies containment and Z (pre-triangle behavior). The spatial hash is
 * built lazily so regions served by the triangle sampler never pay for it.
 */
export function createVoxelSurfaceAt(
    voxels: Array<{ x: number; y: number; z?: number }>,
    cellSize: number,
    minZ: number,
): SurfaceSampler {
    const tolSq = FOOTPRINT_TOLERANCE_MM * FOOTPRINT_TOLERANCE_MM;
    let hash: Map<string, Array<{ x: number; y: number; z?: number }>> | null = null;
    return (x: number, y: number): { z: number } | null => {
        if (!hash) {
            hash = new Map();
            for (const p of voxels) {
                const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
                const bucket = hash.get(key);
                if (bucket) bucket.push(p);
                else hash.set(key, [p]);
            }
        }
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
}

/**
 * Sample triangle-accurate perimeter loops at uniform spacing.
 * Loops are already inset by 0.25 mm (Rust) so no erosion is needed.
 * Each loop is closed — segment n-1 wraps to 0. Returns points with
 * interpolated Z.
 */
export function samplePerimeterLoops(
    loops: Array<Array<[number, number, number]>>,
    spacing: number,
    minZ: number,
): Array<{ x: number; y: number; z: number }> {
    const out: Array<{ x: number; y: number; z: number }> = [];
    if (!loops || loops.length === 0 || spacing <= 0) return out;
    for (const loop of loops) {
        if (!loop || loop.length < 2) continue;
        // Compute total length (XY Euclidean — overhangs are shallow, Z drift small)
        let total = 0;
        const segLen: number[] = [];
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const dz = b[2] - a[2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            segLen.push(len);
            total += len;
        }
        if (total < 1e-6) {
            // Degenerate — emit centroid
            const a = loop[0];
            out.push({ x: a[0], y: a[1], z: a[2] ?? minZ });
            continue;
        }
        const steps = Math.max(1, Math.round(total / spacing));
        const stepDist = total / steps;
        let segIdx = 0;
        let segStart = 0;
        let segEnd = segLen[0];
        for (let s = 0; s < steps; s++) {
            const target = s * stepDist;
            while (target > segEnd + 1e-9 && segIdx + 1 < segLen.length) {
                segIdx++;
                segStart = segEnd;
                segEnd += segLen[segIdx];
            }
            const a = loop[segIdx];
            const b = loop[(segIdx + 1) % loop.length];
            const t = segLen[segIdx] > 1e-9 ? (target - segStart) / segLen[segIdx] : 0;
            const x = a[0] + (b[0] - a[0]) * t;
            const y = a[1] + (b[1] - a[1]) * t;
            const z = (a[2] ?? minZ) + ((b[2] ?? minZ) - (a[2] ?? minZ)) * t;
            out.push({ x, y, z });
        }
    }
    return out;
}

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

/** Boundary-ring spacing relative to the infill spacing. The perimeter is
 *  deliberately tighter than the interior — the region edge engages peel
 *  first, and on small regions a same-spacing ring would dedupe away to
 *  nothing against the lattice. */
export const PERIMETER_RING_FACTOR = 0.7;

/** Floor on the boundary-ring spacing (mm) — the only thing stopping the
 *  ring from fusing on small regions. */
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
 *   flat    = flatDensityBoost × (threshold / area)^suctionAreaExponent   (area > threshold)
 *
 * - Angle term: flat ceilings (0°) densest, slopes at the self-support angle
 *   sparsest — direction from peel physics (force ∝ cross-section), values are
 *   calibration knobs.
 * - Suction term: large shallow ceilings densify sublinearly with projected
 *   area (peel grows with cross-section; direction physical, curve empirical).
 */
export function computeRegionSpacing(
    island: DetectedIsland,
    settings: AutoSupportSettings,
): number {
    const baseSpacing = Math.sqrt(Math.max(settings.areaPerSupportMm2, 0.5));
    const selfSupportAngleDeg = settings.overhangSelfSupportAngleDeg
        ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG;
    const angleT = Math.min(1, Math.max(0,
        (island.overhangAngleDeg ?? 0) / selfSupportAngleDeg));
    const minFactor = settings.flatDensityBoost ?? GRID_SPACING_MIN_FACTOR;
    const maxFactor = settings.slopeRelaxFactor ?? GRID_SPACING_MAX_FACTOR;

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
 * Resample a region's perimeter loops as a 2D-projected boundary ring.
 *
 * The Rust classifier's loops are 3D and wind up tall regions; projecting to
 * the XY plane and resampling at fixed arc-length spacing means a sliver's
 * ring is a short line and a sole's ring follows its outline — the ring can
 * never climb a limb, because Z does not lengthen the boundary. Each sample's
 * Z comes from the region's surface sampler (triangle-exact when available).
 * Points that resolve outside the footprint are dropped; near-duplicates
 * across overlapping projected loops are deduped. Returns null when the
 * region carries no usable loops (caller falls back to the voxel boundary).
 */
export function sampleBoundary2D(
    loops: Array<Array<[number, number, number]>> | undefined,
    spacing: number,
    surfaceAt: SurfaceSampler,
): Array<{ x: number; y: number; z: number }> | null {
    if (!loops || loops.length === 0 || spacing <= 0) return null;
    if (!loops.some((l) => l.length >= 2)) return null;

    const raw: Array<{ x: number; y: number; z: number }> = [];
    for (const loop of loops) {
        let acc = 0;
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (segLen < 1e-9) continue;
            if (acc === 0) {
                const s = surfaceAt(a[0], a[1]);
                if (s) raw.push({ x: a[0], y: a[1], z: s.z });
            }
            let d = spacing - acc;
            while (d <= segLen) {
                const t = d / segLen;
                const x = a[0] + (b[0] - a[0]) * t;
                const y = a[1] + (b[1] - a[1]) * t;
                const s = surfaceAt(x, y);
                if (s) raw.push({ x, y, z: s.z });
                d += spacing;
            }
            acc = (acc + segLen) % spacing;
        }
    }

    const deduped: Array<{ x: number; y: number; z: number }> = [];
    const minDistSq = (spacing * 0.5) * (spacing * 0.5);
    for (const p of raw) {
        let dup = false;
        for (const q of deduped) {
            const dx = p.x - q.x;
            const dy = p.y - q.y;
            if (dx * dx + dy * dy < minDistSq) {
                dup = true;
                break;
            }
        }
        if (!dup) deduped.push(p);
    }
    return deduped.length > 0 ? deduped : null;
}

/**
 * Unified distribution: fixed-density boundary ring + grid infill for every
 * overhang region above `gridAreaThresholdMm2`.
 *
 * One scheme for all surfaces — no anchor selection, no bake-off, no Z
 * bands. A big sole earns a carpet because it is big; a sliver earns a thin
 * line because its 2D-projected boundary is short; a tiny patch stays on the
 * single-pillar path (below threshold). Density knobs are the shared
 * `computeRegionSpacing` curve (angle + suction); every point's Z is the
 * exact surface height (triangle sampler, voxel fallback).
 *
 * Shape handles the degenerate cases:
 *  - sliver (nothing survives footprint erosion): ring only, no infill;
 *  - ring samples come from the 2D-projected loops so the boundary can never
 *    climb a limb in Z;
 *  - the per-region candidate cap subsamples evenly, never silently denser.
 */
export function generateGridCandidates(
    overhangIslands: DetectedIsland[],
    settings: AutoSupportSettings,
    mesh?: THREE.Mesh,
): CandidatePoint[] {
    const baseSpacing = Math.sqrt(Math.max(settings.areaPerSupportMm2, 0.5));
    if (baseSpacing <= 0) return [];
    const threshold = settings.gridAreaThresholdMm2;

    const candidates: CandidatePoint[] = [];

    for (const island of overhangIslands) {
        if (island.source !== 'overhang') continue;
        const area = island.areaMm2 ?? 0;
        if (area < threshold) continue;
        const spacing = computeRegionSpacing(island, settings);

        const voxels = island.contactVoxels;
        if (!voxels || voxels.count === 0) continue;

        // Footprint bbox (lattice span); the containment/Z hash is built
        // lazily inside the voxel fallback sampler.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const cellSize = Math.max(spacing, 1.0);
        const voxelPoints = footprintToPoints(voxels);
        for (const p of voxelPoints) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }

        const surfaceNormal = island.surfaceNormal ?? { x: 0, y: 0, z: -1 };

        // Triangle-accurate surface resolution when the mesh + region
        // triangles are available; voxel nearest-neighbor is the fallback.
        const surfaceAt = createTriangleSurfaceAt(island, mesh)
            ?? createVoxelSurfaceAt(voxelPoints, cellSize, island.baseZ);
        const minZ = island.baseZ;

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
            });
        };

        // Sliver test: nothing survives footprint erosion → ring only.
        const eroded = erodeFootprint(voxelPoints);
        const isSliver = eroded.length === 0;

        // Candidate-cap guard: on overflow, fall back to the angle-only
        // spacing, then subsample evenly — never silently denser than the cap.
        const width = maxX - minX;
        const height = maxY - minY;
        const inset = PERIMETER_CONTACT_INSET_MM;
        const spanX = Math.max(0.5, width - 2 * inset);
        const spanY = Math.max(0.5, height - 2 * inset);
        let stride = 1;
        const estimate = (Math.floor(spanX / spacing) + 2) * (Math.floor(spanY / spacing) + 2);
        if (estimate > MAX_GRID_CANDIDATES_PER_REGION) {
            const fallbackSpacing = computeRegionSpacing(island, { ...settings, suctionAreaExponent: 0 });
            const baseEstimate = (Math.floor(spanX / fallbackSpacing) + 2) * (Math.floor(spanY / fallbackSpacing) + 2);
            if (baseEstimate > MAX_GRID_CANDIDATES_PER_REGION) {
                stride = Math.ceil(baseEstimate / MAX_GRID_CANDIDATES_PER_REGION);
            }
        }

        const nx = Math.max(1, Math.round(spanX / spacing));
        const ny = Math.max(1, Math.round(spanY / spacing));
        const spacingX = spanX / nx;
        const spacingY = spanY / ny;

        // Grid infill — the lattice spans the region with integer rows and
        // columns (never cut off by a leftover margin), inset by the contact
        // radius so a support never hangs half its disc past the edge.
        const lattice: Array<{ x: number; y: number; z: number }> = [];
        if (!isSliver) {
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
        }

        // Boundary ring — deliberately TIGHTER than the infill (the edge
        // engages peel first) and deduped against the lattice at half the
        // ring spacing, so the outline is traced even on small regions where
        // every ring point sits within a lattice cell of some interior point.
        const ringSpacing = Math.max(PERIMETER_SPACING_FLOOR_MM, spacing * PERIMETER_RING_FACTOR) * stride;
        const ringCoverageSq = (ringSpacing * 0.5) * (ringSpacing * 0.5);
        const boundary = sampleBoundary2D(island.perimeterLoops, ringSpacing, surfaceAt)
            ?? buildBoundaryPoints(
                eroded.length > 0 ? eroded : voxelPoints,
                ringSpacing,
                minZ,
            );
        for (const b of boundary) {
            let covered = false;
            for (const p of lattice) {
                const dx = b.x - p.x;
                const dy = b.y - p.y;
                if (dx * dx + dy * dy <= ringCoverageSq) {
                    covered = true;
                    break;
                }
            }
            if (!covered) emitPoint(b.x, b.y, b.z, 'fill');
        }
    }

    return candidates;
}
