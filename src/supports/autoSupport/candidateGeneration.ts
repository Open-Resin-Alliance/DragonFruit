import * as THREE from 'three';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import { SMALL_ISLAND_TIP_AREA_MM2, SUPPORT_RESTSTACK_DELTA_MM, influenceRadiusMm, ISLAND_SUB_HEAD_MM, ISLAND_TWO_POINT_MIN_MM, ISLAND_TWO_POINT_MAX_MM, ISLAND_TWO_POINT_MAX_WIDTH_MM } from './constants';
import { footprintX, footprintY } from '../../volumeAnalysis/Islands/voxelFootprint';
import { smallIslandTipDiameterMm } from './parameterSizing';
import { TIP_COVERAGE_RADIUS_MM } from './coverage';
import { isSupportBlockedContact } from './supportBlockers';

const DOUBLE_SIDED_SURFACE_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const _dedupRaycaster = new THREE.Raycaster();
const _dedupOrigin = new THREE.Vector3();
const _dedupDownDir = new THREE.Vector3(0, 0, -1);

/**
 * Convert detected islands into auto-support candidate points.
 * Filters out already-supported, grounded, and too-small islands.
 * Scores candidates by priority and sorts descending.
 * Note: SDF local free-width tip capping runs in `computeAutoSupportPlan`
 * after true surface normals have been resolved.
 */
export interface CandidatePruneContext {
    /** World-frame mesh for contact-face resolution. */
    mesh?: THREE.Mesh;
    /** Model owning the support-blocker mask. Both required to prune. */
    modelId?: string;
}

export function generateCandidates(
    islands: DetectedIsland[],
    settings: AutoSupportSettings,
    prune?: CandidatePruneContext,
): CandidatePoint[] {
    if (!islands || islands.length === 0) return [];

    // Filter
    // Note: grounded/plate-contact filtering is handled upstream by the
    // Islands panel's Plate toggle — filteredIslands already reflects it.
    const areaEligible = islands.filter(island => {
        if (island.source === 'minima' || island.class === 'intersection' || Boolean(island.isDetached)) return true;
        const area = island.areaMm2 ?? 0;
        return area >= settings.minIslandAreaMm2;
    });

    const presentVoxelIds = new Set<string>();
    for (const isl of areaEligible) {
        if (isl.source === 'voxel') presentVoxelIds.add(isl.id);
    }

    const eligible = areaEligible.filter(
        (isl) => !(isl.source === 'minima' && isl.class === 'intersection' && isl.matchedWith != null && presentVoxelIds.has(isl.matchedWith)),
    );

    // Map to candidates
    let candidates = eligible.flatMap(island => candidatesFromIsland(island));
    // Support blockers: refuse contacts painted as nogo. The mask check
    // early-outs internally, so unpainted models skip the raycasts.
    if (prune?.mesh && prune?.modelId) {
        const { mesh, modelId } = prune;
        candidates = candidates.filter(
            (c) => !isSupportBlockedContact(modelId, mesh, c.tipPos.x, c.tipPos.y, c.tipPos.z),
        );
    }
    // Note: SDF free-width tip capping runs in `computeAutoSupportPlan` once
    // non-gridPoint candidates have resolved their true surface normals.
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
        // Fine detail keeps a shrunk (detail-band) tip; grid/overhang points
        // and larger islands take the active band default (undefined) — until
        // `computeAutoSupportPlan` runs the free-width cap after normal resolution.
        tipDiameterMm: area < SMALL_ISLAND_TIP_AREA_MM2 ? smallIslandTipDiameterMm() : undefined,
        interior: island.interior,
    };
}
/**
 * Island-typed emission: one island yields one or two candidates by span.
 * Sub-head specks get a single tip at the bbox center; narrow islands in
 * the two-point band split into a symmetric pair (each carrying half the
 * area, so sizing tails stay honest); everything else keeps the single
 * contact-point candidate. Islands without footprint voxels (minima)
 * always take the single path.
 */
