import type * as THREE from 'three';
import type { SupportTypeId } from '../supportTypeRegistry';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { resolveSegmentEndpoints } from '../SupportPrimitives/Knot/segmentEndpoints';
import type { Knot, Roots, Segment, SupportState, Vec3 } from '../types';
import { referenceStefanMeanPressureMm2, type RepresentativeLayer, type RepresentativeLayerProfile } from './tractionOptimization';
import { GREEN_RESIN_MODULUS_MPA, NOMINAL_TIP_PEEL_LOAD_N } from './treeSynthesis';

/** Conservative green-state photopolymer tensile/flexural strength (MPa). */
export const GREEN_RESIN_UTS_MPA = 12.0;
/** Poisson's ratio for green-state cured UV photopolymer resin. */
const GREEN_RESIN_POISSON = 0.35;
/** Above this free-node threshold, report rigid-body tip overload only to keep solve time tiny. */
const MAX_FRAME_SOLVE_FREE_NODES = 1200;
/** Extra stages the per-component pass may add beyond the global critical layers. */
const MAX_COMPONENT_STAGE_LAYERS = 8;
/** Nominal peel stress calibration (MPa = N/mm²): `0.15 N` per `10 mm²` reference disc. */
export const NOMINAL_PEEL_PRESSURE_MPA = NOMINAL_TIP_PEEL_LOAD_N / 10.0;
/** Lateral peel drag fraction during release from flexible FEP film. */
const LATERAL_PEEL_DRAG_RATIO = 0.08;
/** Minimum spatial merge tolerance (mm) when connecting shared endpoints & knots. */
const NODE_MERGE_TOL_MM = 0.15;

export interface SupportGraphNode {
    id: string;
    pos: Vec3;
    kind: 'root' | 'joint' | 'knot' | 'tip';
    fixed: boolean;
    entityId?: string;
    entityKind?: SupportTypeId;
    tipContactDiameterMm?: number;
}

export interface SupportGraphMember {
    id: string;
    entityId: string;
    entityKind: SupportTypeId;
    nodeA: number;
    nodeB: number;
    lengthMm: number;
    diameterMm: number;
    angleFromVerticalDeg: number;
}

export interface SupportGraph {
    nodes: SupportGraphNode[];
    members: SupportGraphMember[];
    rootCount: number;
    tipCount: number;
    braceCount: number;
}

export interface FrameStressHotspot {
    entityId: string;
    entityKind: SupportTypeId;
    kind: 'tip' | 'member';
    utilizationPct: number;
    peakStressMpa?: number;
    tipLoadN?: number;
    deflectionMm?: number;
    layerZMm: number;
    pos: Vec3;
}

export interface LayerPeelPoint {
    zMm: number;
    areaMm2: number;
    peelForceN: number;
    maxTipUtilPct: number;
    maxMemberUtilPct: number;
    critical: boolean;
}

export interface StressSegment {
    entityId: string;
    entityKind: SupportTypeId;
    a: Vec3;
    b: Vec3;
    diameterMm: number;
    utilizationPct: number;
}

export interface StressTipPoint {
    entityId: string;
    entityKind: SupportTypeId;
    pos: Vec3;
    utilizationPct: number;
    loadN: number;
}

export interface SupportFrameStressReport {
    nodeCount: number;
    rootCount: number;
    tipCount: number;
    memberCount: number;
    braceCount: number;
    layersEvaluated: number;
    peakLayerZMm: number;
    peakLayerPeelForceN: number;
    maxTipUtilizationPct: number;
    overloadedTips: number;
    maxMemberUtilizationPct: number;
    overloadedMembers: number;
    maxTipDeflectionMm: number;
    solverMode: 'frame3d' | 'rigidBodyOnly';
    hotspots: FrameStressHotspot[];
    layerProfile: LayerPeelPoint[];
    memberSegments: StressSegment[];
    tipPoints: StressTipPoint[];
    reinforcedCount?: number;
}

function compareVec3(a: Vec3, b: Vec3): number {
    return a.z - b.z || a.x - b.x || a.y - b.y;
}

function clampDiameterMm(d: number | undefined, fallback = 1.0): number {
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.max(0.1, d) : fallback;
}

/**
 * Assemble a deterministic structural graph (nodes + beam members) from `snapshot`,
 * splitting hosted segments at branch/brace/kickstand knots so bracing forms true
 * multi-bay triangulated frames.
 *
 * Plate-rooted columns (`trunk`, `stump`, `kickstand`), branches, leaves, and braces
 * participate; model-to-model `twig`/`stick` bridges do not load build-plate trunks
 * and are omitted.
 */
