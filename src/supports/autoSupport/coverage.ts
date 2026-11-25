import * as THREE from 'three';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import type { SupportState } from '../types';
import { SUPPORT_STATE_TYPES, contactEndpointsFor } from '../supportTypeRegistry';
import { cellKey, footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import { bridgeRadiusForAngleDeg, influenceRadiusMm } from './constants';
import { HIGH_LEVERAGE_SPAN_MM, HoldingTipIndex, longestFreeSpanCell } from './supportSpan';

/** A tip covers surface within this radius (mm) — mirrors ALREADY_SUPPORTED_RADIUS_MM. */
export const TIP_COVERAGE_RADIUS_MM = 3.0;
/** Region coverage fraction at which no gap-filling is needed. */
export const REGION_COVERAGE_TARGET = 0.95;
/** Minimum uncovered cluster area (mm²) worth filling (catches bare toe pads & ledges). */
export const MIN_GAP_CLUSTER_MM2 = 1.5;
/** Max gap-fill passes per run. */
export const MAX_GAP_FILL_PASSES = 3;

type TipPos = { x: number; y: number; z: number };

/**
 * Effective cover radius for a region of the given footprint area: large
 * flat regions peel harder (traction ∝ cross-section), so their discs
 * shrink sublinearly → denser packing. At/near the 8 mm² cell reference
 * the full radius applies; floored at half radius.
 */
export function coverageRadiusForArea(areaMm2: number, baseRadiusMm: number = TIP_COVERAGE_RADIUS_MM): number {
    if (!(areaMm2 > 0)) return baseRadiusMm;
    const scale = Math.sqrt(8 / Math.max(areaMm2, 8));
    return baseRadiusMm * Math.max(0.5, scale);
}

/**
 * Angle- and area-aware effective bridge radius (mm) for an overhang region.
 * Flat ceilings (0–15°) bridge only ~1.8 mm laterally in green-state resin;
 * steeper slopes bridge further up to `baseRadiusMm` (3.0 mm).
 */
export function coverageRadiusForRegion(
    region: Pick<DetectedIsland, 'areaMm2' | 'overhangAngleDeg'>,
    baseRadiusMm: number = TIP_COVERAGE_RADIUS_MM,
): number {
    const angleCap = Math.min(baseRadiusMm, bridgeRadiusForAngleDeg(region.overhangAngleDeg));
    const areaRadius = coverageRadiusForArea(region.areaMm2 ?? 0, baseRadiusMm);
    return Math.min(angleCap, areaRadius);
}

/** Collect support-tip world positions from a support snapshot. */
export function collectSupportTips(
    snapshot: SupportState,
    modelId?: string,
): Array<{ x: number; y: number; z: number }> {
    const tips: Array<{ x: number; y: number; z: number }> = [];
    // A collection may be absent on a partially built state (tests, drafts),
    // the same tolerance `collectContactPositions` keeps.
    for (const descriptor of SUPPORT_STATE_TYPES) {
        const endpoints = contactEndpointsFor(descriptor.id);
        if (endpoints.length === 0) continue;
        const collection = snapshot[descriptor.location.key] as Record<string, { modelId?: string }> | undefined;
        if (!collection) continue;
        for (const entity of Object.values(collection)) {
            if (modelId !== undefined && entity.modelId !== modelId) continue;
            const record = entity as Record<string, { pos?: TipPos } | undefined>;
            if (endpoints.length === 1) {
                const pos = record[endpoints[0].field]?.pos;
                if (pos) tips.push(pos);
            } else {
                const upperEndpoint = endpoints.find((ep) => ep.end === 'upper') ?? endpoints[endpoints.length - 1];
                const lowerEndpoint = endpoints.find((ep) => ep.end === 'lower');
                const upperPos = record[upperEndpoint.field]?.pos;
                const lowerPos = lowerEndpoint ? record[lowerEndpoint.field]?.pos : undefined;
                const pos = upperPos && lowerPos && lowerPos.z > upperPos.z ? lowerPos : upperPos;
                if (pos) tips.push(pos);
            }
        }
    }
    return tips;
}

/** A tip's coverage disc widens along the influence curve, which caps at 6 mm
 *  — so the growth term never adds more than this to a disc's radius. */
const MAX_INFLUENCE_GROWTH_MM = Math.max(
    0,
    influenceRadiusMm(Number.POSITIVE_INFINITY) - TIP_COVERAGE_RADIUS_MM,
);

/** Square of the disc a tip covers at a voxel `vz` above `tipZ` (-1 when `tipZ` lies >1 mm above `vz`).
 *  Flat/shallow ceilings (≤15°) do not get upward influence growth across the face,
 *  so a heel tip cannot falsely claim a forefoot 4 mm away as covered. */
function coverRadiusSq(vz: number, tipZ: number, radiusMm: number, shallowRegion: boolean): number {
    if (tipZ - vz > 1.0) return -1;
    if (shallowRegion) return radiusMm * radiusMm;
    const growth = Math.min(1.5, Math.max(0, influenceRadiusMm(vz - tipZ) - TIP_COVERAGE_RADIUS_MM));
    const r = radiusMm + growth;
    return r * r;
}

/**
 * Tips bucketed on a uniform plan grid. A tip's disc never reaches past
 * `radius + MAX_INFLUENCE_GROWTH_MM`, so a voxel only ever has to test the
 * tips in its own cell and the eight around it — the coverage test used to be
 * O(footprint voxels × tips), which on a large region is millions of distance
 * tests per call and the single hottest loop in a run.
 */
class TipIndex {
    private readonly buckets = new Map<number, TipPos[]>();
    private readonly cell: number;

    constructor(tips: TipPos[], radiusMm: number) {
        this.cell = Math.max(0.5, radiusMm + MAX_INFLUENCE_GROWTH_MM);
        for (const tip of tips) {
            const key = cellKey(Math.floor(tip.x / this.cell), Math.floor(tip.y / this.cell));
            const bucket = this.buckets.get(key);
            if (bucket) bucket.push(tip);
            else this.buckets.set(key, [tip]);
        }
    }

    /** Visit tips that could reach (x, y); stops as soon as `visit` returns true. */
    forEachNear(x: number, y: number, visit: (tip: TipPos) => boolean): void {
        const cx = Math.floor(x / this.cell);
        const cy = Math.floor(y / this.cell);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const bucket = this.buckets.get(cellKey(cx + dx, cy + dy));
                if (!bucket) continue;
                for (const tip of bucket) {
                    if (visit(tip)) return;
                }
            }
        }
    }
}

