import { VoxelFootprintBuilder, cellKey, footprintBounds, footprintToPoints, footprintX, footprintY, footprintZ, type VoxelFootprint } from '@/volumeAnalysis/Islands/voxelFootprint';
import * as THREE from 'three';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import {
    OVERHANG_SELF_SUPPORT_ANGLE_DEG,
    GRID_SPACING_MIN_FACTOR,
    SLOPE_RELAX_RAMP_START,
    GRID_SPACING_MAX_FACTOR,
    ISLAND_TWO_POINT_MAX_MM,
    OVERHANG_GRID_MIN_SPAN_MM,
    INTERIOR_CAVITY_SPACING_SCALE,
} from './constants';
import type { AutoSupportSettings } from './settings';
import { applyContactTipCaps } from './contactTipCap';
import { isSupportBlockedContact } from './supportBlockers';
import { activeSizingBand } from './parameterSizing';

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
    voxels: VoxelFootprint,
    spacing: number,
    fallbackZ: number,
): Array<{ x: number; y: number; z: number }> {
    if (voxels.count === 0) return [];
    const set = new Set<number>();
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < voxels.count; i++) {
        set.add(cellKey(Math.round(footprintX(voxels, i) * 4), Math.round(footprintY(voxels, i) * 4)));
        sumX += footprintX(voxels, i);
        sumY += footprintY(voxels, i);
    }
    const cx = sumX / voxels.count;
    const cy = sumY / voxels.count;

    const boundary: Array<{ x: number; y: number; z?: number }> = [];
    for (let i = 0; i < voxels.count; i++) {
        const kx = Math.round(footprintX(voxels, i) * 4);
        const ky = Math.round(footprintY(voxels, i) * 4);
        let onEdge = false;
        for (let dx = -1; dx <= 1 && !onEdge; dx++) {
            for (let dy = -1; dy <= 1 && !onEdge; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (!set.has(cellKey(kx + dx, ky + dy))) onEdge = true;
            }
        }
        if (onEdge) boundary.push({ x: footprintX(voxels, i), y: footprintY(voxels, i), z: footprintZ(voxels, i) ?? undefined });
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
 *  the point lies outside the region. The triangle path also reports the
 *  contact face so callers can honor the support-blocker mask with no extra
 *  raycast. */
export type SurfaceSampler = (x: number, y: number) => { z: number; faceIndex?: number } | null;

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
    return (x: number, y: number): { z: number; faceIndex?: number } | null => {
        _surfaceRaycaster.set(
            new THREE.Vector3(x, y, island.baseZ - 2),
            new THREE.Vector3(0, 0, 1),
        );
        const originalMaterial = mesh.material;
        mesh.material = DOUBLE_SIDED_SURFACE_MATERIAL;
        try {
            for (const hit of _surfaceRaycaster.intersectObject(mesh, false)) {
                if (hit.faceIndex != null && triSet.has(hit.faceIndex)) {
                    return { z: hit.point.z, faceIndex: hit.faceIndex };
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
export function erodeFootprint(voxels: VoxelFootprint): VoxelFootprint {
    const set = new Set<number>();
    for (let i = 0; i < voxels.count; i++) {
        set.add(cellKey(Math.round(footprintX(voxels, i) * 4), Math.round(footprintY(voxels, i) * 4)));
    }
    const interior = new VoxelFootprintBuilder(voxels.count, voxels.z !== null);
    for (let i = 0; i < voxels.count; i++) {
        const kx = Math.round(footprintX(voxels, i) * 4);
        const ky = Math.round(footprintY(voxels, i) * 4);
        let all = true;
        for (let dx = -PERIMETER_ERODE_PIXELS; dx <= PERIMETER_ERODE_PIXELS && all; dx++) {
            for (let dy = -PERIMETER_ERODE_PIXELS; dy <= PERIMETER_ERODE_PIXELS && all; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (!set.has(cellKey(kx + dx, ky + dy))) all = false;
            }
        }
        if (all) interior.push(footprintX(voxels, i), footprintY(voxels, i), footprintZ(voxels, i) ?? undefined);
    }
    return interior.build();
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
/** Reference footprint area (mm²) above which suction densification kicks in.
 *  Decoupled from `gridAreaThresholdMm2` (4 mm²) so small miniature soles get
 *  perimeter sampling without triggering large-slab suction compaction. */
const SUCTION_REFERENCE_AREA_MM2 = 25;

export function computeRegionSpacing(
    island: DetectedIsland,
    settings: AutoSupportSettings,
): number {
    const baseSpacing = Math.sqrt(Math.max(settings.areaPerSupportMm2, 0.5));
    const selfSupportAngleDeg = settings.overhangSelfSupportAngleDeg
        ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG;
    // Relaxation is a last-stretch effect, not a ramp from flat (see
    // `SLOPE_RELAX_RAMP_START`): below the start the region keeps the flat spacing,
    // because a shallow underside is a formation overhang like any other ceiling.
    const relaxStartDeg = selfSupportAngleDeg * SLOPE_RELAX_RAMP_START;
    const rampDeg = Math.max(1e-6, selfSupportAngleDeg - relaxStartDeg);
    const angleT = Math.min(1, Math.max(0,
        ((island.overhangAngleDeg ?? 0) - relaxStartDeg) / rampDeg));
    const minFactor = settings.flatDensityBoost ?? GRID_SPACING_MIN_FACTOR;
    const maxFactor = settings.slopeRelaxFactor ?? GRID_SPACING_MAX_FACTOR;

    const area = island.areaMm2 ?? 0;
    const threshold = Math.max(SUCTION_REFERENCE_AREA_MM2, settings.gridAreaThresholdMm2);
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
/** Turning angle (deg) above which a 2D boundary vertex counts as a sharp convex corner (e.g. toe tips, rim corners). */
const BOUNDARY_CONVEX_CORNER_COS = Math.cos((35 * Math.PI) / 180);
const BOUNDARY_CORNER_MIN_EDGE_MM = 0.25;

export function sampleBoundary2D(
    loops: Array<Array<[number, number, number]>> | undefined,
    spacing: number,
    surfaceAt: SurfaceSampler,
): Array<{ x: number; y: number; z: number; faceIndex?: number }> | null {
    if (!loops || loops.length === 0 || spacing <= 0) return null;
    if (!loops.some((l) => l.length >= 2)) return null;

    const deduped: Array<{ x: number; y: number; z: number; faceIndex?: number }> = [];
    const cornerMinDist = Math.max(1.1, spacing * 0.55);
    const cornerMinDistSq = cornerMinDist * cornerMinDist;
    const minDistSq = (spacing * 0.5) * (spacing * 0.5);

    const tryPush = (p: { x: number; y: number; z: number; faceIndex?: number }, distSq: number): void => {
        for (const q of deduped) {
            const dx = p.x - q.x;
            const dy = p.y - q.y;
            if (dx * dx + dy * dy < distSq) return;
        }
        deduped.push(p);
    };

    // Pass 1: Pin sharp convex corners and local Z minima along each closed loop
    // first so scalloped leading edges (toe tips, heel crests, sharp cuffs) are
    // anchored before uniform arc-length resampling fills the spans between them.
    for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        const n = loop.length;
        if (n < 3) continue;

        let depth = 0;
        const sx = loop[0][0];
        const sy = loop[0][1];
        for (let lj = 0; lj < loops.length; lj++) {
            if (lj === li || loops[lj].length < 3) continue;
            if (pointInPolygon2D(sx, sy, loops[lj])) depth++;
        }
        const isHole = depth % 2 === 1;

        let area2 = 0;
        for (let i = 0; i < n; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % n];
            area2 += a[0] * b[1] - b[0] * a[1];
        }
        const windingSign = area2 >= 0 ? 1 : -1;

        const sampledVerts: Array<{ x: number; y: number; z: number; faceIndex?: number } | null> = new Array(n);
        for (let i = 0; i < n; i++) {
            const s = surfaceAt(loop[i][0], loop[i][1]);
            sampledVerts[i] = s ? { x: loop[i][0], y: loop[i][1], z: s.z, faceIndex: s.faceIndex } : null;
        }

        const priorityCorners: Array<{ pt: { x: number; y: number; z: number; faceIndex?: number }; score: number }> = [];
        for (let i = 0; i < n; i++) {
            const cur = sampledVerts[i];
            if (!cur) continue;
            const prev = loop[(i + n - 1) % n];
            const curr = loop[i];
            const next = loop[(i + 1) % n];
            const e1x = curr[0] - prev[0];
            const e1y = curr[1] - prev[1];
            const e2x = next[0] - curr[0];
            const e2y = next[1] - curr[1];
            const len1 = Math.hypot(e1x, e1y);
            const len2 = Math.hypot(e2x, e2y);

            let isConvexCorner = false;
            let sharpness = 0;
            if (len1 >= BOUNDARY_CORNER_MIN_EDGE_MM && len2 >= BOUNDARY_CORNER_MIN_EDGE_MM) {
                const dot = (e1x * e2x + e1y * e2y) / (len1 * len2);
                const cross = (e1x * e2y - e1y * e2x) * windingSign;
                // On an outer loop, convex turns share the loop's winding sign;
                // on a hole, inward protrusions have the opposite sign.
                const outwardTurn = isHole ? cross < 0 : cross > 0;
                if (outwardTurn && dot <= BOUNDARY_CONVEX_CORNER_COS) {
                    isConvexCorner = true;
                    sharpness = 1 - dot; // [0.18, 2.0] — sharper tips score higher
                }
            }

            const prevS = sampledVerts[(i + n - 1) % n];
            const nextS = sampledVerts[(i + 1) % n];
            const isLocalZMin = prevS !== null && nextS !== null
                && cur.z <= prevS.z - 0.05
                && cur.z <= nextS.z - 0.05;

            if (isConvexCorner || isLocalZMin) {
                priorityCorners.push({
                    pt: cur,
                    score: (isLocalZMin ? 2 : 0) + sharpness,
                });
            }
        }
        priorityCorners.sort((a, b) => b.score - a.score || a.pt.z - b.pt.z);
        for (const item of priorityCorners) {
            tryPush(item.pt, cornerMinDistSq);
        }
    }

    // Pass 2: Uniform arc-length resampling fills the spans between pinned corners.
    const raw: Array<{ x: number; y: number; z: number; faceIndex?: number }> = [];
    for (const loop of loops) {
        let acc = 0;
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (segLen < 1e-9) continue;
            if (acc === 0) {
                const s = surfaceAt(a[0], a[1]);
                if (s) raw.push({ x: a[0], y: a[1], z: s.z, faceIndex: s.faceIndex });
            }
            let d = spacing - acc;
            while (d <= segLen) {
                const t = d / segLen;
                const x = a[0] + (b[0] - a[0]) * t;
                const y = a[1] + (b[1] - a[1]) * t;
                const s = surfaceAt(x, y);
                if (s) raw.push({ x, y, z: s.z, faceIndex: s.faceIndex });
                d += spacing;
            }
            acc = (acc + segLen) % spacing;
        }
    }

    for (const p of raw) {
        tryPush(p, minDistSq);
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
/**
 * Does this overhang region get the ring + lattice treatment?
 *
 * Area is the density question, but SHAPE decides whether the region can be
 * carried by the single-candidate path at all: a thin footprint (a plank's
 * underside, a fin edge) erodes away, so the lattice has nothing to infill —
 * yet its boundary ring is exactly the line of supports it needs. Under the
 * area threshold those slivers used to fall through to one centre pillar: a
 * 19 mm² plank underside of 15 × 1.3 mm got a single support with both ends
 * of the anchoring edge unsupported. Anything longer than the two-point band
 * (`ISLAND_TWO_POINT_MAX_MM`, which already splits 1.5–6 mm islands into a
 * symmetric pair) is long enough to want its perimeter sampled.
 */
/**
 * Spacing multiplier for a steep flat. Such a face forms fine on its own, so
 * the density curve — which is tuned for formation, densest on flat ceilings —
 * overstates what it needs: the only thing contact on it buys is toppling
 * resistance, and that wants a sparse field of contacts spread over the face,
 * not a lattice. On a low-poly model the face IS the patch (a 12-triangle
 * plank's 81° side is 500 mm², a big model's 64° shoulder is 11000 mm²), so
 * this multiplier is the difference between a carpet and a brace field.
 * Removing the coverage outright was wrong: a huge face left bare overhangs its
 * own weight and peel.
 */
export const STEEP_FLAT_SPACING_MULTIPLIER = 2.5;

/** How much of a steep flat's height its anchoring contacts may occupy: the
 *  lowest third, or 6mm, whichever is more, so a thin region still gets a line
 *  and a tall one does not sprout supports up to where the print is nearly
 *  finished. */
export const STEEP_FLAT_ANCHOR_BAND_FRACTION = 0.35;
export const STEEP_FLAT_ANCHOR_BAND_MM = 6.0;

/**
 * Spacing multiplier for a steep flat.
 *
 * The 2.5x exists because a steep face needs no formation contact: it forms on
 * its own, so a sparse field is enough for anchoring. A SLENDER part is the
 * exception, and for the opposite reason: its problem is sway, and the sag
 * between two contacts goes as the span to the fourth power, so the spacing is
 * the whole knob. There the flat gets the formation density.
 */
export function steepFlatSpacingMultiplier(
    island: { steepFlat?: boolean },
    baseSpacingMm: number,
    partThicknessMm = 0,
): number {
    if (!island.steepFlat) return 1;
    // The rung spacing up a face is a beam span: the sag between two contacts
    // goes as the span to the fourth power, so it has to stay under the part's
    // own thickness whatever the sparse field would like to do. That makes the
    // density a function of the part rather than a switch on its shape: a 7mm
    // wall lands at 7mm and a 30mm-thick one keeps the full sparse field.
    const sparse = STEEP_FLAT_SPACING_MULTIPLIER;
    if (!(partThicknessMm > 0) || !(baseSpacingMm > 0)) return sparse;
    return Math.max(1, Math.min(sparse, partThicknessMm / baseSpacingMm));
}

/**
 * Top of the band a steep flat's anchoring contacts may occupy (mm), or
 * `Infinity` for anything that is not a steep flat. The lowest third of the
 * face, or 6mm, whichever is more, so a thin region still gets a line and a
 * tall one does not sprout supports up to where the print is nearly finished.
 */
export function steepFlatAnchorBandTop(
    island: { steepFlat?: boolean; baseZ: number; maxZ?: number },
    slenderPart = false,
): number {
    if (!island.steepFlat) return Infinity;
    // A slender part sways under the peel's lateral load, and a contact only
    // stops the sway at its own height. Anchoring a wall therefore wants a
    // ladder up its face, not a band at the bottom: the band is for parts whose
    // problem is rigid-body motion.
    if (slenderPart) return Infinity;
    const top = island.maxZ ?? island.baseZ;
    return (
        island.baseZ +
        Math.max(STEEP_FLAT_ANCHOR_BAND_MM, (top - island.baseZ) * STEEP_FLAT_ANCHOR_BAND_FRACTION)
    );
}

export const BASE_OVERHANG_WINDOW_MIN_MM = 1.8;
export const BASE_OVERHANG_WINDOW_MAX_MM = 3.5;
export const BASE_OVERHANG_WINDOW_DEFAULT_MM = 3.0;
export const BASE_OVERHANG_HEIGHT_FRACTION = 0.1;

/** Base-overhang densification window (mm) scaled by oriented model height. */
export function baseOverhangWindowMm(modelHeightMm = 0): number {
    if (!(modelHeightMm > 0)) return BASE_OVERHANG_WINDOW_DEFAULT_MM;
    return Math.min(
        BASE_OVERHANG_WINDOW_MAX_MM,
        Math.max(BASE_OVERHANG_WINDOW_MIN_MM, modelHeightMm * BASE_OVERHANG_HEIGHT_FRACTION),
    );
}

/** World-space Z bottom and height (mm) of an oriented mesh bounding box. */
export function meshWorldZBounds(mesh?: THREE.Mesh): { minZ: number; heightMm: number } {
    if (!mesh) return { minZ: 0, heightMm: 0 };
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const minZ = Number.isFinite(box.min.z) ? box.min.z : 0;
    const maxZ = Number.isFinite(box.max.z) ? box.max.z : minZ;
    return { minZ, heightMm: Math.max(0, maxZ - minZ) };
}

export function shouldUseDensityGrid(
    island: DetectedIsland,
    settings: AutoSupportSettings,
    modelMinZ = 0,
    baseWindowMm = BASE_OVERHANG_WINDOW_DEFAULT_MM,
): boolean {
    if (island.source !== 'overhang') return false;
    if ((island.areaMm2 ?? 0) >= settings.gridAreaThresholdMm2) return true;

    const voxels = island.contactVoxels;
    const bounds = voxels ? footprintBounds(voxels) : null;
    if (!bounds) return false;
    const { minX, minY, maxX, maxY } = bounds;
    const major = Math.max(maxX - minX, maxY - minY);
    if (!island.interior
        && !island.steepFlat
        && (island.contact.z - modelMinZ) <= baseWindowMm
        && ((island.maxZ ?? island.contact.z) - modelMinZ) <= baseWindowMm * 1.5
        && voxels !== undefined && voxels.count > 1
        && ((island.areaMm2 ?? 0) >= 2.0 || major >= 2.0)) {
        return true;
    }
    // Any overhang at least OVERHANG_GRID_MIN_SPAN_MM (3mm) across — such as a
    // miniature foot sole, chin, or thin rib — needs its perimeter sampled so
    // leading edges and corners are pinned instead of getting 1–2 center tips.
    return major >= Math.min(ISLAND_TWO_POINT_MAX_MM, OVERHANG_GRID_MIN_SPAN_MM);
}

/**
 * World-space normal of one mesh face. The region carries a SINGLE
 * `surfaceNormal`, but its cells land on a surface that curves or bends across
 * the region — measured on a cylinder underside, every contact's axis sat a
 * median 26° (worst 41°) from the surface it was touching, so the contact disc
 * dug in on one edge and floated on the other. The sampler already reports the
 * face it hit, so the per-cell normal is free.
 */
function faceNormalAt(
    mesh: THREE.Mesh,
    faceIndex: number,
): { x: number; y: number; z: number } | null {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position) return null;
    const index = geometry.getIndex();
    const i0 = index ? index.getX(faceIndex * 3) : faceIndex * 3;
    const i1 = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
    const i2 = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
    if (i0 < 0 || i1 < 0 || i2 < 0) return null;

    const a = new THREE.Vector3().fromBufferAttribute(position, i0);
    const b = new THREE.Vector3().fromBufferAttribute(position, i1);
    const c = new THREE.Vector3().fromBufferAttribute(position, i2);
    const normal = b.sub(a).cross(c.sub(a));
    if (normal.lengthSq() < 1e-12) return null;
    normal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
    return { x: normal.x, y: normal.y, z: normal.z };
}

export const SCAN_PERIMETER_BASE_INSET_MM = 0.10;

export function computePerimeterInsetMm(bandTipDiameterMm: number): number {
    return Math.min(0.25, Math.max(0.10, 0.5 * (Number.isFinite(bandTipDiameterMm) ? bandTipDiameterMm : 0.28) + 0.03));
}

function pointInPolygon2D(px: number, py: number, poly: Array<[number, number, number]>): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0];
        const yi = poly[i][1];
        const xj = poly[j][0];
        const yj = poly[j][1];
        const intersect = ((yi > py) !== (yj > py))
            && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export function insetPolygonLoops2D(
    loops: Array<Array<[number, number, number]>> | undefined,
    extraInsetMm: number,
): Array<Array<[number, number, number]>> | undefined {
    if (!loops || loops.length === 0 || !(extraInsetMm > 1e-6)) return loops;
    const maxDispSq = (3.0 * extraInsetMm) * (3.0 * extraInsetMm);
    const out: Array<Array<[number, number, number]>> = [];

    for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        const n = loop.length;
        if (n < 3) {
            out.push(loop);
            continue;
        }
        let depth = 0;
        const sx = loop[0][0];
        const sy = loop[0][1];
        for (let lj = 0; lj < loops.length; lj++) {
            if (lj === li || loops[lj].length < 3) continue;
            if (pointInPolygon2D(sx, sy, loops[lj])) depth++;
        }
        const isHole = depth % 2 === 1;

        let area2 = 0;
        for (let i = 0; i < n; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % n];
            area2 += a[0] * b[1] - b[0] * a[1];
        }
        if (Math.abs(area2) < 1e-7) {
            out.push(loop);
            continue;
        }
        const ccw = area2 >= 0;
        const sign = isHole ? (ccw ? -1 : 1) : (ccw ? 1 : -1);

        const edgeNormals: Array<[number, number]> = new Array(n);
        for (let i = 0; i < n; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % n];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            edgeNormals[i] = len > 1e-9
                ? [sign * (-dy / len), sign * (dx / len)]
                : [0, 0];
        }

        const shifted: Array<[number, number, number]> = new Array(n);
        let dispInvalid = false;
        for (let i = 0; i < n; i++) {
            const p = loop[i];
            const nPrev = edgeNormals[(i + n - 1) % n];
            const nNext = edgeNormals[i];
            const bx = nPrev[0] + nNext[0];
            const by = nPrev[1] + nNext[1];
            const bLen = Math.hypot(bx, by);
            let ox = 0;
            let oy = 0;
            if (bLen > 1e-9) {
                ox = (bx / bLen) * extraInsetMm;
                oy = (by / bLen) * extraInsetMm;
            } else if (nNext[0] !== 0 || nNext[1] !== 0) {
                ox = nNext[0] * extraInsetMm;
                oy = nNext[1] * extraInsetMm;
            } else if (nPrev[0] !== 0 || nPrev[1] !== 0) {
                ox = nPrev[0] * extraInsetMm;
                oy = nPrev[1] * extraInsetMm;
            }
            if (ox * ox + oy * oy > maxDispSq) {
                dispInvalid = true;
                break;
            }
            shifted[i] = [p[0] + ox, p[1] + oy, p[2]];
        }
        if (dispInvalid) {
            out.push(loop);
            continue;
        }

        let newArea2 = 0;
        let totalOrigLen = 0;
        let reversedOrigLen = 0;
        for (let i = 0; i < n; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % n];
            const sa = shifted[i];
            const sb = shifted[(i + 1) % n];
            newArea2 += sa[0] * sb[1] - sb[0] * sa[1];
            const odx = b[0] - a[0];
            const ody = b[1] - a[1];
            const olen = Math.hypot(odx, ody);
            totalOrigLen += olen;
            if (olen > 1e-9 && odx * (sb[0] - sa[0]) + ody * (sb[1] - sa[1]) <= 0) {
                reversedOrigLen += olen;
            }
        }
        const sameSign = (area2 > 0 && newArea2 > 0) || (area2 < 0 && newArea2 < 0);
        const areaValid = isHole
            ? Math.abs(newArea2) > Math.abs(area2)
            : Math.abs(newArea2) < Math.abs(area2);
        const majorityReversed = totalOrigLen > 0 && reversedOrigLen > 0.5 * totalOrigLen;
        if (!sameSign || Math.abs(newArea2) < 1e-5 || !areaValid || majorityReversed) {
            out.push(loop);
        } else {
            out.push(shifted);
        }
    }
    return out;
}