export function buildSupportGraph(snapshot: SupportState, modelId?: string): SupportGraph {
    const nodes: SupportGraphNode[] = [];
    const members: SupportGraphMember[] = [];
    let rootCount = 0;
    let tipCount = 0;
    let braceCount = 0;

    // Spatial hash + exact tolerance check to merge coincident joints/knots cleanly.
    const cellSize = 0.5;
    const tolSq = NODE_MERGE_TOL_MM * NODE_MERGE_TOL_MM;
    const buckets = new Map<string, number[]>();

    const bucketKey = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;

    const internNode = (
        pos: Vec3,
        kind: SupportGraphNode['kind'],
        fixed: boolean,
        meta?: { entityId?: string; entityKind?: SupportTypeId; tipContactDiameterMm?: number },
    ): number => {
        const cx = Math.floor(pos.x / cellSize);
        const cy = Math.floor(pos.y / cellSize);
        const cz = Math.floor(pos.z / cellSize);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const list = buckets.get(bucketKey(cx + dx, cy + dy, cz + dz));
                    if (!list) continue;
                    for (const idx of list) {
                        const existing = nodes[idx];
                        // Keep contact tips distinct from adjacent joints unless very close,
                        // and keep fixed plate roots fixed.
                        if (kind === 'tip' && existing.kind === 'tip') continue;
                        const d2 = (existing.pos.x - pos.x) ** 2
                            + (existing.pos.y - pos.y) ** 2
                            + (existing.pos.z - pos.z) ** 2;
                        if (d2 <= tolSq) {
                            if (fixed && !existing.fixed) {
                                existing.fixed = true;
                                existing.kind = 'root';
                                rootCount++;
                            }
                            if (meta?.tipContactDiameterMm !== undefined) {
                                existing.kind = 'tip';
                                existing.tipContactDiameterMm = meta.tipContactDiameterMm;
                                existing.entityId = meta.entityId;
                                existing.entityKind = meta.entityKind;
                            }
                            return idx;
                        }
                    }
                }
            }
        }

        const idx = nodes.length;
        nodes.push({
            id: `n-${idx}`,
            pos: { x: pos.x, y: pos.y, z: pos.z },
            kind,
            fixed,
            ...(meta?.entityId ? { entityId: meta.entityId } : {}),
            ...(meta?.entityKind ? { entityKind: meta.entityKind } : {}),
            ...(meta?.tipContactDiameterMm !== undefined ? { tipContactDiameterMm: meta.tipContactDiameterMm } : {}),
        });
        if (fixed) rootCount++;
        if (kind === 'tip') tipCount++;
        const k = bucketKey(cx, cy, cz);
        const arr = buckets.get(k);
        if (arr) arr.push(idx);
        else buckets.set(k, [idx]);
        return idx;
    };

    const addBeamMember = (
        entityId: string,
        entityKind: SupportTypeId,
        nodeA: number,
        nodeB: number,
        diameterMm: number,
    ) => {
        if (nodeA === nodeB) return;
        const a = nodes[nodeA].pos;
        const b = nodes[nodeB].pos;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const lengthMm = Math.hypot(dx, dy, dz);
        if (lengthMm < 1e-4) return;
        const lateral = Math.hypot(dx, dy);
        const angleFromVerticalDeg = (Math.atan2(lateral, Math.abs(dz)) * 180) / Math.PI;
        members.push({
            id: `m-${members.length}`,
            entityId,
            entityKind,
            nodeA,
            nodeB,
            lengthMm,
            diameterMm: clampDiameterMm(diameterMm),
            angleFromVerticalDeg,
        });
    };

    // Index knots by host segment so hosted shafts split cleanly at knots.
    const knotsBySegment = new Map<string, Knot[]>();
    for (const knot of Object.values(snapshot.knots ?? {})) {
        if (!knot?.parentShaftId) continue;
        const list = knotsBySegment.get(knot.parentShaftId);
        if (list) list.push(knot);
        else knotsBySegment.set(knot.parentShaftId, [knot]);
    }
    for (const list of knotsBySegment.values()) {
        list.sort((a, b) => (a.t ?? 0.5) - (b.t ?? 0.5) || compareVec3(a.pos, b.pos));
    }

    const knotNodeById = new Map<string, number>();
    const ensureKnotNode = (knot: Knot): number => {
        const cached = knotNodeById.get(knot.id);
        if (cached !== undefined) return cached;
        const idx = internNode(knot.pos, 'knot', false);
        knotNodeById.set(knot.id, idx);
        return idx;
    };

    const matchesModel = (entityModelId: string | undefined, rootId?: string): boolean => {
        if (!modelId) return true;
        const resolved = entityModelId ?? (rootId ? snapshot.roots?.[rootId]?.modelId : undefined);
        return resolved === modelId;
    };

    // Split a shaft segment at all knots hosted on it and emit linear beam members.
    const addShaftSegments = (
        entity: { id: string; typeId?: SupportTypeId; segments: Segment[]; rootId?: string; contactCone?: { pos: Vec3; profile?: { bodyDiameterMm?: number; contactDiameterMm?: number } } },
        kind: SupportTypeId,
        root: Roots | undefined,
        hostKnot: Knot | undefined,
        anchorIsFixedRoot: boolean,
    ): { lastNodeIdx: number | null; lastDiameterMm: number } => {
        let lastNodeIdx: number | null = null;
        let lastDiameterMm = clampDiameterMm(entity.segments[0]?.diameter, 1.0);
        const typedEntity = entity.typeId ? entity : { ...entity, typeId: kind };

        for (let i = 0; i < entity.segments.length; i++) {
            const seg = entity.segments[i];
            const ep = resolveSegmentEndpoints(typedEntity, seg, i, { root, hostKnot });
            if (!ep) continue;
            lastDiameterMm = clampDiameterMm(seg.diameter, lastDiameterMm);

            const isFirstRootSeg = i === 0 && anchorIsFixedRoot;
            const startIdx = isFirstRootSeg
                ? internNode(ep.start, 'root', true)
                : (lastNodeIdx ?? (i === 0 && hostKnot ? ensureKnotNode(hostKnot) : internNode(ep.start, 'joint', false)));
            const endIdx = internNode(ep.end, 'joint', false);

            const hostedKnots = (knotsBySegment.get(seg.id) ?? []).filter((k) => {
                const dStart2 = (k.pos.x - ep.start.x) ** 2 + (k.pos.y - ep.start.y) ** 2 + (k.pos.z - ep.start.z) ** 2;
                const dEnd2 = (k.pos.x - ep.end.x) ** 2 + (k.pos.y - ep.end.y) ** 2 + (k.pos.z - ep.end.z) ** 2;
                return dStart2 > tolSq && dEnd2 > tolSq;
            });

            if (hostedKnots.length === 0) {
                addBeamMember(entity.id, kind, startIdx, endIdx, lastDiameterMm);
            } else {
                // Sort strictly along segment direction so t errors in inputs cannot reverse spans.
                const dirX = ep.end.x - ep.start.x;
                const dirY = ep.end.y - ep.start.y;
                const dirZ = ep.end.z - ep.start.z;
                const lenSq = Math.max(1e-9, dirX * dirX + dirY * dirY + dirZ * dirZ);
                const ordered = [...hostedKnots].sort((a, b) => {
                    const ta = ((a.pos.x - ep.start.x) * dirX + (a.pos.y - ep.start.y) * dirY + (a.pos.z - ep.start.z) * dirZ) / lenSq;
                    const tb = ((b.pos.x - ep.start.x) * dirX + (b.pos.y - ep.start.y) * dirY + (b.pos.z - ep.start.z) * dirZ) / lenSq;
                    return ta - tb;
                });

                let prev = startIdx;
                for (const knot of ordered) {
                    const kIdx = ensureKnotNode(knot);
                    addBeamMember(entity.id, kind, prev, kIdx, lastDiameterMm);
                    prev = kIdx;
                }
                addBeamMember(entity.id, kind, prev, endIdx, lastDiameterMm);
            }

            lastNodeIdx = endIdx;
        }

        return { lastNodeIdx, lastDiameterMm };
    };

    // 1. Trunks (plate-rooted primary columns)
    const trunks = Object.values(snapshot.trunks ?? {})
        .filter((t) => matchesModel(t.modelId, t.rootId) && t.segments.length > 0)
        .sort((a, b) => compareVec3(
            snapshot.roots?.[a.rootId]?.transform.pos ?? a.contactCone?.pos ?? { x: 0, y: 0, z: 0 },
            snapshot.roots?.[b.rootId]?.transform.pos ?? b.contactCone?.pos ?? { x: 0, y: 0, z: 0 },
        ));
    for (const trunk of trunks) {
        const root = snapshot.roots?.[trunk.rootId];
        if (!root) continue;
        const { lastNodeIdx, lastDiameterMm } = addShaftSegments(trunk, 'trunk', root, undefined, true);
        if (trunk.contactCone?.pos && lastNodeIdx !== null) {
            const tipDia = clampDiameterMm(trunk.contactCone.profile?.contactDiameterMm, 0.28);
            const coneDia = Math.max(tipDia, clampDiameterMm(trunk.contactCone.profile?.bodyDiameterMm, lastDiameterMm) * 0.7);
            const tipIdx = internNode(trunk.contactCone.pos, 'tip', false, {
                entityId: trunk.id,
                entityKind: 'trunk',
                tipContactDiameterMm: tipDia,
            });
            addBeamMember(trunk.id, 'trunk', lastNodeIdx, tipIdx, coneDia);
        }
    }

    // 2. Stumps (near-plate self-rooted columns)
    const stumps = Object.values(snapshot.stumps ?? {})
        .filter((s) => matchesModel(s.modelId) && s.segments.length > 0)
        .sort((a, b) => compareVec3(a.rootPos, b.rootPos));
    for (const stump of stumps) {
        const rootIdx = internNode(stump.rootPos, 'root', true);
        let prev = rootIdx;
        let dia = clampDiameterMm(stump.segments[0]?.diameter, 1.0);
        for (const seg of stump.segments) {
            dia = clampDiameterMm(seg.diameter, dia);
            const endPos = seg.topJoint?.pos ?? stump.contactCone.pos;
            const isTip = !seg.topJoint && Boolean(stump.contactCone?.pos);
            const endIdx = isTip
                ? internNode(endPos, 'tip', false, {
                    entityId: stump.id,
                    entityKind: 'stump',
                    tipContactDiameterMm: clampDiameterMm(stump.contactCone.profile?.contactDiameterMm, 0.28),
                })
                : internNode(endPos, 'joint', false);
            addBeamMember(stump.id, 'stump', prev, endIdx, dia);
            prev = endIdx;
        }
    }

    // 3. Kickstands (plate-rooted lateral stabilisers attached to a host knot)
    const kickstands = Object.values(snapshot.kickstands ?? {})
        .filter((ks) => matchesModel(ks.modelId, ks.rootId) && ks.segments.length > 0)
        .sort((a, b) => compareVec3(
            snapshot.roots?.[a.rootId]?.transform.pos ?? { x: 0, y: 0, z: 0 },
            snapshot.roots?.[b.rootId]?.transform.pos ?? { x: 0, y: 0, z: 0 },
        ));
    for (const ks of kickstands) {
        const root = snapshot.roots?.[ks.rootId];
        const hostKnot = snapshot.knots?.[ks.hostKnotId];
        if (!root || !hostKnot) continue;
        addShaftSegments(ks, 'kickstand', root, hostKnot, true);
    }

    // 4. Branches (knot-hosted multi-segment arms carrying contacts)
    const branches = Object.values(snapshot.branches ?? {})
        .filter((b) => matchesModel(b.modelId) && b.segments.length > 0)
        .sort((a, b) => compareVec3(
            a.contactCone?.pos ?? { x: 0, y: 0, z: 0 },
            b.contactCone?.pos ?? { x: 0, y: 0, z: 0 },
        ));
    for (const branch of branches) {
        const hostKnot = snapshot.knots?.[branch.parentKnotId];
        if (!hostKnot) continue;
        const { lastNodeIdx, lastDiameterMm } = addShaftSegments(branch, 'branch', undefined, hostKnot, false);
        if (branch.contactCone?.pos && lastNodeIdx !== null) {
            const tipDia = clampDiameterMm(branch.contactCone.profile?.contactDiameterMm, 0.28);
            const coneDia = Math.max(tipDia, clampDiameterMm(branch.contactCone.profile?.bodyDiameterMm, lastDiameterMm) * 0.7);
            const tipIdx = internNode(branch.contactCone.pos, 'tip', false, {
                entityId: branch.id,
                entityKind: 'branch',
                tipContactDiameterMm: tipDia,
            });
            addBeamMember(branch.id, 'branch', lastNodeIdx, tipIdx, coneDia);
        }
    }

    // 5. Leaves (single tapered contact member from knot to tip)
    const leaves = Object.values(snapshot.leaves ?? {})
        .filter((l) => matchesModel(l.modelId))
        .sort((a, b) => compareVec3(a.contactCone.pos, b.contactCone.pos));
    for (const leaf of leaves) {
        const hostKnot = snapshot.knots?.[leaf.parentKnotId];
        if (!hostKnot || !leaf.contactCone?.pos) continue;
        const hostIdx = ensureKnotNode(hostKnot);
        const tipDia = clampDiameterMm(leaf.contactCone.profile?.contactDiameterMm, 0.25);
        const effDia = Math.max(tipDia, clampDiameterMm(leaf.contactCone.profile?.bodyDiameterMm, 0.9) * 0.7);
        const tipIdx = internNode(leaf.contactCone.pos, 'tip', false, {
            entityId: leaf.id,
            entityKind: 'leaf',
            tipContactDiameterMm: tipDia,
        });
        addBeamMember(leaf.id, 'leaf', hostIdx, tipIdx, effDia);
    }

    // 6. Braces (strut connecting startKnotId <-> endKnotId)
    const braces = Object.values(snapshot.braces ?? {})
        .filter((br) => matchesModel(br.modelId))
        .sort((a, b) => compareVec3(
            snapshot.knots?.[a.startKnotId]?.pos ?? { x: 0, y: 0, z: 0 },
            snapshot.knots?.[b.startKnotId]?.pos ?? { x: 0, y: 0, z: 0 },
        ));
    for (const brace of braces) {
        const startKnot = snapshot.knots?.[brace.startKnotId];
        const endKnot = snapshot.knots?.[brace.endKnotId];
        if (!startKnot || !endKnot) continue;
        const nA = ensureKnotNode(startKnot);
        const nB = ensureKnotNode(endKnot);
        addBeamMember(brace.id, 'brace', nA, nB, clampDiameterMm(brace.profile?.diameter, 1.0));
        braceCount++;
    }

    return { nodes, members, rootCount, tipCount, braceCount };
}

/**
 * Distribute a layer's net vertical peel force `totalForceN` applied at Center of
 * Pressure `(copX, copY)` across a rigid body supported by tensile tips `(x, y, contactDiameterMm)`.
 *
 * Solves 3-DOF rigid-body vertical/tilt equilibrium `w(x, y) = w0 + α·dx + β·dy` weighted by
 * tip axial stiffness `k_i = d_i²`, with an active-set loop dropping any tip that goes into
 * compression (`f_i < 0`) so only pulling tips carry tensile peel load.
 */