export function candidatesFromIsland(island: DetectedIsland): CandidatePoint[] {
    const base = candidateFromIsland(island);
    const voxels = island.contactVoxels;
    let out: CandidatePoint[];
    if (!voxels || voxels.count === 0) {
        out = [base];
    } else {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < voxels.count; i++) {
            const x = footprintX(voxels, i);
            const y = footprintY(voxels, i);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const extX = maxX - minX;
        const extY = maxY - minY;
        const major = Math.max(extX, extY);
        const minor = Math.min(extX, extY);
        if (major <= ISLAND_SUB_HEAD_MM) {
            out = island.class === 'intersection'
                ? [base]
                : [{
                    ...base,
                    tipPos: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: island.contact.z },
                }];
        } else if (
            major >= ISLAND_TWO_POINT_MIN_MM && major < ISLAND_TWO_POINT_MAX_MM &&
            minor < ISLAND_TWO_POINT_MAX_WIDTH_MM
        ) {
            const alongX = extX >= extY;
            const lo = alongX ? minX : minY;
            const span = alongX ? extX : extY;
            const fixed = alongX ? (minY + maxY) / 2 : (minX + maxX) / 2;
            const halfArea = base.islandAreaMm2 / 2;
            const pairTip = halfArea < SMALL_ISLAND_TIP_AREA_MM2 ? smallIslandTipDiameterMm() : undefined;
            if (island.class === 'intersection') {
                const t = (((alongX ? island.contact.x : island.contact.y) - lo) <= 0.5 * span) ? 0.75 : 0.25;
                const along = lo + span * t;
                out = [
                    {
                        ...base,
                        id: `${island.id}-a`,
                        tipPos: { x: island.contact.x, y: island.contact.y, z: island.contact.z },
                        islandAreaMm2: halfArea,
                        tipDiameterMm: pairTip,
                    },
                    {
                        ...base,
                        id: `${island.id}-b`,
                        tipPos: alongX
                            ? { x: along, y: fixed, z: island.contact.z }
                            : { x: fixed, y: along, z: island.contact.z },
                        islandAreaMm2: halfArea,
                        tipDiameterMm: pairTip,
                    },
                ];
            } else {
                out = [0.25, 0.75].map((t, i) => {
                    const along = lo + span * t;
                    return {
                        ...base,
                        id: `${island.id}-${i === 0 ? 'a' : 'b'}`,
                        tipPos: alongX
                            ? { x: along, y: fixed, z: island.contact.z }
                            : { x: fixed, y: along, z: island.contact.z },
                        islandAreaMm2: halfArea,
                        tipDiameterMm: pairTip,
                    };
                });
            }
        } else {
            out = [base];
        }
    }

    if (island.subApexes && island.subApexes.length > 0) {
        const acceptedPts = out.map((c) => ({ x: c.tipPos.x, y: c.tipPos.y, z: c.tipPos.z }));
        const minSubDistSq = 0.8 * 0.8;
        let subIdx = 0;
        for (const ap of island.subApexes) {
            if (!Number.isFinite(ap.x) || !Number.isFinite(ap.y) || !Number.isFinite(ap.z)) continue;
            let tooClose = false;
            for (const prev of acceptedPts) {
                const dx = ap.x - prev.x;
                const dy = ap.y - prev.y;
                const dz = ap.z - prev.z;
                if (dx * dx + dy * dy + dz * dz < minSubDistSq) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) continue;
            out.push({
                ...base,
                id: `${island.id}-sub${subIdx++}`,
                tipPos: { x: ap.x, y: ap.y, z: ap.z },
                zHeight: ap.z,
                tipDiameterMm: smallIslandTipDiameterMm(),
            });
            acceptedPts.push({ x: ap.x, y: ap.y, z: ap.z });
        }
    }

    return out;
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
 * Overhang-lattice pairs suppress on a 2D (XY) disc that widens with
 * vertical separation (support influence curve) — except pairs farther
 * apart in Z than SUPPORT_RESTSTACK_DELTA_MM, so staircase shelves keep
 * their supports. Discrete islands (voxel/minima/intersection) always use
 * the flat 3D ball: neighboring islands must never eat each other.
 */