export function generateGridCandidates(
    overhangIslands: DetectedIsland[],
    settings: AutoSupportSettings,
    mesh?: THREE.Mesh,
    modelId?: string,
    /** The part is tall and thin enough that sway matters, so anchoring
     *  contacts ladder up a steep flat instead of banding low. */
    slenderPart = false,
    /** The part's average thickness (mm), which caps the spacing between those
     *  contacts: the sag between two of them goes as the span to the fourth
     *  power. */
    partThicknessMm = 0,
    /** Lowest world Z (mm) of the oriented model bounding box, so lifted
     *  models keep their base-overhang density window relative to the model. */
    modelMinZ?: number,
    /** Height (mm) of the base-overhang densification window above modelMinZ. */
    baseWindowMm?: number,
    /** Discrete anchors (isDetached / intersection) already placed on these regions. */
    pinnedIslands?: readonly DetectedIsland[],
): CandidatePoint[] {
    const baseSpacing = Math.sqrt(Math.max(settings.areaPerSupportMm2, 0.5));
    if (baseSpacing <= 0) return [];

    const bandTipDia = activeSizingBand(settings).tipContactDiameterMm;
    const targetInsetMm = computePerimeterInsetMm(bandTipDia);
    const extraLoopInsetMm = Math.max(0, targetInsetMm - SCAN_PERIMETER_BASE_INSET_MM);

    const meshZ = (modelMinZ === undefined || baseWindowMm === undefined)
        ? meshWorldZBounds(mesh)
        : null;
    const resolvedMinZ = modelMinZ ?? meshZ!.minZ;
    const resolvedWindowMm = baseWindowMm ?? baseOverhangWindowMm(meshZ!.heightMm);

    const candidates: CandidatePoint[] = [];

    for (const island of overhangIslands) {
        if (!shouldUseDensityGrid(island, settings, resolvedMinZ, resolvedWindowMm)) continue;
        const baseSpacing = computeRegionSpacing(island, settings);
        // An internal ceiling is bridged to the cavity floor, not carried to
        // the plate; the short strut needs far fewer contacts.
        let spacing = baseSpacing
            * steepFlatSpacingMultiplier(island, baseSpacing, partThicknessMm)
            * (island.interior ? INTERIOR_CAVITY_SPACING_SCALE : 1);
        const nearPlateFlat = !island.interior
            && !island.steepFlat
            && (island.contact.z - resolvedMinZ) <= resolvedWindowMm
            && ((island.maxZ ?? island.contact.z) - resolvedMinZ) <= resolvedWindowMm * 1.5;
        if (nearPlateFlat) {
            spacing = Math.max(1.35, Math.min(spacing * 0.8, 1.75));
        }

        const voxels = island.contactVoxels;
        if (!voxels || voxels.count === 0) continue;

        // Footprint bbox (lattice span); the containment/Z hash is built
        // lazily inside the voxel fallback sampler.
        const bounds = footprintBounds(voxels)!;
        const { minX, minY, maxX, maxY } = bounds;
        const cellSize = Math.max(spacing, 1.0);

        const surfaceNormal = island.surfaceNormal ?? { x: 0, y: 0, z: -1 };


        // Triangle-accurate surface resolution when the mesh + region
        // triangles are available; voxel nearest-neighbor is the fallback.
        // The fallback's point objects are built only when it is actually
        // used: materialising a 112k-voxel footprint per region cost more
        // than the placement that reads it.
        const surfaceAt = createTriangleSurfaceAt(island, mesh)
            ?? createVoxelSurfaceAt(footprintToPoints(voxels), cellSize, island.baseZ);
        const minZ = island.baseZ;
        // A steep flat is self-supporting, so its contacts are there to ANCHOR
        // the part, not to hold up material that is still forming. Anchoring
        // wants the low band: a tip's job is to stop the part moving, and low
        // contacts are short, stiff and cheap, while the reach that resists a
        // topple moment is the stabilization braces' job. Left alone the grid
        // climbs the face, because a near-vertical patch has a thin XY
        // footprint whose cells map up its height.
        const anchorBandTop = steepFlatAnchorBandTop(island, slenderPart);
        let emittedForRegion = 0;

        const emitPoint = (x: number, y: number, z: number, kind: 'grid' | 'fill', faceIndex?: number | null) => {
            if (z > anchorBandTop) return;
            // The contact leans into the face it actually lands on; the
            // region-wide normal is only the fallback (voxel sampler, blockers).
            const tipNormal = (mesh && faceIndex != null ? faceNormalAt(mesh, faceIndex) : null) ?? surfaceNormal;
            // Support blockers: refuse contacts painted as nogo. Lattice and
            // ring points carry the sampler's face for free; voxel-fallback
            // points resolve it with one raycast. Empty mask → no raycasts.
            if (modelId && mesh && isSupportBlockedContact(modelId, mesh, x, y, z, faceIndex)) return;
            emittedForRegion++;
            candidates.push({
                id: `${kind}-${island.id}-${x.toFixed(2)}-${y.toFixed(2)}`,
                tipPos: { x, y, z },
                tipNormal,
                modelId: '',
                source: 'overhang',
                islandAreaMm2: settings.areaPerSupportMm2,
                zHeight: z,
                priority: 0,
                gridPoint: true,
                interior: island.interior,
                nearBase: (nearPlateFlat && (z - resolvedMinZ) <= resolvedWindowMm) || undefined,
            });
        };

        // Sliver test: nothing survives footprint erosion → ring only. A rib
        // thinner than one lattice cell is treated the same way — infilling it
        // would stack a second line of supports a millimeter from the edge.
        const eroded = erodeFootprint(voxels);
        const isSliver = eroded.count === 0;

        // Candidate-cap guard: on overflow, fall back to the angle-only
        // spacing, then subsample evenly — never silently denser than the cap.
        const width = maxX - minX;
        const height = maxY - minY;
        const minDim = Math.min(width, height);
        const inset = minDim < 1.0 ? Math.min(targetInsetMm, 0.25 * minDim) : PERIMETER_CONTACT_INSET_MM;
        const spanX = Math.max(0.5, width - 2 * inset);
        const spanY = Math.max(0.5, height - 2 * inset);
        let stride = 1;
        let nx: number;
        let ny: number;
        const estimate = (Math.floor(spanX / spacing) + 2) * (Math.floor(spanY / spacing) + 2);
        if (estimate > MAX_GRID_CANDIDATES_PER_REGION) {
            const fallbackBaseSpacing = computeRegionSpacing(island, { ...settings, suctionAreaExponent: 0 });
            const fallbackSpacing = fallbackBaseSpacing
                * steepFlatSpacingMultiplier(island, fallbackBaseSpacing, partThicknessMm)
                * (island.interior ? INTERIOR_CAVITY_SPACING_SCALE : 1);
            spacing = fallbackSpacing;
            nx = Math.max(1, Math.round(spanX / spacing));
            ny = Math.max(1, Math.round(spanY / spacing));
            const baseEstimate = (Math.floor(spanX / fallbackSpacing) + 2) * (Math.floor(spanY / fallbackSpacing) + 2);
            if (baseEstimate > MAX_GRID_CANDIDATES_PER_REGION) {
                stride = Math.ceil(Math.sqrt(baseEstimate / MAX_GRID_CANDIDATES_PER_REGION));
            }
            while ((Math.floor(nx / stride) + 1) * (Math.floor(ny / stride) + 1) > MAX_GRID_CANDIDATES_PER_REGION) {
                stride += 1;
            }
        } else {
            nx = Math.max(1, Math.round(spanX / spacing));
            ny = Math.max(1, Math.round(spanY / spacing));
        }
        const spacingX = spanX / nx;
        const spacingY = spanY / ny;

        const pinnedAnchors: Array<{ x: number; y: number; z: number }> = [];
        if (pinnedIslands && pinnedIslands.length > 0) {
            const regionMaxZ = island.maxZ ?? minZ;
            const addPinAnchor = (x: number, y: number, z: number): void => {
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
                if (modelId && mesh && isSupportBlockedContact(modelId, mesh, x, y, z)) return;
                pinnedAnchors.push({ x, y, z });
            };
            for (const p of pinnedIslands) {
                if (p.coveredByOverhangId != null && p.coveredByOverhangId !== island.id) continue;
                const matchedById = p.coveredByOverhangId === island.id;
                const inBox = p.contact.x >= minX - 0.5
                    && p.contact.x <= maxX + 0.5
                    && p.contact.y >= minY - 0.5
                    && p.contact.y <= maxY + 0.5
                    && p.contact.z >= minZ - 0.5
                    && p.contact.z <= regionMaxZ + 0.5;
                if (!matchedById && !inBox) continue;
                addPinAnchor(p.contact.x, p.contact.y, p.contact.z);
                if (p.subApexes) {
                    for (const ap of p.subApexes) {
                        addPinAnchor(ap.x, ap.y, ap.z);
                    }
                }
            }
        }

        const ringFloor = nearPlateFlat ? 1.2 : PERIMETER_SPACING_FLOOR_MM;
        const ringSpacing = Math.max(ringFloor, spacing * PERIMETER_RING_FACTOR) * stride;
        const anchorBackoffSq = Math.max(settings.tipInfluenceRadiusMm, 0.6 * ringSpacing) ** 2;
        const isNearPinnedAnchor = (x: number, y: number, z: number): boolean => {
            for (const a of pinnedAnchors) {
                const dx = x - a.x;
                const dy = y - a.y;
                if (dx * dx + dy * dy <= anchorBackoffSq && Math.abs(z - a.z) <= 1.0) {
                    return true;
                }
            }
            return false;
        };

        // Grid infill — the lattice spans the region with integer rows and
        // columns (never cut off by a leftover margin), inset by the contact
        // radius so a support never hangs half its disc past the edge.
        const lattice: Array<{ x: number; y: number; z: number }> = [];
        // A footprint thinner than one lattice cell gets no infill: the rows
        // would land a fraction of a millimeter apart, doubling the density on
        // a rib the ring already carries end to end.
        if (!isSliver && Math.min(width, height) >= spacing) {
            for (let i = 0; i <= nx; i += stride) {
                for (let j = 0; j <= ny; j += stride) {
                    const x = minX + inset + i * spacingX;
                    const y = minY + inset + j * spacingY;
                    const s = surfaceAt(x, y);
                    if (s && !isNearPinnedAnchor(x, y, s.z)) {
                        const pt = { x, y, z: s.z };
                        lattice.push(pt);
                        emitPoint(x, y, s.z, 'grid', s.faceIndex);
                    }
                }
            }
        }
        // Pinned anchors are checked via Z-aware `isNearPinnedAnchor` below — never
        // flatten them into the 2D `lattice`, which would strip Z-distant boundary points.
        // Boundary ring — deliberately TIGHTER than the infill (the edge
        // engages peel first) and deduped against the lattice at half the
        // ring spacing, so the outline is traced even on small regions where
        // every ring point sits within a lattice cell of some interior point.
        const ringCoverageSq = (ringSpacing * 0.5) * (ringSpacing * 0.5);
        const boundary: Array<{ x: number; y: number; z: number; faceIndex?: number }> = sampleBoundary2D(
            insetPolygonLoops2D(island.perimeterLoops, extraLoopInsetMm),
            ringSpacing,
            surfaceAt,
        )
            ?? buildBoundaryPoints(
                eroded.count > 0 ? eroded : voxels,
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
            if (covered) continue;
            // Reuse faceIndex from sampleBoundary2D when already sampled; otherwise
            // raycast voxel fallback points so the ring matches lattice Z and normal.
            const sampled = b.faceIndex !== undefined
                ? { z: b.z, faceIndex: b.faceIndex }
                : surfaceAt(b.x, b.y);
            if (!sampled) continue;
            if (isNearPinnedAnchor(b.x, b.y, sampled.z)) continue;
            emitPoint(b.x, b.y, sampled.z, 'fill', sampled.faceIndex ?? b.faceIndex ?? null);
        }

        if (emittedForRegion === 0) {
            const fallbackSample = surfaceAt(island.contact.x, island.contact.y);
            const fallbackZ = fallbackSample?.z ?? island.contact.z;
            if (!isNearPinnedAnchor(island.contact.x, island.contact.y, fallbackZ)) {
                emitPoint(
                    island.contact.x,
                    island.contact.y,
                    fallbackZ,
                    'fill',
                    fallbackSample?.faceIndex ?? null,
                );
            }
        }
    }

    // Cap every lattice/ring contact by the local free width at its contact,
    // the same pass the island path runs: a tip must fit the feature it lands
    // on, and the lattice used to take the full band contact whatever it hit.
    applyContactTipCaps(candidates, mesh, settings.tipContactMarginScale, settings);
    return candidates;
}