export function distributeRigidBodyPeelLoads(
    tips: ReadonlyArray<{ x: number; y: number; contactDiameterMm: number }>,
    totalForceN: number,
    copX: number,
    copY: number,
): Float64Array {
    const n = tips.length;
    const loads = new Float64Array(n);
    if (n === 0 || totalForceN <= 0) return loads;

    const stiffness = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        stiffness[i] = Math.max(0.04, tips[i].contactDiameterMm ** 2);
    }

    if (n === 1) {
        loads[0] = totalForceN;
        return loads;
    }

    const active = new Uint8Array(n);
    active.fill(1);

    for (let pass = 0; pass < 4; pass++) {
        let sK = 0, sKx = 0, sKy = 0, sKxx = 0, sKxy = 0, sKyy = 0;
        let activeCount = 0;
        for (let i = 0; i < n; i++) {
            if (!active[i]) continue;
            activeCount++;
            const k = stiffness[i];
            const dx = tips[i].x - copX;
            const dy = tips[i].y - copY;
            sK += k;
            sKx += k * dx;
            sKy += k * dy;
            sKxx += k * dx * dx;
            sKxy += k * dx * dy;
            sKyy += k * dy * dy;
        }
        if (activeCount === 0 || sK <= 0) break;

        // Small Tikhonov regularization handles single-point or collinear tip groups safely.
        const reg = 1e-4 * Math.max(1e-6, (sK + sKxx + sKyy) / 3);
        const a00 = sK, a01 = sKx, a02 = sKy;
        const a11 = sKxx + reg, a12 = sKxy;
        const a22 = sKyy + reg;

        // Solve 3x3 symmetric system [A]{w0, alpha, beta} = [totalForceN, 0, 0] via Gaussian elimination.
        const M = [
            [a00, a01, a02, totalForceN],
            [a01, a11, a12, 0],
            [a02, a12, a22, 0],
        ];
        for (let col = 0; col < 3; col++) {
            let piv = col;
            for (let row = col + 1; row < 3; row++) {
                if (Math.abs(M[row][col]) > Math.abs(M[piv][col])) piv = row;
            }
            if (piv !== col) {
                const tmp = M[col];
                M[col] = M[piv];
                M[piv] = tmp;
            }
            const diag = Math.abs(M[col][col]) > 1e-12 ? M[col][col] : 1e-12;
            for (let row = col + 1; row < 3; row++) {
                const f = M[row][col] / diag;
                for (let c = col; c < 4; c++) M[row][c] -= f * M[col][c];
            }
        }
        const beta = M[2][3] / (Math.abs(M[2][2]) > 1e-12 ? M[2][2] : 1e-12);
        const alpha = (M[1][3] - M[1][2] * beta) / (Math.abs(M[1][1]) > 1e-12 ? M[1][1] : 1e-12);
        const w0 = (M[0][3] - M[0][1] * alpha - M[0][2] * beta) / (Math.abs(M[0][0]) > 1e-12 ? M[0][0] : 1e-12);

        let anyNegative = false;
        let remainingActive = 0;
        for (let i = 0; i < n; i++) {
            if (!active[i]) {
                loads[i] = 0;
                continue;
            }
            const dx = tips[i].x - copX;
            const dy = tips[i].y - copY;
            const fi = stiffness[i] * (w0 + alpha * dx + beta * dy);
            if (fi < 0) {
                active[i] = 0;
                loads[i] = 0;
                anyNegative = true;
            } else {
                loads[i] = fi;
                remainingActive++;
            }
        }
        if (!anyNegative || remainingActive === 0) break;
    }

    let sum = 0;
    for (let i = 0; i < n; i++) {
        if (loads[i] > 0) sum += loads[i];
        else loads[i] = 0;
    }
    if (sum > 1e-12) {
        const scale = totalForceN / sum;
        for (let i = 0; i < n; i++) loads[i] *= scale;
    } else {
        // Fallback: stiffness-proportional split if degenerate geometry forced all inactive.
        let sK = 0;
        for (let i = 0; i < n; i++) sK += stiffness[i];
        for (let i = 0; i < n; i++) loads[i] = totalForceN * (stiffness[i] / sK);
    }

    return loads;
}

/** Invert a 6x6 matrix (returns zero matrix fallback if nearly singular). */
function invert6x6(block: Float64Array, offset: number, out: Float64Array, outOffset: number): void {
    const aug = new Float64Array(6 * 12);
    for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 6; c++) {
            aug[r * 12 + c] = block[offset + r * 6 + c];
        }
        aug[r * 12 + 6 + r] = 1.0;
    }
    for (let col = 0; col < 6; col++) {
        let piv = col;
        let maxVal = Math.abs(aug[col * 12 + col]);
        for (let row = col + 1; row < 6; row++) {
            const v = Math.abs(aug[row * 12 + col]);
            if (v > maxVal) {
                maxVal = v;
                piv = row;
            }
        }
        if (piv !== col) {
            for (let c = 0; c < 12; c++) {
                const tmp = aug[col * 12 + c];
                aug[col * 12 + c] = aug[piv * 12 + c];
                aug[piv * 12 + c] = tmp;
            }
        }
        const diag = aug[col * 12 + col];
        if (Math.abs(diag) < 1e-12) {
            for (let r = 0; r < 6; r++) out[outOffset + r * 6 + r] = 1.0;
            return;
        }
        const invD = 1.0 / diag;
        for (let c = 0; c < 12; c++) aug[col * 12 + c] *= invD;
        for (let row = 0; row < 6; row++) {
            if (row === col) continue;
            const factor = aug[row * 12 + col];
            if (factor === 0) continue;
            for (let c = 0; c < 12; c++) aug[row * 12 + c] -= factor * aug[col * 12 + c];
        }
    }
    for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 6; c++) {
            out[outOffset + r * 6 + c] = aug[r * 12 + 6 + c];
        }
    }
}

interface ElementBasisAndLocalK {
    memberIdx: number;
    nodeA: number;
    nodeB: number;
    /** 3x3 orthogonal rotation whose rows are local e1 (axial), e2, e3. */
    r00: number; r01: number; r02: number;
    r10: number; r11: number; r12: number;
    r20: number; r21: number; r22: number;
    kLoc: Float64Array; // 12x12 local stiffness
    areaMm2: number;
    radiusMm: number;
    inertiaMm4: number;
    bucklingCritN: number;
}

function buildElementStiffness(graph: SupportGraph, memberIdx: number): ElementBasisAndLocalK {
    const m = graph.members[memberIdx];
    const a = graph.nodes[m.nodeA].pos;
    const b = graph.nodes[m.nodeB].pos;
    const L = Math.max(1e-3, m.lengthMm);
    const e1x = (b.x - a.x) / L;
    const e1y = (b.y - a.y) / L;
    const e1z = (b.z - a.z) / L;

    // Right-handed local basis (e1, e2, e3).
    const refX = Math.abs(e1z) < 0.9 ? 0 : 1;
    const refY = 0;
    const refZ = Math.abs(e1z) < 0.9 ? 1 : 0;
    // e2 = normalize(ref x e1)
    let e2x = refY * e1z - refZ * e1y;
    let e2y = refZ * e1x - refX * e1z;
    let e2z = refX * e1y - refY * e1x;
    const e2Len = Math.max(1e-12, Math.hypot(e2x, e2y, e2z));
    e2x /= e2Len; e2y /= e2Len; e2z /= e2Len;
    // e3 = e1 x e2
    const e3x = e1y * e2z - e1z * e2y;
    const e3y = e1z * e2x - e1x * e2z;
    const e3z = e1x * e2y - e1y * e2x;

    const d = m.diameterMm;
    const radiusMm = 0.5 * d;
    const areaMm2 = Math.PI * radiusMm * radiusMm;
    const inertiaMm4 = (Math.PI * (d ** 4)) / 64;
    const polarJ = 2 * inertiaMm4;
    const E = GREEN_RESIN_MODULUS_MPA;
    const G = E / (2 * (1 + GREEN_RESIN_POISSON));

    const kAx = (E * areaMm2) / L;
    const kTor = (G * polarJ) / L;
    const L2 = L * L;
    const L3 = L2 * L;
    const EI_12 = (12 * E * inertiaMm4) / L3;
    const EI_6 = (6 * E * inertiaMm4) / L2;
    const EI_4 = (4 * E * inertiaMm4) / L;
    const EI_2 = (2 * E * inertiaMm4) / L;

    // 12x12 local Euler-Bernoulli frame stiffness: [ux, uy, uz, rx, ry, rz] x 2.
    // Note signs for (uz, ry) plane via diag(1, -1, 1, -1) since ry = -dw/dx.
    const kLoc = new Float64Array(144);
    const setSym = (i: number, j: number, v: number) => {
        kLoc[i * 12 + j] = v;
        kLoc[j * 12 + i] = v;
    };
    // Axial (ux: 0, 6)
    setSym(0, 0, kAx); setSym(0, 6, -kAx); setSym(6, 6, kAx);
    // Torsion (rx: 3, 9)
    setSym(3, 3, kTor); setSym(3, 9, -kTor); setSym(9, 9, kTor);
    // Bending in (e1, e2) plane (uy: 1, rz: 5, uyB: 7, rzB: 11)
    setSym(1, 1, EI_12); setSym(1, 5, EI_6); setSym(1, 7, -EI_12); setSym(1, 11, EI_6);
    setSym(5, 5, EI_4); setSym(5, 7, -EI_6); setSym(5, 11, EI_2);
    setSym(7, 7, EI_12); setSym(7, 11, -EI_6);
    setSym(11, 11, EI_4);
    // Bending in (e1, e3) plane (uz: 2, ry: 4, uzB: 8, ryB: 10)
    setSym(2, 2, EI_12); setSym(2, 4, -EI_6); setSym(2, 8, -EI_12); setSym(2, 10, -EI_6);
    setSym(4, 4, EI_4); setSym(4, 8, EI_6); setSym(4, 10, EI_2);
    setSym(8, 8, EI_12); setSym(8, 10, EI_6);
    setSym(10, 10, EI_4);

    const bucklingCritN = (Math.PI * Math.PI * E * inertiaMm4) / ((1.1 * L) ** 2);

    return {
        memberIdx,
        nodeA: m.nodeA,
        nodeB: m.nodeB,
        r00: e1x, r01: e1y, r02: e1z,
        r10: e2x, r11: e2y, r12: e2z,
        r20: e3x, r21: e3y, r22: e3z,
        kLoc,
        areaMm2,
        radiusMm,
        inertiaMm4,
        bucklingCritN,
    };
}

/** Rotate 3-vector or 12-vector in-place via element's orthogonal basis R. */
function globalToLocal12(el: ElementBasisAndLocalK, uGlob: Float64Array, outLoc: Float64Array): void {
    for (let block = 0; block < 4; block++) {
        const o = block * 3;
        const gx = uGlob[o], gy = uGlob[o + 1], gz = uGlob[o + 2];
        outLoc[o] = el.r00 * gx + el.r01 * gy + el.r02 * gz;
        outLoc[o + 1] = el.r10 * gx + el.r11 * gy + el.r12 * gz;
        outLoc[o + 2] = el.r20 * gx + el.r21 * gy + el.r22 * gz;
    }
}

