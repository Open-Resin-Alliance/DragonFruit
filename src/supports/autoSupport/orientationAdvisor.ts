/**
 * Orientation advisor (M1 sweep-and-score, see `docs/dev/auto-orientation.md`):
 * suggest a build orientation that minimizes support contact area, without
 * ever auto-rotating. Curvy-style quality-weighted cost (Ulu et al. 2021)
 * plus a resin-required suction-cup penalty Curvy lacks — its cost would
 * happily invert a cupped part.
 *
 * The search is a deterministic candidate sweep, not an annealer: a
 * Fibonacci-sphere sweep over down-axes plus convex-hull resting poses
 * (largest hull faces stood on the plate — an approximation of the stable
 * set, not a full center-of-mass stability proof), always including the
 * current pose so the result never regresses, then coordinate-descent
 * refinement around the top-K candidates from the coarse pass. Same model,
 * same result — no RNG. The
 * `objective` option picks what ranks first (`supports` contact area by
 * default, `height` for the fastest print, `scarring` for contact weighted by
 * surface detail). Under `supports`, primaries within
 * the anchoring margin of the minimum tie so a wider base wins a few extra
 * mm² of contact instead of balancing on a point.
 *
 * Pure functions over triangle soup (no mesh store dependency) so the
 * solver is trivially testable. (Rotation about Z is omitted deliberately:
 * Z is plate-up, so it cannot change any normal.z and the cost would be
 * blind to it.)
 */

import * as THREE from 'three';
import { ConvexHull } from 'three-stdlib';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { isStaticallyUnstable, measurePoseStability, type PoseStability, type RestingContact } from './poseStability';

export interface AdvisorMesh {
    /** Flat XYZ positions (mm, model space). */
    positions: ArrayLike<number>;
    /** Triangle indices into positions (3 per tri). Non-indexed if omitted. */
    index?: ArrayLike<number> | null;
}

/** Cost breakdown for one orientation (radians about X, then Y). */
export interface OrientationCost {
    /** Down-facing area past the self-support angle (mm²). */
    overhangAreaMm2: number;
    /** Near-flat down-facing area — suction-cup proxy (mm²). */
    cupAreaMm2: number;
    /** Z extent of the rotated mesh (mm). Primary under the height objective, tie-breaker otherwise. */
    heightMm: number;
    /** XY bounding-box area of the rotated mesh (mm²). Tie-breaker. */
    footprintMm2: number;
    /** Scar-weighted down-facing area (contact plus detail multiple); the primary under the scarring objective. */
    scarAreaMm2: number;
    /** Down-facing support-blocked area (mm²): contact the generator must refuse. Weighted into cost under every objective. */
    blockedAreaMm2: number;
    /** Bearing-hull area under this pose (mm²); 0 = no bearing polygon. */
    bearingAreaMm2: number;
    /** Bearing-hull edge count; 0 = the pose touches on a point or an edge. */
    bearingEdges: number;
    /** How far the volume centroid sits inside the worst bearing edge (mm).
     *  Negative means the mass is already outside the base. */
    centroidDepthMm: number;
    /** Gravity verdict geometry: `V·d/M` (mm), infinite with no lateral drag. */
    marginMm: number;
    /** Plate-adhesion verdict geometry: `A_contact·d̄/M` (dimensionless). */
    adhesionRatio: number;
    /** What an unstable pose was charged, in area-equivalent (mm²). */
    stabilityPenaltyMm2: number;
    /** Weighted total the search minimizes: the objective's primary plus cup and blocked terms. */
    cost: number;
}

/** What the sweep ranks first. `supports` minimizes contact area (the resin default); `height` minimizes Z extent (fastest print) and breaks ties by contact area; `scarring` minimizes contact weighted by surface detail (least scarring) with the same cup guard. */
export type OrientationObjective = 'supports' | 'height' | 'scarring';