const DOUBLE_SIDED_SURFACE_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const _coverageRaycaster = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _upDir = new THREE.Vector3(0, 0, 1);
const _downDir = new THREE.Vector3(0, 0, -1);

/**
 * Evaluate each voxel in `region.contactVoxels` against `tips` while enforcing
 * flat-step isolation and (when `mesh` is present) vertical occlusion across
 * solid shelves so lower overhang supports cannot mark higher stacked shelves covered.
 */
function visitVoxelCoverage(
    region: DetectedIsland,
    tips: TipPos[],
    radiusMm: number,
    mesh: THREE.Mesh | undefined,
    onVoxel: (vx: number, vy: number, vz: number | null, covered: boolean) => void,
): void {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return;

    if (tips.length === 0) {
        for (let i = 0; i < voxels.count; i++) {
            onVoxel(footprintX(voxels, i), footprintY(voxels, i), footprintZ(voxels, i), false);
        }
        return;
    }

    const index = new TipIndex(tips, radiusMm);
    const flatRegion = (region.overhangAngleDeg ?? 0) <= 5;
    const shallowRegion = (region.overhangAngleDeg ?? 0) <= 15;
    let minTipZ = Infinity;
    let maxVoxelZ = -Infinity;
    if (mesh) {
        for (const t of tips) {
            if (t.z < minTipZ) minTipZ = t.z;
        }
        for (let i = 0; i < voxels.count; i++) {
            const z = footprintZ(voxels, i);
            if (z !== null && z > maxVoxelZ) maxVoxelZ = z;
        }
    }
    const checkMesh = Boolean(mesh && maxVoxelZ - minTipZ > 0.5);
    const tipCeilingCache = checkMesh && flatRegion ? new Map<TipPos, number | null>() : null;

    const getTipCeilingZ = (tip: TipPos): number | null => {
        if (!tipCeilingCache || !mesh) return null;
        if (tipCeilingCache.has(tip)) return tipCeilingCache.get(tip)!;
        _rayOrigin.set(tip.x, tip.y, tip.z + 0.05);
        _coverageRaycaster.near = 0;
        _coverageRaycaster.far = Math.max(0.1, maxVoxelZ - tip.z + 0.05);
        _coverageRaycaster.set(_rayOrigin, _upDir);
        const ceilZ = _coverageRaycaster.intersectObject(mesh, false)[0]?.point.z ?? null;
        tipCeilingCache.set(tip, ceilZ);
        return ceilZ;
    };

    let originalMaterial: THREE.Material | THREE.Material[] | undefined;
    if (checkMesh && mesh) {
        originalMaterial = mesh.material;
        mesh.material = DOUBLE_SIDED_SURFACE_MATERIAL;
    }

    try {
        let vx = 0;
        let vy = 0;
        let vz: number | null = null;
        let voxelFloorCached = false;
        let voxelFloorZ = -Infinity;
        let hit = false;

        const probe = (tip: TipPos): boolean => {
            const dx = vx - tip.x;
            const dy = vy - tip.y;
            const rSq = coverRadiusSq(vz ?? tip.z, tip.z, radiusMm, shallowRegion);
            if (rSq < 0 || dx * dx + dy * dy > rSq) return false;

            if (vz !== null && vz - tip.z > 0.5) {
                if (flatRegion && vz - tip.z > 1.0) {
                    if (tip.z >= region.baseZ - 0.25) return false;
                    if (checkMesh) {
                        const ceilZ = getTipCeilingZ(tip);
                        if (ceilZ !== null && ceilZ < vz - 0.05) return false;
                    }
                }
                if (checkMesh && mesh) {
                    if (!voxelFloorCached) {
                        _rayOrigin.set(vx, vy, vz - 0.05);
                        _coverageRaycaster.near = 0;
                        _coverageRaycaster.far = Math.max(0.1, vz - minTipZ + 0.05);
                        _coverageRaycaster.set(_rayOrigin, _downDir);
                        voxelFloorZ = _coverageRaycaster.intersectObject(mesh, false)[0]?.point.z ?? -Infinity;
                        voxelFloorCached = true;
                    }
                    if (tip.z < voxelFloorZ + 0.05) return false;
                }
            }

            hit = true;
            return true;
        };

        for (let i = 0; i < voxels.count; i++) {
            vx = footprintX(voxels, i);
            vy = footprintY(voxels, i);
            vz = footprintZ(voxels, i);
            voxelFloorCached = false;
            voxelFloorZ = -Infinity;
            hit = false;
            index.forEachNear(vx, vy, probe);
            onVoxel(vx, vy, vz, hit);
        }
    } finally {
        if (checkMesh && mesh && originalMaterial !== undefined) {
            mesh.material = originalMaterial;
        }
    }
}