export function computeLayerPeelForceAndCop(
    layer: RepresentativeLayer,
    fallbackAreaMm2: number,
): { forceN: number; copX: number; copY: number } {
    const field = layer.stefanField;
    if (!field || field.maskAreaMm2 <= 0) {
        return {
            forceN: Math.max(0.01, layer.areaMm2 || fallbackAreaMm2) * NOMINAL_PEEL_PRESSURE_MPA,
            copX: 0,
            copY: 0,
        };
    }

    const pRef = Math.max(1e-4, referenceStefanMeanPressureMm2(10.0));
    const cellArea = field.cellMm * field.cellMm;
    let totalW = 0;
    let sumX = 0;
    let sumY = 0;
    let solidCount = 0;
    let sumXS = 0;
    let sumYS = 0;

    for (let j = 0; j < field.ny; j++) {
        const y = field.minY + (j + 0.5) * field.cellMm;
        const row = j * field.nx;
        for (let i = 0; i < field.nx; i++) {
            const p = field.pressure[row + i];
            if (p <= 0) continue;
            const x = field.minX + (i + 0.5) * field.cellMm;
            solidCount++;
            sumXS += x;
            sumYS += y;
            totalW += p * cellArea;
            sumX += x * p * cellArea;
            sumY += y * p * cellArea;
        }
    }

    const forceN = Math.max(
        0.01,
        (field.integratedForceMm4 / pRef) * NOMINAL_PEEL_PRESSURE_MPA,
    );
    if (totalW > 1e-9) {
        return { forceN, copX: sumX / totalW, copY: sumY / totalW };
    }
    if (solidCount > 0) {
        return { forceN, copX: sumXS / solidCount, copY: sumYS / solidCount };
    }
    return { forceN, copX: 0, copY: 0 };
}

export interface PeelLayerSample {
    zMm: number;
    areaMm2: number;
    forceN: number;
    copX: number;
    copY: number;
}

/**
 * Peel force at every sampled layer, not only the ones with a solved field.
 *
 * The field-derived pressure ratio (`mean p̃ / p̃_ref`) is anchored at the
 * representative layers and interpolated across the layers between them, then
 * multiplied by each layer's own area. The alternative — field force at
 * representative layers, nominal pressure elsewhere — makes every cluster peak
 * a spike on the peel graph, because a broad cross-section's saturated suction
 * is up to ~16× the reference disc's mean while its neighbours read nominal.
 *
 * At a representative layer the result equals `computeLayerPeelForceAndCop`
 * exactly (the ratio is computed from that same integral), so the critical-layer
 * solve is unaffected; only the layers in between move onto the same scale.
 */
export function computePeelLayerSamples(
    samples: ReadonlyArray<{ zMm: number; areaMm2: number }>,
    layers: readonly RepresentativeLayer[],
    fallbackAreaMm2: number,
): PeelLayerSample[] {
    const pRef = Math.max(1e-4, referenceStefanMeanPressureMm2(10.0));
    const anchors = layers
        .filter((layer) => layer.areaMm2 > 0)
        .map((layer) => ({
            zMm: layer.zMm,
            ratio: layer.stefanField && layer.stefanField.integratedForceMm4 > 0
                ? (layer.stefanField.integratedForceMm4 / pRef) / Math.max(0.05, layer.areaMm2)
                : 1,
        }))
        .sort((a, b) => a.zMm - b.zMm);
    const representativeByZ = new Map<number, RepresentativeLayer>();
    for (const layer of layers) representativeByZ.set(Math.round(layer.zMm * 1000), layer);

    const out: PeelLayerSample[] = [];
    let anchorIndex = 0;
    for (const sample of samples) {
        while (anchorIndex + 1 < anchors.length && anchors[anchorIndex + 1].zMm <= sample.zMm) anchorIndex++;
        let ratio = 1;
        if (anchors.length > 0) {
            const before = anchors[anchorIndex];
            const after = anchors[Math.min(anchors.length - 1, anchorIndex + 1)];
            if (sample.zMm <= before.zMm || anchors.length === 1 || after.zMm <= before.zMm) {
                ratio = before.ratio;
            } else if (sample.zMm >= after.zMm) {
                ratio = after.ratio;
            } else {
                const t = (sample.zMm - before.zMm) / (after.zMm - before.zMm);
                ratio = before.ratio + (after.ratio - before.ratio) * t;
            }
        }
        const representative = representativeByZ.get(Math.round(sample.zMm * 1000));
        const cop = representative
            ? computeLayerPeelForceAndCop(representative, fallbackAreaMm2)
            : { copX: 0, copY: 0 };
        out.push({
            zMm: sample.zMm,
            areaMm2: sample.areaMm2,
            forceN: Math.max(0.01, sample.areaMm2 * ratio) * NOMINAL_PEEL_PRESSURE_MPA,
            copX: cop.copX,
            copY: cop.copY,
        });
    }
    return out;
}

/**
 * Connected support sub-assemblies, each with at least one tip and grounded
 * through its own plate roots. Braces merge assemblies, so a limb braced to the
 * main tower is one component; the split this looks for is a part standing on
 * its own support tree.
 */
function tipComponents(graph: SupportGraph): number[][] {
    const adjacency: number[][] = Array.from({ length: graph.nodes.length }, () => []);
    for (const member of graph.members) {
        adjacency[member.nodeA].push(member.nodeB);
        adjacency[member.nodeB].push(member.nodeA);
    }
    const seen = new Uint8Array(graph.nodes.length);
    const components: number[][] = [];
    for (let start = 0; start < graph.nodes.length; start++) {
        if (seen[start]) continue;
        const stack = [start];
        seen[start] = 1;
        const tips: number[] = [];
        let grounded = false;
        while (stack.length > 0) {
            const ni = stack.pop()!;
            const node = graph.nodes[ni];
            if (node.fixed) grounded = true;
            if (node.kind === 'tip') tips.push(ni);
            for (const next of adjacency[ni]) {
                if (!seen[next]) {
                    seen[next] = 1;
                    stack.push(next);
                }
            }
        }
        if (grounded && tips.length > 0) components.push(tips);
    }
    return components;
}

/**
 * One stage per disconnected sub-assembly at its own peak peel and expansion
 * layer, for assemblies no global stage reaches. Global selection samples the
 * model's three worst layers; a short limb hanging on its own support tree can
 * sit entirely below them, and its tips would then never see a load at all.
 *
 * A component already exercised by a chosen global stage is skipped: the global
 * stage activates its tips, and the extra solve would only re-sample the same
 * cross-section.
 */
function selectComponentStages(
    graph: SupportGraph,
    profile: RepresentativeLayerProfile,
    eligibleIndices: readonly number[],
    chosenPositions: ReadonlySet<number>,
): number[] {
    const stages = new Set<number>();
    for (const tips of tipComponents(graph)) {
        let lowestZ = Infinity;
        let highestZ = -Infinity;
        for (const ni of tips) {
            const z = graph.nodes[ni].pos.z;
            if (z < lowestZ) lowestZ = z;
            if (z > highestZ) highestZ = z;
        }
        let covered = false;
        for (const pos of chosenPositions) {
            const zMm = profile.layers[eligibleIndices[pos]].zMm;
            if (zMm >= lowestZ - 0.5 && zMm <= highestZ + 1.0) {
                covered = true;
                break;
            }
        }
        if (covered) continue;

        let bestForcePos = -1;
        let bestForceScore = -1;
        let bestJumpPos = -1;
        let bestJumpScore = -1;
        for (let pos = 0; pos < eligibleIndices.length; pos++) {
            const layer = profile.layers[eligibleIndices[pos]];
            if (layer.zMm < lowestZ - 0.5 || layer.zMm > highestZ + 1.0) continue;
            const score = layer.stefanField?.integratedForceMm4 ?? layer.areaMm2;
            if (score > bestForceScore) {
                bestForceScore = score;
                bestForcePos = pos;
            }
            const jump = layer.areaJumpRatio * layer.areaMm2;
            if (jump > bestJumpScore) {
                bestJumpScore = jump;
                bestJumpPos = pos;
            }
        }
        if (bestForcePos >= 0) stages.add(bestForcePos);
        if (bestJumpPos >= 0) stages.add(bestJumpPos);
        if (stages.size >= MAX_COMPONENT_STAGE_LAYERS) break;
    }
    return [...stages];
}

function selectCriticalLayers(
    graph: SupportGraph,
    profile: RepresentativeLayerProfile | undefined,
    areaPerSupportMm2: number,
    maxCriticalLayers: number,
): Array<{ zMm: number; areaMm2: number; peelForceN: number; copX: number; copY: number; repIndex: number }> {
    let minTipZ = Infinity;
    let maxTipZ = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let tipCnt = 0;
    for (const node of graph.nodes) {
        if (node.kind !== 'tip') continue;
        tipCnt++;
        if (node.pos.z < minTipZ) minTipZ = node.pos.z;
        if (node.pos.z > maxTipZ) maxTipZ = node.pos.z;
        sumX += node.pos.x;
        sumY += node.pos.y;
    }
    if (tipCnt === 0) return [];

    if (!profile || profile.layers.length === 0) {
        const areaMm2 = tipCnt * areaPerSupportMm2;
        return [{
            zMm: maxTipZ,
            areaMm2,
            peelForceN: areaMm2 * NOMINAL_PEEL_PRESSURE_MPA,
            copX: sumX / tipCnt,
            copY: sumY / tipCnt,
            repIndex: -1,
        }];
    }

    const eligibleIndices: number[] = [];
    for (let i = 0; i < profile.layers.length; i++) {
        const l = profile.layers[i];
        if (l.zMm >= minTipZ - 0.5 && l.areaMm2 > 0.05) eligibleIndices.push(i);
    }
    if (eligibleIndices.length === 0) {
        const lastIdx = profile.layers.length - 1;
        const last = profile.layers[lastIdx];
        const peel = computeLayerPeelForceAndCop(last, tipCnt * areaPerSupportMm2);
        return [{
            zMm: Math.max(last.zMm, maxTipZ),
            areaMm2: last.areaMm2,
            peelForceN: peel.forceN,
            copX: peel.copX,
            copY: peel.copY,
            repIndex: lastIdx,
        }];
    }

    const chosenIndices = new Set<number>();
    // 1. Peak integrated Stefan force (or cross-section area)
    let bestForcePos = 0;
    let bestForceScore = -1;
    for (let pos = 0; pos < eligibleIndices.length; pos++) {
        const layer = profile.layers[eligibleIndices[pos]];
        const score = layer.stefanField?.integratedForceMm4 ?? layer.areaMm2;
        if (score > bestForceScore) {
            bestForceScore = score;
            bestForcePos = pos;
        }
    }
    chosenIndices.add(bestForcePos);

    // 2. Peak area-jump expansion shock layer
    if (chosenIndices.size < maxCriticalLayers) {
        let bestJumpPos = -1;
        let bestJumpScore = -1;
        for (let pos = 0; pos < eligibleIndices.length; pos++) {
            const layer = profile.layers[eligibleIndices[pos]];
            const score = layer.areaJumpRatio * layer.areaMm2;
            if (!chosenIndices.has(pos) && score > bestJumpScore) {
                bestJumpScore = score;
                bestJumpPos = pos;
            }
        }
        if (bestJumpPos >= 0) chosenIndices.add(bestJumpPos);
    }

    // 3. Highest layer below/near the top of supports
    const lastPos = eligibleIndices.length - 1;
    if (chosenIndices.size < maxCriticalLayers && !chosenIndices.has(lastPos)) {
        chosenIndices.add(lastPos);
    }

    // 4. Disconnected sub-assemblies no global stage reaches get their own peak
    // peel / expansion layers, bounded so a many-tower forest cannot multiply
    // the solve count.
    for (const pos of selectComponentStages(graph, profile, eligibleIndices, chosenIndices)) {
        if (chosenIndices.size >= maxCriticalLayers + MAX_COMPONENT_STAGE_LAYERS) break;
        chosenIndices.add(pos);
    }

    return [...chosenIndices]
        .sort((a, b) => a - b)
        .map((pos) => {
            const repIndex = eligibleIndices[pos];
            const layer = profile.layers[repIndex];
            const peel = computeLayerPeelForceAndCop(layer, tipCnt * areaPerSupportMm2);
            return { zMm: layer.zMm, areaMm2: layer.areaMm2, peelForceN: peel.forceN, copX: peel.copX, copY: peel.copY, repIndex };
        });
}