export interface AdvisorOptions {
    /** Face is overhang when normal.z < -cos(angle). Default 45°. */
    selfSupportAngleDeg?: number;
    /** Extra weight per mm² of cup area. Default 2 (cups fail prints). */
    cupWeight?: number;
    /** Detail multiple on scar-weighted contact. Default 3: a mm² on a sharp crease costs ~4× flat contact. */
    scarWeight?: number;
    /** Ranking objective. Default 'supports'. */
    objective?: OrientationObjective;
    /** Model-space triangle indices painted as support blockers (nogo contact). Default none. */
    blockedTriangleIndices?: ArrayLike<number> | Set<number> | null;
    /** Extra weight per mm² of down-facing blocked area. Default 10: blocked contact is refused, so poses needing it lose hard — while staying finite so the result never regresses. */
    blockedWeight?: number;
    /** Extra weight per mm² of footprint charged to a pose that cannot stand on
     *  the plate at all — no bearing polygon, or its mass outside the base
     *  (`isStaticallyUnstable`). Default 1: an unstable pose is charged its
     *  whole footprint, the contact the stabilization pass will have to
     *  manufacture. Finite on purpose, so the search still returns the least
     *  bad pose when every candidate is unstable. Set 0 to rank on contact
     *  area alone, as before. */
    stabilityWeight?: number;
    /** Fibonacci-sphere candidate count. Default 120. */
    candidateCount?: number;
    /** Max convex-hull resting poses folded into the sweep. Default 12. */
    restingPoseCount?: number;
    /** Top-K coarse candidates refined by coordinate descent. Default 5. */
    refineTopK?: number;
}

export interface OrientationSuggestion {
    rotXDeg: number;
    rotYDeg: number;
    baseline: OrientationCost;
    suggested: OrientationCost;
    /** Predicted contact-area change vs current orientation (negative = better). */
    deltaPercent: number;
}

/** One sweep candidate: tilt (rotX) and turntable (rotY) in radians. */
export interface OrientationCandidate {
    rotXRad: number;
    rotYRad: number;
}

const DEFAULT_ANGLE_DEG = 45;
const CUP_FLAT_COS = 0.95;
/** Detail weight default; detail itself is 0 (flat) to 1 (≥90° crease). */
const DEFAULT_SCAR_WEIGHT = 3;
const DEFAULT_BLOCKED_WEIGHT = 10;
const DEFAULT_STABILITY_WEIGHT = 1;
const DEFAULT_FIBONACCI_COUNT = 120;
const DEFAULT_RESTING_POSES = 12;
const DEFAULT_REFINE_TOP_K = 5;
/** Poses closer than this (down-axis dot) dedupe — cos(5°). */
const DEDUP_COS = 0.9962;
/** Hull input cap — extremes survive grid decimation; interior points cannot pose. */
const HULL_POINT_CAP = 6000;
const DEG = Math.PI / 180;
const REFINEMENT_STEPS_RAD = [8 * DEG, 4 * DEG, 2 * DEG, 1 * DEG];