/**
 * Fraction of an overhang region's projected footprint covered by tips.
 * Each tip's disc grows with the voxel height above it (support influence
 * curve): a tip covers `radiusMm` at its own height, widening along
 * `influenceRadiusMm` above. This is the footprint-aware coverage the
 * convergence loop iterates on — a region whose centroid is covered but
 * whose edges are exposed reads as under-covered.
 */
export function computeRegionCoverage(
    region: DetectedIsland,
    tips: Array<{ x: number; y: number; z: number }>,
    radiusMm: number = TIP_COVERAGE_RADIUS_MM,
    mesh?: THREE.Mesh,
): number {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return 0;
    if (tips.length === 0) return 0;

    let covered = 0;
    visitVoxelCoverage(region, tips, radiusMm, mesh, (_vx, _vy, _vz, isCovered) => {
        if (isCovered) covered++;
    });
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
    allowZeroTips: boolean = false,
    layerHeightMm: number = 0.05,
    mesh?: THREE.Mesh,
    minClusterSpanMm: number = HIGH_LEVERAGE_SPAN_MM,
): Array<{ x: number; y: number; z: number }> {
    const voxels = region.contactVoxels;
    if (!voxels || voxels.count === 0) return [];
    if (tips.length === 0 && !allowZeroTips) {
        // No tips at all — a single cluster covering everything is not useful;
        // return [] so the caller's main grid handles the region instead.
        return [];
    }

    const cells: Array<{ x: number; y: number; z?: number }> = [];
    visitVoxelCoverage(region, tips, radiusMm, mesh, (vx, vy, vz, isCovered) => {
        if (!isCovered) cells.push({ x: vx, y: vy, z: vz ?? undefined });
    });

    const visited = new Set<number>();
    const clusters: Array<{ x: number; y: number; z: number }> = [];
    // Voxels sit on a 0.25mm grid; exact integer cell key → indices for O(1)
    // neighbor lookup (avoids indexOf-per-neighbor O(n²) on big regions, and
    // preserves stacked shelves at the same XY).
    const indicesByKey = new Map<number, number[]>();
    cells.forEach((v, i) => {
        const key = cellKey(Math.round(v.x * 4), Math.round(v.y * 4));
        const list = indicesByKey.get(key);
        if (list) list.push(i);
        else indicesByKey.set(key, [i]);
    });
    const angleDeg = region.overhangAngleDeg ?? 0;

    for (let i = 0; i < cells.length; i++) {
        if (visited.has(i)) continue;
        // BFS over the voxel set (voxels are at 0.25mm spacing; neighbors are
        // within 0.5mm and Z-continuous).
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
                    const neighbors = indicesByKey.get(cellKey(kx + ddx, ky + ddy));
                    if (!neighbors) continue;
                    for (const ni of neighbors) {
                        if (visited.has(ni)) continue;
                        if (v.z !== undefined && cells[ni].z !== undefined) {
                            const stepXY = Math.hypot(cells[ni].x - v.x, cells[ni].y - v.y);
                            const maxStepDz = angleDeg <= 2
                                ? 2 * layerHeightMm
                                : 2 * layerHeightMm + stepXY * Math.tan((Math.min(75, angleDeg + 8) * Math.PI) / 180);
                            if (Math.abs(cells[ni].z! - v.z) > maxStepDz) continue;
                        }
                        visited.add(ni);
                        stack.push(ni);
                    }
                }
            }
        }

        const areaMm2 = cluster.length * 0.25 * 0.25;
        if (areaMm2 < minClusterMm2) {
            // A long thin bare sliver has little area but a real unsupported
            // span; the old area-only floor skipped it while the printability
            // span check warned about it.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const v of cluster) {
                if (v.x < minX) minX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.x > maxX) maxX = v.x;
                if (v.y > maxY) maxY = v.y;
            }
            if (Math.max(maxX - minX, maxY - minY) < minClusterSpanMm) continue;
        }

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