/**
 * Evaluate rigid-body peel load distribution across support tips AND solve the
 * full 3D Euler-Bernoulli support+brace frame on critical high-traction layers.
 *
 * Uses Block-Jacobi Preconditioned Conjugate Gradient on the assembled 6-DOF
 * per-node stiffness matrix (fast, zero allocations in the inner loop).
 */
export function solveSupportFrameStress(
    graph: SupportGraph,
    profile: RepresentativeLayerProfile | undefined,
    options?: {
        maxCriticalLayers?: number;
        areaPerSupportMm2?: number;
        /** Optional explicit nodal force override `(fx, fy, fz, mx, my, mz)` per node index for analytical benchmarks. */
        explicitNodalLoads?: Map<number, readonly [number, number, number, number, number, number]>;
    },
): SupportFrameStressReport {
    const maxCriticalLayers = Math.max(1, options?.maxCriticalLayers ?? 3);
    const areaPerSupportMm2 = Math.max(1.0, options?.areaPerSupportMm2 ?? 10.0);

    // Reachability BFS from all fixed root nodes so the frame stiffness matrix is strictly SPD.
    const nodeAdj: number[][] = Array.from({ length: graph.nodes.length }, () => []);
    for (let mi = 0; mi < graph.members.length; mi++) {
        const m = graph.members[mi];
        nodeAdj[m.nodeA].push(m.nodeB);
        nodeAdj[m.nodeB].push(m.nodeA);
    }
    const grounded = new Uint8Array(graph.nodes.length);
    const bfsQueue: number[] = [];
    for (let ni = 0; ni < graph.nodes.length; ni++) {
        if (graph.nodes[ni].fixed) {
            grounded[ni] = 1;
            bfsQueue.push(ni);
        }
    }
    for (let head = 0; head < bfsQueue.length; head++) {
        const cur = bfsQueue[head];
        for (const nxt of nodeAdj[cur]) {
            if (!grounded[nxt]) {
                grounded[nxt] = 1;
                bfsQueue.push(nxt);
            }
        }
    }

    const freeMap = new Int32Array(graph.nodes.length).fill(-1);
    let freeNodeCount = 0;
    for (let ni = 0; ni < graph.nodes.length; ni++) {
        if (grounded[ni] && !graph.nodes[ni].fixed) {
            freeMap[ni] = freeNodeCount++;
        }
    }

    const solverMode: 'frame3d' | 'rigidBodyOnly' =
        freeNodeCount > 0 && freeNodeCount <= MAX_FRAME_SOLVE_FREE_NODES
            ? 'frame3d'
            : 'rigidBodyOnly';

    // Precompute element stiffness + global-diagonal 6x6 block preconditioner once across all layers.
    let elements: ElementBasisAndLocalK[] = [];
    let invDiagBlocks = new Float64Array(0);
    if (solverMode === 'frame3d') {
        elements = [];
        for (let mi = 0; mi < graph.members.length; mi++) {
            const m = graph.members[mi];
            if (!grounded[m.nodeA] || !grounded[m.nodeB]) continue;
            elements.push(buildElementStiffness(graph, mi));
        }

        const diagBlocks = new Float64Array(freeNodeCount * 36);
        const uGlob12 = new Float64Array(12);
        const uLoc12 = new Float64Array(12);
        const fLoc12 = new Float64Array(12);
        const fGlob12 = new Float64Array(12);

        // Build exact 6x6 diagonal block for each free node directly from element transforms: R^T k_AA R.
        for (const el of elements) {
            const fA = freeMap[el.nodeA];
            const fB = freeMap[el.nodeB];
            for (const [isNodeA, fIdx] of [[true, fA], [false, fB]] as const) {
                if (fIdx < 0) continue;
                const dOff = fIdx * 36;
                const localOff = isNodeA ? 0 : 6;
                for (let col = 0; col < 6; col++) {
                    uGlob12.fill(0);
                    uGlob12[localOff + col] = 1.0;
                    globalToLocal12(el, uGlob12, uLoc12);
                    for (let r = 0; r < 6; r++) {
                        let s = 0;
                        const rowBase = (localOff + r) * 12;
                        for (let k = 0; k < 12; k++) s += el.kLoc[rowBase + k] * uLoc12[k];
                        fLoc12[localOff + r] = s;
                    }
                    // R^T * fLoc slice (orthogonal transpose for translational + rotational triplets)
                    for (let blk = 0; blk < 2; blk++) {
                        const o = localOff + blk * 3;
                        const lx = fLoc12[o], ly = fLoc12[o + 1], lz = fLoc12[o + 2];
                        fGlob12[o] = el.r00 * lx + el.r10 * ly + el.r20 * lz;
                        fGlob12[o + 1] = el.r01 * lx + el.r11 * ly + el.r21 * lz;
                        fGlob12[o + 2] = el.r02 * lx + el.r12 * ly + el.r22 * lz;
                    }
                    for (let r = 0; r < 6; r++) {
                        diagBlocks[dOff + r * 6 + col] += fGlob12[localOff + r];
                    }
                }
            }
        }
        invDiagBlocks = new Float64Array(freeNodeCount * 36);
        for (let fIdx = 0; fIdx < freeNodeCount; fIdx++) {
            invert6x6(diagBlocks, fIdx * 36, invDiagBlocks, fIdx * 36);
        }
    }

    const dofCount = freeNodeCount * 6;
    const rhs = new Float64Array(dofCount);
    const u = new Float64Array(dofCount);
    const r = new Float64Array(dofCount);
    const zVec = new Float64Array(dofCount);
    const pVec = new Float64Array(dofCount);
    const apVec = new Float64Array(dofCount);
    const uElemGlob = new Float64Array(12);
    const uElemLoc = new Float64Array(12);
    const fElemLoc = new Float64Array(12);
    const fElemGlob = new Float64Array(12);

    const applyK = (vec: Float64Array, out: Float64Array) => {
        out.fill(0);
        for (const el of elements) {
            const fA = freeMap[el.nodeA];
            const fB = freeMap[el.nodeB];
            if (fA >= 0) {
                const base = fA * 6;
                for (let k = 0; k < 6; k++) uElemGlob[k] = vec[base + k];
            } else {
                for (let k = 0; k < 6; k++) uElemGlob[k] = 0;
            }
            if (fB >= 0) {
                const base = fB * 6;
                for (let k = 0; k < 6; k++) uElemGlob[6 + k] = vec[base + k];
            } else {
                for (let k = 0; k < 6; k++) uElemGlob[6 + k] = 0;
            }

            globalToLocal12(el, uElemGlob, uElemLoc);
            for (let row = 0; row < 12; row++) {
                let s = 0;
                const rowBase = row * 12;
                for (let k = 0; k < 12; k++) s += el.kLoc[rowBase + k] * uElemLoc[k];
                fElemLoc[row] = s;
            }
            for (let blk = 0; blk < 4; blk++) {
                const o = blk * 3;
                const lx = fElemLoc[o], ly = fElemLoc[o + 1], lz = fElemLoc[o + 2];
                fElemGlob[o] = el.r00 * lx + el.r10 * ly + el.r20 * lz;
                fElemGlob[o + 1] = el.r01 * lx + el.r11 * ly + el.r21 * lz;
                fElemGlob[o + 2] = el.r02 * lx + el.r12 * ly + el.r22 * lz;
            }
            if (fA >= 0) {
                const base = fA * 6;
                for (let k = 0; k < 6; k++) out[base + k] += fElemGlob[k];
            }
            if (fB >= 0) {
                const base = fB * 6;
                for (let k = 0; k < 6; k++) out[base + k] += fElemGlob[6 + k];
            }
        }
    };

    const applyPrecond = (src: Float64Array, dst: Float64Array) => {
        for (let fIdx = 0; fIdx < freeNodeCount; fIdx++) {
            const mOff = fIdx * 36;
            const vOff = fIdx * 6;
            for (let row = 0; row < 6; row++) {
                let s = 0;
                const rOff = mOff + row * 6;
                for (let col = 0; col < 6; col++) s += invDiagBlocks[rOff + col] * src[vOff + col];
                dst[vOff + row] = s;
            }
        }
    };

    const solveCG = () => {
        u.fill(0);
        r.set(rhs);
        let rhsNormSq = 0;
        for (let i = 0; i < dofCount; i++) rhsNormSq += rhs[i] * rhs[i];
        if (rhsNormSq <= 1e-20) return;

        applyPrecond(r, zVec);
        pVec.set(zVec);
        let rzOld = 0;
        for (let i = 0; i < dofCount; i++) rzOld += r[i] * zVec[i];

        const maxIter = Math.min(350, Math.max(80, freeNodeCount * 4));
        const tolSq = 1e-10 * rhsNormSq;

        for (let iter = 0; iter < maxIter; iter++) {
            applyK(pVec, apVec);
            let pAp = 0;
            for (let i = 0; i < dofCount; i++) pAp += pVec[i] * apVec[i];
            if (pAp <= 1e-24) break;
            const alpha = rzOld / pAp;
            let rNormSq = 0;
            for (let i = 0; i < dofCount; i++) {
                u[i] += alpha * pVec[i];
                r[i] -= alpha * apVec[i];
                rNormSq += r[i] * r[i];
            }
            if (rNormSq <= tolSq) break;

            applyPrecond(r, zVec);
            let rzNew = 0;
            for (let i = 0; i < dofCount; i++) rzNew += r[i] * zVec[i];
            const beta = rzNew / Math.max(1e-24, rzOld);
            for (let i = 0; i < dofCount; i++) pVec[i] = zVec[i] + beta * pVec[i];
            rzOld = rzNew;
        }
    };

    const tipNodes: number[] = [];
    for (let ni = 0; ni < graph.nodes.length; ni++) {
        if (graph.nodes[ni].kind === 'tip') tipNodes.push(ni);
    }

    const explicitLoads = options?.explicitNodalLoads;
    const criticalLayers = explicitLoads
        ? [{ zMm: 0, areaMm2: 0, peelForceN: 0, copX: 0, copY: 0, repIndex: -1 }]
        : selectCriticalLayers(graph, profile, areaPerSupportMm2, maxCriticalLayers);

    let peakLayerZMm = 0;
    let peakLayerPeelForceN = 0;
    let maxTipUtilizationPct = 0;
    let maxMemberUtilizationPct = 0;
    let maxTipDeflectionMm = 0;
    const overloadedTipIds = new Set<string>();
    const overloadedMemberIds = new Set<string>();
    const candidateHotspots: FrameStressHotspot[] = [];
    const memberMaxUtil = new Float64Array(graph.members.length);
    const tipPeakUtil = new Map<number, { utilPct: number; loadN: number }>();
    const criticalStatsByRepIndex = new Map<number, { maxTipUtilPct: number; maxMemberUtilPct: number }>();
    const syntheticLayerPoints: LayerPeelPoint[] = [];

    for (const layer of criticalLayers) {
        if (layer.peelForceN > peakLayerPeelForceN) {
            peakLayerPeelForceN = layer.peelForceN;
            peakLayerZMm = layer.zMm;
        }
        rhs.fill(0);
        let layerMaxTipUtilPct = 0;
        let layerMaxMemberUtilPct = 0;

        if (explicitLoads) {
            for (const [nodeIdx, f6] of explicitLoads.entries()) {
                const fIdx = freeMap[nodeIdx];
                if (fIdx < 0) continue;
                const base = fIdx * 6;
                for (let k = 0; k < 6; k++) rhs[base + k] = f6[k];
            }
        } else {
            const activeTips = tipNodes.filter((ni) => graph.nodes[ni].pos.z <= layer.zMm + 0.5);
            if (activeTips.length === 0) continue;

            const rigidInput = activeTips.map((ni) => ({
                x: graph.nodes[ni].pos.x,
                y: graph.nodes[ni].pos.y,
                contactDiameterMm: graph.nodes[ni].tipContactDiameterMm ?? 0.28,
            }));
            const tipForces = distributeRigidBodyPeelLoads(rigidInput, layer.peelForceN, layer.copX, layer.copY);

            for (let ti = 0; ti < activeTips.length; ti++) {
                const ni = activeTips[ti];
                const node = graph.nodes[ni];
                const fz = tipForces[ti];
                const tipDia = node.tipContactDiameterMm ?? 0.28;
                const tipArea = Math.PI * (0.5 * tipDia) ** 2;
                const tipStressMpa = fz / Math.max(1e-4, tipArea);
                const tipUtilPct = (100 * tipStressMpa) / GREEN_RESIN_UTS_MPA;

                if (tipUtilPct > layerMaxTipUtilPct) layerMaxTipUtilPct = tipUtilPct;
                if (tipUtilPct > maxTipUtilizationPct) maxTipUtilizationPct = tipUtilPct;
                if (tipUtilPct > 100 && node.entityId) overloadedTipIds.add(node.entityId);
                const prevTip = tipPeakUtil.get(ni);
                if (!prevTip || tipUtilPct > prevTip.utilPct) {
                    tipPeakUtil.set(ni, { utilPct: tipUtilPct, loadN: fz });
                }
                if (node.entityId && node.entityKind) {
                    candidateHotspots.push({
                        entityId: node.entityId,
                        entityKind: node.entityKind,
                        kind: 'tip',
                        utilizationPct: tipUtilPct,
                        peakStressMpa: tipStressMpa,
                        tipLoadN: fz,
                        layerZMm: layer.zMm,
                        pos: node.pos,
                    });
                }

                const fIdx = freeMap[ni];
                if (fIdx >= 0 && solverMode === 'frame3d') {
                    // Coherent unidirectional peel shear: a solid cured layer acts as a rigid
                    // diaphragm rather than stretching opposing X-braces radially apart.
                    const latF = fz * LATERAL_PEEL_DRAG_RATIO;
                    const base = fIdx * 6;
                    rhs[base] = latF * Math.SQRT1_2;
                    rhs[base + 1] = latF * Math.SQRT1_2;
                    rhs[base + 2] = fz;
                }
            }
        }

        if (solverMode === 'frame3d') {
            solveCG();

            for (const ni of tipNodes) {
                const fIdx = freeMap[ni];
                if (fIdx < 0) continue;
                const base = fIdx * 6;
                const defl = Math.hypot(u[base], u[base + 1], u[base + 2]);
                if (defl > maxTipDeflectionMm) maxTipDeflectionMm = defl;
            }

            // Recover element internal axial force + peak bending stress + Euler buckling ratio.
            for (const el of elements) {
                const fA = freeMap[el.nodeA];
                const fB = freeMap[el.nodeB];
                if (fA >= 0) {
                    const base = fA * 6;
                    for (let k = 0; k < 6; k++) uElemGlob[k] = u[base + k];
                } else {
                    for (let k = 0; k < 6; k++) uElemGlob[k] = 0;
                }
                if (fB >= 0) {
                    const base = fB * 6;
                    for (let k = 0; k < 6; k++) uElemGlob[6 + k] = u[base + k];
                } else {
                    for (let k = 0; k < 6; k++) uElemGlob[6 + k] = 0;
                }

                globalToLocal12(el, uElemGlob, uElemLoc);
                for (let row = 0; row < 12; row++) {
                    let s = 0;
                    const rowBase = row * 12;
                    for (let k = 0; k < 12; k++) s += el.kLoc[rowBase + k] * uElemLoc[k];
                    fElemLoc[row] = s;
                }

                // Axial: positive fElemLoc[0] pushing nodeA along +e1 toward nodeB is compression.
                const axialMagN = Math.max(Math.abs(fElemLoc[0]), Math.abs(fElemLoc[6]));
                const axialCompN = Math.max(0, 0.5 * (fElemLoc[0] - fElemLoc[6]));
                const mA = Math.hypot(fElemLoc[4], fElemLoc[5]);
                const mB = Math.hypot(fElemLoc[10], fElemLoc[11]);
                const maxMomentNmm = Math.max(mA, mB);

                const axialStressMpa = axialMagN / el.areaMm2;
                const bendingStressMpa = (maxMomentNmm * el.radiusMm) / el.inertiaMm4;
                const peakStressMpa = axialStressMpa + bendingStressMpa;
                const stressUtilPct = (100 * peakStressMpa) / GREEN_RESIN_UTS_MPA;
                const buckleUtilPct = (100 * axialCompN) / Math.max(1e-6, el.bucklingCritN);
                const utilPct = Math.max(stressUtilPct, buckleUtilPct);

                if (utilPct > layerMaxMemberUtilPct) layerMaxMemberUtilPct = utilPct;
                if (utilPct > memberMaxUtil[el.memberIdx]) memberMaxUtil[el.memberIdx] = utilPct;
                const m = graph.members[el.memberIdx];
                if (utilPct > maxMemberUtilizationPct) maxMemberUtilizationPct = utilPct;
                if (utilPct > 100) overloadedMemberIds.add(m.entityId);

                const pa = graph.nodes[el.nodeA].pos;
                const pb = graph.nodes[el.nodeB].pos;
                candidateHotspots.push({
                    entityId: m.entityId,
                    entityKind: m.entityKind,
                    kind: 'member',
                    utilizationPct: utilPct,
                    peakStressMpa,
                    deflectionMm: fB >= 0 ? Math.hypot(u[fB * 6], u[fB * 6 + 1], u[fB * 6 + 2]) : 0,
                    layerZMm: layer.zMm,
                    pos: {
                        x: 0.5 * (pa.x + pb.x),
                        y: 0.5 * (pa.y + pb.y),
                        z: 0.5 * (pa.z + pb.z),
                    },
                });
            }
        }

        if (layer.repIndex >= 0) {
            criticalStatsByRepIndex.set(layer.repIndex, {
                maxTipUtilPct: layerMaxTipUtilPct,
                maxMemberUtilPct: layerMaxMemberUtilPct,
            });
        } else {
            syntheticLayerPoints.push({
                zMm: Math.round(layer.zMm * 1000) / 1000,
                areaMm2: Math.round(layer.areaMm2 * 100) / 100,
                peelForceN: Math.round(layer.peelForceN * 1000) / 1000,
                maxTipUtilPct: Math.round(layerMaxTipUtilPct * 100) / 100,
                maxMemberUtilPct: Math.round(layerMaxMemberUtilPct * 100) / 100,
                critical: true,
            });
        }
    }

    // Build the force & stress curve for UI visualization at the sampled-layer
    // resolution (`profile.samples`, one point per printed layer) and fall back
    // to the cluster peaks for hand-built profiles.
    const layerProfile: LayerPeelPoint[] = [];
    if (!explicitLoads && profile && profile.layers.length > 0) {
        const fallbackArea = Math.max(1, tipNodes.length) * areaPerSupportMm2;
        const representativeByZ = new Map<number, { layer: RepresentativeLayer; index: number }>();
        profile.layers.forEach((layer, index) => {
            representativeByZ.set(Math.round(layer.zMm * 1000), { layer, index });
        });
        const samples = profile.samples ?? profile.layers.map((layer) => ({ zMm: layer.zMm, areaMm2: layer.areaMm2 }));
        const sampled = computePeelLayerSamples(samples, profile.layers, fallbackArea);
        for (const sample of sampled) {
            const representative = representativeByZ.get(Math.round(sample.zMm * 1000));
            const crit = representative ? criticalStatsByRepIndex.get(representative.index) : undefined;
            let maxTipUtil = crit?.maxTipUtilPct ?? 0;
            if (!crit && sample.areaMm2 > 0.05) {
                const activeTips = tipNodes.filter((ni) => graph.nodes[ni].pos.z <= sample.zMm + 0.5);
                if (activeTips.length > 0) {
                    const rigidInput = activeTips.map((ni) => ({
                        x: graph.nodes[ni].pos.x,
                        y: graph.nodes[ni].pos.y,
                        contactDiameterMm: graph.nodes[ni].tipContactDiameterMm ?? 0.28,
                    }));
                    const tipForces = distributeRigidBodyPeelLoads(rigidInput, sample.forceN, sample.copX, sample.copY);
                    for (let ti = 0; ti < activeTips.length; ti++) {
                        const tipDia = graph.nodes[activeTips[ti]].tipContactDiameterMm ?? 0.28;
                        const tipArea = Math.PI * (0.5 * tipDia) ** 2;
                        const util = (100 * (tipForces[ti] / Math.max(1e-4, tipArea))) / GREEN_RESIN_UTS_MPA;
                        if (util > maxTipUtil) maxTipUtil = util;
                    }
                }
            }
            layerProfile.push({
                zMm: Math.round(sample.zMm * 1000) / 1000,
                areaMm2: Math.round(sample.areaMm2 * 100) / 100,
                peelForceN: Math.round(sample.forceN * 1000) / 1000,
                maxTipUtilPct: Math.round(maxTipUtil * 100) / 100,
                maxMemberUtilPct: Math.round((crit?.maxMemberUtilPct ?? 0) * 100) / 100,
                critical: Boolean(crit),
            });
        }
        layerProfile.sort((a, b) => a.zMm - b.zMm);
    } else {
        layerProfile.push(...syntheticLayerPoints.sort((a, b) => a.zMm - b.zMm));
    }

    const memberSegments: StressSegment[] = graph.members
        .map((m, mi) => ({
            entityId: m.entityId,
            entityKind: m.entityKind,
            a: graph.nodes[m.nodeA].pos,
            b: graph.nodes[m.nodeB].pos,
            diameterMm: m.diameterMm,
            utilizationPct: memberMaxUtil[mi],
        }))
        .sort((x, y) => compareVec3(x.a, y.a) || compareVec3(x.b, y.b));

    const tipPoints: StressTipPoint[] = tipNodes
        .map((ni) => {
            const node = graph.nodes[ni];
            const peak = tipPeakUtil.get(ni);
            return {
                entityId: node.entityId ?? node.id,
                entityKind: node.entityKind ?? 'trunk',
                pos: node.pos,
                utilizationPct: peak?.utilPct ?? 0,
                loadN: peak?.loadN ?? 0,
            };
        })
        .sort((x, y) => compareVec3(x.pos, y.pos));

    // Deduplicate to peak utilization per (kind, entityId) with deterministic coordinate ordering.
    const bestHotspotByKey = new Map<string, FrameStressHotspot>();
    for (const h of candidateHotspots) {
        const key = `${h.kind}:${h.entityId}`;
        const prev = bestHotspotByKey.get(key);
        if (!prev || h.utilizationPct > prev.utilizationPct + 1e-6) {
            bestHotspotByKey.set(key, h);
        }
    }
    const hotspots = [...bestHotspotByKey.values()]
        .sort((a, b) => (
            b.utilizationPct - a.utilizationPct
            || a.layerZMm - b.layerZMm
            || compareVec3(a.pos, b.pos)
        ))
        .slice(0, 5);

    return {
        nodeCount: graph.nodes.length,
        rootCount: graph.rootCount,
        tipCount: graph.tipCount,
        memberCount: graph.members.length,
        braceCount: graph.braceCount,
        layersEvaluated: criticalLayers.length,
        peakLayerZMm,
        peakLayerPeelForceN,
        maxTipUtilizationPct,
        overloadedTips: overloadedTipIds.size,
        maxMemberUtilizationPct,
        overloadedMembers: overloadedMemberIds.size,
        maxTipDeflectionMm,
        solverMode,
        hotspots,
        layerProfile,
        memberSegments,
        tipPoints,
    };
}