function wrapAngle(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

/** Per-triangle unit normals + areas, computed once per search. */
interface PreparedTriangles {
    normals: Float64Array;
    areas: Float64Array;
    details: Float64Array;
    triCount: number;
}

function prepareTriangles(mesh: AdvisorMesh): PreparedTriangles {
    const { positions, index } = mesh;
    const triCount = index && index.length > 0 ? Math.floor(index.length / 3) : Math.floor(positions.length / 9);
    const normals = new Float64Array(triCount * 3);
    const areas = new Float64Array(triCount);
    const hasIndex = !!index && index.length > 0;
    for (let t = 0; t < triCount; t++) {
        const ia = hasIndex ? (index as ArrayLike<number>)[t * 3] : t * 3;
        const ib = hasIndex ? (index as ArrayLike<number>)[t * 3 + 1] : t * 3 + 1;
        const ic = hasIndex ? (index as ArrayLike<number>)[t * 3 + 2] : t * 3 + 2;
        const ux = positions[ib * 3] - positions[ia * 3];
        const uy = positions[ib * 3 + 1] - positions[ia * 3 + 1];
        const uz = positions[ib * 3 + 2] - positions[ia * 3 + 2];
        const wx = positions[ic * 3] - positions[ia * 3];
        const wy = positions[ic * 3 + 1] - positions[ia * 3 + 1];
        const wz = positions[ic * 3 + 2] - positions[ia * 3 + 2];
        // Normal = u × w; area = |n| / 2.
        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;
        const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
        if (area <= 0) continue;
        areas[t] = area;
        normals[t * 3] = nx / (2 * area);
        normals[t * 3 + 1] = ny / (2 * area);
        normals[t * 3 + 2] = nz / (2 * area);
    }
    const details = computeTriangleDetail(positions, index, triCount, normals, areas);
    return { normals, areas, details, triCount };
}

/**
 * Per-triangle surface detail in [0,1] from dihedral angles over shared
 * edges: 0 for flat or boundary-only triangles, rising to 1 at a right-angle
 * crease. Welds non-indexed soup at 0.1µm so shared edges are found; rotation
 * independent, so it is computed once per search like the normals.
 */
export function computeTriangleDetail(
    positions: ArrayLike<number>,
    index: ArrayLike<number> | null | undefined,
    triCount: number,
    normals: Float64Array,
    areas: Float64Array,
): Float64Array {
    const details = new Float64Array(triCount);
    const hasIndex = !!index && index.length > 0;
    const ids = new Int32Array(triCount * 3);
    if (hasIndex) {
        for (let t = 0; t < triCount; t++) {
            ids[t * 3] = (index as ArrayLike<number>)[t * 3];
            ids[t * 3 + 1] = (index as ArrayLike<number>)[t * 3 + 1];
            ids[t * 3 + 2] = (index as ArrayLike<number>)[t * 3 + 2];
        }
    } else {
        const seen = new Map<string, number>();
        let next = 0;
        for (let t = 0; t < triCount; t++) {
            for (let k = 0; k < 3; k++) {
                const x = positions[(t * 3 + k) * 3];
                const y = positions[(t * 3 + k) * 3 + 1];
                const z = positions[(t * 3 + k) * 3 + 2];
                const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
                let id = seen.get(key);
                if (id === undefined) {
                    id = next++;
                    seen.set(key, id);
                }
                ids[t * 3 + k] = id;
            }
        }
    }
    const edgeTris = new Map<string, number[]>();
    for (let t = 0; t < triCount; t++) {
        if (areas[t] <= 0) continue;
        const a = ids[t * 3];
        const b = ids[t * 3 + 1];
        const c = ids[t * 3 + 2];
        const triEdges: Array<[number, number]> = [[a, b], [b, c], [c, a]];
        for (const [u, v] of triEdges) {
            const key = u < v ? `${u},${v}` : `${v},${u}`;
            const list = edgeTris.get(key);
            if (list) list.push(t);
            else edgeTris.set(key, [t]);
        }
    }
    for (const list of edgeTris.values()) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const s = list[i];
                const q = list[j];
                if (areas[s] <= 0 || areas[q] <= 0) continue;
                const dot =
                    normals[s * 3] * normals[q * 3] +
                    normals[s * 3 + 1] * normals[q * 3 + 1] +
                    normals[s * 3 + 2] * normals[q * 3 + 2];
                const detail = Math.min(1, Math.acos(Math.min(1, Math.max(-1, dot))) / (Math.PI / 2));
                if (detail > details[s]) details[s] = detail;
                if (detail > details[q]) details[q] = detail;
            }
        }
    }
    return details;
}

/** Rotated normal z after Rx(a) then Ry(b) applied to unit (ux, uy, uz). */
function rotatedNz(ux: number, uy: number, uz: number, sa: number, ca: number, sb: number, cb: number): number {
    // Rx: y' = y·ca − z·sa; z1 = y·sa + z·ca. Ry preserves nothing here:
    // z' = −x·sb + z1·cb.
    return -ux * sb + (uy * sa + uz * ca) * cb;
}

function toBlockedSet(blocked: ArrayLike<number> | Set<number> | null | undefined): Set<number> | null {
    if (!blocked) return null;
    if (blocked instanceof Set) return blocked.size > 0 ? blocked : null;
    if (blocked.length === 0) return null;
    const out = new Set<number>();
    for (let i = 0; i < blocked.length; i++) out.add(blocked[i]);
    return out;
}

/**
 * The plate contact, subtracted from the CUP term only.
 *
 * The app auto-lifts models off the plate (a few mm, deliberately), so a
 * down-facing base really does need supports bridging that gap and stays
 * charged as overhang, scar and blocked contact — which is also what the
 * island scan does (a face-down cube reports one overhang region: its base).
 *
 * A flat base is not a suction cup, though: with a sparse support forest
 * under it the resin has room to flow, and there is no enclosed pocket to
 * trap it. Charging `cupWeight` for it (default 2) is what made a flat pose
 * cost 300 mm² while a corner-down pose — every face just above the
 * self-support angle, and needing a stabilization anchor at every edge —
 * scored 0. The search was being paid to balance parts on a corner.
 */