export function deduplicateCandidates(
    candidates: CandidatePoint[],
    settings: AutoSupportSettings,
    mesh?: THREE.Mesh,
): CandidatePoint[] {
    if (candidates.length <= 1) return candidates;

    const baseRadius = settings.tipInfluenceRadiusMm;
    if (baseRadius <= 0) return [...candidates].sort((a, b) => b.priority - a.priority);
    // The suppression disc widens with vertical separation (support influence
    // curve) — but never across the restack allowance, so staircase shelves
    // keep their own supports. Neighbor search spans the max grown radius.
    const maxGate = Math.max(baseRadius, 0.6) + (6.0 - TIP_COVERAGE_RADIUS_MM);
    const cellSize = Math.max(0.1, baseRadius);
    const cellRange = Math.max(1, Math.ceil(maxGate / cellSize));
    const pairRadius = Math.max(baseRadius, 0.6);
    const pairRadiusSq = pairRadius * pairRadius;
    const baseRadiusSq = baseRadius * baseRadius;

    // Bucket the *retained* candidates by XY cell as they are kept. Only a
    // retained candidate can suppress a later one, so the index only ever
    // holds survivors: a candidate probes its neighbourhood against that
    // local set rather than filtering the whole retained list through each
    // bucket (the old code was O(candidates × retained × bucket) and was the
    // single largest cost of a dense lattice run).
    //
    // Numeric cell keys, not strings: this runs once per candidate and the
    // interpolation allocated two strings a call. The offset keeps the key
    // positive and exact in a double for every grid a plate can hold
    // (±32768 cells at the tip radius).
    const suppressedGrid = new Set<CandidatePoint>();
    const grid = new Map<number, CandidatePoint[]>();
    const floorBelowCache = mesh ? new Map<CandidatePoint, number | null>() : null;

    const getFloorBelowZ = (high: CandidatePoint): number | null => {
        if (!mesh || !floorBelowCache) return null;
        if (floorBelowCache.has(high)) return floorBelowCache.get(high)!;
        _dedupOrigin.set(high.tipPos.x, high.tipPos.y, high.tipPos.z - 0.05);
        _dedupRaycaster.near = 0;
        _dedupRaycaster.far = SUPPORT_RESTSTACK_DELTA_MM + 0.05;
        _dedupRaycaster.set(_dedupOrigin, _dedupDownDir);
        const floorZ = _dedupRaycaster.intersectObject(mesh, false)[0]?.point.z ?? null;
        floorBelowCache.set(high, floorZ);
        return floorZ;
    };

    const sorted = [...candidates].sort((a, b) => b.priority - a.priority);
    const retained: CandidatePoint[] = [];

    let originalMaterial: THREE.Material | THREE.Material[] | undefined;
    if (mesh) {
        originalMaterial = mesh.material;
        mesh.material = DOUBLE_SIDED_SURFACE_MATERIAL;
    }

    try {
        for (const c of sorted) {
            const cx = Math.round(c.tipPos.x / cellSize);
            const cy = Math.round(c.tipPos.y / cellSize);

            let duplicate = false;
            const pendingEvictions: Array<{ item: CandidatePoint; bucket: CandidatePoint[] }> = [];
            for (let dx = -cellRange; dx <= cellRange && !duplicate; dx++) {
                for (let dy = -cellRange; dy <= cellRange && !duplicate; dy++) {
                    const bucket = grid.get((cx + dx + 0x8000) * 0x10000 + (cy + dy + 0x8000));
                    if (!bucket) continue;
                    for (let bi = bucket.length - 1; bi >= 0; bi--) {
                        const r = bucket[bi];
                        const ddx = c.tipPos.x - r.tipPos.x;
                        const ddy = c.tipPos.y - r.tipPos.y;
                        const dz = Math.abs(c.tipPos.z - r.tipPos.z);
                        const rDiscreteCOverhang = r.source !== 'overhang' && !r.gridPoint && c.source === 'overhang';
                        const cDiscreteROverhang = c.source !== 'overhang' && !c.gridPoint && r.source === 'overhang';
                        if (rDiscreteCOverhang || cDiscreteROverhang) {
                            const ddz = c.tipPos.z - r.tipPos.z;
                            if (ddx * ddx + ddy * ddy + ddz * ddz <= pairRadiusSq) {
                                if (rDiscreteCOverhang) {
                                    duplicate = true;
                                    break;
                                }
                                // Defer bucket eviction until we know `c` itself survives all neighbor checks.
                                pendingEvictions.push({ item: r, bucket });
                            }
                            continue;
                        }
                        // Discrete islands (voxel/minima/intersection) and near-base
                        // overhang points (e.g. slightly sloped soles) use the flat
                        // 3D ball only so higher-Z points on a sloped foot aren't
                        // erased by the vertical influence-radius growth.
                        if (c.source !== 'overhang' || r.source !== 'overhang' || (c.nearBase && r.nearBase)) {
                            const ddz = c.tipPos.z - r.tipPos.z;
                            if (ddx * ddx + ddy * ddy + ddz * ddz <= baseRadiusSq) {
                                duplicate = true;
                                break;
                            }
                            continue;
                        }
                        // Restack: vertically separated shelves never suppress
                        // each other, however close in XY.
                        if (dz > SUPPORT_RESTSTACK_DELTA_MM) continue;
                        const gate = baseRadius
                            + Math.max(0, influenceRadiusMm(dz) - TIP_COVERAGE_RADIUS_MM);
                        if (ddx * ddx + ddy * ddy <= gate * gate) {
                            if (mesh && dz > 0.5) {
                                const low = c.tipPos.z <= r.tipPos.z ? c : r;
                                const high = c.tipPos.z <= r.tipPos.z ? r : c;
                                if (Math.abs(low.tipNormal.z) > 0.99 && Math.abs(high.tipNormal.z) > 0.99 && dz > 1.0) {
                                    continue;
                                }
                                const floorZ = getFloorBelowZ(high);
                                if (floorZ !== null && floorZ >= low.tipPos.z - 0.05) {
                                    continue;
                                }
                            }
                            duplicate = true;
                            break;
                        }
                    }
                }
            }

            if (duplicate) continue;
            for (const ev of pendingEvictions) {
                suppressedGrid.add(ev.item);
                const liveIdx = ev.bucket.indexOf(ev.item);
                if (liveIdx !== -1) ev.bucket.splice(liveIdx, 1);
            }
            retained.push(c);
            const key = (cx + 0x8000) * 0x10000 + (cy + 0x8000);
            const bucket = grid.get(key);
            if (bucket) bucket.push(c);
            else grid.set(key, [c]);
        }
    } finally {
        if (mesh && originalMaterial !== undefined) {
            mesh.material = originalMaterial;
        }
    }

    const finalRetained = suppressedGrid.size > 0
        ? retained.filter((c) => !suppressedGrid.has(c))
        : retained;
    return finalRetained.sort((a, b) => b.priority - a.priority);
}