/** Max strengthened diameter (mm) applied by automatic weak-spot reinforcement. */
const MAX_REINFORCED_TRUNK_DIA_MM = 2.2;
const MAX_REINFORCED_BRANCH_DIA_MM = 1.65;
const MAX_REINFORCED_LEAF_BODY_DIA_MM = 1.55;
const MAX_REINFORCED_BRACE_DIA_MM = 1.6;
const REINFORCE_JOINT_OFFSET_MM = 0.125;

function insetSegmentEnd(start: Vec3, end: Vec3, maxInsetMm = 1.5): Vec3 {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const len = Math.hypot(dx, dy, dz);
    if (len <= 1e-4) return end;
    const inset = Math.min(maxInsetMm, len * 0.35);
    const keep = (len - inset) / len;
    return {
        x: start.x + dx * keep,
        y: start.y + dy * keep,
        z: start.z + dz * keep,
    };
}

function tryClearedScale(idealScale: number, testScale: (scale: number) => boolean): number | null {
    const candidates = [
        idealScale,
        Math.max(1.08, 1 + (idealScale - 1) * 0.5),
        1.08,
    ];
    for (let i = 0; i < candidates.length; i++) {
        const s = candidates[i];
        if (i > 0 && Math.abs(s - candidates[i - 1]) < 1e-4) continue;
        if (testScale(s)) return s;
    }
    return null;
}