function netSupportAreas(
    raw: { overhang: number; cup: number; scarArea: number; blockedArea: number },
    resting: RestingContact,
): { overhang: number; cup: number; scarArea: number; blockedArea: number } {
    return {
        overhang: raw.overhang,
        cup: Math.max(0, raw.cup - resting.cupAreaMm2),
        scarArea: raw.scarArea,
        blockedArea: raw.blockedArea,
    };
}

function scoreParts(
    prep: PreparedTriangles,
    threshold: number,
    sa: number,
    ca: number,
    sb: number,
    cb: number,
    blocked: Set<number> | null = null,
): { overhang: number; cup: number; scarArea: number; blockedArea: number } {
    let overhang = 0;
    let cup = 0;
    let scarArea = 0;
    let blockedArea = 0;
    const { normals, areas, details, triCount } = prep;
    for (let t = 0; t < triCount; t++) {
        const area = areas[t];
        if (area <= 0) continue;
        const nzr = rotatedNz(normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2], sa, ca, sb, cb);
        if (nzr < -threshold) {
            overhang += area;
            scarArea += area * details[t];
            if (blocked !== null && blocked.has(t)) blockedArea += area;
        }
        if (nzr < -CUP_FLAT_COS) cup += area;
    }
    return { overhang, cup, scarArea, blockedArea };
}

function measureBoundingBox(
    positions: ArrayLike<number>,
    sa: number,
    ca: number,
    sb: number,
    cb: number,
): { heightMm: number; footprintMm2: number } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i + 2 < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        // Rx(a) then Ry(b) — the same rotation the scorer applies to normals.
        const y1 = y * ca - z * sa;
        const z1 = y * sa + z * ca;
        const x2 = x * cb + z1 * sb;
        const z2 = -x * sb + z1 * cb;
        if (x2 < minX) minX = x2;
        if (x2 > maxX) maxX = x2;
        if (y1 < minY) minY = y1;
        if (y1 > maxY) maxY = y1;
        if (z2 < minZ) minZ = z2;
        if (z2 > maxZ) maxZ = z2;
    }
    if (minX === Infinity) return { heightMm: 0, footprintMm2: 0 };
    return { heightMm: maxZ - minZ, footprintMm2: (maxX - minX) * (maxY - minY) };
}

/**
 * Cost of one orientation: down-facing area past the self-support
 * threshold, plus the cup proxy (near-flat down-facing area) at extra
 * weight. Support-blocked down-facing area carries its own heavy weight
 * under every objective: the generator refuses that contact, so poses
 * needing it must lose. Height and footprint are reported for tie-breaking
 * upstream.
 */
export function evaluateOrientationCost(
    mesh: AdvisorMesh,
    rotXRad: number,
    rotYRad: number,
    opts: AdvisorOptions = {},
): OrientationCost {
    const threshold = Math.cos(((opts.selfSupportAngleDeg ?? DEFAULT_ANGLE_DEG) * Math.PI) / 180);
    const cupWeight = opts.cupWeight ?? 2;
    const scarWeight = opts.scarWeight ?? DEFAULT_SCAR_WEIGHT;
    const blockedWeight = opts.blockedWeight ?? DEFAULT_BLOCKED_WEIGHT;
    const stabilityWeight = opts.stabilityWeight ?? DEFAULT_STABILITY_WEIGHT;
    const objective = opts.objective ?? 'supports';
    const blocked = toBlockedSet(opts.blockedTriangleIndices);
    const prep = prepareTriangles(mesh);
    const sa = Math.sin(rotXRad);
    const ca = Math.cos(rotXRad);
    const sb = Math.sin(rotYRad);
    const cb = Math.cos(rotYRad);
    const { overhang, cup, scarArea, blockedArea } = scoreParts(prep, threshold, sa, ca, sb, cb, blocked);
    const { heightMm, footprintMm2 } = measureBoundingBox(mesh.positions, sa, ca, sb, cb);
    const stability = measurePoseStability(mesh.positions, mesh.index, rotXRad, rotYRad, {
        normals: prep.normals,
        areas: prep.areas,
        details: prep.details,
        blocked,
        threshold,
        cupCos: CUP_FLAT_COS,
    });
    const net = netSupportAreas({ overhang, cup, scarArea, blockedArea }, stability.restingContact);
    const stabilityPenaltyMm2 = isStaticallyUnstable(stability) ? stabilityWeight * footprintMm2 : 0;
    const scar = net.overhang + scarWeight * net.scarArea;
    const base =
        objective === 'scarring' ? scar + cupWeight * net.cup : net.overhang + cupWeight * net.cup;
    const cost = base + blockedWeight * net.blockedArea + stabilityPenaltyMm2;
    return {
        overhangAreaMm2: net.overhang,
        cupAreaMm2: net.cup,
        scarAreaMm2: scar,
        blockedAreaMm2: net.blockedArea,
        bearingAreaMm2: stability.bearingAreaMm2,
        bearingEdges: stability.bearingEdges,
        centroidDepthMm: stability.centroidDepthMm,
        marginMm: stability.marginMm,
        adhesionRatio: stability.adhesionRatio,
        stabilityPenaltyMm2,
        heightMm,
        footprintMm2,
        cost,
    };
}