function tipBelongsToLowerFlatRegion(
    tip: TipPos,
    targetRegion: DetectedIsland,
    allRegions: DetectedIsland[],
): boolean {
    if (tip.z >= targetRegion.baseZ - 1.0) return false;
    for (const other of allRegions) {
        if (other.id === targetRegion.id) continue;
        if ((other.overhangAngleDeg ?? 0) > 5) continue;
        const otherMaxZ = other.maxZ ?? other.baseZ;
        if (tip.z < other.baseZ - 0.5 || tip.z > otherMaxZ + 0.5) continue;
        const ov = other.contactVoxels;
        if (ov && ov.count > 0) {
            for (let i = 0; i < ov.count; i++) {
                const dx = footprintX(ov, i) - tip.x;
                const dy = footprintY(ov, i) - tip.y;
                if (dx * dx + dy * dy <= 0.5 * 0.5) return true;
            }
        } else if (Math.abs(tip.z - other.baseZ) <= 0.5) {
            return true;
        }
    }
    return false;
}

/**
 * Build gap-fill candidates for under-covered overhang regions: standalone
 * trunk candidates (gridPoint) at uncovered footprint cluster centroids,
 * using the region's surface normal so placement skips the wrong-face raycast.
 */
/** Most perimeter contacts one region may contribute per gap-fill pass. */
const MAX_PERIMETER_CANDIDATES_PER_REGION = 12;

/**
 * Walk a closed plan loop and emit a point every `spacingMm` of arc length.
 * Spacing is measured along the loop, not per edge: `perimeterLoops` are
 * triangle-accurate polygons whose edges can be far shorter than a support
 * disc, so one point per vertex would flood a flat foot with contacts.
 */
function sampleLoopByArc(
    loop: readonly [number, number, number][],
    spacingMm: number,
): Array<{ x: number; y: number; z: number }> {
    const points: Array<{ x: number; y: number; z: number }> = [];
    if (loop.length < 2 || !(spacingMm > 0)) return points;
    let carry = 0;
    for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) continue;
        for (let d = carry; d < len; d += spacingMm) {
            const t = d / len;
            points.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] });
        }
        carry = (carry - len) % spacingMm;
        if (carry < 0) carry += spacingMm;
    }
    return points;
}

/** Whether a plan point is inside any placed tip's coverage disc, using the
 *  same influence growth the footprint coverage applies. */