export interface ReinforceFrameMembersResult {
    snapshot: SupportState;
    reinforcedTrunks: number;
    reinforcedBranches: number;
    reinforcedLeaves: number;
    reinforcedBraces: number;
    totalReinforced: number;
    skippedCount: number;
    changed: boolean;
}

/**
 * Thicken overloaded `trunk`, `branch`, `leaf`, and `brace` members identified
 * by `solveSupportFrameStress` (`utilizationPct > 100%`), scaling diameters by
 * `clamp((util / 90)^(1/3), 1.10, 1.35)` with stepped clearance fallbacks
 * (`isShaftBlocked`) so thickening never introduces mesh intersections and
 * host knots track upgraded child diameters for consistent 3D rendering.
 */
export function reinforceOverloadedFrameMembers(
    snapshot: SupportState,
    report: SupportFrameStressReport,
    mesh?: THREE.Mesh,
    modelId?: string,
): ReinforceFrameMembersResult {
    const peakUtilByTrunkId = new Map<string, number>();
    const peakUtilByBranchId = new Map<string, number>();
    const peakUtilByLeafId = new Map<string, number>();
    const peakUtilByBraceId = new Map<string, number>();

    for (const seg of report.memberSegments) {
        if (seg.utilizationPct <= 100) continue;
        if (seg.entityKind === 'trunk') {
            const prev = peakUtilByTrunkId.get(seg.entityId) ?? 0;
            if (seg.utilizationPct > prev) peakUtilByTrunkId.set(seg.entityId, seg.utilizationPct);
        } else if (seg.entityKind === 'branch') {
            const prev = peakUtilByBranchId.get(seg.entityId) ?? 0;
            if (seg.utilizationPct > prev) peakUtilByBranchId.set(seg.entityId, seg.utilizationPct);
        } else if (seg.entityKind === 'leaf') {
            const prev = peakUtilByLeafId.get(seg.entityId) ?? 0;
            if (seg.utilizationPct > prev) peakUtilByLeafId.set(seg.entityId, seg.utilizationPct);
        } else if (seg.entityKind === 'brace') {
            const prev = peakUtilByBraceId.get(seg.entityId) ?? 0;
            if (seg.utilizationPct > prev) peakUtilByBraceId.set(seg.entityId, seg.utilizationPct);
        }
    }

    if (
        peakUtilByTrunkId.size === 0
        && peakUtilByBranchId.size === 0
        && peakUtilByLeafId.size === 0
        && peakUtilByBraceId.size === 0
    ) {
        return {
            snapshot,
            reinforcedTrunks: 0,
            reinforcedBranches: 0,
            reinforcedLeaves: 0,
            reinforcedBraces: 0,
            totalReinforced: 0,
            skippedCount: 0,
            changed: false,
        };
    }

    let nextTrunks: SupportState['trunks'] | null = null;
    let nextBranches: SupportState['branches'] | null = null;
    let nextLeaves: SupportState['leaves'] | null = null;
    let nextBraces: SupportState['braces'] | null = null;
    let nextKnots: SupportState['knots'] | null = null;
    const upgradedSegmentDia = new Map<string, number>();
    const minKnotDia = new Map<string, number>();
    let reinforcedTrunks = 0;
    let reinforcedBranches = 0;
    let reinforcedLeaves = 0;
    let reinforcedBraces = 0;
    let skippedCount = 0;

    const bumpKnotMinDia = (knotId: string | undefined, targetDia: number) => {
        if (!knotId) return;
        const prev = minKnotDia.get(knotId) ?? 0;
        if (targetDia > prev) minKnotDia.set(knotId, targetDia);
    };

    for (const [trunkId, utilPct] of peakUtilByTrunkId.entries()) {
        const trunk = snapshot.trunks?.[trunkId];
        if (!trunk || trunk.segments.length === 0) continue;
        if (modelId && trunk.modelId !== modelId) continue;

        const root = snapshot.roots?.[trunk.rootId];
        const idealScale = Math.min(1.35, Math.max(1.10, Math.cbrt(utilPct / 90)));
        const typedTrunk = trunk.typeId ? trunk : { ...trunk, typeId: 'trunk' as const };

        const computeTargetDias = (scale: number) => trunk.segments.map((seg) =>
            Math.min(MAX_REINFORCED_TRUNK_DIA_MM, Math.max(seg.diameter, Number((seg.diameter * scale).toFixed(2)))));

        const acceptedScale = tryClearedScale(idealScale, (scale) => {
            const targetDias = computeTargetDias(scale);
            if (targetDias.every((d, i) => d <= trunk.segments[i].diameter + 1e-4)) return false;
            if (!mesh || !root) return true;
            for (let i = 0; i < trunk.segments.length; i++) {
                const seg = trunk.segments[i];
                const ep = resolveSegmentEndpoints(typedTrunk, seg, i, { root });
                if (!ep) continue;
                const endsAtTip = !seg.topJoint && Boolean(trunk.contactCone?.pos);
                const checkEnd = endsAtTip ? insetSegmentEnd(ep.start, ep.end) : ep.end;
                if (isShaftBlocked(ep.start, checkEnd, Math.max(0.2, targetDias[i] * 0.5), mesh)) {
                    return false;
                }
            }
            return true;
        });

        if (acceptedScale === null) {
            skippedCount++;
            continue;
        }

        const targetDias = computeTargetDias(acceptedScale);
        if (!nextTrunks) nextTrunks = { ...snapshot.trunks };
        const updatedSegments = trunk.segments.map((seg, i) => {
            const newDia = targetDias[i];
            upgradedSegmentDia.set(seg.id, newDia);
            return {
                ...seg,
                diameter: newDia,
                ...(seg.bottomJoint ? { bottomJoint: { ...seg.bottomJoint, diameter: Math.max(seg.bottomJoint.diameter, newDia + REINFORCE_JOINT_OFFSET_MM) } } : {}),
                ...(seg.topJoint ? { topJoint: { ...seg.topJoint, diameter: Math.max(seg.topJoint.diameter, newDia + REINFORCE_JOINT_OFFSET_MM) } } : {}),
            };
        });
        const topSegDia = updatedSegments[updatedSegments.length - 1]?.diameter;
        const nextCone = trunk.contactCone && topSegDia !== undefined && trunk.contactCone.profile
            ? {
                ...trunk.contactCone,
                profile: {
                    ...trunk.contactCone.profile,
                    bodyDiameterMm: Math.max(trunk.contactCone.profile.bodyDiameterMm, topSegDia),
                },
            }
            : trunk.contactCone;
        nextTrunks[trunkId] = {
            ...trunk,
            segments: updatedSegments,
            ...(nextCone ? { contactCone: nextCone } : {}),
        };
        reinforcedTrunks++;
    }

    for (const [branchId, utilPct] of peakUtilByBranchId.entries()) {
        const branch = snapshot.branches?.[branchId];
        if (!branch || branch.segments.length === 0) continue;
        if (modelId && branch.modelId !== modelId) continue;

        const hostKnot = snapshot.knots?.[branch.parentKnotId];
        const idealScale = Math.min(1.35, Math.max(1.10, Math.cbrt(utilPct / 90)));
        const typedBranch = branch.typeId ? branch : { ...branch, typeId: 'branch' as const };

        const computeTargetDias = (scale: number) => branch.segments.map((seg) =>
            Math.min(MAX_REINFORCED_BRANCH_DIA_MM, Math.max(seg.diameter, Number((seg.diameter * scale).toFixed(2)))));

        const acceptedScale = tryClearedScale(idealScale, (scale) => {
            const targetDias = computeTargetDias(scale);
            if (targetDias.every((d, i) => d <= branch.segments[i].diameter + 1e-4)) return false;
            if (!mesh || !hostKnot) return true;
            for (let i = 0; i < branch.segments.length; i++) {
                const seg = branch.segments[i];
                const ep = resolveSegmentEndpoints(typedBranch, seg, i, { hostKnot });
                if (!ep) continue;
                const endsAtTip = !seg.topJoint && Boolean(branch.contactCone?.pos);
                const checkEnd = endsAtTip ? insetSegmentEnd(ep.start, ep.end) : ep.end;
                if (isShaftBlocked(ep.start, checkEnd, Math.max(0.2, targetDias[i] * 0.5), mesh)) {
                    return false;
                }
            }
            return true;
        });

        if (acceptedScale === null) {
            skippedCount++;
            continue;
        }

        const targetDias = computeTargetDias(acceptedScale);
        if (!nextBranches) nextBranches = { ...snapshot.branches };
        const updatedSegments = branch.segments.map((seg, i) => {
            const newDia = targetDias[i];
            upgradedSegmentDia.set(seg.id, newDia);
            return {
                ...seg,
                diameter: newDia,
                ...(seg.bottomJoint ? { bottomJoint: { ...seg.bottomJoint, diameter: Math.max(seg.bottomJoint.diameter, newDia + REINFORCE_JOINT_OFFSET_MM) } } : {}),
                ...(seg.topJoint ? { topJoint: { ...seg.topJoint, diameter: Math.max(seg.topJoint.diameter, newDia + REINFORCE_JOINT_OFFSET_MM) } } : {}),
            };
        });
        const firstSegDia = updatedSegments[0]?.diameter;
        const nextCone = branch.contactCone && firstSegDia !== undefined && branch.contactCone.profile
            ? {
                ...branch.contactCone,
                profile: {
                    ...branch.contactCone.profile,
                    bodyDiameterMm: Math.max(branch.contactCone.profile.bodyDiameterMm, firstSegDia),
                },
            }
            : branch.contactCone;
        nextBranches[branchId] = {
            ...branch,
            segments: updatedSegments,
            ...(nextCone ? { contactCone: nextCone } : {}),
        };
        if (firstSegDia !== undefined) {
            bumpKnotMinDia(branch.parentKnotId, firstSegDia + REINFORCE_JOINT_OFFSET_MM);
        }
        reinforcedBranches++;
    }

    for (const [leafId, utilPct] of peakUtilByLeafId.entries()) {
        const leaf = snapshot.leaves?.[leafId];
        if (!leaf?.contactCone?.profile) continue;
        if (modelId && leaf.modelId !== modelId) continue;

        const hostKnot = snapshot.knots?.[leaf.parentKnotId];
        const curBodyDia = leaf.contactCone.profile.bodyDiameterMm ?? 0.9;
        const idealScale = Math.min(1.35, Math.max(1.10, Math.cbrt(utilPct / 90)));

        const computeTargetBodyDia = (scale: number) =>
            Math.min(MAX_REINFORCED_LEAF_BODY_DIA_MM, Math.max(curBodyDia, Number((curBodyDia * scale).toFixed(2))));

        const acceptedScale = tryClearedScale(idealScale, (scale) => {
            const newBodyDia = computeTargetBodyDia(scale);
            if (newBodyDia <= curBodyDia + 1e-4) return false;
            if (!mesh || !hostKnot) return true;
            const checkEnd = insetSegmentEnd(hostKnot.pos, leaf.contactCone.pos);
            return !isShaftBlocked(hostKnot.pos, checkEnd, Math.max(0.2, newBodyDia * 0.35), mesh);
        });

        if (acceptedScale === null) {
            skippedCount++;
            continue;
        }

        const newBodyDia = computeTargetBodyDia(acceptedScale);
        if (!nextLeaves) nextLeaves = { ...snapshot.leaves };
        nextLeaves[leafId] = {
            ...leaf,
            contactCone: {
                ...leaf.contactCone,
                profile: {
                    ...leaf.contactCone.profile,
                    bodyDiameterMm: newBodyDia,
                },
            },
        };
        bumpKnotMinDia(leaf.parentKnotId, newBodyDia + REINFORCE_JOINT_OFFSET_MM);
        reinforcedLeaves++;
    }

    for (const [braceId, utilPct] of peakUtilByBraceId.entries()) {
        const brace = snapshot.braces?.[braceId];
        if (!brace) continue;
        if (modelId && brace.modelId !== modelId) continue;

        const idealScale = Math.min(1.35, Math.max(1.10, Math.cbrt(utilPct / 90)));
        const curDia = brace.profile?.diameter ?? 1.0;
        const startPos = snapshot.knots?.[brace.startKnotId]?.pos;
        const endPos = snapshot.knots?.[brace.endKnotId]?.pos;

        const computeTargetDia = (scale: number) =>
            Math.min(MAX_REINFORCED_BRACE_DIA_MM, Math.max(curDia, Number((curDia * scale).toFixed(2))));

        const acceptedScale = tryClearedScale(idealScale, (scale) => {
            const newDia = computeTargetDia(scale);
            if (newDia <= curDia + 1e-4) return false;
            if (!mesh || !startPos || !endPos) return true;
            return !isShaftBlocked(startPos, endPos, Math.max(0.2, newDia * 0.5), mesh);
        });

        if (acceptedScale === null) {
            skippedCount++;
            continue;
        }

        const newDia = computeTargetDia(acceptedScale);
        if (!nextBraces) nextBraces = { ...snapshot.braces };
        nextBraces[braceId] = { ...brace, profile: { ...brace.profile, diameter: newDia } };
        bumpKnotMinDia(brace.startKnotId, newDia + REINFORCE_JOINT_OFFSET_MM);
        bumpKnotMinDia(brace.endKnotId, newDia + REINFORCE_JOINT_OFFSET_MM);
        reinforcedBraces++;
    }

    if (upgradedSegmentDia.size > 0 || minKnotDia.size > 0) {
        for (const [knotId, knot] of Object.entries(snapshot.knots ?? {})) {
            const hostDia = upgradedSegmentDia.get(knot.parentShaftId);
            const hostedTarget = hostDia !== undefined ? hostDia + REINFORCE_JOINT_OFFSET_MM : 0;
            const childTarget = minKnotDia.get(knotId) ?? 0;
            const targetKnotDia = Math.max(hostedTarget, childTarget);
            if (targetKnotDia <= 0 || (knot.diameter ?? 0) >= targetKnotDia - 1e-4) continue;
            if (!nextKnots) nextKnots = { ...snapshot.knots };
            nextKnots[knotId] = { ...knot, diameter: targetKnotDia };
        }
    }

    const totalReinforced = reinforcedTrunks + reinforcedBranches + reinforcedLeaves + reinforcedBraces;
    if (totalReinforced === 0) {
        return {
            snapshot,
            reinforcedTrunks: 0,
            reinforcedBranches: 0,
            reinforcedLeaves: 0,
            reinforcedBraces: 0,
            totalReinforced: 0,
            skippedCount,
            changed: false,
        };
    }

    return {
        snapshot: {
            ...snapshot,
            ...(nextTrunks ? { trunks: nextTrunks } : {}),
            ...(nextBranches ? { branches: nextBranches } : {}),
            ...(nextLeaves ? { leaves: nextLeaves } : {}),
            ...(nextBraces ? { braces: nextBraces } : {}),
            ...(nextKnots ? { knots: nextKnots } : {}),
        },
        reinforcedTrunks,
        reinforcedBranches,
        reinforcedLeaves,
        reinforcedBraces,
        totalReinforced,
        skippedCount,
        changed: true,
    };
}