/**
 * The model-space direction that ends up pointing at the plate under
 * R = Ry(b)·Rx(a) is d = (sin b, −cos b·sin a, −cos b·cos a); invert it
 * so a sampled down-axis becomes a tilt/turntable candidate.
 */
function downAxisToTilt(dx: number, dy: number, dz: number): OrientationCandidate {
    const cx = Math.min(1, Math.max(-1, dx));
    const rotYRad = Math.asin(cx);
    const rotXRad = Math.abs(cx) >= 1 - 1e-9 ? 0 : Math.atan2(-dy, -dz);
    return { rotXRad: wrapAngle(rotXRad), rotYRad: wrapAngle(rotYRad) };
}

function tiltToDownAxis(rx: number, ry: number): [number, number, number] {
    const cb = Math.cos(ry);
    return [Math.sin(ry), -cb * Math.sin(rx), -cb * Math.cos(rx)];
}

function fibonacciCandidates(count: number): OrientationCandidate[] {
    const n = Math.max(1, Math.floor(count));
    const golden = Math.PI * (3 - Math.sqrt(5));
    const out: OrientationCandidate[] = [];
    for (let i = 0; i < n; i++) {
        const z = 1 - ((i + 0.5) * 2) / n;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const t = golden * i;
        out.push(downAxisToTilt(r * Math.cos(t), r * Math.sin(t), z));
    }
    return out;
}

/**
 * Resting poses from the convex hull: group hull faces by coplanar normal,
 * rank by area, stand each large face on the plate. Degenerate input
 * (too few points, hull failure) yields no poses — the Fibonacci sweep
 * still covers the search.
 */
export function restingPoseCandidates(mesh: AdvisorMesh, maxPoses: number): OrientationCandidate[] {
    const { positions } = mesh;
    const vertCount = Math.floor(positions.length / 3);
    if (vertCount < 4 || maxPoses <= 0) return [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < vertCount; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    if (!(maxDim > 0)) return [];
    // Grid decimation: the hull only needs the extreme points.
    const cell = Math.max(maxDim / 50, 1e-6);
    const seen = new Set<string>();
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < vertCount && points.length < HULL_POINT_CAP; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(new THREE.Vector3(x, y, z));
    }
    if (points.length < 4) return [];
    let faces;
    try {
        faces = new ConvexHull().setFromPoints(points).faces;
    } catch {
        return [];
    }
    const groups = new Map<string, { nx: number; ny: number; nz: number; area: number }>();
    for (const face of faces) {
        const n = face.normal;
        const key = `${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}`;
        const corners: THREE.Vector3[] = [];
        let edge = face.edge;
        do {
            corners.push(edge.vertex.point);
            edge = edge.next;
        } while (edge !== face.edge);
        let area = 0;
        for (let i = 1; i + 1 < corners.length; i++) {
            const ux = corners[i].x - corners[0].x;
            const uy = corners[i].y - corners[0].y;
            const uz = corners[i].z - corners[0].z;
            const wx = corners[i + 1].x - corners[0].x;
            const wy = corners[i + 1].y - corners[0].y;
            const wz = corners[i + 1].z - corners[0].z;
            const nx = uy * wz - uz * wy;
            const ny = uz * wx - ux * wz;
            const nz = ux * wy - uy * wx;
            area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
        }
        const group = groups.get(key);
        if (group) group.area += area;
        else groups.set(key, { nx: n.x, ny: n.y, nz: n.z, area });
    }
    return [...groups.values()]
        .filter((g) => g.area > 1e-9)
        .sort((a, b) => b.area - a.area)
        .slice(0, Math.max(0, Math.floor(maxPoses)))
        .map((g) => {
            const len = Math.hypot(g.nx, g.ny, g.nz) || 1;
            return downAxisToTilt(g.nx / len, g.ny / len, g.nz / len);
        });
}