function isPlanPointCovered(
    point: { x: number; y: number; z: number },
    tips: Array<{ x: number; y: number; z: number }>,
    radiusMm: number,
    shallowRegion: boolean,
): boolean {
    for (const tip of tips) {
        if (tip.z - point.z > 1.0) continue;
        const growth = shallowRegion
            ? 0
            : Math.min(1.5, Math.max(0, influenceRadiusMm(point.z - tip.z) - TIP_COVERAGE_RADIUS_MM));
        const reach = radiusMm + growth;
        const dx = point.x - tip.x;
        const dy = point.y - tip.y;
        if (dx * dx + dy * dy <= reach * reach) return true;
    }
    return false;
}

export function buildGapFillCandidates(
    overhangIslands: DetectedIsland[],
    settings: AutoSupportSettings,
    tips: Array<{ x: number; y: number; z: number }>,
    layerHeightMm: number = 0.05,
    mesh?: THREE.Mesh,
): CandidatePoint[] {
    const out: CandidatePoint[] = [];
    const coverageTarget = (settings.coverageTargetPercent ?? 95) / 100;
    for (const region of overhangIslands) {
        if (region.source !== 'overhang') continue;
        // Internal ceilings use the sparser interior grid; re-densifying them
        // through coverage convergence defeats that.
        if (region.interior) continue;
        if (!region.contactVoxels || region.contactVoxels.count === 0) continue;
        const regionTips = mesh
            ? tips
            : tips.filter((t) => !tipBelongsToLowerFlatRegion(t, region, overhangIslands));
        const radius = coverageRadiusForRegion(region);
        const coverage = computeRegionCoverage(region, regionTips, radius, mesh);
        const emitted: Array<{ x: number; y: number; z: number }> = [];

        if (coverage < coverageTarget) {
            const clusters = findUncoveredClusters(region, regionTips, radius, MIN_GAP_CLUSTER_MM2, true, layerHeightMm, mesh);
            for (const c of clusters) {
                emitted.push(c);
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
                    interior: region.interior,
                });
            }
        }

        // Coverage is a disc radius; it does not say how far a footprint cell
        // is from the nearest holding tip. A covered region with a long free
        // span is still a cantilever, so add one contact at its worst cell even
        // when the coverage target is met.
        const spanCell = longestFreeSpanCell(region, new HoldingTipIndex(regionTips), region.baseZ);
        if (spanCell && spanCell.spanMm >= HIGH_LEVERAGE_SPAN_MM) {
            const cell = spanCell.cell;
            const near = emitted.some((other) => Math.hypot(other.x - cell.x, other.y - cell.y) < 0.75);
            if (!near) {
                emitted.push(cell);
                out.push({
                    id: `span-${region.id}-${cell.x.toFixed(2)}-${cell.y.toFixed(2)}`,
                    tipPos: cell,
                    tipNormal: region.surfaceNormal ?? { x: 0, y: 0, z: -1 },
                    modelId: '',
                    source: 'overhang',
                    islandAreaMm2: settings.areaPerSupportMm2,
                    zHeight: cell.z,
                    priority: 0,
                    gridPoint: true,
                    interior: region.interior,
                });
            }
        }

        // Perimeter-first fill. A cluster centroid covers the middle of a bare
        // patch but leaves a long foot's sole and its toe/heel corners exposed —
        // exactly where a flat overhang tears first. Walk the region's own
        // triangle-accurate loops at disc spacing and add a contact at every
        // uncovered point, corners included because the arc walk visits them.
        const loops = region.perimeterLoops;
        if (!loops || loops.length === 0) continue;
        const spacingMm = Math.max(1.2, radius * 1.1);
        const shallow = (region.overhangAngleDeg ?? 0) <= 15;
        let added = 0;
        for (const loop of loops) {
            if (added >= MAX_PERIMETER_CANDIDATES_PER_REGION) break;
            for (const point of sampleLoopByArc(loop, spacingMm)) {
                if (added >= MAX_PERIMETER_CANDIDATES_PER_REGION) break;
                if (isPlanPointCovered(point, regionTips, radius, shallow)) continue;
                if (emitted.some((other) => Math.hypot(other.x - point.x, other.y - point.y) < spacingMm * 0.5)) continue;
                emitted.push(point);
                out.push({
                    id: `perim-${region.id}-${added}`,
                    tipPos: { x: point.x, y: point.y, z: point.z },
                    tipNormal: region.surfaceNormal ?? { x: 0, y: 0, z: -1 },
                    modelId: '',
                    source: 'overhang',
                    islandAreaMm2: settings.areaPerSupportMm2,
                    zHeight: point.z,
                    priority: 0,
                    gridPoint: true,
                    interior: region.interior,
                });
                added++;
            }
        }
    }
    return out;
}