/**
 * The M1 coarse set: identity (current pose — the result never regresses),
 * the Fibonacci sweep, then resting poses that add a genuinely new
 * down-axis. Fixed order, no RNG: same mesh, same candidates.
 */
export function generateM1Candidates(mesh: AdvisorMesh, opts: AdvisorOptions = {}): OrientationCandidate[] {
    const fibCount = opts.candidateCount ?? DEFAULT_FIBONACCI_COUNT;
    const restingMax = opts.restingPoseCount ?? DEFAULT_RESTING_POSES;
    const out: OrientationCandidate[] = [{ rotXRad: 0, rotYRad: 0 }];
    const axes: Array<[number, number, number]> = [tiltToDownAxis(0, 0)];
    const tryAdd = (c: OrientationCandidate): void => {
        const d = tiltToDownAxis(c.rotXRad, c.rotYRad);
        for (const e of axes) {
            if (d[0] * e[0] + d[1] * e[1] + d[2] * e[2] > DEDUP_COS) return;
        }
        axes.push(d);
        out.push({ rotXRad: wrapAngle(c.rotXRad), rotYRad: wrapAngle(c.rotYRad) });
    };
    for (const c of fibonacciCandidates(fibCount)) tryAdd(c);
    for (const c of restingPoseCandidates(mesh, restingMax)) tryAdd(c);
    return out;
}

interface ScoredOrientation extends OrientationCandidate {
    primary: number;
    overhang: number;
    cup: number;
    scar: number;
    blocked: number;
    heightMm: number;
    footprintMm2: number;
    stability: PoseStability;
    stabilityPenalty: number;
}

/** Epsilons for rank comparisons, scaled to the baseline so tiny meshes and huge ones behave alike. */
interface RankEps {
    primary: number;
    height: number;
}

/**
 * Anchoring margin: a minimum-contact pose often balances on a point with no
 * physical purchase. When supports are unavoidable, primaries within 5% of the
 * minimum (plus a 0.5 mm² floor, about one small support) tie, and the widest
 * base wins. Zero-support landscapes keep exact tie-breaks — a perfect print
 * is never tilted for anchoring it does not need.
 */
const ANCHOR_TOL = 0.05;
const ANCHOR_FLOOR_MM2 = 0.5;
const ANCHOR_MIN_PRIMARY = 1e-9;

/** Lexicographic rank: the objective first, then the other term, then near-identity. */
function compareScored(
    a: ScoredOrientation,
    b: ScoredOrientation,
    eps: RankEps,
    objective: OrientationObjective,
    preferFootprint: boolean,
): number {
    if (objective === 'height') {
        if (Math.abs(a.heightMm - b.heightMm) > eps.height) return a.heightMm < b.heightMm ? -1 : 1;
        if (Math.abs(a.primary - b.primary) > eps.primary) return a.primary < b.primary ? -1 : 1;
    } else {
        if (Math.abs(a.primary - b.primary) > eps.primary) return a.primary < b.primary ? -1 : 1;
        if (preferFootprint) {
            if (Math.abs(a.footprintMm2 - b.footprintMm2) > 1e-6) return a.footprintMm2 > b.footprintMm2 ? -1 : 1;
            if (Math.abs(a.heightMm - b.heightMm) > eps.height) return a.heightMm < b.heightMm ? -1 : 1;
        } else {
            if (Math.abs(a.heightMm - b.heightMm) > eps.height) return a.heightMm < b.heightMm ? -1 : 1;
        }
    }
    if (Math.abs(a.footprintMm2 - b.footprintMm2) > 1e-6) return a.footprintMm2 > b.footprintMm2 ? -1 : 1;
    const da = Math.abs(a.rotXRad) + Math.abs(a.rotYRad);
    const db = Math.abs(b.rotXRad) + Math.abs(b.rotYRad);
    if (Math.abs(da - db) > 1e-9) return da < db ? -1 : 1;
    return 0;
}

/**
 * Suggest a better orientation from the M1 sweep. Never returns worse than
 * identity — the suggestion surface shows the delta, and applying it stays
 * the user's explicit choice.
 */
export function suggestOrientation(mesh: AdvisorMesh, opts: AdvisorOptions = {}): OrientationSuggestion {
    const threshold = Math.cos(((opts.selfSupportAngleDeg ?? DEFAULT_ANGLE_DEG) * Math.PI) / 180);
    const cupWeight = opts.cupWeight ?? 2;
    const scarWeight = opts.scarWeight ?? DEFAULT_SCAR_WEIGHT;
    const blockedWeight = opts.blockedWeight ?? DEFAULT_BLOCKED_WEIGHT;
    const stabilityWeight = opts.stabilityWeight ?? DEFAULT_STABILITY_WEIGHT;
    const objective = opts.objective ?? 'supports';
    const blocked = toBlockedSet(opts.blockedTriangleIndices);
    const prep = prepareTriangles(mesh);
    const candidates = generateM1Candidates(mesh, opts);

    const scoreFull = (c: OrientationCandidate): ScoredOrientation => {
        const sa = Math.sin(c.rotXRad);
        const ca = Math.cos(c.rotXRad);
        const sb = Math.sin(c.rotYRad);
        const cb = Math.cos(c.rotYRad);
        const { overhang, cup, scarArea, blockedArea } = scoreParts(prep, threshold, sa, ca, sb, cb, blocked);
        const { heightMm, footprintMm2 } = measureBoundingBox(mesh.positions, sa, ca, sb, cb);
        const stability = measurePoseStability(mesh.positions, mesh.index, c.rotXRad, c.rotYRad, {
            normals: prep.normals,
            areas: prep.areas,
            details: prep.details,
            blocked,
            threshold,
            cupCos: CUP_FLAT_COS,
        });
        const net = netSupportAreas({ overhang, cup, scarArea, blockedArea }, stability.restingContact);
        const stabilityPenalty = isStaticallyUnstable(stability) ? stabilityWeight * footprintMm2 : 0;
        const scar = net.overhang + scarWeight * net.scarArea;
        const primary =
            (objective === 'scarring' ? scar + cupWeight * net.cup : net.overhang + cupWeight * net.cup) +
            blockedWeight * net.blockedArea +
            stabilityPenalty;
        return { ...c, primary, overhang: net.overhang, cup: net.cup, scar, blocked: net.blockedArea, heightMm, footprintMm2, stability, stabilityPenalty };
    };
    const descend = (start: ScoredOrientation, eps: RankEps, obj: OrientationObjective, preferFootprint: boolean): ScoredOrientation => {
        let cur = start;
        for (const step of REFINEMENT_STEPS_RAD) {
            const neighbors = [
                { rotXRad: wrapAngle(cur.rotXRad + step), rotYRad: cur.rotYRad },
                { rotXRad: wrapAngle(cur.rotXRad - step), rotYRad: cur.rotYRad },
                { rotXRad: cur.rotXRad, rotYRad: wrapAngle(cur.rotYRad + step) },
                { rotXRad: cur.rotXRad, rotYRad: wrapAngle(cur.rotYRad - step) },
            ];
            for (const n of neighbors) {
                const s = scoreFull(n);
                if (compareScored(s, cur, eps, obj, preferFootprint) < 0) cur = s;
            }
        }
        return cur;
    };

    // Coarse pass: full score per candidate, ranked by the objective, so a
    // height search seeds refinement from short poses even when their
    // support cost is poor. Stable sort keeps ties in candidate order:
    // same mesh, same result.
    const scores = candidates.map((c) => scoreFull(c));
    const baseline = scores[0] ?? scoreFull({ rotXRad: 0, rotYRad: 0 });
    let minPrimary = Infinity;
    for (const s of scores) {
        if (s.primary < minPrimary) minPrimary = s.primary;
    }
    if (!Number.isFinite(minPrimary)) minPrimary = 0;
    const preferFootprint = objective === 'supports' && minPrimary > ANCHOR_MIN_PRIMARY;
    const gainEps = 1e-6 * Math.max(1, baseline.primary);
    const eps: RankEps = {
        primary: preferFootprint ? minPrimary * ANCHOR_TOL + ANCHOR_FLOOR_MM2 : gainEps,
        height: 1e-6 * Math.max(1, baseline.heightMm),
    };
    let best = baseline;
    for (let i = 1; i < scores.length; i++) {
        if (compareScored(scores[i], best, eps, objective, preferFootprint) < 0) best = scores[i];
    }

    // Refinement around the top-K coarse candidates by objective rank.
    const refineK = Math.max(0, Math.floor(opts.refineTopK ?? DEFAULT_REFINE_TOP_K));
    const order = scores.map((_, i) => i).sort((a, b) => compareScored(scores[a], scores[b], eps, objective, preferFootprint));
    for (const s of order.slice(0, Math.min(Math.max(1, refineK), order.length))) {
        const r = descend(scores[s], eps, objective, preferFootprint);
        if (compareScored(r, best, eps, objective, preferFootprint) < 0) best = r;
    }

    const toDeg = (a: number): number => Math.round(((a * 180) / Math.PI) * 10) / 10;
    const toCost = (s: ScoredOrientation): OrientationCost => ({
        overhangAreaMm2: s.overhang,
        cupAreaMm2: s.cup,
        scarAreaMm2: s.scar,
        blockedAreaMm2: s.blocked,
        bearingAreaMm2: s.stability.bearingAreaMm2,
        bearingEdges: s.stability.bearingEdges,
        centroidDepthMm: s.stability.centroidDepthMm,
        marginMm: s.stability.marginMm,
        adhesionRatio: s.stability.adhesionRatio,
        stabilityPenaltyMm2: s.stabilityPenalty,
        heightMm: s.heightMm,
        footprintMm2: s.footprintMm2,
        cost: s.primary,
    });
    const improved =
        objective === 'height'
            ? best.heightMm < baseline.heightMm - eps.height
            : best.primary < baseline.primary - gainEps;
    const suggested = improved ? best : baseline;
    const deltaPercent =
        baseline.overhang > 0 ? ((suggested.overhang - baseline.overhang) / baseline.overhang) * 100 : 0;
    return {
        rotXDeg: improved ? toDeg(best.rotXRad) : 0,
        rotYDeg: improved ? toDeg(best.rotYRad) : 0,
        baseline: toCost(baseline),
        suggested: toCost(suggested),
        deltaPercent,
    };
}

/** Minimal BufferGeometry surface for the adapter (avoids a three import). */
export interface AdvisorGeometry {
    attributes: { position?: { array: ArrayLike<number> } | null };
    index?: ArrayLike<number> | null;
}

/**
 * Suggest an orientation directly from a render geometry: extracts the
 * position/index soup and runs the sweep. The UI layer calls this with
 * the active model's geometry and surfaces the returned delta; applying
 * the rotation stays an explicit user action through the scene transform
 * path (with its own history entry).
 */
export function suggestOrientationForGeometry(
    geometry: AdvisorGeometry,
    opts: AdvisorOptions = {},
): OrientationSuggestion | null {
    const positions = geometry.attributes?.position?.array;
    if (!positions || positions.length < 9) return null;
    return suggestOrientation({ positions, index: geometry.index ?? null }, opts);
}

/**
 * Compose an advisor tilt/turntable delta onto a stored scene orientation.
 * Reads and stores in the canonical extrinsic frame the renderer uses, so the
 * applied model lands on the scored orientation: the base triple means
 * qz * qy * qx, the delta is the advisor's Rx-then-Ry (THREE 'YXZ'), and the
 * result carries order 'ZYX' (which composes the same way) so canonical and
 * setFromEuler readers agree. Previously this read/stored XYZ and silently
 * rotated up to ~17° off the scored pose on compound tilts.
 */
export function composeOrientationDelta(
    currentRotation: { x: number; y: number; z: number } | null | undefined,
    rotXDeg: number,
    rotYDeg: number,
): THREE.Euler {
    const qDelta = new THREE.Quaternion().setFromEuler(
        new THREE.Euler((rotXDeg * Math.PI) / 180, (rotYDeg * Math.PI) / 180, 0, 'YXZ'),
    );
    const qNew = qDelta.multiply(quaternionFromGlobalEuler(currentRotation));
    return new THREE.Euler().setFromQuaternion(qNew, 'ZYX');
}
