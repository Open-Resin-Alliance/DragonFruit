import {
    contactBridgeTypes,
    contactEndpointsFor,
    getSupportTypeDescriptor,
    GRID_HOST_TYPES,
    isOriginConvertibleToTree,
    resolveSupportTypeIdOf,
    SHAFT_HOSTED_MEMBER_TYPES,
    SUPPORT_TYPES,
    NEAR_PLATE_ORIGIN,
} from '../supportTypeRegistry';
import type { SupportCollectionKey, ShaftHostedMemberType, ShaftHostedMemberTypeId } from '../supportTypeRegistry';
import type { SupportTypeId } from '../supportTypeRegistry';
import { footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import * as THREE from 'three';
import { quantizeToScale } from '@/utils/math';

/**
 * Diagnostics to 2dp. NOT interchangeable with `round(v, 2)`: that rounds the
 * decimal representation, and the two disagree on exact halfway values.
 */
const round2Mm = (v: number): number => quantizeToScale(v, 100);
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { AttachmentKind, CandidatePoint, AutoPlaceResult, AutoPlaceStatus, AutoPlaceAnalytics, RejectReason, AutoSupportPlan, PlacementDiagnostics, FanLeafRefusal, ForestLedgerEntry, ForestReport, ForestTree, OrphanInfo, PlacementOutcomeKind } from './types';
import { isLedgerKind } from './types';
import type { Branch, Segment, SupportState, SupportOrigin, Vec3 } from '../types';
import type { AutoSupportSettings } from './settings';
import type { AutoPlaceTimings } from './types';
import { normalizeAutoSupportSettings } from './settings';
import { activeSizingBand } from './parameterSizing';
import { generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { generateGridCandidates, shouldUseDensityGrid } from './gridPlacement';
import { computeStabilizationAnchors } from './stabilization';
import { perfEndFrame, perfMark, perfMeasure, type PerfFrame } from '../PlacementLogic/Pathfinding/pathfindingPerf';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { getRouterStats, resetRouterStats } from '../PlacementLogicV3/SmartPlacementV3';
import {
    MAX_GAP_FILL_PASSES,
    buildGapFillCandidates,
    collectSupportTips,
    computeRegionCoverage,
    coverageRadiusForArea,
} from './coverage';
import { sizeParameters, presetForArea } from './parameterSizing';
import type { ModelSizingContext } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { memberDepartureAngleFromVerticalDeg } from '../PlacementLogic/smartPlacementSearchUtils';
import { DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG } from '../Settings/defaults';
import { cloneSupportState, getSnapshot, setSnapshot } from '../state';
import { draftAddEntity, draftAddPrimitive, draftCommitSupport } from './supportDraft';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import { buildCavityBridge } from '../SupportTypes/Trunk/useTrunkPlacement';
import { computeForestDiameterProfile } from '../SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { pushSupportHistory } from '../history/supportHistory';
import { SUPPORT_AUTO_PLACE } from '../history/actionTypes';
import { getModelMesh } from './meshStore';
import {
    ALREADY_SUPPORTED_RADIUS_MM,
    GRIDLESS_MERGE_RADIUS_MM,
    LEAF_FAN_RADIUS_MM,
    MIN_LEAF_FAN_RADIUS_MM,
    GRID_HOST_FAN_RADIUS_MM,
    LEAF_FAN_MAX_ANGLE_DEG,
    CONSOLIDATION_FAN_RADIUS_MM,
    CAVITY_FAN_RADIUS_MM,
    CONSOLIDATION_MAX_ANGLE_DEG,
    CONSOLIDATION_BRANCH_MIN_HEIGHT_MM,
    MAX_LEAF_SPAN_BEFORE_BRANCH_MM,
    MERGE_HOST_LOAD_WEIGHT,
    MAX_CAVITY_BRIDGE_MM,
} from './constants';

const LOG_PREFIX = '[AutoSupport]';

/**
 * The steepest angle from vertical an auto member or chunk link may lean —
 * derived from the user's branch-angle rule (`grid.minBranchAngleDeg`, 60°
 * above the horizontal), the same rule the grid engine and the trunk
 * promotion path already enforce on manual branches. Auto members used to
 * ignore it (fan 45°, merge 45° rise, consolidation 75°), which is where the
 * near-level bars came from: a member at 45° from vertical carries almost
 * nothing along its axis and reads as a stray branch off the host.
 */
function memberMaxAngleFromVerticalDeg(): number {
    const minRiseDeg = getSettings().grid?.minBranchAngleDeg ?? DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG;
    return Math.max(0, Math.min(90, 90 - minRiseDeg));
}

/**
 * Where a BRANCH actually leaves its host, as an angle from vertical.
 *
 * The contact cone is clamped toward the surface normal, so a branch can pass
 * the knot→tip gate and still run out of the host nearly level, only bending
 * into a steep cone at the tip — measured on a speck field: every branch chord
 * read 30° while every shaft left the host at 42°. Gate the shaft, not the
 * chord.
 */
/** The angle this branch's shaft leaves its host at. 0 when it has no joints yet. */
function branchDepartureAngleDeg(
    branch: Branch,
    knotPos: { x: number; y: number; z: number },
): number {
    const firstJoint = branch.segments[0]?.topJoint?.pos;
    if (!firstJoint) return 0;
    return memberDepartureAngleFromVerticalDeg(knotPos, firstJoint);
}

// Per-entity placement logging (Trunk/Leaf/Merge lines) is OFF by default —
// the Forest Report at the end of each run replaces the per-support spam.
// Re-enable via setAutoSupportVerboseLogging(true) for debugging.
let verboseLogging = false;

export function setAutoSupportVerboseLogging(enabled: boolean): void {
    verboseLogging = enabled;
}

function logPlacement(message: string): void {
    if (verboseLogging) console.log(LOG_PREFIX, message);
}

// ---------------------------------------------------------------------------
// Knot identity
// ---------------------------------------------------------------------------

/**
 * Allocate a knot id that is free in the draft. Auto knot ids are built from
 * candidate ids, which repeat across scans, and `draftAddPrimitive` replaces a
 * knot on collision rather than failing.
 */
function freeKnotId(draft: SupportState, baseId: string): string {
    if (!draft.knots[baseId]) return baseId;
    let n = 2;
    while (draft.knots[`${baseId}-${n}`]) n++;
    return `${baseId}-${n}`;
}


// ---------------------------------------------------------------------------
// Mesh volume helper
// ---------------------------------------------------------------------------

/**
 * Exact volume (mm³) of a closed mesh via the signed tetrahedron sum around
 * the origin. Used for physics-informed sizing — replaces the bounding-box
 * volume, which wildly overestimates non-cubic models.
 */
function computeMeshVolumeMm3(mesh: THREE.Mesh): number {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return 0;
    const index = geo.index;
    let vol = 0;
    const addTri = (i0: number, i1: number, i2: number) => {
        const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
        const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
        const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
        vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    };
    if (index) {
        for (let i = 0; i < index.count; i += 3) addTri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    } else {
        for (let i = 0; i < pos.count; i += 3) addTri(i, i + 1, i + 2);
    }
    return Math.abs(vol);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The registry's walk entry per shaft-hosted member type. */
const SHAFT_HOSTED_MEMBER_TYPE_BY_ID: ReadonlyMap<SupportTypeId, ShaftHostedMemberType> = new Map(
    SHAFT_HOSTED_MEMBER_TYPES.map((memberType) => [memberType.typeId as SupportTypeId, memberType]),
);

/**
 * The type a member this file just built belongs to, read off the `typeId` its
 * builder stamped. A member the shaft-hosted walk does not visit is refused.
 */
function builtMemberTypeId(member: { id: string; typeId?: SupportTypeId }): ShaftHostedMemberTypeId {
    const typeId = resolveSupportTypeIdOf(member);
    const memberType = typeId ? SHAFT_HOSTED_MEMBER_TYPE_BY_ID.get(typeId) : undefined;
    if (!memberType) {
        throw new Error(`built member ${member.id} is not a shaft-hosted member type (${typeId ?? 'no typeId'})`);
    }
    return memberType.typeId;
}

/** One counter per support type, so no placement path can go uncounted. */
function emptyPlacedCounts(): Record<SupportTypeId, number> {
    const counts = {} as Record<SupportTypeId, number>;
    for (const descriptor of SUPPORT_TYPES) counts[descriptor.id] = 0;
    return counts;
}

/** A type's shafted entity, as far as host resolution reads it. */
interface HostEntity {
    id: string;
    modelId?: string;
    origin?: SupportOrigin;
    /** Set for a type that owns a plate root; hostSegmentSpan reads it. */
    rootId?: string;
    segments: Segment[];
    contactCone?: { pos: Vec3; normal?: Vec3 };
}

/** One host entity in the draft, with the type that owns it. */
interface HostRef {
    hostTypeId: SupportTypeId;
    hostId: string;
    entity: HostEntity;
}

/** Every host entity in the draft, in registry order. */
function collectHostEntities(draft: SupportState): HostRef[] {
    const hosts: HostRef[] = [];
    for (const descriptor of GRID_HOST_TYPES) {
        const collection = draft[descriptor.location.key] as unknown as
            Record<string, HostEntity> | undefined;
        for (const [hostId, entity] of Object.entries(collection ?? {})) {
            hosts.push({ hostTypeId: descriptor.id, hostId, entity });
        }
    }
    return hosts;
}

/** The host entity `(hostTypeId, hostId)` names, or undefined. */
function hostEntityOf(
    draft: SupportState,
    hostTypeId: SupportTypeId,
    hostId: string,
): HostEntity | undefined {
    const collection = draft[getSupportTypeDescriptor(hostTypeId).location.key] as unknown as
        Record<string, HostEntity> | undefined;
    return collection?.[hostId];
}

/** A type's own name for a log line: the declared singular, capitalised. */
function typeWord(typeId: SupportTypeId): string {
    const singular = getSupportTypeDescriptor(typeId).singular;
    return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function makeResult(
    placed: Record<SupportTypeId, number>,
    rejected: number,
    changed: boolean,
    status: AutoPlaceStatus,
): AutoPlaceResult {
    return {
        placed,
        rejectedCandidates: rejected,
        changed,
        status,
    };
}

// ---------------------------------------------------------------------------
// Normal resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the real surface normal at a candidate's tip position by
 * raycasting against the model mesh — exactly the same way manual
 * placement obtains a surface normal from a click intersection.
 *
 * Primary ray goes UPWARD from just below the tip: a support contact sits on
 * the underside of an overhang, so the first surface hit is the contact face
 * itself, whose normal (pointing away from the model interior, i.e. downward)
 * is what the support tip must align with. A downward ray from above would hit
 * the model's TOP surface first, which is the wrong face for a support.
 *
 * Falls back to a downward ray (normal flipped) for top-surface contacts, and
 * finally to the candidate's placeholder normal when the mesh is unavailable
 * or both rays miss.
 *
 * Both rays walk a small DISC of offsets before giving up (radii 0, 0.75,
 * 1.5, 2.25 mm): a punched drain hole or a gap directly above/below the tip
 * swallows the single straight ray, and the contact then resolved to the far
 * side of the wall — the interior ceiling of a cavity lost every support the
 * moment a hole was punched through it, because the upward ray escaped and
 * the downward fallback landed on the cavity floor with a flipped normal.
 */
function resolveSurfaceNormal(
    tipPos: CandidatePoint['tipPos'],
    mesh: THREE.Mesh | undefined,
): { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } {
    if (!mesh) {
        return { point: tipPos, normal: { x: 0, y: 0, z: -1 } };
    }

    const raycaster = new THREE.Raycaster();
    const SEARCH_RADII_MM = [0, 0.75, 1.5, 2.25];
    // A contact never sits BELOW its own candidate: a hit further down than
    // this came through a hole or gap, not from the surface being supported.
    const SAME_SIDE_TOLERANCE_MM = 0.5;

    /**
     * Cast `direction` from the tip's height (±2 mm) at each offset, nearest
     * radius first, and take the first hit that is still on the tip's side.
     */
    const castFromDisc = (directionZ: 1 | -1): THREE.Intersection | null => {
        const seedZ = directionZ === 1 ? tipPos.z - 2 : tipPos.z + 2;
        for (const radiusMm of SEARCH_RADII_MM) {
            const steps = radiusMm === 0 ? 1 : 8;
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                raycaster.set(
                    new THREE.Vector3(
                        tipPos.x + Math.cos(angle) * radiusMm,
                        tipPos.y + Math.sin(angle) * radiusMm,
                        seedZ,
                    ),
                    new THREE.Vector3(0, 0, directionZ),
                );
                const hit = raycaster.intersectObject(mesh, false)
                    .find((h) => h.point.z >= tipPos.z - SAME_SIDE_TOLERANCE_MM);
                if (hit) return hit;
            }
        }
        return null;
    };

    // Primary: upward ray from just below the tip (underside contact).
    const upHit = castFromDisc(1);
    if (upHit) {
        return {
            point: { x: upHit.point.x, y: upHit.point.y, z: upHit.point.z },
            normal: calculateSmoothedNormal(upHit),
        };
    }

    // Fallback: downward ray from above (top-surface contact), normal flipped
    // so the support still grows away from the face.
    const downHit = castFromDisc(-1);
    if (downHit) {
        const smoothed = calculateSmoothedNormal(downHit);
        return {
            point: { x: downHit.point.x, y: downHit.point.y, z: downHit.point.z },
            normal: { x: -smoothed.x, y: -smoothed.y, z: -smoothed.z },
        };
    }

    // Fallback: keep the existing normal.
    return { point: tipPos, normal: { x: 0, y: 0, z: -1 } };
}

// ---------------------------------------------------------------------------
// Already-supported filter
// ---------------------------------------------------------------------------

/**
 * Where every support currently touches the model.
 *
 * Both callers -- "is this candidate already supported" and "how much of this
 * island is covered" -- want the same answer, and each collected it from four
 * types by hand: trunk, branch, leaf, anchor. Twig and stick declare contacts
 * too, so a point held by one of those read as unsupported.
 */
export function collectContactPositions(snapshot: SupportState): Array<{ x: number; y: number; z: number }> {
    const positions: Array<{ x: number; y: number; z: number }> = [];

    for (const descriptor of SUPPORT_TYPES) {
        const collection = snapshot[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;
        for (const entity of Object.values(collection ?? {})) {
            for (const contact of contactEndpointsFor(descriptor.id)) {
                const pos = (entity[contact.field] as { pos?: { x: number; y: number; z: number } } | undefined)?.pos;
                if (pos) positions.push(pos);
            }
        }
    }

    return positions;
}

/**
 * Remove candidates whose tip position is already covered by an existing
 * support contact. Prevents stacking duplicate supports on repeated runs.
 */
function filterAlreadySupported(candidates: CandidatePoint[], draft: SupportState): CandidatePoint[] {
    const snapshot = draft;
    const existingTips: Array<{ x: number; y: number; z: number }> = [];

    existingTips.push(...collectContactPositions(snapshot));

    if (existingTips.length === 0) return candidates;

    const r2 = ALREADY_SUPPORTED_RADIUS_MM * ALREADY_SUPPORTED_RADIUS_MM;
    return candidates.filter(c => {
        for (const tip of existingTips) {
            const dx = c.tipPos.x - tip.x;
            const dy = c.tipPos.y - tip.y;
            const dz = c.tipPos.z - tip.z;
            if (dx * dx + dy * dy + dz * dz <= r2) return false;
        }
        return true;
    });
}

// ---------------------------------------------------------------------------
// Nearby-trunk merge (works even without grid mode)
// ---------------------------------------------------------------------------

export interface MergeHost {
    /** The type whose entity hosts the merge. */
    hostTypeId: SupportTypeId;
    hostId: string;
    tipPos: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// Leaf cone triangle collision
// ---------------------------------------------------------------------------

const _leafRaycaster = new THREE.Raycaster();

/** Check whether a leaf cone from `knotPos` to `cone` intersects the model.
 *  Raycasts from the knot toward a point just before the tip (offset inward
 *  along the surface normal), excluding the tip contact itself.  Returns true
 *  if the ray hits a model triangle before reaching the offset point. */
function contactConeCollides(
    knotPos: { x: number; y: number; z: number },
    cone: { pos: { x: number; y: number; z: number }; surfaceNormal?: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } },
    mesh: THREE.Mesh,
): boolean {
    // Ray from knot toward tip. The tip is ON the surface — the first
    // hit should be the tip surface at ~totalDist.  If the first hit
    // is significantly closer, there's geometry between shaft and tip.
    const dx = cone.pos.x - knotPos.x;
    const dy = cone.pos.y - knotPos.y;
    const dz = cone.pos.z - knotPos.z;
    const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (totalDist < 0.01) return false;
    const dir = new THREE.Vector3(dx / totalDist, dy / totalDist, dz / totalDist);

    // Cast two offset rays to account for cone thickness (~0.25mm).
    const n = cone.surfaceNormal ?? cone.normal;
    const perpX = dir.y * n.z - dir.z * n.y;
    const perpY = dir.z * n.x - dir.x * n.z;
    const perpZ = dir.x * n.y - dir.y * n.x;
    const perpLen = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
    const offsets = perpLen > 0.001
        ? [0, 0.25, -0.25]
        : [0];

    for (const off of offsets) {
        const sx = knotPos.x + (perpX / perpLen) * off;
        const sy = knotPos.y + (perpY / perpLen) * off;
        const sz = knotPos.z + (perpZ / perpLen) * off;
        _leafRaycaster.set(new THREE.Vector3(sx, sy, sz), dir);
        const hits = _leafRaycaster.intersectObject(mesh, false);
        if (hits.length > 0 && hits[0].distance < totalDist - 0.5) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Post-build collision verification
// ---------------------------------------------------------------------------

/** Check all segments of a built branch against the SDF. */
function branchCollidesWithSDF(
    branch: { segments: Array<{ bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null; diameter?: number }> },
    mesh: THREE.Mesh,
): boolean {
    for (const seg of branch.segments) {
        const start = seg.bottomJoint?.pos;
        const end = seg.topJoint?.pos;
        if (start && end) {
            const r = (seg.diameter ?? 1.0) / 2;
            if (isShaftBlocked(start, end, r, mesh)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Attachment capacity
// ---------------------------------------------------------------------------

/**
 * Count how many knots (branches + leaves) ride the host's shaft.
 * Does NOT count brace knots (they ride their type's declared span prefix).
 */
function countAttachmentsOnHost(
    hostTypeId: SupportTypeId,
    hostId: string,
    draft: SupportState,
): number {
    const snapshot = draft;
    const host = hostEntityOf(snapshot, hostTypeId, hostId);
    if (!host) return 0;

    const segmentIds = new Set(host.segments.map(s => s.id));
    // Also match legacy knots that reference the entity id directly.
    segmentIds.add(hostId);

    let count = 0;
    for (const knot of Object.values(snapshot.knots)) {
        if (segmentIds.has(knot.parentShaftId)) {
            count++;
        }
    }
    return count;
}

/** Longest hosted member span (mm) on a host — knot→tip over its leaves
 *  and branches. Dumas-style load-concentration signal: merging onto a
 *  host that already carries long members concentrates peel load on one
 *  plate anchor. Zero when the host carries nothing. */
function maxMemberSpanMm(
    hostTypeId: SupportTypeId,
    hostId: string,
    draft: SupportState,
): number {
    const host = hostEntityOf(draft, hostTypeId, hostId);
    if (!host) return 0;
    const segmentIds = new Set(host.segments.map((s) => s.id));
    segmentIds.add(hostId);
    const knotById = new Map<string, { x: number; y: number; z: number }>();
    for (const knot of Object.values(draft.knots)) {
        if (segmentIds.has(knot.parentShaftId)) knotById.set(knot.id, knot.pos);
    }
    if (knotById.size === 0) return 0;
    let longest = 0;
    // The members come off `SHAFT_HOSTED_MEMBER_TYPES`, as elsewhere in this file.
    for (const { collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const collection = draft[collectionKey] as unknown as
            | Record<string, { parentKnotId?: string; contactCone?: { pos: { x: number; y: number; z: number } } }>
            | undefined;
        for (const member of Object.values(collection ?? {})) {
            const knotPos = member.parentKnotId ? knotById.get(member.parentKnotId) : undefined;
            const tip = member.contactCone?.pos;
            if (!knotPos || !tip) continue;
            const span = Math.sqrt(
                (tip.x - knotPos.x) ** 2 + (tip.y - knotPos.y) ** 2 + (tip.z - knotPos.z) ** 2,
            );
            if (span > longest) longest = span;
        }
    }
    return longest;
}

/** Returns true if the host has reached its attachment capacity. */
function isHostAtAttachmentCapacity(
    hostTypeId: SupportTypeId,
    hostId: string,
    limit: number,
    draft: SupportState,
): boolean {
    if (limit <= 0) return false;
    return countAttachmentsOnHost(hostTypeId, hostId, draft) >= limit;
}

// ---------------------------------------------------------------------------
// Nearby-trunk merge
// ---------------------------------------------------------------------------

/** Find the closest existing host (shaft or tip) within merge radius.
 *  Stump-origin entities never host merges: they are load-bearing standalone
 *  pillars, leaves are not. */
export function findMergeHost(
    tipPos: { x: number; y: number; z: number },
    modelId: string,
    draft: SupportState,
): MergeHost | null {
    const snapshot = draft;
    const r2 = GRIDLESS_MERGE_RADIUS_MM * GRIDLESS_MERGE_RADIUS_MM;
    let best: MergeHost | null = null;
    let bestScore = Infinity;
    // Dumas-style gain ranking: among in-radius hosts, nearer wins, but a
    // host already carrying long members is penalized (merging there
    // concentrates peel load on one plate anchor). With no hosted members
    // the penalty is zero and ranking reduces to nearest-first.
    const loadOf = new Map<string, number>();
    const scoreFor = (hostTypeId: SupportTypeId, hostId: string, adjustedD2: number): number => {
        const key = `${hostTypeId}:${hostId}`;
        let lmax = loadOf.get(key);
        if (lmax === undefined) {
            lmax = maxMemberSpanMm(hostTypeId, hostId, snapshot);
            loadOf.set(key, lmax);
        }
        return Math.sqrt(Math.max(0, adjustedD2)) + MERGE_HOST_LOAD_WEIGHT * lmax;
    };

    for (const { hostTypeId, hostId, entity } of collectHostEntities(snapshot)) {
        if (entity.modelId !== modelId) continue;
        if (entity.origin === NEAR_PLATE_ORIGIN) continue;

        // Check the host's tip (contact cone).
        const tp = entity.contactCone?.pos;
        if (tp) {
            const dx = tipPos.x - tp.x;
            const dy = tipPos.y - tp.y;
            const dz = tipPos.z - tp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) {
                const score = scoreFor(hostTypeId, hostId, d2);
                if (score < bestScore) {
                    bestScore = score;
                    best = { hostTypeId, hostId, tipPos: tp };
                }
            }
        }

        // Also check segment joints (shaft body), preferring lower attachment.
        for (const seg of entity.segments) {
            const jp = seg.bottomJoint?.pos ?? seg.topJoint?.pos;
            if (!jp) continue;
            const dx = tipPos.x - jp.x;
            const dy = tipPos.y - jp.y;
            const dz = tipPos.z - jp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            const adjustedD2 = d2 * 0.9;
            if (adjustedD2 > r2) continue;
            const score = scoreFor(hostTypeId, hostId, adjustedD2);
            if (score < bestScore) {
                bestScore = score;
                best = { hostTypeId, hostId, tipPos: jp };
            }
        }
    }
    return best;
}

/** Consolidation fallback: when the straight fan leaf is blocked by the
 *  model (or another support), attach the standalone trunk to the steepest
 *  eligible host sample as a ROUTED BRANCH — its shaft and cone
 *  re-placement can go around an obstruction a straight cone cannot. */
export function buildConsolidationBranch(args: {
    tip: { x: number; y: number; z: number };
    tipNormal: { x: number; y: number; z: number };
    modelId: string;
    pool: FanShaftPoint[];
    pruned: SupportState;
    mesh: THREE.Mesh | undefined;
    radiusMm: number;
    maxAttachments: number;
    knotId: string;
}): { draft: SupportState; branchId: string; kind: AttachmentKind } | null {
    const { tip, tipNormal, modelId, pool, pruned, mesh, radiusMm, maxAttachments, knotId } = args;

    // Steepest eligible host sample (≤ the branch-angle rule from vertical —
    // the leaf fan's cap is looser). Steepest, not nearest: the contact cone
    // is clamped to the surface normal, so the shaft loses its last couple of
    // millimeters of rise to the cone bend and a link picked at the angle cap
    // always leaves the host a few degrees too flat. Reaching further down the
    // shaft buys that rise back; the angle cap keeps the link short anyway.
    let best: FanShaftPoint | null = null;
    let bestAngleDeg = Infinity;
    for (const sp of pool) {
        // Same rule as the leaf fan: only this model's shafts can host.
        if (hostEntityOf(pruned, sp.hostTypeId, sp.hostId)?.modelId !== modelId) continue;
        const ddx = sp.pos.x - tip.x;
        const ddy = sp.pos.y - tip.y;
        const ddz = sp.pos.z - tip.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz > radiusMm * radiusMm) continue;
        const vDist = tip.z - sp.pos.z;
        if (vDist < 1.5) continue;
        const angleDeg = (Math.atan2(Math.hypot(ddx, ddy), vDist) * 180) / Math.PI;
        if (angleDeg > Math.min(50, memberMaxAngleFromVerticalDeg())) continue;
        if (angleDeg < bestAngleDeg) {
            bestAngleDeg = angleDeg;
            best = sp;
        }
    }
    if (!best) return null;
    if (maxAttachments > 0 && isHostAtAttachmentCapacity(best.hostTypeId, best.hostId, maxAttachments, pruned)) return null;

    const parentKnot = {
        id: freeKnotId(pruned, knotId),
        parentShaftId: best.segmentId ?? best.hostId,
        t: best.t,
        pos: best.pos,
        diameter: best.diameter + 0.125,
    };

    try {
        const band = activeSizingBand();
        const { branch, supportData: sd } = buildBranchData({
            tipPos: tip,
            tipNormal,
            modelId,
            parentKnot,
            mesh,
            shaftDiameterMm: band.shaftDiameterMm,
            tipContactDiameterMm: band.tipContactDiameterMm,
            rootsDiameterMm: band.rootDiameterMm,
        });
        if (sd.error) return null;
        if (mesh && branchCollidesWithSDF(branch, mesh)) return null;
        if (branchDepartureAngleDeg(branch, parentKnot.pos) > memberMaxAngleFromVerticalDeg()) return null;
        if (leafPathCrossesSupports(parentKnot.pos, branch.contactCone?.pos ?? tip, 0.25, pruned, best.hostId)) return null;

        let d = draftAddPrimitive(pruned, 'knots', parentKnot);
        branch.origin = 'overhang';
        const memberTypeId = builtMemberTypeId(branch);
        d = draftAddEntity(d, memberTypeId, branch);
        return { draft: d, branchId: branch.id, kind: memberTypeId };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Phase labels for the run's own timing breakdown. The `auto:` prefix keeps
 * them apart from the inner placement measurements the perf module already
 * collects, so one frame carries both the coarse breakdown and the detail.
 */
const TIMING_PREFIX = 'auto:';

/** Start timing one of the run's phases. */
function timingStart(phase: string): void {
    perfMark(TIMING_PREFIX + phase);
}

/** End timing one of the run's phases. */
function timingEnd(phase: string): void {
    perfMeasure(TIMING_PREFIX + phase, TIMING_PREFIX + phase);
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 1234567 -> "1.2M", 45000 -> "45k". */
const compactCount = (value: number): string => (
    value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(0)}k` : String(value)
);

/**
 * Turn the perf frame into the run's timing summary. Coarse phases keep their
 * order; the inner labels are summed and sorted by cost, because the question
 * they answer is "what should I look at first".
 */
function collectTimings(frame: PerfFrame | null): AutoPlaceTimings | null {
    if (!frame) return null;

    const phases: AutoPlaceTimings['phases'] = [];
    const detailTotals = new Map<string, { durationMs: number; calls: number }>();
    for (const phase of frame.phases) {
        if (phase.label.startsWith(TIMING_PREFIX)) {
            phases.push({ label: phase.label.slice(TIMING_PREFIX.length), durationMs: round1(phase.durationMs) });
            continue;
        }
        const entry = detailTotals.get(phase.label) ?? { durationMs: 0, calls: 0 };
        entry.durationMs += phase.durationMs;
        entry.calls += 1;
        detailTotals.set(phase.label, entry);
    }

    return {
        totalMs: round1(frame.totalMs),
        phases,
        detail: [...detailTotals]
            .map(([label, entry]) => ({ label, durationMs: round1(entry.durationMs), calls: entry.calls }))
            .sort((a, b) => b.durationMs - a.durationMs),
        // Inner operations only. The coarse phases are tens to hundreds of
        // milliseconds by nature and would every one of them trip the perf
        // module's default threshold, which is a spike detector for the inner
        // work; the summary line is their report.
        spikes: frame.spikes
            .filter((spike) => !spike.phase.startsWith(TIMING_PREFIX))
            .map((spike) => ({
                label: spike.phase,
                durationMs: round1(spike.durationMs),
                thresholdMs: spike.thresholdMs,
            })),
    };
}

/**
 * One line per run, plus a detail line when the perf module measured anything
 * inside it. Greppable as `[AutoSupport] Timing:` in `dragonfruit.log`.
 *
 * Exported because the worker's own logs do not reach the log bridge: the client
 * prints the timing the worker returned, with this same formatter.
 */
export function logAutoPlaceTimings(timings: AutoPlaceTimings | null | undefined): void {
    if (!timings) return;
    const phases = timings.phases
        .map((phase) => `${phase.label} ${phase.durationMs.toFixed(0)}ms`)
        .join(' · ');
    console.log(LOG_PREFIX, `Timing: ${timings.totalMs.toFixed(0)}ms total — ${phases}`);

    if (timings.detail.length > 0) {
        const detail = timings.detail
            .slice(0, 8)
            .map((entry) => `${entry.label} ${entry.durationMs.toFixed(0)}ms/${entry.calls}x`)
            .join(' · ');
        console.log(LOG_PREFIX, `Timing detail: ${detail}`);
    }
    if (timings.router) {
        const router = timings.router;
        const per = (value: number) => (value / Math.max(1, router.placements)).toFixed(1);
        console.log(LOG_PREFIX,
            `Timing router: ${router.placements} placements · per placement ` +
            `${per(router.conesTested)} cones (${per(router.coneGates)} gated) · ` +
            `${per(router.jointSearches)} joint searches (${per(router.jointProbes)} probes) · ` +
            `${per(router.rootsChecks)} roots checks (${per(router.rootsSamples)} samples) · ` +
            `${per(router.baseCandidates)} base candidates` +
            (Object.keys(router.jointOutcomes).length > 0
                ? ` — joint searches: ${Object.entries(router.jointOutcomes)
                    .sort((a, b) => b[1] - a[1])
                    .map(([outcome, count]) => `${outcome} ${count}`)
                    .join(' · ')}`
                : '') +
            (router.foundProbeBuckets.some((count) => count > 0)
                ? ` — found within: ${router.foundProbeBuckets
                    .map((count, index) => (count > 0 ? `≤${64 << index} probes ${count}` : null))
                    .filter(Boolean)
                    .join(' · ')}` +
                (router.maxFoundProbes > 0 ? ` (worst success ${router.maxFoundProbes} probes)` : '')
                : ''));
    }
    if (timings.sdf) {
        console.log(LOG_PREFIX,
            `Timing field: ${compactCount(timings.sdf.cellReads)} cell reads · ` +
            `${compactCount(timings.sdf.bvhQueries)} BVH queries · ` +
            `${compactCount(timings.sdf.cachedCells)} cells cached` +
            (timings.sdf.store ? ` (${timings.sdf.store})` : ''));
    }
    if (timings.spikes.length > 0) {
        // Summarized, not listed: a big model produces hundreds of these and the
        // list buries the lines above it. The distribution is the signal.
        const worst = timings.spikes.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
        const durations = timings.spikes.map((spike) => spike.durationMs).sort((a, b) => a - b);
        const median = durations[Math.floor(durations.length / 2)];
        const top = [...timings.spikes]
            .sort((a, b) => b.durationMs - a.durationMs)
            .slice(0, 5)
            .map((spike) => `${spike.label} ${spike.durationMs.toFixed(0)}ms`);
        console.warn(LOG_PREFIX,
            `Timing spikes: ${timings.spikes.length} over threshold — worst ${worst.label} ` +
            `${worst.durationMs.toFixed(0)}ms (threshold ${worst.thresholdMs}ms), median ${median.toFixed(0)}ms · ` +
            `top: ${top.join(' · ')}`);
    }
}

/**
 * Run a single candidate through the standard placement pipeline:
 * resolve surface normal → buildTrunkData → decideGridPlacement → commit.
 *
 * When grid mode is disabled, we additionally check whether another
 * trunk already sits within {@link GRIDLESS_MERGE_RADIUS_MM} of this
 * candidate's tip.  If so, the candidate is routed as a branch off
 * that host instead of becoming a standalone trunk — preventing
 * clusters of near-identical vertical supports at the same XY.
 *
 * This is the same sequence used by manual placement clicks.
 * Returns the decision kind so the orchestrator can tally.
 */
function placeOneCandidate(
    candidate: CandidatePoint,
    draft: SupportState,
    _settingsOverride: Partial<AutoSupportSettings> | undefined,
    gridHostIds?: ReadonlySet<string>,
    mesh?: THREE.Mesh,
): { kind: PlacementOutcomeKind; draft: SupportState; rejectedReason?: RejectReason; preset?: 'detail' | 'structure' | 'anchor'; entityId?: string; stickCount?: number; fanRefusal?: FanLeafRefusal; mergeRefusal?: 'noHost' | 'rejected'; cavityFanRefusal?: string } {
    const supportSettings = getSettings();
    const snapshot = draft;
    let d = draft;

    // Grid points carry the region's exact surface position and normal (from
    // the classifier's own triangles, world space). Re-resolving via a
    // whole-mesh raycast hits the wrong face on sloped geometry (side walls
    // below the region face at the same XY), so trust the region data.
    const resolved = candidate.gridPoint && candidate.tipNormal && candidate.tipNormal.z < 0
        ? { point: candidate.tipPos, normal: candidate.tipNormal }
        : resolveSurfaceNormal(candidate.tipPos, mesh);
    const tipPos = resolved.point;
    const tipNormal = resolved.normal;

    // Determine preset band for analytics + empirical sizing.
    const area = candidate.islandAreaMm2;
    const preset = presetForArea(area);

    // The fan pool is a walk of every host segment with its 10 samples, and
    // this function asks for it up to three times (island fan, overhang fan,
    // cavity fan) against an unchanged draft. Build it once, lazily — each
    // attempt returns as soon as it succeeds, so nothing mutates in between.
    let fanPool: FanShaftPoint[] | null = null;
    const fanShaftPoints = (): FanShaftPoint[] => (fanPool ??= collectFanShaftPoints(draft));

    // ── Gridless merge check ──────────────────────────────────────
    // Density-grid points force standalone trunks (a flat region needs
    // independent supports, not a bush of branches off one shaft).
    let mergeHostFound = false;
    let fanRefusal: FanLeafRefusal | undefined;
    if (!supportSettings.grid?.enabled) {
        // Grid/poisson points fan into ISLAND trunks only (hosts not placed
        // from gridPoint candidates). Only ORGANIC Poisson + coverage-fill
        // points — flat-lattice grid infill and the anchor band stay
        // standalone (peel distribution). A pillar standing next to an island
        // trunk attaches as a leaf instead of duplicating it; grid points
        // never attach to other grid trunks.
        if (candidate.gridPoint && candidate.source === 'overhang' && gridHostIds
            && !candidate.id.startsWith('grid-')) {
            const auto = supportSettings.autoSupport ?? {};
            const islandPool = fanShaftPoints()
                .filter((sp) => !gridHostIds.has(sp.hostId));
            if (islandPool.length > 0) {
                const fan = fanLeafToHost(
                    tipPos,
                    candidate.modelId,
                    islandPool,
                    new Set(),
                    `auto-fan-${candidate.id}`,
                    Math.max(MIN_LEAF_FAN_RADIUS_MM, auto.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                    GRID_HOST_FAN_RADIUS_MM,
                    Math.min(auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG, memberMaxAngleFromVerticalDeg()),
                    auto.maxAttachmentsPerTrunk ?? 12,
                    draft,
                    mesh,
                    'overhang',
                );
                if (fan.ok) {
                    logPlacement(
                        `${typeWord(fan.kind)} (grid→island) ${candidate.id} → ${typeWord(fan.hostTypeId).toLowerCase()} ${fan.hostId} ` +
                        `dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                    return { kind: fan.kind, preset, draft: fan.draft, entityId: fan.entityId };
                }
            }
        }
    }
    if (!supportSettings.grid?.enabled && !candidate.gridPoint && candidate.source !== 'stabilization') {
        // Overhang-derived candidates (sub-threshold, non-anchor regions)
        // attach via the regular leaf-fanning path — a standalone straight
        // trunk next to fan leaves reads as a misplaced island support. No
        // host in fan range → fall through to the merge/trunk fallbacks.
        if (candidate.source === 'overhang' && gridHostIds) {
            const auto = supportSettings.autoSupport ?? {};
            const fan = fanLeafToHost(
                tipPos,
                candidate.modelId,
                fanShaftPoints(),
                gridHostIds,
                `auto-fan-${candidate.id}`,
                Math.max(MIN_LEAF_FAN_RADIUS_MM, auto.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                GRID_HOST_FAN_RADIUS_MM,
                Math.min(auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG, memberMaxAngleFromVerticalDeg()),
                auto.maxAttachmentsPerTrunk ?? 12,
                draft,
                mesh,
                'overhang',
            );
            if (fan.ok) {
                logPlacement(
                    `${typeWord(fan.kind)} (fan merge) ${candidate.id} → ${typeWord(fan.hostTypeId).toLowerCase()} ${fan.hostId} ` +
                    `dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                return { kind: fan.kind, preset, draft: fan.draft, entityId: fan.entityId };
            }
            fanRefusal = fan.reason;
        }
        let host = findMergeHost(tipPos, candidate.modelId, draft);
        // Island candidates never merge INTO grid trunks: at a junction the
        // island trunk should HOST the grid (the grid pillars convert to fan
        // leaves on it in the consolidation pass), not the reverse — a pillar
        // with a leaf still reads as a pillar.
        if (host && gridHostIds?.has(host.hostId)) {
            host = null;
        }
        if (host) {
            mergeHostFound = true;
            // Find the best attachment point on the host trunk's shaft,
            // below the candidate's tip.  This matches the W-key sprout
            // behaviour: leaves/branches fan from the shaft body, not
            // from the contact tip.
            const hostEntity = hostEntityOf(snapshot, host.hostTypeId, host.hostId);
            let bestKnotPos: { x: number; y: number; z: number } | null = null;
            let bestKnotSegmentId = '';
            let bestKnotT = 0;

            // Attachment point: snap the knot DOWN the host shaft only far
            // enough to reach the 45°-above-horizontal steep minimum — the
            // HIGHEST sample whose rise to the tip is ≥ 45°. A deeper knot
            // makes the leaf nearly parallel to the shaft (a second pillar
            // "floating" next to the trunk — the recent defect); a knot at
            // the junction is the original shallow-branch bug. 45° matches
            // the relaxed leafFanMaxAngleDeg default (was 60°).
            const STEEP_MIN_RISE_DEG = Math.max(
                45,
                90 - memberMaxAngleFromVerticalDeg(),
            );
            const MAX_MERGE_ATTACH_SPAN_MM = 12;
            let maxRiseDeg = 0;
            if (hostEntity) {
                for (const seg of hostEntity.segments) {
                    // The SAME span the drift check measures against — a knot
                    // placed on any other line is culled as an orphan.
                    const span = hostSegmentSpan(snapshot, hostEntity, seg);
                    if (!span) continue;
                    const { start, end } = span;
                    for (let i = 0; i <= 10; i++) {
                        const t = i / 10;
                        const sx = start.x + (end.x - start.x) * t;
                        const sy = start.y + (end.y - start.y) * t;
                        const sz = start.z + (end.z - start.z) * t;
                        const vDist = tipPos.z - sz;
                        if (vDist <= 0) continue;
                        const hDist = Math.hypot(tipPos.x - sx, tipPos.y - sy);
                        if (Math.hypot(hDist, vDist) > MAX_MERGE_ATTACH_SPAN_MM) continue;
                        const riseDeg = (Math.atan2(vDist, hDist) * 180) / Math.PI;
                        if (riseDeg > maxRiseDeg) maxRiseDeg = riseDeg;
                        if (riseDeg < STEEP_MIN_RISE_DEG) continue;
                        if (bestKnotPos === null || sz > bestKnotPos.z) {
                            bestKnotPos = { x: sx, y: sy, z: sz };
                            bestKnotSegmentId = seg.id;
                            bestKnotT = t;
                        }
                    }
                }
            }
            if (!bestKnotPos) {
                logPlacement(
                    `Merge skip ${candidate.id}: no steep attachment on host ${host.hostId} ` +
                    `(max rise ${maxRiseDeg.toFixed(0)}° < ${STEEP_MIN_RISE_DEG}° above horizontal)`);
            } else {
                const knotPos = bestKnotPos;
                let knotDiameter = 1.0;
                if (hostEntity && bestKnotSegmentId) {
                    const seg = hostEntity.segments.find(s => s.id === bestKnotSegmentId);
                    if (seg?.diameter) knotDiameter = seg.diameter;
                }
                const parentKnot = {
                    id: freeKnotId(d, `auto-merge-${candidate.id}`),
                    parentShaftId: bestKnotSegmentId || host.hostId,
                    t: bestKnotT,
                    pos: knotPos,
                    // The knot renders at exactly the trunk-joint size when
                    // unselected: the KnotRenderer subtracts the full joint
                    // offset (0.1), while the JointRenderer subtracts 0.075
                    // from a shaft+0.1 joint — so shaft + 0.125 renders at
                    // shaft + 0.025, the joint's own rendered diameter.
                    diameter: knotDiameter + 0.125,
                };
                // Leaf/branch decision on the ACTUAL span the member will
                // bridge (knot → tip). Tip-to-host-tip understates it when
                // the knot sits low on the shaft — a leaf gated on that
                // built 8–11 mm tapered spikes.
                const leafSpanMm = Math.sqrt(
                    (tipPos.x - knotPos.x) ** 2 +
                    (tipPos.y - knotPos.y) ** 2 +
                    (tipPos.z - knotPos.z) ** 2,
                );
                if (leafSpanMm <= MAX_LEAF_SPAN_BEFORE_BRANCH_MM) {
                    // Knot attachment is on the shaft; angle check uses the
                    // actual knot-to-tip geometry for the leaf cone.
                    const hDist = Math.sqrt(
                        (tipPos.x - knotPos.x) ** 2 + (tipPos.y - knotPos.y) ** 2,
                    );
                    const vDist = tipPos.z - knotPos.z;
                    if (vDist <= 0) {
                        logPlacement(
                            `Merge skip ${candidate.id}: knot above tip (kZ=${knotPos.z.toFixed(1)} tZ=${tipPos.z.toFixed(1)})`);
                    } else if (vDist < 1.5) {
                        // Too shallow — fall through to branch.
                        logPlacement(
                            `Leaf (merge) ${candidate.id}: too shallow (vDist=${vDist.toFixed(1)}mm), trying branch...`);
                    } else {
                        try {
                            const { leaf, supportData: sd } = buildLeafData({
                                tipPos,
                                surfaceNormal: tipNormal,
                                modelId: candidate.modelId,
                                parentKnot,
                                // Cone body = the HOST shaft, not the knot —
                                // otherwise the cone's wide base swallows the
                                // junction ball and the knot stays invisible.
                                hostDiameterMm: knotDiameter,
                                tipContactDiameterMm: activeSizingBand().tipContactDiameterMm,
                                mesh,
                            });
                            if (sd.error) {
                                logPlacement(
                                    `Leaf (merge) ${candidate.id}: sd.error, trying branch...`);
                            } else if (mesh && contactConeCollides(parentKnot.pos, leaf.contactCone, mesh)) {
                                logPlacement(
                                    `Leaf (merge) ${candidate.id}: triangle collision, trying branch...`);
                            } else {
                                const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                                if (isHostAtAttachmentCapacity(host.hostTypeId, host.hostId, cap, draft)) {
                                    logPlacement(
                                        `Merge skip ${candidate.id}: host ${host.hostId} at capacity (${cap} attachments)`);
                                    // fall through to standalone trunk
                                } else {
                                    d = draftAddPrimitive(d, 'knots', parentKnot);
                                    leaf.origin = candidate.source === 'overhang' ? 'overhang' : 'island';
                                    const memberTypeId = builtMemberTypeId(leaf);
                                    d = draftAddEntity(d, memberTypeId, leaf);
                                    const la = (Math.atan2(hDist, vDist) * 180) / Math.PI;
                                    logPlacement(
                                        `Leaf (merge) ${candidate.id} → ${typeWord(host.hostTypeId).toLowerCase()} ${host.hostId} ` +
                                        `span=${leafSpanMm.toFixed(1)}mm angle=${la.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                                    return { kind: memberTypeId, preset, draft: d, entityId: leaf.id };
                                }
                            }
                        } catch {}
                    }
                } else if (leafSpanMm > MAX_LEAF_SPAN_BEFORE_BRANCH_MM) {
                    // Branch: requires upward angle from knot to tip. Every origin
                    // branches here, overhang included: a leaf is a seg-less
                    // tapered cone, so past MAX_LEAF_SPAN_BEFORE_BRANCH_MM it is a
                    // spindly spike standing next to its trunk rather than a
                    // support — an 11.6mm one came out of this merge path.
                    // `buildConsolidationBranch` has always built overhang-origin
                    // branches, so there is nothing overhang-specific about it.
                    const hDist2 = Math.sqrt(
                        (tipPos.x - knotPos.x) ** 2 + (tipPos.y - knotPos.y) ** 2,
                    );
                    const vDist2 = tipPos.z - knotPos.z;
                    const mergeAngleDeg = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                    if (mergeAngleDeg > Math.min(50, memberMaxAngleFromVerticalDeg())) {
                        logPlacement(
                            `Merge skip ${candidate.id}: angle too shallow (${mergeAngleDeg.toFixed(0)}° from vertical > 50°) span=${leafSpanMm.toFixed(1)}mm`);
                    } else try {
                        const band = activeSizingBand();
                        const { branch, supportData: sd } = buildBranchData({
                            tipPos, tipNormal, modelId: candidate.modelId, parentKnot, mesh,
                            shaftDiameterMm: band.shaftDiameterMm,
                            tipContactDiameterMm: band.tipContactDiameterMm,
                            rootsDiameterMm: band.rootDiameterMm,
                        });
                        const collides = sd.error || (mesh && branchCollidesWithSDF(branch, mesh));
                        if (collides) {
                            logPlacement(`Branch (merge) ${candidate.id}: collision, falling back`);
                        } else if (branchDepartureAngleDeg(branch, knotPos) > memberMaxAngleFromVerticalDeg()) {
                            logPlacement(
                                `Merge skip ${candidate.id}: shaft leaves the host too flat ` +
                                `(${branchDepartureAngleDeg(branch, knotPos).toFixed(0)}° from vertical) span=${leafSpanMm.toFixed(1)}mm`);
                        } else {
                            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                            if (isHostAtAttachmentCapacity(host.hostTypeId, host.hostId, cap, draft)) {
                                logPlacement(
                                    `Merge skip ${candidate.id}: host ${host.hostId} at capacity (${cap} attachments)`);
                                // fall through to standalone trunk
                            } else {
                                d = draftAddPrimitive(d, 'knots', parentKnot);
                                branch.origin = candidate.source === 'overhang' ? 'overhang' : 'island';
                                const memberTypeId = builtMemberTypeId(branch);
                                d = draftAddEntity(d, memberTypeId, branch);
                                const ma = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                                logPlacement(
                                    `Branch (merge) ${candidate.id} → ${typeWord(host.hostTypeId).toLowerCase()} ${host.hostId} ` +
                                    `span=${leafSpanMm.toFixed(1)}mm angle=${ma.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                                return { kind: memberTypeId, preset, draft: d, entityId: branch.id };
                            }
                        }
                    } catch (e) {
                        logPlacement(
                            `Merge branch failed for ${candidate.id}, falling back to trunk: ` +
                            `${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
        }
    }

    // Empirical sizing: the candidate's own island area drives the tail over
    // the active profile band. No merge-radius cluster summing — dense
    // regions would double-count the same area onto every trunk.
    const overrides = sizeParameters(
        candidate,
        supportSettings.autoSupport?.sizeScale ?? 1,
    );
    const isSmallIsland = (candidate.source !== 'overhang' && (candidate.islandAreaMm2 ?? 0) < 5) || candidate.zHeight < 15;
    const trunkResult = buildTrunkData({
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
        overrides,
        isPreview: false,
        isSmallIsland,
    });
    if (trunkResult.error) {
        // Cavity fallback: if the trunk can't reach the build plate, try
        // bridging to a lower surface with a Stick (model-to-model).
        if (trunkResult.error === 'COLLISION_WITH_MODEL' && mesh) {
            // Before bridging model-to-model, try to carry the tip as a fan
            // leaf on a nearby host. A jaw tip whose straight pillar pierces
            // the chest often has a trunk within 5 mm that can host it — that
            // reads as a regular tree, not a "stick under the jaw". The trunk
            // build's COLLISION_WITH_MODEL means "no plate route found", not
            // "nowhere to attach".
            let cavityFanRefusal: string | undefined;
            try {
                const auto = getSettings().autoSupport ?? {};
                const fan = fanLeafToHost(
                    tipPos,
                    candidate.modelId,
                    fanShaftPoints(),
                    gridHostIds ?? new Set<string>(),
                    `auto-cavity-fan-${candidate.id}`,
                    // The widest search in the pipeline, and the same for a grid
                    // host: the alternative to carrying this tip is a
                    // model-to-model bridge, which leaves a second scar on the
                    // model, and the grid forest's 2.5 mm limit is there to keep
                    // ordinary fan leaves off it, not to strand a cavity tip.
                    CAVITY_FAN_RADIUS_MM,
                    CAVITY_FAN_RADIUS_MM,
                    Math.min(auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG, memberMaxAngleFromVerticalDeg()),
                    auto.maxAttachmentsPerTrunk ?? 12,
                    draft,
                    mesh,
                    candidate.source as SupportOrigin | undefined,
                    'steepest',
                    Number.POSITIVE_INFINITY,
                );
                if (fan.ok) {
                    const fanKind = typeWord(fan.kind);
                    logPlacement(`${fanKind} (cavity-fan) ${candidate.id} → ${typeWord(fan.hostTypeId).toLowerCase()} ${fan.hostId} dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                    return { kind: fan.kind, preset, draft: fan.draft, entityId: fan.entityId };
                }
                // Carry the numbers: `noHost` cannot say whether there was no
                // host at all or only a far one, and that decides whether the
                // reach is the lever or the angle gate is.
                const nearest = fan.nearestHostMm;
                const steep = fan.nearestSteepMm;
                cavityFanRefusal = nearest === undefined
                    ? fan.reason
                    : `${fan.reason} (nearest ${nearest.toFixed(1)}mm plan${
                        steep === undefined
                            ? ', no legal host'
                            : `, nearest legal ${steep.toFixed(1)}mm @ ${(fan.steepAngleDeg ?? 0).toFixed(0)}°`
                    })`;
            } catch {}
            const band = activeSizingBand();
            const cavityResult = buildCavityBridge(tipPos, tipNormal, candidate.modelId, mesh, band);
            if (cavityResult) {
                // Keep short cavity twigs but cap long bridges at 12mm; a
                // rejected tip is reconsidered by fan/merge in a later pass.
                // BUG (see docs/dev/support-registry-findings.md): the cap measures
                // from `upper`, which the builder sorts to the tip, so the span
                // is always ~0 and the cap has never rejected anything.
                const entity = cavityResult.entity;
                const upperField = contactEndpointsFor(cavityResult.kind)
                    .find(({ end }) => end === 'upper')?.field;
                const lower = upperField
                    ? (entity as unknown as Record<string, { pos?: Vec3 } | undefined>)[upperField]?.pos
                    : undefined;
                const bridgeLen = lower
                    ? Math.hypot(tipPos.x - lower.x, tipPos.y - lower.y, tipPos.z - lower.z)
                    : null;

                if (bridgeLen !== null && bridgeLen > MAX_CAVITY_BRIDGE_MM) {
                    logPlacement(`Cavity ${cavityResult.kind} rejected (bridge ${bridgeLen.toFixed(1)}mm > ${MAX_CAVITY_BRIDGE_MM}mm) ${candidate.id}`);
                    // fall through to rejected trunk path below
                } else {
                    d = draftAddEntity(d, cavityResult.kind, entity);
                    logPlacement(`${cavityResult.kind} (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                    return { kind: cavityResult.kind, preset, draft: d, entityId: entity.id, cavityFanRefusal };
                }
            }
        }
        const bbox = mesh ? new THREE.Box3().setFromObject(mesh) : null;
        logPlacement(
            `Rejected ${candidate.id}: trunk build error \"${trunkResult.error}\" ` +
            `tip=(${tipPos.x.toFixed(1)},${tipPos.y.toFixed(1)},${tipPos.z.toFixed(1)}) ` +
            `mesh=${mesh ? 'yes' : 'no'} ` +
            `bbox=${bbox ? `(${bbox.min.x.toFixed(0)},${bbox.min.y.toFixed(0)},${bbox.min.z.toFixed(0)})-(${bbox.max.x.toFixed(0)},${bbox.max.y.toFixed(0)},${bbox.max.z.toFixed(0)})` : 'none'}`);
        return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
    }

    // Side-wall guard at placement time: do not build a trunk whose contact
    // points sideways. Previously this was a post-resize cull that orphaned
    // leaves; rejecting at placement prevents the trunk and its leaves from
    // ever being created. Applies to all sources — even minima side-walls at
    // 80.8° are now kept (threshold 85°) while true 90° horizontal cones are
    // rejected.
    {
        const n = trunkResult.trunk.contactCone?.normal ?? trunkResult.trunk.contactCone?.surfaceNormal;
        if (n) {
            const hz = Math.hypot(n.x, n.y);
            const angleDeg = (Math.atan2(hz, Math.max(0.001, Math.abs(n.z))) * 180) / Math.PI;
            const isMinima = candidate.source === 'minima' || candidate.source === 'intersection';
            const threshold = isMinima ? 85 : 75;
            if (angleDeg > threshold) {
                logPlacement(`Rejected ${candidate.id}: side-wall trunk too shallow ${angleDeg.toFixed(1)}° > ${threshold}°`);
                return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
            }
        }
    }

    // Route through the standard grid placement engine.
    // This handles grid snapping, SDF collision checks, host-trunk
    // attachment (branch/leaf), anchor short-circuit, and rejection.
    const decision = decideGridPlacement({
        settings: supportSettings,
        snapshot,
        candidate: trunkResult,
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
    });

    switch (decision.kind) {
        case 'place': {
            // One arm for every type: the collection and the primitives that
            // travel with it are declared on the descriptor.
            const placed = decision.placed;
            const { typeId, supplied, hostedBy } = placed;

            // A hosted support is limited by what its host may carry.
            if (hostedBy) {
                const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                if (isHostAtAttachmentCapacity(hostedBy.typeId, hostedBy.id, cap, draft)) {
                    logPlacement(
                        `Grid skip ${candidate.id}: host ${hostedBy.id} at capacity (${cap})`);
                    return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
                }
            }

            // Whether this type records an origin is declared.
            const entity = { ...placed.entity } as typeof placed.entity & { origin?: SupportOrigin };
            if (getSupportTypeDescriptor(typeId).hasOrigin) {
                entity.origin = candidate.gridPoint
                    ? 'overhang'
                    : (candidate.source === 'overhang' ? 'standalone' : 'island');
            }
            d = draftCommitSupport(d, typeId, entity, supplied);
            logPlacement(
                `${typeWord(typeId)} ${candidate.id} @ grid ${decision.nodeKey} ` +
                `area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm ${preset}` +
                (fanRefusal ? ` fan:${fanRefusal}` : '') +
                (mergeHostFound ? ' merge:rejected' : ''));
            const mergeChecked = !supportSettings.grid?.enabled && !candidate.gridPoint;
            return {
                kind: typeId as PlacementOutcomeKind,
                preset,
                draft: d,
                entityId: entity.id,
                fanRefusal,
                mergeRefusal: mergeChecked ? (mergeHostFound ? 'rejected' : 'noHost') : undefined,
            };
        }

        case 'reject': {
            const reason: RejectReason =
                decision.reason === 'COLLISION_WITH_MODEL' ? 'grid_reject_collision' :
                decision.reason === 'NO_VALID_ATTACHMENT' || decision.reason === 'KNOT_ABOVE_TIP' ? 'grid_reject_no_attachment' :
                'grid_reject_other';
            logPlacement(`Rejected ${candidate.id}: ${decision.reason} (grid ${decision.nodeKey})`);
            return { kind: 'reject', rejectedReason: reason, preset, draft: d };
        }
    }
}

// ---------------------------------------------------------------------------
// runAutoPlace
// ---------------------------------------------------------------------------

/**
 * Run the complete auto-support pipeline using the standard placement engine.
 *
 * Each candidate is individually routed through
 * {@link decideGridPlacement}, the same function used by manual support
 * placement.  This guarantees that SDF collision checks, grid snapping,
 * host-trunk attachment rules, and anchor/branch/leaf auto-selection are
 * identical to the manual workflow.
 *
 * Candidates are processed in priority order (largest / lowest islands
 * first).  Because the state snapshot is refreshed after every commit,
 * later candidates see the supports placed by earlier ones, enabling
 * organic tree fan-out via grid occupancy — a subsequent candidate whose
 * preferred grid node is already occupied will automatically become a
 * branch or leaf of the existing trunk.
 */
/**
 * Compute the full auto-support pipeline against a LOCAL draft — no store
 * commits, no notify() — and return the plan: before/after state pair plus
 * analytics. This is the atomic-commit seam: the caller applies the plan with
 * one `setSnapshot` + `setKickstandSnapshot` + a single history entry, and a
 * later step can run this same function inside a Web Worker.
 *
 * The base states and mesh default to the live stores/model, but can be passed
 * explicitly (worker deserialization); settings are read from the live store.
 *
 * NOTE: placement, gap-fill, fanning, overhang coverage and bracing all work
 * on the local draft, so nothing here commits to the store mid-run; the
 * rollback guard below restores the pre-run snapshot if the run throws.
 */
export type FanShaftPoint = {
    /** The type whose shaft this sample sits on. */
    hostTypeId: SupportTypeId;
    /** That entity's id. */
    hostId: string;
    segmentId?: string;
    t?: number;
    pos: { x: number; y: number; z: number };
    diameter: number;
};

/**
 * Pick the fanning host for an uncovered island.
 *
 * The nearest shaft point wins, but density-grid hosts are offered only up
 * close (tight grid-host radius) — a long leaf from a grid shaft would sweep
 * across the grid forest and puncture sibling grid shafts. When the nearest
 * host is a grid host beyond the tight radius, fall back to the nearest
 * regular host (within the regular fan radius).
 */
export function pickFanHost(
    shaftPoints: FanShaftPoint[],
    gridHostIds: ReadonlySet<string>,
    target: { x: number; y: number; z: number },
    fanRadiusMm: number,
    gridHostFanRadiusMm: number,
): { sp: FanShaftPoint; dist2: number } | null {
    let best: FanShaftPoint | null = null;
    let bestDist2 = Infinity;
    let bestRegular: FanShaftPoint | null = null;
    let bestRegularDist2 = Infinity;

    for (const sp of shaftPoints) {
        const dx = target.x - sp.pos.x;
        const dy = target.y - sp.pos.y;
        const dz = target.z - sp.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist2) { bestDist2 = d2; best = sp; }
        if (!gridHostIds.has(sp.hostId) && d2 < bestRegularDist2) {
            bestRegularDist2 = d2;
            bestRegular = sp;
        }
    }

    if (best && gridHostIds.has(best.hostId) && bestDist2 > gridHostFanRadiusMm * gridHostFanRadiusMm) {
        best = bestRegular;
        bestDist2 = bestRegularDist2;
    }

    if (!best || bestDist2 > fanRadiusMm * fanRadiusMm) return null;
    return { sp: best, dist2: bestDist2 };
}

/** Squared distance between two 3D segments (closest points). */
function segmentDistanceSq(
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number },
    p3: { x: number; y: number; z: number },
    p4: { x: number; y: number; z: number },
): number {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d1z = p2.z - p1.z;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y, d2z = p4.z - p3.z;
    const rx = p1.x - p3.x, ry = p1.y - p3.y, rz = p1.z - p3.z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    let s = 0;
    let t = 0;
    if (a < 1e-9) {
        if (e < 1e-9) { /* both points */ } else { t = clamp01(f / e); }
    } else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e < 1e-9) {
            s = clamp01(-c / a);
        } else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z;
            const denom = a * e - b * b;
            if (denom !== 0) s = clamp01((b * f - c * e) / denom);
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); }
            else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }

    const c1x = p1.x + d1x * s, c1y = p1.y + d1y * s, c1z = p1.z + d1z * s;
    const c2x = p3.x + d2x * t, c2y = p3.y + d2y * t, c2z = p3.z + d2z * t;
    const dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z;
    return dx * dx + dy * dy + dz * dz;
}

/**
 * True when the straight leaf path (knot → tip) passes within the leaf
 * radius + shaft radius of ANY other trunk's shaft. The guarantee that fans
 * never puncture neighboring supports.
 */
export function leafPathCrossesSupports(
    knotPos: { x: number; y: number; z: number },
    tipPos: { x: number; y: number; z: number },
    leafRadiusMm: number,
    draft: SupportState,
    hostId: string | null,
): boolean {
    for (const { hostId: candidateId, entity } of collectHostEntities(draft)) {
        if (candidateId === hostId) continue;
        for (const seg of entity.segments) {
            const start = seg.bottomJoint?.pos;
            const end = seg.topJoint?.pos;
            if (!start || !end) continue;
            const shaftRadius = (seg.diameter ?? 1.0) / 2;
            const clearance = leafRadiusMm + shaftRadius;
            if (segmentDistanceSq(knotPos, tipPos, start, end) < clearance * clearance) return true;
        }
    }
    return false;
}

/** Shaft samples per segment for fanning host picking. */
const SHAFT_SAMPLES_PER_SEGMENT = 10;
/** Max leaf-fanning convergence passes. */
const MAX_FANNING_PASSES = 5;

/**
 * Collect shaft sample points from a snapshot — the fanning host pool.
 *
 * The pool is every collection whose type declares `canBeGridHost`.
 * Stump-origin trunks are excluded: they never host fan leaves.
 *
 * The pool spans EVERY model, so host choosers must filter on `modelId`.
 */
export function collectFanShaftPoints(draft: SupportState): FanShaftPoint[] {
    const shaftPoints: FanShaftPoint[] = [];
    for (const { hostTypeId, hostId, entity } of collectHostEntities(draft)) {
        if (entity.origin === NEAR_PLATE_ORIGIN) continue;
        for (const seg of entity.segments ?? []) {
            // Both joints must exist: a knot attached to a joint-less segment
            // is culled later as missingHost — never offer such a segment.
            const start = seg.bottomJoint?.pos;
            const end = seg.topJoint?.pos;
            if (!start || !end) continue;
            const diameter = seg.diameter ?? 1.0;
            for (let i = 0; i <= SHAFT_SAMPLES_PER_SEGMENT; i++) {
                const t = i / SHAFT_SAMPLES_PER_SEGMENT;
                shaftPoints.push({
                    hostTypeId,
                    hostId,
                    segmentId: seg.id,
                    t,
                    pos: {
                        x: start.x + (end.x - start.x) * t,
                        y: start.y + (end.y - start.y) * t,
                        z: start.z + (end.z - start.z) * t,
                    },
                    diameter,
                });
            }
        }
    }
    return shaftPoints;
}

/**
 * Where a fan attempt attached, and the id of the entity it built there.
 *
 * `entityId` names the place, not the type; the caller indexes by `kind`.
 */
export type FanLeafResult =
    | { ok: true; kind: AttachmentKind; draft: SupportState; hostTypeId: SupportTypeId; hostId: string; entityId: string; distMm: number; angleDeg: number }
    | {
        ok: false;
        reason: FanLeafRefusal;
        /** Plan distance to the closest same-model host sample, whatever it was.
         *  `noHost` alone cannot say whether there was no host or only a far
         *  one, which is the difference between widening the reach and
         *  something else. */
        nearestHostMm?: number;
        /** Plan distance and angle of the closest sample that DID clear the
         *  angle gate: set means a legal host exists but was out of reach,
         *  unset means the angle gate was the binder. */
        nearestSteepMm?: number;
        steepAngleDeg?: number;
    };

/** How a fanning/cluster link picks its host among eligible shaft samples.
 *  `steepest` (placement fanning) reads as a real branch; `nearest` (chunk
 *  consolidation) keeps the link local instead of reaching for the tallest
 *  pillar in range. */
export type FanHostOrder = 'steepest' | 'nearest';

// ---------------------------------------------------------------------------
// Fanning orphan detection & legacy rehost
// ---------------------------------------------------------------------------

function pointToSegmentDistanceSq(
    p: { x: number; y: number; z: number },
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
): number {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-9) return apx * apx + apy * apy + apz * apz;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2));
    const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    return dx * dx + dy * dy + dz * dz;
}

/**
 * The world-space span of a trunk segment — the line a hosted member's knot has
 * to lie on. This is the ONE resolver for it: the merge knot search WALKS this
 * line while `validateAndCullOrphans` measures the knot's drift against it, so
 * two resolvers that disagree leave the knot floating beside its shaft and the
 * validator culls the whole member as `drift` — silently stripping the support
 * it was placed for.
 *
 * Both ends carry by-design fallbacks, and the validator's semantics here are
 * load-bearing (see the constraint notes below), so they are reproduced
 * verbatim.
 */
function hostSegmentSpan(
    draft: SupportState,
    host: { rootId?: string; segments: Array<{ bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null }>; contactCone?: { pos: { x: number; y: number; z: number } } },
    seg: { bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null },
): { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } } | null {
    // Bottom segments carry no bottomJoint by design (they rise from the root
    // plate, not a joint entity) — the root top IS the segment start. Using
    // anything else here is what produced the `drift` culls: the merge search
    // used to fabricate `(0, 0, rootTopZ)`, which is the same line only for a
    // trunk rooted at the world origin, so on the reported model every minima
    // member merged onto an off-origin host landed beside its shaft and was
    // culled — leaving the model's lowest edge, the edge that anchors the
    // print, with no supports at all.
    const root = draft.roots[host.rootId ?? ''];
    const start = seg.bottomJoint?.pos ?? (root ? {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + (root.diskHeight ?? 0) + (root.coneHeight ?? 0),
    } : undefined);
    // Top segments connect to the contact cone and carry no topJoint by design
    // — the cone position IS the segment top. Without this fallback every knot
    // hosted high on a trunk (the best, shortest spans) was culled as
    // missingHost.
    const end = seg.topJoint?.pos ?? host.contactCone?.pos;
    return start && end ? { start, end } : null;
}

/**
 * The shaft a knot sits on, across every type that has one.
 *
 * The owner's type travels with its id so a caller can index the right
 * collection rather than assuming a trunk.
 */
function findHostSegment(
    draft: SupportState,
    parentShaftId: string,
): { hostTypeId: SupportTypeId; hostId: string; segment: { id: string; bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null } } | null {
    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.hasSegments) continue;
        const collection = draft[descriptor.location.key] as unknown as Record<string, { segments?: { id: string }[] }>;

        for (const [ownerId, entity] of Object.entries(collection ?? {})) {
            for (const seg of entity.segments ?? []) {
                if (seg.id === parentShaftId) {
                    return { hostTypeId: descriptor.id, hostId: ownerId, segment: seg as never };
                }
            }
            if (ownerId === parentShaftId) {
                // Legacy: the knot's parent was the support id rather than a
                // segment id. Treated as missing so `rehostLegacyKnots` moves it
                // to the nearest segment instead.
                return null;
            }
        }
    }
    return null;
}

/**
 * Rehost knots whose `parentShaftId` is an entity id rather than the segment
 * id they now use (legacy fan leaves/branches) to the nearest segment of that
 * host.
 */
export function rehostLegacyKnots(draft: SupportState): SupportState {
    let nextKnots = draft.knots;
    let changed = false;
    // Whichever host type owns the id, not trunks by name: a legacy knot points
    // at a host entity, and which type that is, is the collection it lives in.
    const hostByEntityId = new Map(
        collectHostEntities(draft).map(({ hostId, entity }) => [hostId, entity]),
    );
    for (const [kid, knot] of Object.entries(draft.knots)) {
        const legacyHost = hostByEntityId.get(knot.parentShaftId);
        if (legacyHost) {
            let bestSeg: typeof legacyHost.segments[0] | null = null;
            let bestDist2 = Infinity;
            let bestT = 0;
            for (const seg of legacyHost.segments) {
                const start = seg.bottomJoint?.pos ?? { x: 0, y: 0, z: 0 };
                const end = seg.topJoint?.pos;
                if (!end) continue;
                // Compute t of projection of knot.pos onto segment
                const abx = end.x - start.x, aby = end.y - start.y, abz = end.z - start.z;
                const apx = knot.pos.x - start.x, apy = knot.pos.y - start.y, apz = knot.pos.z - start.z;
                const ab2 = abx * abx + aby * aby + abz * abz;
                const t = ab2 < 1e-9 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2));
                const cx = start.x + abx * t, cy = start.y + aby * t, cz = start.z + abz * t;
                const d2 = (knot.pos.x - cx) ** 2 + (knot.pos.y - cy) ** 2 + (knot.pos.z - cz) ** 2;
                if (d2 < bestDist2) {
                    bestDist2 = d2;
                    bestSeg = seg as typeof legacyHost.segments[0];
                    bestT = t;
                }
            }
            if (bestSeg) {
                const updated: typeof knot = { ...knot, parentShaftId: bestSeg.id, t: bestT };
                nextKnots = { ...nextKnots, [kid]: updated };
                changed = true;
            }
        }
    }
    return changed ? { ...draft, knots: nextKnots } : draft;
}

/**
 * Enforce "contact cone body == the shaft it sits on" across the whole draft —
 * the same geometry a settings-driven rebuild from the shaft produces. The
 * resize pass thickens shafts AFTER cones are built, so a cone body lags its
 * (thickened) shaft and renders as a visible step; conversely a leaf fanned
 * while its host was temporarily thicker, a transplanted replacement profile,
 * or a re-run over a resized forest can leave a cone wider than its shaft.
 * Only the body moves — the tip contact diameter is a peel-force choice and
 * stays exactly as placed.
 */
export function syncContactConeDiameters(draft: SupportState): SupportState {
    // Which types contribute their segment diameters, from each type's declared
    // `coneBodyFollows`. A type whose cone body is left alone (stick, stump)
    // declares no source rather than being filtered out.
    const diameterBySegmentId = new Map<string, number>();
    for (const descriptor of SUPPORT_TYPES) {
        if (descriptor.coneBodyFollows !== 'ownFirstSegment'
            && descriptor.coneBodyFollows !== 'ownLastSegment') continue;

        const collection = draft[descriptor.location.key] as unknown as
            | Record<string, { segments?: Segment[] }>
            | undefined;
        for (const entity of Object.values(collection ?? {})) {
            for (const seg of entity.segments ?? []) {
                if (typeof seg.diameter === 'number' && seg.diameter > 0) {
                    diameterBySegmentId.set(seg.id, seg.diameter);
                }
            }
        }
    }

    let changed = false;
    const syncCone = (cone: ContactCone | undefined, hostDia: number | undefined): ContactCone | undefined => {
        const body = cone?.profile?.bodyDiameterMm;
        if (!cone || body === undefined || hostDia === undefined) return cone;
        if (Math.abs(body - hostDia) > 1e-6) {
            changed = true;
            return { ...cone, profile: { ...cone.profile, bodyDiameterMm: hostDia } };
        }
        return cone;
    };

    const nextTrunks: SupportState['trunks'] = { ...draft.trunks };
    for (const [tid, t] of Object.entries(draft.trunks)) {
        const topSeg = t.segments[t.segments.length - 1];
        const cone = syncCone(t.contactCone, topSeg?.diameter);
        if (cone !== t.contactCone) nextTrunks[tid] = { ...t, contactCone: cone };
    }
    const nextLeaves: SupportState['leaves'] = { ...draft.leaves };
    for (const [lid, l] of Object.entries(draft.leaves)) {
        const knot = draft.knots[l.parentKnotId];
        if (!knot) continue;
        const hostDia = diameterBySegmentId.get(knot.parentShaftId);
        if (hostDia === undefined) continue;
        const cone = syncCone(l.contactCone, hostDia);
        if (cone && cone !== l.contactCone) nextLeaves[lid] = { ...l, contactCone: cone };
    }

    const nextBranches: SupportState['branches'] = { ...draft.branches };
    for (const [bid, b] of Object.entries(draft.branches)) {
        const firstSeg = b.segments[0];
        const cone = syncCone(b.contactCone, firstSeg?.diameter);
        if (cone !== b.contactCone) nextBranches[bid] = { ...b, contactCone: cone };
    }

    if (!changed) return draft;
    return { ...draft, trunks: nextTrunks, leaves: nextLeaves, branches: nextBranches };
}

/**
 * One entity of a shaft-hosted member type, as the cull and the report read it.
 *
 * The knot field is NOT named here: `SHAFT_HOSTED_MEMBER_TYPES` supplies it, so
 * a renamed type reaches only the descriptor. `segments` is present exactly on
 * the members whose type declares `hasSegments`, the same flag that picks the
 * branch-side collision check below.
 */
interface ShaftHostedMemberEntity {
    id: string;
    contactCone?: ContactCone;
    segments: Segment[];
}

/** The entities of one member collection, whichever member type holds it. */
function hostedMemberEntities(
    draft: SupportState,
    collectionKey: SupportCollectionKey,
): Record<string, ShaftHostedMemberEntity> {
    return draft[collectionKey] as unknown as Record<string, ShaftHostedMemberEntity>;
}

/** The knot a hosted member hangs from, by the field name the registry declares. */
function memberKnotId(member: ShaftHostedMemberEntity, knotField: string): string | undefined {
    const value = (member as unknown as Record<string, unknown>)[knotField];
    return typeof value === 'string' ? value : undefined;
}

/** Validate hosted members' attachment after forest resize; cull orphans and return them for reporting. */
export function validateAndCullOrphans(
    draft: SupportState,
    mesh: THREE.Mesh | undefined,
): { draft: SupportState; orphans: OrphanInfo[] } {
    const orphans: OrphanInfo[] = [];
    const DRIFT_TOL_SQ = 0.25; // 0.5mm
    let nextDraft: SupportState = draft;
    const knotsToRemove = new Set<string>();
    const hostsToRemove = new Set<string>();
    /**
     * Culled host id -> the type's own name, recorded as the cull happens. The
     * name has to survive the cull: by the time a member is re-parented the
     * entity is gone, and only this says what type it was.
     */
    const culledHostTypeNameById = new Map<string, string>();

    // Host shafts that pierce the mesh (zig-zag pillars that crash) — cull the whole pillar
    if (mesh) {
        // Every host type, not trunks by name: a blocked pillar is a blocked
        // pillar whatever type built it.
        for (const { hostTypeId, hostId, entity } of collectHostEntities(nextDraft)) {
            // A host is a vertical pillar — any segment that is blocked (excluding the tip contact itself)
            // is a mis-placed pillar that would print through the model.
            let blocked = false;
            for (const seg of entity.segments) {
                const start = seg.bottomJoint?.pos;
                const end = seg.topJoint?.pos;
                if (!start || !end) continue;
                const radius = (seg.diameter ?? 1.0) / 2;
                // Offset the check slightly inward from the tip so the contact itself is not counted as blocked
                const tip = entity.contactCone?.pos ?? end;
                const checkEnd = {
                    x: end.x * 0.9 + tip.x * 0.1,
                    y: end.y * 0.9 + tip.y * 0.1,
                    z: end.z * 0.9 + tip.z * 0.1,
                };
                // Use a slightly larger radius for the check to catch near-misses that render as crash
                if (isShaftBlocked(start, checkEnd, radius + 0.15, mesh)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) {
                const tip = entity.contactCone?.pos;
                const where = tip ? ` @ (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)}, Z${tip.z.toFixed(1)})` : '';
                const typeName = getSupportTypeDescriptor(hostTypeId).singular;
                culledHostTypeNameById.set(hostId, typeName);
                orphans.push({
                    id: hostId,
                    kind: hostTypeId,
                    reason: 'hostBlocked',
                    detail: `${typeName} shaft pierces mesh${where}`,
                });
                hostsToRemove.add(hostId);
            }
        }
    }
    const checkAttachment = (
        id: string,
        kind: ShaftHostedMemberTypeId,
        knotField: string,
        member: ShaftHostedMemberEntity,
        tipPos: { x: number; y: number; z: number } | undefined,
    ) => {
        const parentKnotId = memberKnotId(member, knotField);
        if (!parentKnotId) {
            orphans.push({ id, kind, reason: 'missingKnot', detail: 'no parentKnotId' });
            return false;
        }
        const knot = nextDraft.knots[parentKnotId];
        if (!knot) {
            orphans.push({ id, kind, reason: 'missingKnot', knotId: parentKnotId, detail: 'knot not in draft' });
            return false;
        }
        const host = findHostSegment(nextDraft, knot.parentShaftId);
        if (!host) {
            // parentShaftId is an entity id or a missing segment (legacy or deleted host)
            const entityExists = collectHostEntities(nextDraft).some((h) => h.hostId === knot.parentShaftId);
            const reason = entityExists ? 'missingSegment' as const : 'missingHost' as const;
            orphans.push({ id, kind, reason, hostId: knot.parentShaftId, knotId: knot.id, detail: `knot ${knot.id} parent ${knot.parentShaftId}` });
            return false;
        }
        const seg = host.segment;
        const owner = hostEntityOf(nextDraft, host.hostTypeId, host.hostId);
        const span = owner ? hostSegmentSpan(nextDraft, owner, seg) : null;
        if (!span) {
            const segIndex = owner?.segments.findIndex((s) => s.id === seg.id) ?? -1;
            orphans.push({ id, kind, reason: 'missingHost', hostId: host.hostId, knotId: knot.id, detail: `segment missing joints (seg ${seg.id.slice(0, 8)}, topJoint ${seg.topJoint ? 'yes' : 'no'}, bottomJoint ${seg.bottomJoint ? 'yes' : 'no'}, seg ${segIndex + 1}/${owner?.segments.length ?? 0}, origin ${owner?.origin ?? 'unset'})` });
            return false;
        }
        const { start, end } = span;
        const drift2 = pointToSegmentDistanceSq(knot.pos, start, end);
        if (drift2 > DRIFT_TOL_SQ) {
            orphans.push({ id, kind, reason: 'drift', hostId: host.hostId, knotId: knot.id, detail: `drift ${(Math.sqrt(drift2)).toFixed(2)}mm from shaft` });
            return false;
        }
        if (tipPos) {
            let blocked = false;
            if (!getSupportTypeDescriptor(kind).hasSegments) {
                const cone = member.contactCone;
                if (cone && mesh) {
                    const normal = cone.normal ?? { x: 0, y: 0, z: -1 };
                    const surfaceNormal = cone.surfaceNormal;
                    blocked = contactConeCollides(knot.pos, { pos: cone.pos, normal, surfaceNormal }, mesh);
                } else if (mesh) {
                    blocked = isShaftBlocked(knot.pos, tipPos, 0.2, mesh);
                }
            } else {
                if (mesh) {
                    blocked = branchCollidesWithSDF(member, mesh);
                }
            }
            if (blocked) {
                orphans.push({ id, kind, reason: 'blocked', hostId: host.hostId, knotId: knot.id, detail: 'knot→tip blocked by mesh' });
                return false;
            }
            // Shallow leaf/branch guard: after resize/rehost a leaf can drift to ~90°
            // from vertical (knot and tip end up at similar height). That reads
            // as a horizontal arm and prints poorly — cull it as "too shallow"
            // so it shows in the report instead of as a visible shallow leaf.
            if (tipPos) {
                const vDist = tipPos.z - knot.pos.z;
                const hDist = Math.hypot(tipPos.x - knot.pos.x, tipPos.y - knot.pos.y);
                const angleDeg = (Math.atan2(hDist, Math.max(0.001, vDist)) * 180) / Math.PI;
                // Post-resize drift can push a leaf to ~90° (horizontal). Use a
                // permissive 75° ceiling here (same as chunk consolidation) so
                // a leaf that was valid at placement (≤45°) and drifted to ~63°
                // stays as "cross" (kept), while a true 90° shallow leaf is culled.
                const maxAngle = 75;
                if (vDist < 0.4 || angleDeg > maxAngle + 1e-6) {
                    orphans.push({ id, kind, reason: 'blocked', hostId: host.hostId, knotId: knot.id, detail: `too shallow ${angleDeg.toFixed(1)}° > ${maxAngle}° (h=${hDist.toFixed(1)} v=${vDist.toFixed(1)})` });
                    return false;
                }
            }
            if (leafPathCrossesSupports(knot.pos, tipPos, 0.25, nextDraft, host.hostId)) {
                orphans.push({ id, kind, reason: 'cross', hostId: host.hostId, knotId: knot.id, detail: 'leaf/branch crosses another shaft after thickening' });
                return true;
            }
        }
        return true;
    };

    /**
     * Members to cull, per type. Every walk below goes through
     * `SHAFT_HOSTED_MEMBER_TYPES` rather than naming a member's collection, so a
     * renamed type reaches this file only as a compile error.
     */
    const membersToRemove = new Map<ShaftHostedMemberTypeId, Set<string>>();
    const removedFor = (typeId: ShaftHostedMemberTypeId): Set<string> => {
        const existing = membersToRemove.get(typeId);
        if (existing) return existing;
        const created = new Set<string>();
        membersToRemove.set(typeId, created);
        return created;
    };

    // Registry walk order, which is observable: leaf orphans are reported
    // before branch ones, and likewise for the missing-host pass below.
    for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const removal = removedFor(typeId);
        for (const [memberId, member] of Object.entries(hostedMemberEntities(nextDraft, collectionKey))) {
            const tipPos = member.contactCone?.pos;
            if (!checkAttachment(memberId, typeId, knotField, member, tipPos)) removal.add(memberId);
        }
    }
    // Members whose host was culled (hostBlocked) are also orphaned
    for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const removal = removedFor(typeId);
        for (const [memberId, member] of Object.entries(hostedMemberEntities(nextDraft, collectionKey))) {
            if (removal.has(memberId)) continue;
            const knotId = memberKnotId(member, knotField);
            const knot = knotId ? nextDraft.knots[knotId] : undefined;
            if (!knot) continue;
            const host = findHostSegment(nextDraft, knot.parentShaftId);
            // A member whose host was culled: the host resolves through the
            // knot's segment, or -- for a legacy knot keyed to the entity
            // itself -- is the parent id. Either way the cull recorded the type
            // by name.
            const culledHostId = host?.hostId ?? knot.parentShaftId;
            const culledTypeName = culledHostTypeNameById.get(culledHostId);
            if (culledTypeName) {
                orphans.push({ id: memberId, kind: typeId, reason: 'missingHost', hostId: culledHostId, knotId: knot.id, detail: `${culledTypeName} culled (blocked)` });
                removal.add(memberId);
            }
        }
    }

    if (SHAFT_HOSTED_MEMBER_TYPES.every(({ typeId }) => removedFor(typeId).size === 0)
        && hostsToRemove.size === 0) {
        return { draft: nextDraft, orphans };
    }

    // Collect knots that are only used by culled members
    const remainingKnotUsers = new Map<string, number>();
    for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const removal = removedFor(typeId);
        for (const member of Object.values(hostedMemberEntities(nextDraft, collectionKey))) {
            if (removal.has(member.id)) continue;
            const kid = memberKnotId(member, knotField);
            if (kid) remainingKnotUsers.set(kid, (remainingKnotUsers.get(kid) ?? 0) + 1);
        }
    }
    // Brace knots are separate — never cull a knot that is a brace endpoint
    for (const brace of Object.values(nextDraft.braces)) {
        remainingKnotUsers.set(brace.startKnotId, (remainingKnotUsers.get(brace.startKnotId) ?? 0) + 1);
        remainingKnotUsers.set(brace.endKnotId, (remainingKnotUsers.get(brace.endKnotId) ?? 0) + 1);
    }

    for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const collection = hostedMemberEntities(nextDraft, collectionKey);
        for (const memberId of removedFor(typeId)) {
            const kid = memberKnotId(collection[memberId], knotField);
            if (kid && !remainingKnotUsers.has(kid)) knotsToRemove.add(kid);
        }
    }
    // Knots on removed hosts
    const segmentIdsToRemove = new Set<string>();
    const removedHostTypeById = new Map<string, SupportTypeId>();
    for (const descriptor of GRID_HOST_TYPES) {
        const collection = nextDraft[descriptor.location.key] as unknown as
            Record<string, { segments: Segment[] }> | undefined;
        for (const id of hostsToRemove) {
            const entity = collection?.[id];
            if (!entity) continue;
            for (const seg of entity.segments) segmentIdsToRemove.add(seg.id);
            removedHostTypeById.set(id, descriptor.id);
        }
    }
    for (const [kid, knot] of Object.entries(nextDraft.knots)) {
        if (segmentIdsToRemove.has(knot.parentShaftId) || hostsToRemove.has(knot.parentShaftId)) {
            if (!remainingKnotUsers.has(kid)) knotsToRemove.add(kid);
        }
    }

    const nextMembers: Partial<Record<SupportCollectionKey, Record<string, unknown>>> = {};
    for (const { typeId, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const cloned = { ...(nextDraft[collectionKey] as unknown as Record<string, unknown>) };
        for (const id of removedFor(typeId)) delete cloned[id];
        nextMembers[collectionKey] = cloned;
    }
    const nextKnots = { ...nextDraft.knots };
    for (const id of knotsToRemove) delete nextKnots[id];

    // Delete each culled host from whichever collection owns it, then drop any
    // root left unclaimed -- across every type that owns one, not just trunks.
    const hostCollections: Partial<Record<SupportCollectionKey, Record<string, unknown>>> = {};
    for (const descriptor of GRID_HOST_TYPES) {
        const key = descriptor.location.key;
        const cloned = { ...(nextDraft[key] as unknown as Record<string, unknown>) };
        for (const id of hostsToRemove) delete cloned[id];
        hostCollections[key] = cloned;
    }
    const nextRoots: Record<string, unknown> = { ...nextDraft.roots };
    for (const [hostId, hostTypeId] of removedHostTypeById) {
        const ownerRootId = (hostEntityOf(draft, hostTypeId, hostId) as unknown as
            { rootId?: string } | undefined)?.rootId;
        if (!ownerRootId || !nextRoots[ownerRootId]) continue;
        const stillUsed = SUPPORT_TYPES.some((descriptor) => descriptor.ownsRoot
            && Object.values(hostCollections[descriptor.location.key] ?? {})
                .some((entity) => (entity as { rootId?: string }).rootId === ownerRootId));
        if (!stillUsed) delete nextRoots[ownerRootId];
    }

    nextDraft = {
        ...nextDraft,
        ...nextMembers,
        knots: nextKnots,
        roots: nextRoots as SupportState['roots'],
        ...hostCollections,
    } as SupportState;
    return { draft: nextDraft, orphans };
}

export function fanLeafToHost(
    target: { x: number; y: number; z: number },
    modelId: string,
    shaftPoints: FanShaftPoint[],
    gridHostIds: ReadonlySet<string>,
    knotIdPrefix: string,
    fanRadiusMm: number,
    gridHostFanRadiusMm: number,
    maxAngleDeg: number,
    maxAttachments: number,
    draft: SupportState,
    mesh: THREE.Mesh | undefined,
    origin?: SupportOrigin,
    hostOrder: FanHostOrder = 'steepest',
    /** Span ceiling for the wide tier, overriding the derived reach/sin(maxAngle).
     *  The derived cap is what keeps an ordinary fan link short, and it is the
     *  right answer almost everywhere. A cavity rescue passes Infinity: its
     *  alternative is a model-to-model stick whose lower contact is a second
     *  scar on the model, so a long near-vertical branch onto a host that is
     *  close in plan but low is still the better support. The wide tier takes
     *  the SHORTEST legal link, so it never spends more than that geometry
     *  forces. */
    rescueSpanOverrideMm?: number,
): FanLeafResult {
    // Single pass over the shaft pool: the ELIGIBLE sample (grid hosts accept
    // only up close) that is geometrically VALID (not same-Z, within the max
    // angle from vertical) wins. Placement fanning takes the STEEPEST — the
    // nearest sample alone sits at the shallowest valid angle (the "knot at
    // the junction" look), while the steepest sample in reach reads as a real
    // branch. Chunk consolidation takes the NEAREST instead: its links are
    // local ties between neighbouring pillars, and "steepest in reach" makes
    // it skip the adjacent pillar for a taller one up to 8mm away, which is
    // the long diagonal that reads as a stray branch.
    const candidates: Array<{ sp: FanShaftPoint; dist2: number; angleDeg: number }> = [];
    // A second, wider tier, offered only when the first finds nothing: the
    // same plan reach with a span the angle gate implies (reach / sin(maxAngle)
    // — at the full reach that pins the link to exactly the legal angle, and it
    // shrinks with the host's reach, so a grid host's rescue stays short).
    // Without it a tip beside a TALL thin neighbour had no host at all: the
    // samples close in 3D are the ones near the host's top, which are the
    // shallow ones the angle gate refuses, while the steep sample that would
    // have been legal sits further down — outside a 3D radius that counted the
    // drop as if it were lateral. That tip stood alone as a 1:1 pillar, or
    // crossed to the model as a stick with two contact scars instead of one.
    // Tier 1 keeps every placement that already worked, and the look that goes
    // with it; the wide tier only ever rescues a tip that had nothing.
    const rescue: Array<{ sp: FanShaftPoint; dist2: number; angleDeg: number }> = [];
    let refusal: FanLeafRefusal = 'noHost';
    let nearestHostMm = Infinity;
    let nearestSteepMm = Infinity;
    let steepAngleDeg = Infinity;

    for (const sp of shaftPoints) {
        // A host must belong to the model being supported. The shaft pool is
        // collected from the whole snapshot, which holds every model's forest
        // — an unfiltered pool attaches this model's leaf to a neighbouring
        // model's shaft (and its knot to that model's segment).
        if (hostEntityOf(draft, sp.hostTypeId, sp.hostId)?.modelId !== modelId) continue;
        const isGrid = gridHostIds.has(sp.hostId);
        const limit = isGrid ? gridHostFanRadiusMm : fanRadiusMm;
        const ddx = sp.pos.x - target.x;
        const ddy = sp.pos.y - target.y;
        const ddz = sp.pos.z - target.z;
        const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
        const lateral2 = ddx * ddx + ddy * ddy;
        const lateralMm = Math.sqrt(lateral2);
        if (lateralMm < nearestHostMm) nearestHostMm = lateralMm;
        if (lateral2 > limit * limit) continue;
        const inReach = dist2 <= limit * limit;
        const rescueSpanMm = rescueSpanOverrideMm
            ?? (maxAngleDeg > 0 ? limit / Math.sin((maxAngleDeg * Math.PI) / 180) : Infinity);
        const inRescue = dist2 <= rescueSpanMm * rescueSpanMm;
        if (!inReach && !inRescue) continue;

        // The leaf must RISE: the host sample must sit below the target tip.
        // absVDist here was the bug — it let leaves attach from a sample ABOVE
        // the tip, hanging downward (upside-down leaves that read as shallow).
        const vDist = target.z - sp.pos.z;
        if (vDist < 0.4) {
            // A real vertical drop is required. The ANGLE limit is the real
            // shallowness guard (75° needs drop ≥ 0.27 × lateral); this floor
            // only rejects same-height neighbours whose drop rounds to zero.
            if (refusal === 'noHost') refusal = 'sameZ';
            continue;
        }
        const angleDeg = (Math.atan2(Math.sqrt(ddx * ddx + ddy * ddy), vDist) * 180) / Math.PI;
        if (angleDeg > maxAngleDeg) {
            if (refusal === 'noHost') refusal = 'angle';
            continue;
        }
        if (lateralMm < nearestSteepMm) {
            nearestSteepMm = lateralMm;
            steepAngleDeg = angleDeg;
        }
        (inReach ? candidates : rescue).push({ sp, dist2, angleDeg });
    }
    // Tier 1 keeps every placement that already worked, and the look that goes
    // with it. The rescue tier answers a different question — it removes a lone
    // pillar, it does not add material — so it takes the SHORTEST legal link
    // (the least drop that still clears the angle) instead of the steepest,
    // which would spend the whole rescue span on a longer member for no gain.
    const pool = candidates.length > 0 ? candidates : rescue;
    if (pool.length === 0) {
        return {
            ok: false,
            reason: refusal,
            nearestHostMm: Number.isFinite(nearestHostMm) ? nearestHostMm : undefined,
            nearestSteepMm: Number.isFinite(nearestSteepMm) ? nearestSteepMm : undefined,
            steepAngleDeg: Number.isFinite(steepAngleDeg) ? steepAngleDeg : undefined,
        };
    }
    const order: FanHostOrder = candidates.length > 0 ? hostOrder : 'nearest';

    // Steepest first (placement fanning) or nearest first (chunk
    // consolidation); the other metric breaks ties.
    pool.sort((a, b) => (order === 'nearest'
        ? a.dist2 - b.dist2 || a.angleDeg - b.angleDeg
        : a.angleDeg - b.angleDeg || a.dist2 - b.dist2));

    // Try each candidate until one clears blocked/cross/capacity/build.
    let lastBlockedReason: FanLeafRefusal | null = null;
    for (const { sp, dist2, angleDeg } of pool) {
        const parentKnot = {
            id: freeKnotId(draft, knotIdPrefix),
            parentShaftId: sp.segmentId ?? sp.hostId,
            t: sp.t,
            pos: sp.pos,
            diameter: sp.diameter + 0.125,
        };
        if (mesh && isShaftBlocked(sp.pos, target, 0.2, mesh)) {
            lastBlockedReason = 'blocked';
            continue;
        }

        const resolved = resolveSurfaceNormal(target, mesh ?? undefined);
        // Long spans route to branches with real shafts instead of long tapered
        // leaf cones (spindly spikes), for EVERY origin. Overhang fanning used to
        // stay a leaf past this threshold, which is how an 11.6mm cone got built;
        // the leaf's own rule — past ~6mm it stands next to its trunk rather than
        // supporting it — does not care which surface the tip touches. Failed
        // branch attempts fall through to the next candidate (a shorter span may
        // still leaf).
        if (Math.sqrt(dist2) > MAX_LEAF_SPAN_BEFORE_BRANCH_MM) {
            try {
                const band = activeSizingBand();
                const built = buildBranchData({
                    tipPos: resolved.point,
                    tipNormal: resolved.normal,
                    modelId,
                    parentKnot,
                    mesh: mesh ?? undefined,
                    shaftDiameterMm: band.shaftDiameterMm,
                    tipContactDiameterMm: band.tipContactDiameterMm,
                    rootsDiameterMm: band.rootDiameterMm,
                });
                const collides = built.supportData.error || (mesh && branchCollidesWithSDF(built.branch, mesh));
                if (collides) {
                    lastBlockedReason = 'blocked';
                    continue;
                }
                if (branchDepartureAngleDeg(built.branch, parentKnot.pos) > maxAngleDeg) {
                    lastBlockedReason = 'angle';
                    continue;
                }
                {
                    if (maxAttachments > 0 && isHostAtAttachmentCapacity(sp.hostTypeId, sp.hostId, maxAttachments, draft)) {
                        lastBlockedReason = 'capacity';
                        continue;
                    }
                    const next = draftAddPrimitive(draft, 'knots', parentKnot);
                    built.branch.origin = origin === 'overhang' ? 'overhang' : 'island';
                    const memberTypeId = builtMemberTypeId(built.branch);
                    return {
                        ok: true,
                        kind: memberTypeId,
                        draft: draftAddEntity(next, memberTypeId, built.branch),
                        hostTypeId: sp.hostTypeId,
                        hostId: sp.hostId,
                        entityId: built.branch.id,
                        distMm: Math.sqrt(dist2),
                        angleDeg,
                    };
                }
                lastBlockedReason = 'blocked';
            } catch {
                lastBlockedReason = 'build';
            }
            continue;
        }

        let leaf;
        try {
            const built = buildLeafData({
                tipPos: resolved.point,
                surfaceNormal: resolved.normal,
                modelId,
                parentKnot,
                hostDiameterMm: sp.diameter,
                tipContactDiameterMm: activeSizingBand().tipContactDiameterMm,
                mesh: mesh ?? undefined,
            });
            if (built.supportData.error) {
                lastBlockedReason = 'build';
                continue;
            }
            leaf = built.leaf;
        } catch {
            lastBlockedReason = 'build';
            continue;
        }

        if (leafPathCrossesSupports(
            parentKnot.pos,
            leaf.contactCone?.pos ?? target,
            0.25,
            draft,
            sp.hostId,
        )) {
            lastBlockedReason = 'cross';
            continue;
        }
        if (maxAttachments > 0 && isHostAtAttachmentCapacity(sp.hostTypeId, sp.hostId, maxAttachments, draft)) {
            lastBlockedReason = 'capacity';
            continue;
        }

        const next = draftAddPrimitive(draft, 'knots', parentKnot);
        if (origin) leaf.origin = origin;
        const memberTypeId = builtMemberTypeId(leaf);
        return {
            ok: true,
            kind: memberTypeId,
            draft: draftAddEntity(next, memberTypeId, leaf),
            hostTypeId: sp.hostTypeId,
            hostId: sp.hostId,
            entityId: leaf.id,
            distMm: Math.sqrt(dist2),
            angleDeg,
        };
    }
    return { ok: false, reason: lastBlockedReason ?? refusal };
}

// ---------------------------------------------------------------------------
// Forest Report
// ---------------------------------------------------------------------------
// A structured per-run summary of the placed forest: every support's id, size,
// and sizing reasoning, plus the fan-out groups (host trunk → attached leaves
// and branches). Shown in the Auto Supports panel after a run; the per-entity
// placement log spam is off by default (see setAutoSupportVerboseLogging).

function clamp01(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** The sizing reasoning for one placed support: island area + active band + height factor. */
export function forestSizingNote(entry: ForestLedgerEntry, actualShaftMm: number): string {
    const heightFactor = 1 + clamp01((entry.zHeight - 20) / 200, 0, 0.25);
    const areaInput = Math.max(entry.areaMm2, 0.01);
    return `area ${areaInput.toFixed(2)}mm² · base Ø${entry.bandShaftMm.toFixed(2)} · h${heightFactor.toFixed(2)}` +
        ` → Ø${actualShaftMm.toFixed(2)}mm`;
}

export function buildForestReport(draft: SupportState, ledger: ForestLedgerEntry[]): ForestReport {
    const displayByEntity = new Map<string, string>();
    const entryByEntity = new Map<string, ForestLedgerEntry>();
    for (const entry of ledger) {
        displayByEntity.set(entry.entityId, entry.displayId);
        entryByEntity.set(entry.entityId, entry);
    }

    const memberById = new Map<string, { id: string; kind: ShaftHostedMemberTypeId; spanMm: number; angleDeg: number }>();
    const membersByHost = new Map<string, ForestTree['members']>();

    // Knots reference their host SEGMENT (or the entity directly for legacy
    // data) — normalize to the host id for grouping, across every host type.
    const hostIdByShaftId = new Map<string, string>();
    for (const { hostId, entity } of collectHostEntities(draft)) {
        hostIdByShaftId.set(hostId, hostId);
        for (const seg of entity.segments) hostIdByShaftId.set(seg.id, hostId);
    }

    const pushMember = (
        entityId: string,
        kind: ShaftHostedMemberTypeId,
        hostShaftId: string,
        tipPos: { x: number; y: number; z: number } | undefined,
        knotPos: { x: number; y: number; z: number } | undefined,
    ) => {
        const memberHostId = hostIdByShaftId.get(hostShaftId) ?? hostShaftId;
        const hDist = knotPos && tipPos ? Math.hypot(tipPos.x - knotPos.x, tipPos.y - knotPos.y) : 0;
        const vDist = knotPos && tipPos ? tipPos.z - knotPos.z : 0;
        const spanMm = knotPos && tipPos
            ? Math.hypot(tipPos.x - knotPos.x, tipPos.y - knotPos.y, tipPos.z - knotPos.z)
            : 0;
        const angleDeg = vDist > 0.01 ? (Math.atan2(hDist, vDist) * 180) / Math.PI : 90;
        const member = { id: displayByEntity.get(entityId) ?? entityId.slice(0, 8), kind, spanMm, angleDeg };
        memberById.set(entityId, member);
        const list = membersByHost.get(memberHostId);
        if (list) list.push(member);
        else membersByHost.set(memberHostId, [member]);
    };

    // Registry walk order, which the member list depends on: a host's leaves
    // come before its branches, as they did when this named the two collections.
    for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        for (const member of Object.values(hostedMemberEntities(draft, collectionKey))) {
            const knotId = memberKnotId(member, knotField);
            const knot = knotId ? draft.knots[knotId] : undefined;
            if (!knot) continue;
            pushMember(member.id, typeId, knot.parentShaftId, member.contactCone?.pos, knot.pos);
        }
    }

    const trees: ForestTree[] = [];
    const bareHosts: ForestReport['bareHosts'] = [];

    for (const { hostId, entity } of collectHostEntities(draft)) {
        const shaftMm = entity.segments[0]?.diameter ?? 0;
        const entry = entryByEntity.get(hostId);
        const members = membersByHost.get(hostId);
        if (members && members.length > 0) {
            trees.push({
                hostId: displayByEntity.get(hostId) ?? hostId.slice(0, 8),
                hostZ: entity.contactCone?.pos?.z ?? 0,
                shaftDiameterMm: shaftMm,
                sizingNote: entry ? forestSizingNote(entry, shaftMm) : '',
                members,
            });
        } else {
            bareHosts.push({
                id: displayByEntity.get(hostId) ?? hostId.slice(0, 8),
                z: entity.contactCone?.pos?.z ?? 0,
                shaftDiameterMm: shaftMm,
                sizingNote: entry ? forestSizingNote(entry, shaftMm) : '',
            });
        }
    }

    trees.sort((a, b) => b.members.length - a.members.length);
    bareHosts.sort((a, b) => a.z - b.z);

    return {
        hostCount: collectHostEntities(draft).length,
        stumpCount: Object.keys(draft.stumps).length,
        leafCount: Object.keys(draft.leaves).length,
        branchCount: Object.keys(draft.branches).length,
        stickCount: Object.keys(draft.sticks).length,
        twigCount: Object.keys(draft.twigs).length,
        trees,
        bareHosts,
    };
}

/** Plain-text rendering of the forest report (copy-to-clipboard format). */
export function forestReportToText(report: ForestReport): string {
    const lines: string[] = [];
    // The report describes hosts as a set, so the word comes from the declared
    // host types: spelling "Trunks" here would be a type name in a second place.
    const hostLabel = GRID_HOST_TYPES.map((descriptor) => descriptor.label).join('/');
    lines.push('FOREST REPORT');
    lines.push('─────────────');
    const s = report.scan;
    if (s) {
        lines.push('SCAN');
        lines.push(`  ${s.islands} islands ` +
            `(voxel ${s.bySource.voxel} · minima ${s.bySource.minima} · intersection ${s.bySource.intersection} · overhang ${s.bySource.overhang}) ` +
            `→ ${s.candidates} candidates · ${s.overhangRegions} overhang regions · ` +
            `coverage ${s.coveragePercent.toFixed(0)}% of ${s.totalAreaMm2.toFixed(0)}mm² (${s.uncoveredIslands} uncovered) · ${s.rejected} rejected`);
        // Justification: what scan means
        lines.push(`  → ${s.candidates} candidates after dedup/filter from ${s.islands} islands (fixed-density ring + grid infill)`);
        if (s.dedupedAway || s.alreadySupported) {
            lines.push(
                `  → dropped: ${s.dedupedAway ?? 0} dedup, ${s.alreadySupported ?? 0} already supported ` +
                `(a support within 3mm of the contact — including one BELOW it)`);
        }
        const rejectEntries = Object.entries(s.rejectionReasons ?? {}).filter(([, v]) => v > 0);
        if (rejectEntries.length > 0) {
            lines.push(`  → rejected as: ${rejectEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
        lines.push('');
    }
    if (report.orphans && report.orphans.length > 0) {
        lines.push('ORPHANS CULLED');
        // Group by reason with justification
        const byReason = new Map<string, typeof report.orphans>();
        for (const o of report.orphans) {
            const list = byReason.get(o.reason);
            if (list) list.push(o);
            else byReason.set(o.reason, [o]);
        }
        const reasonHelp: Record<string, string> = {
            hostBlocked: 'shaft pierces mesh (vertical pillar would print through model)',
            blocked: 'knot→tip ray hits mesh (leaf/branch would go through model)',
            missingHost: 'host segment has no joints (single-segment anchor with no top joint)',
            missingSegment: 'knot points to trunkId not segmentId (legacy, rehost failed)',
            missingKnot: 'parent knot not in draft (deleted host)',
            drift: 'knot drifted >0.5mm from host shaft (split offset)',
            cross: 'leaf/branch crosses another shaft after thickening (kept but flagged)',
        };
        for (const [reason, list] of byReason) {
            const help = reasonHelp[reason] ?? '';
            lines.push(`  ${list.length}× ${reason}${help ? ` — ${help}` : ''}`);
        }
        for (const o of report.orphans) {
            lines.push(`    ${o.id} (${o.kind}) ${o.reason}${o.hostId ? ` @${o.hostId.slice(0, 8)}` : ''}${o.knotId ? ` knot ${o.knotId.slice(0, 8)}` : ''}${o.detail ? ` — ${o.detail}` : ''}`);
        }
        lines.push('');
    }
    if (report.diagnostics) {
        const d = report.diagnostics;
        lines.push('PLACEMENT DIAGNOSTICS');
        lines.push(`  ${hostLabel} by kind: grid ${d.hostsByKind.gridInfill} (ring + infill), gap-fill ${d.hostsByKind.coverageFill}, standalone ${d.hostsByKind.standalone} (sub-threshold overhang, no host)`);
        lines.push(`  Candidates by source: voxel ${d.candidatesBySource.voxel} · minima ${d.candidatesBySource.minima} · intersection ${d.candidatesBySource.intersection} · overhang ${d.candidatesBySource.overhang} · stabilization ${d.candidatesBySource.stabilization}`);
        const fanEntries = Object.entries(d.fanRefusals).filter(([, v]) => v);
        const mergeEntries = Object.entries(d.mergeRefusals).filter(([, v]) => v);
        if (fanEntries.length > 0 || mergeEntries.length > 0) {
            const fanStr = fanEntries.length > 0 ? fanEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
            const mergeStr = mergeEntries.length > 0 ? mergeEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
            const fanMaxDeg = getSettings().autoSupport?.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;
            lines.push(`  Fan refusals: ${fanStr} (noHost=too far in plan >5mm/2.5mm grid, angle=>${Math.min(fanMaxDeg, memberMaxAngleFromVerticalDeg())}° too flat, sameZ|cross|blocked|capacity=host full)`);
            const conEntries = Object.entries(d.consolidationRefusals ?? {}).filter(([, v]) => v);
            if (conEntries.length > 0) {
                const conStr = conEntries.map(([k, v]) => `${k}=${v}`).join(', ');
                lines.push(`  Consolidation refusals: ${conStr} (sameZ=surface too flat for side-leaves — chunking needs ≥0.4 mm neighbour height rise)`);
            }
            lines.push(`  Merge refusals: ${mergeStr} (noHost=no host within 4mm, rejected=host at capacity or collision)`);
        } else {
            lines.push(`  Fan/Merge refusals: none (all fanned or standalone)`);
        }
        if (d.cavityFallbacks && d.cavityFallbacks.length > 0) {
            lines.push(`  Cavity fallbacks: ${d.cavityFallbacks.length} — trunk could not reach the plate (bridged model-to-model)`);
            for (const fb of d.cavityFallbacks.slice(0, 20)) {
                const fanNote = fb.fanRefusal ? ` fan:${fb.fanRefusal}` : ' fan:—';
                lines.push(`    ${fb.id} (${fb.kind}) @ (${fb.tip.x.toFixed(1)}, ${fb.tip.y.toFixed(1)}, Z${fb.tip.z.toFixed(1)})${fanNote}`);
            }
        }
        lines.push('');
    }
    lines.push(`${report.hostCount} ${hostLabel.toLowerCase()} · ${report.leafCount} leaves · ${report.branchCount} branches · ` +
        `${report.bareHosts.length} bare ${hostLabel.toLowerCase()}`);
    if (report.trees.length > 0) {
        lines.push('');
        lines.push('FAN-OUT GROUPS');
        {
            const fanMaxDeg = getSettings().autoSupport?.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;
            const cap = getSettings().autoSupport?.maxAttachmentsPerTrunk ?? 12;
            const maxFromVertical = memberMaxAngleFromVerticalDeg();
            const effectiveFan = Math.min(fanMaxDeg, maxFromVertical);
            const effectiveLink = Math.min(Math.max(fanMaxDeg, CONSOLIDATION_MAX_ANGLE_DEG), maxFromVertical);
            lines.push(
                `  (host trunk → its leaves/branches. Every member must rise ≥${90 - maxFromVertical}° above horizontal ` +
                `(grid.minBranchAngleDeg), so placement fans ≤${effectiveFan}° from vertical within 5mm ` +
                `(2.5mm for grid hosts) and chunk-consolidation links ≤${effectiveLink}° within ` +
                `${CONSOLIDATION_FAN_RADIUS_MM}mm; cap ${cap} members per host. ` +
                `spans/angles are post-resize knot→tip — drift can make a link read shallower than its placement gate)`);
        }
        for (const tree of report.trees) {
            const members = tree.members
                .map((m) => `${m.id}(${typeWord(m.kind).charAt(0)} ${m.spanMm.toFixed(1)}mm/${m.angleDeg.toFixed(0)}°)`)
                .join(' ');
            lines.push(`  ${tree.hostId} @ Z=${tree.hostZ.toFixed(1)}mm Ø${tree.shaftDiameterMm.toFixed(2)}mm ` +
                (tree.sizingNote ? `[${tree.sizingNote}] ` : '') +
                `→ ${tree.members.length}: ${members}`);
        }
    }
    if (report.bareHosts.length > 0) {
        lines.push('');
        lines.push(`STANDALONE ${hostLabel.toUpperCase()}`);
        lines.push(`  (no host within fan radius — 1:1 pillar; grid-/fill- = region ring + infill, v/m = standalone voxel/minima)`);
        for (const host of report.bareHosts) {
            const id = host.id;
            let why = '';
            if (id.startsWith('grid-') || id.startsWith('fill-')) why = ' — region ring + grid infill';
            else if (id.startsWith('v') || id.startsWith('m')) why = ' — standalone voxel/minima (below threshold or consolidated)';
            lines.push(`  ${host.id} @ Z=${host.z.toFixed(1)}mm Ø${host.shaftDiameterMm.toFixed(2)}mm ` +
                (host.sizingNote ? `[${host.sizingNote}]` : '') + why);
        }
    }
    return lines.join('\n');
}

/** Progress the pipeline reports while it runs; see `computeAutoSupportPlan`. */
export type AutoPlaceProgress = { phase: string; done: number; total: number };
export type AutoPlaceProgressCallback = (progress: AutoPlaceProgress) => void;

export function computeAutoSupportPlan(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
    baseState?: SupportState,
    mesh?: THREE.Mesh,
    onProgress?: AutoPlaceProgressCallback,
): AutoSupportPlan | null {
    // ------------------------------------------------------------------
    // 0. Settings
    // ------------------------------------------------------------------

    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);

    if (!autoSettings.enabled) {
        return null;
    }

    const before = baseState ?? cloneSupportState(getSnapshot());
    let draft: SupportState = before;

    // Trunks placed from density-grid cells — fanning hosts only up close.
    const gridHostIds = new Set<string>();

    // Early-exit no-op plan (no candidates / nothing to place): the run
    // reported as unchanged, so the caller commits nothing.
    const noopPlan = (result: AutoPlaceResult): AutoSupportPlan => ({
        before,
        support: draft,
        analytics: {
            islandsCovered: 0,
            islandsUncovered: islands.length,
            presets: { detail: 0, structure: 0, anchor: 0 },
            rejectionReasons: {},
            areaCoverage: 0,
        },
        result,
    });

    // The model mesh is needed by the grid phase (surface snapping) and the
    // placement pipeline (pathfinding + collision).
    const resolvedMesh: THREE.Mesh | undefined = mesh ?? (getModelMesh(modelId) ?? undefined);
    if (resolvedMesh) resolvedMesh.updateMatrixWorld();

    // ------------------------------------------------------------------
    // 1. Generate candidates
    // ------------------------------------------------------------------

    console.log(LOG_PREFIX, `Input: ${islands.length} islands from scan`);
    resetRouterStats();
    timingStart('candidates');

    let candidates = generateCandidates(islands, autoSettings, { mesh: resolvedMesh, modelId });
    candidates = candidates.map((c): CandidatePoint => ({ ...c, modelId }));

    // Stabilization pass: when the oriented mesh bears on a point or edge,
    // formation detection sees nothing to support, so a dedicated bearing
    // analysis adds anchor contacts to broaden the base. Standalone trunks —
    // they never fan/merge onto a nearby host (the source gates that below).
    let stabilizationAnchors = 0;
    if (autoSettings.stabilizationEnabled !== false && resolvedMesh) {
        const anchors = computeStabilizationAnchors(resolvedMesh);
        if (anchors.length > 0) {
            const stabilizationCandidates: CandidatePoint[] = anchors.map((a, i) => ({
                id: `stab-${i}`,
                tipPos: { x: a.x, y: a.y, z: a.z },
                tipNormal: { x: 0, y: 0, z: -1 }, // placeholder — caller raycasts for the real normal
                modelId,
                source: 'stabilization',
                islandAreaMm2: 0.05,
                zHeight: a.z,
                priority: 0,
            }));
            stabilizationAnchors = stabilizationCandidates.length;
            candidates = [...candidates, ...stabilizationCandidates];
        }
    }

    // Candidate generation phase: every overhang region above the threshold
    // gets the unified fixed-density distribution (2D-projected boundary ring
    // + grid infill). Shape decides the degenerate cases — slivers get a ring
    // only, small patches stay on the single-candidate path below. A
    // generation failure must not kill the whole run — fall back to the
    // region's single candidate.
    const overhangIslands = islands.filter((i) => i.source === 'overhang');
    const eligible = overhangIslands.filter((i) => shouldUseDensityGrid(i, autoSettings));
    if (eligible.length > 0) {
        let generated: CandidatePoint[] = [];
        try {
            generated = generateGridCandidates(eligible, autoSettings, resolvedMesh, modelId)
                .map((c): CandidatePoint => ({ ...c, modelId }));
        } catch (e) {
            console.error(LOG_PREFIX,
                `Candidate generation failed — falling back to per-region candidates.`,
                e instanceof Error ? e.message : String(e));
        }
        const generatedRegionIds = new Set(eligible.map((i) => i.id));
        if (generated.length > 0) {
            candidates = [
                ...generated,
                ...candidates.filter((c) => !generatedRegionIds.has(c.id)),
            ];
        }
    }

    console.log(LOG_PREFIX,
        `Step 1/3: ${candidates.length} candidates generated ` +
        `(filtered from ${islands.length} islands, min area ${autoSettings.minIslandAreaMm2}mm², ` +
        `grid: ${autoSettings.areaPerSupportMm2}mm²/support @ ${autoSettings.gridAreaThresholdMm2}mm² threshold, ` +
        `stabilization: ${stabilizationAnchors} anchors)`);
    if (candidates.length === 0) {
        return noopPlan(makeResult(emptyPlacedCounts(), 0, false, 'no-candidates'));
    }

    timingEnd('candidates');
    timingStart('dedup');
    // ------------------------------------------------------------------
    // 2. Deduplicate
    // ------------------------------------------------------------------

    const beforeDedup = candidates.length;
    candidates = deduplicateCandidates(candidates, autoSettings);
    const dedupedCandidates = candidates.length;

    console.log(LOG_PREFIX,
        `Step 2/3: ${candidates.length} candidates after dedup ` +
        `(removed ${beforeDedup - candidates.length} within ${autoSettings.tipInfluenceRadiusMm}mm radius)`);

    if (candidates.length === 0) {
        return noopPlan(makeResult(emptyPlacedCounts(), 0, false, 'all-deduplicated'));
    }

    // ------------------------------------------------------------------
    // 2b. Filter out already-supported positions
    // ------------------------------------------------------------------

    timingEnd('dedup');
    timingStart('support-filter');
    const beforeSupportFilter = candidates.length;
    candidates = filterAlreadySupported(candidates, draft);
    const filteredCandidates = candidates.length;
    console.log(LOG_PREFIX,
        `Step 2b: ${candidates.length} candidates after support filter ` +
        `(removed ${beforeSupportFilter - candidates.length} already supported within ${ALREADY_SUPPORTED_RADIUS_MM}mm)`);

    if (candidates.length === 0) {
        return noopPlan(makeResult(emptyPlacedCounts(), 0, false, 'already-supported'));
    }

    // ------------------------------------------------------------------
    // 3. Place candidates through the standard pipeline
    // ------------------------------------------------------------------
    // Each candidate goes through resolveNormal → buildTrunkData →
    // decideGridPlacement.  State is committed after each placement so
    // subsequent candidates see existing supports (enabling organic
    // tree fan-out via grid occupancy).

    console.log(LOG_PREFIX,
        `Mesh for ${modelId}: ${resolvedMesh ? 'available (pathfinding + SDF active)' : 'UNAVAILABLE (supports route straight, no collision avoidance)'}`);

    const gridEnabled = getSettings().grid?.enabled;
    console.log(LOG_PREFIX,
        `Grid mode: ${gridEnabled ? 'ENABLED (supports share grid nodes, branch/leaf fan-out active)' : 'DISABLED (all supports become standalone trunks)'}`);

    // ── Model sizing context (mesh volume/top-Z for the debug analytics) ──
    let modelCtx: ModelSizingContext | undefined;
    if (resolvedMesh) {
        const bbox = new THREE.Box3().setFromObject(resolvedMesh);
        modelCtx = {
            modelVolumeMm3: computeMeshVolumeMm3(resolvedMesh),
            modelZMaxMm: bbox.max.z,
            totalCandidates: candidates.length,
        };
    }

    const placed = emptyPlacedCounts();
    /**
     * How many hosts the run has placed, for the per-support mass share. Read
     * off the declared host types rather than naming one, so a second hostable
     * type counts and a renamed one keeps working.
     */
    const placedHostCount = () =>
        GRID_HOST_TYPES.reduce((total, descriptor) => total + (placed[descriptor.id] ?? 0), 0);
    let rejectedCount = 0;

    // A placement whose kind is one of these is a model-to-model bridge: the
    // set is whichever types registered a bridge builder, which is the same
    // registry fact `buildCavityBridge` resolves its kind from.
    const bridgingTypes = contactBridgeTypes();

    // Placement-path diagnostics: where each placed trunk came from and why
    // non-fanned candidates didn't fan/merge. Pure counts — no physics.
    const diagnostics: PlacementDiagnostics = {
        candidatesBySource: { voxel: 0, minima: 0, intersection: 0, overhang: 0, stabilization: 0 },
        hostsByKind: { gridInfill: 0, coverageFill: 0, standalone: 0 },
        fanRefusals: {},
        mergeRefusals: {},
        cavityFallbacks: [],
    };
    // Consolidation (chunk fanning) refusal tallies — hoisted so the forest
    // report can surface them even when the resize pass re-scopes.
    const conRefusals: Partial<Record<FanLeafRefusal, number>> = {};
    // Trunk id → origin kind, so the consolidation pass can adjust the tallies
    // when it converts a standalone grid pillar into a fan leaf.
    const hostOriginById = new Map<string, 'gridInfill' | 'coverageFill'>();
    // Per-placed-entity ledger for the Forest Report (display id, sizing inputs).
    const forestLedger: ForestLedgerEntry[] = [];

    // Analytics accumulators
    const presets = { detail: 0, structure: 0, anchor: 0 };
    const rejectionReasons: Record<string, number> = {};

    // Step 3 is wrapped in a rollback guard: state is committed per-candidate,
    // so an uncaught failure mid-run would otherwise leave partial supports in
    // the store with no history entry to undo them.
    let analytics!: AutoPlaceAnalytics;
    try {
    // Per-candidate placement, shared by the main pass and the coverage
    // convergence (gap-fill) passes. Each placement advances the local draft
    // (no store commit) so later candidates see earlier supports.
    timingEnd('support-filter');
    timingStart('placement');

    const placeOne = (candidate: CandidatePoint): string => {
        try {
            const result = placeOneCandidate(candidate, draft, settingsOverride, gridHostIds, resolvedMesh);
            draft = result.draft;
            // A fan host is a type whose shaft the pool offers, which is what
            // `canBeGridHost` declares. Recorded so later candidates fan to a
            // grid-placed host only up close.
            const placedTypeId = result.kind === 'reject' ? null : result.kind;
            const placedAGridHost = placedTypeId !== null
                && getSupportTypeDescriptor(placedTypeId).canBeGridHost;
            if (candidate.gridPoint && placedAGridHost && result.entityId) {
                gridHostIds.add(result.entityId);
            }
            if (result.kind === 'reject') {
                rejectedCount++;
                if (result.rejectedReason) {
                    rejectionReasons[result.rejectedReason] = (rejectionReasons[result.rejectedReason] ?? 0) + 1;
                }
            } else {
                placed[result.kind]++;
                if (bridgingTypes.includes(result.kind)) {
                    // Cavity fallback: the trunk could not reach the plate, so
                    // we bridged model-to-model. Report WHERE, so avoidable
                    // bridges are visible instead of buried in a count.
                    diagnostics.cavityFallbacks.push({
                        id: candidate.id,
                        kind: result.kind,
                        tip: candidate.tipPos,
                        fanRefusal: result.cavityFanRefusal,
                    });
                }
            }
            if (result.preset) presets[result.preset]++;

            // Placement-path diagnostics: where each candidate ended up.
            diagnostics.candidatesBySource[candidate.source] =
                (diagnostics.candidatesBySource[candidate.source] ?? 0) + 1;
            if (placedAGridHost && result.entityId) {
                if (candidate.gridPoint) {
                    diagnostics.hostsByKind.gridInfill++;
                    hostOriginById.set(result.entityId, 'gridInfill');
                } else {
                    diagnostics.hostsByKind.standalone++;
                }
            }
            if (result.fanRefusal) {
                diagnostics.fanRefusals[result.fanRefusal] = (diagnostics.fanRefusals[result.fanRefusal] ?? 0) + 1;
            }
            if (result.mergeRefusal) {
                diagnostics.mergeRefusals[result.mergeRefusal] = (diagnostics.mergeRefusals[result.mergeRefusal] ?? 0) + 1;
            }
            if (result.kind !== 'reject' && result.entityId) {
                if (isLedgerKind(result.kind)) {
                    forestLedger.push({
                        displayId: candidate.id,
                        kind: result.kind,
                        entityId: result.entityId,
                        areaMm2: candidate.islandAreaMm2,
                        zHeight: candidate.zHeight,
                        preset: result.preset ?? presetForArea(candidate.islandAreaMm2),
                        bandShaftMm: activeSizingBand().shaftDiameterMm,
                    });
                } else {
                    // The ledger covers the types auto-placement produces. A new
                    // one reaching here is a wiring gap, not a placement result.
                    console.warn(LOG_PREFIX, `Placed ${result.kind} has no Forest Report column; omitted from the ledger.`);
                }
            }
            return result.kind;
        } catch (e) {
            rejectedCount++;
            rejectionReasons['exception'] = (rejectionReasons['exception'] ?? 0) + 1;
            console.warn(LOG_PREFIX,
                `Exception placing ${candidate.id}: ${e instanceof Error ? e.message : String(e)}`);
            return 'reject';
        }
    };

    // The placement pass is most of a run's wall clock, so it is what the
    // modal's progress bar follows. Reported in batches: one postMessage per
    // candidate would cost more than the placement does.
    let placementIndex = 0;
    const placementTotal = candidates.length;
    for (const candidate of candidates) {
        if (onProgress !== undefined
            && (placementIndex % 16 === 0 || placementIndex + 1 === placementTotal)) {
            onProgress({ phase: 'placing', done: placementIndex + 1, total: placementTotal });
        }
        placementIndex++;
        placeOne(candidate);
    }

    timingEnd('placement');
    timingStart('consolidation');

    // ── Overhang→tree consolidation (order-independent) ──────────────
    // A BARE overhang-origin trunk (organic Poisson, coverage fill,
    // sub-threshold single) whose tip is within CONSOLIDATION_FAN_RADIUS_MM
    // of a valid host is converted into a fan leaf — whether the host placed
    // before or after it, the junction reads as a tree. The radius is wider
    // than the regular fanning radius so overhang trunks 5–8 mm from an
    // island trunk still merge, and the angle is relaxed to
    // CONSOLIDATION_MAX_ANGLE_DEG so neighbours on shallow surfaces can
    // chunk (see constants.ts for why). Same-height pillars (vDist ≈ 0)
    // still cannot fan and stay as their own trunks.
    const conFanRadiusMm = Math.max(autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM, CONSOLIDATION_FAN_RADIUS_MM);
    const conFanMaxAngleDeg = Math.min(
        Math.max(autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG, CONSOLIDATION_MAX_ANGLE_DEG),
        memberMaxAngleFromVerticalDeg(),
    );
    let consolidated = 0;
    for (let pass = 0; pass < 3; pass++) {
        let convertedThisPass = 0;
        // One pool per pass, maintained as pillars convert. A conversion
        // deletes the pillar it replaces, and `collectFanShaftPoints` walks
        // every host segment with its 10 samples — rebuilding that per host
        // made this loop O(n²) with an allocation per sample. The pool only
        // ever loses the host being converted, so filter it out instead.
        let pool = collectFanShaftPoints(draft);
        for (const { hostTypeId, hostId, entity } of collectHostEntities(draft)) {
            // Only this model's hosts are ours to convert (and to delete --
            // the conversion replaces the pillar with a leaf of ours).
            if (entity.modelId !== modelId) continue;
            // Convertible: ring + grid infill, coverage fill, and
            // sub-threshold overhang singles — the overhang forest reads as
            // TREES: neighbouring pillars fan into each other so supports
            // release in chunks (one plate contact per chunk). Chunk size is
            // bounded by the declared attachment cap; stumps (near-plate) and
            // island hosts are never converted.
            const originKind = hostOriginById.get(hostId);
            const isConvertible = isOriginConvertibleToTree(entity.origin)
                && (originKind === 'gridInfill'
                    || originKind === 'coverageFill'
                    || entity.origin === 'standalone');
            if (!isConvertible) continue;
            if (countAttachmentsOnHost(hostTypeId, hostId, draft) > 0) continue;
            const tip = entity.contactCone?.pos;
            if (!tip) continue;
            const tipNormal = entity.contactCone?.normal ?? { x: 0, y: 0, z: -1 };
            const hostKey = getSupportTypeDescriptor(hostTypeId).location.key;
            const pruned: SupportState = {
                ...draft,
                [hostKey]: { ...(draft[hostKey] as unknown as Record<string, unknown>) },
                roots: { ...draft.roots },
            };
            delete (pruned[hostKey] as unknown as Record<string, unknown>)[hostId];
            delete pruned.roots[entity.rootId ?? ''];
            // The maintained pool already excludes every host converted
            // earlier this pass; this iteration's pillar is the only other
            // one that must not be offered as its own host.
            const hostPool = pool.filter((sp) => sp.hostId !== hostId);
            if (hostPool.length === 0) break;
            const fan = fanLeafToHost(
                tip,
                modelId,
                hostPool,
                new Set(),
                `auto-con-${hostId}-p${pass}`,
                conFanRadiusMm,
                GRID_HOST_FAN_RADIUS_MM,
                conFanMaxAngleDeg,
                autoSettings.maxAttachmentsPerTrunk,
                pruned,
                resolvedMesh ?? undefined,
                'overhang',
                'nearest',
            );
            if (!fan.ok) {
                // Routed-branch fallback, HEIGHT-GATED: a straight leaf can be
                // impossible between same-height or concave-surface pillars
                // (the leaf must rise; a horizontal link is not a support),
                // and that is exactly where chunking is still wanted — tall
                // pillar forests like an under-arm row. A routed branch high
                // above the plate reads as a tree; near the plate it reads as
                // a zig-zag spiderweb, so only tips at
                // ≥ CONSOLIDATION_BRANCH_MIN_HEIGHT_MM qualify.
                const branchResult = (tip.z >= CONSOLIDATION_BRANCH_MIN_HEIGHT_MM
                    && (fan.reason === 'blocked' || fan.reason === 'cross' || fan.reason === 'sameZ'))
                    ? buildConsolidationBranch({
                        tip,
                        tipNormal,
                        modelId,
                        pool: hostPool,
                        pruned,
                        mesh: resolvedMesh ?? undefined,
                        radiusMm: conFanRadiusMm,
                        maxAttachments: autoSettings.maxAttachmentsPerTrunk,
                        knotId: `auto-con-branch-${hostId}`,
                    })
                    : null;
                if (branchResult) {
                    draft = branchResult.draft;
                    pool = hostPool;
                    gridHostIds.delete(hostId);
                    const origin = originKind ?? 'standalone';
                    diagnostics.hostsByKind[origin]--;
                    // The host that yielded, and the type it became -- both in hand.
                    placed[hostTypeId]--;
                    placed[branchResult.kind]++;
                    consolidated++;
                    convertedThisPass++;
                    const hostEntry = forestLedger.find((e) => e.entityId === hostId);
                    if (hostEntry) {
                        // The type comes off the built result, so a renamed type
                        // reaches here through the builder rather than a literal.
                        forestLedger.push({ ...hostEntry, kind: branchResult.kind, entityId: branchResult.branchId });
                    }
                    continue;
                }
                conRefusals[fan.reason] = (conRefusals[fan.reason] ?? 0) + 1;
                continue;
            }
            draft = fan.draft;
            pool = hostPool;
            gridHostIds.delete(hostId);
            const origin = originKind ?? 'standalone';
            diagnostics.hostsByKind[origin]--;
            placed[hostTypeId]--;
            placed[fan.kind]++;
            consolidated++;
            convertedThisPass++;
            const hostEntry = forestLedger.find((e) => e.entityId === hostId);
            if (hostEntry) {
                forestLedger.push({ ...hostEntry, kind: fan.kind, entityId: fan.entityId });
            }
        }
        if (convertedThisPass === 0) break;
    }
    if (consolidated > 0) {
        console.log(LOG_PREFIX,
            `Overhang consolidation: ${consolidated} standalone trunks merged into fan trees`);
    }

    // ── Stump pass: none ──────────────────────────────────────────
    // Near-plate contacts place as anchor primitives upstream (tip Z below
    // ANCHOR_HEIGHT_THRESHOLD_MM) and stay standalone.

    const fmtRefusals = (r: Record<string, number | undefined>): string => {
        const entries = Object.entries(r).filter(([, v]) => v !== undefined) as Array<[string, number]>;
        return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k}=${v}`).join(', ');
    };
    console.log(LOG_PREFIX,
        `Placement: ${diagnostics.hostsByKind.gridInfill} ring+infill, ` +
        `${diagnostics.hostsByKind.coverageFill} coverage-fill, ${diagnostics.hostsByKind.standalone} standalone trunks ` +
        `| fan refusals: ${fmtRefusals(diagnostics.fanRefusals)} | merge refusals: ${fmtRefusals(diagnostics.mergeRefusals)} ` +
        `| consolidation refusals: ${fmtRefusals(conRefusals)}`);

    timingEnd('consolidation');
    timingStart('gap-fill');

    // ── Coverage convergence (gap-fill) ─────────────────────────────
    // Footprint-aware: an overhang region is covered when its projected
    // footprint is covered by tips, not just its centroid. Under-covered
    // regions get additional standalone trunks at uncovered footprint
    // clusters (the gridPoint path — region normal, no wrong-face raycast),
    // iterating until the coverage target is met or nothing more places.
    let gapFilledTrunks = 0;
    for (let pass = 0; pass < MAX_GAP_FILL_PASSES; pass++) {
        // Reads the committed store, not the draft: the run's own supports are
        // not counted here. Left as-is deliberately (a worker seeds the store
        // with the pre-run state so it matches the main thread); switching to
        // `draft` converges properly and moves placement by one twig on the
        // signature fixture. See docs/dev/backlog.md.
        const tips = collectSupportTips(getSnapshot());
        const gapCandidates = buildGapFillCandidates(overhangIslands, autoSettings, tips)
            .map((c): CandidatePoint => ({ ...c, modelId }));
        if (gapCandidates.length === 0) break;
        let placedThisPass = 0;
        for (const c of gapCandidates) {
            const kind = placeOne(c) as PlacementOutcomeKind;
            if (kind !== 'reject' && getSupportTypeDescriptor(kind).placementRule?.metric === 'tipHeight') placedThisPass++;
        }
        gapFilledTrunks += placedThisPass;
        if (placedThisPass === 0) break;
    }
    if (gapFilledTrunks > 0) {
        console.log(LOG_PREFIX, `Coverage convergence: ${gapFilledTrunks} gap-fill trunks placed`);
    }

    console.log(LOG_PREFIX,
        `Step 3/3: ${SUPPORT_TYPES.map((d) => `${placed[d.id]}${typeWord(d.id).charAt(0)}`).join(' ')} — ${rejectedCount} rejected ` +
        `| presets: detail=${presets.detail} structure=${presets.structure} anchor=${presets.anchor}`);

    timingEnd('gap-fill');
    timingStart('analytics');

    // ── Coverage analytics ────────────────────────────────────────
    const snapshot = draft;
    const supportedIds = new Set<string>();
    const SUPPORT_COVERAGE_RADIUS_MM = 4.0;
    const covR2 = SUPPORT_COVERAGE_RADIUS_MM * SUPPORT_COVERAGE_RADIUS_MM;

    // Collect all support tips from the post-placement snapshot.
    const allTips: Array<{ x: number; y: number; z: number }> = [];
    allTips.push(...collectContactPositions(snapshot));

    let coveredArea = 0;
    let totalArea = 0;
    for (const island of islands) {
        const area = island.areaMm2 ?? 0;
        totalArea += area;
        // FOOTPRINT coverage: the fraction of the region's contact voxels
        // within the support radius of a tip (the gap-fill's own measure).
        // The old centroid heuristic under-counted big regions — a 20×20
        // grid read 1% covered — which sent the fanning pass after
        // already-supported surfaces (redundant "floating" leaves).
        let fraction: number;
        if (island.contactVoxels && island.contactVoxels.count > 0) {
            fraction = computeRegionCoverage(island, allTips, coverageRadiusForArea(area, SUPPORT_COVERAGE_RADIUS_MM));
        } else {
            // No footprint (minima islands): centroid proximity fallback.
            let hit = false;
            for (const tip of allTips) {
                const dx = island.contact.x - tip.x;
                const dy = island.contact.y - tip.y;
                const dz = island.contact.z - tip.z;
                if (dx * dx + dy * dy + dz * dz <= covR2) {
                    hit = true;
                    break;
                }
            }
            fraction = hit ? 1 : 0;
        }
        coveredArea += area * fraction;
        if (fraction >= 0.9) supportedIds.add(island.id);
    }

    // ── Sizing debug info ───────────────────────────────────────────
    let sizingDebug: AutoPlaceAnalytics['sizingDebug'];
    if (modelCtx && candidates.length > 0) {
        const weightG = modelCtx.modelVolumeMm3 * 0.0011;
        const areas = candidates.map(c => c.islandAreaMm2);
        areas.sort((a, b) => a - b);
        const minArea = areas[0];
        const maxArea = areas[areas.length - 1];
        const avgArea = areas.reduce((s, a) => s + a, 0) / areas.length;
        const zMax = Math.max(...candidates.map(c => c.zHeight), 1);
        // Sample min/max/avg candidates for shaft diameter range.
        const makeSample = (area: number, z: number): CandidatePoint => ({
            id: 'dbg', tipPos: { x: 0, y: 0, z: 0 }, tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '', source: 'voxel', islandAreaMm2: area,
            zHeight: z, priority: 0,
        });
        const sMin = sizeParameters(makeSample(minArea, 10), getSettings().autoSupport?.sizeScale ?? 1);
        const sMax = sizeParameters(makeSample(maxArea, zMax), getSettings().autoSupport?.sizeScale ?? 1);
        const sAvg = sizeParameters(makeSample(avgArea, zMax / 2), getSettings().autoSupport?.sizeScale ?? 1);
        sizingDebug = {
            modelVolumeMm3: Math.round(modelCtx.modelVolumeMm3),
            estimatedWeightG: round2Mm(weightG),
            totalCandidates: modelCtx.totalCandidates,
            // Honest mass share: total model weight divided by the number of
            // placed supports. A load share, not a force estimate.
            weightPerSupportG: round2Mm(placedHostCount() > 0 ? weightG / placedHostCount() : 0),
            avgIslandAreaMm2: round2Mm(avgArea),
            standaloneHosts: diagnostics.hostsByKind.standalone,
            gridInfillHosts: diagnostics.hostsByKind.gridInfill + diagnostics.hostsByKind.coverageFill,
            shaftDiameterRange: {
                min: round2Mm(sMin.shaftDiameterMm ?? 0),
                max: round2Mm(sMax.shaftDiameterMm ?? 0),
                avg: round2Mm(sAvg.shaftDiameterMm ?? 0),
            },
            tipContactRange: {
                min: round2Mm(sMin.tipContactDiameterMm ?? 0),
                max: round2Mm(sMax.tipContactDiameterMm ?? 0),
                avg: round2Mm(sAvg.tipContactDiameterMm ?? 0),
            },
        };
    }

    analytics = {
        islandsCovered: supportedIds.size,
        islandsUncovered: islands.length - supportedIds.size,
        presets,
        rejectionReasons,
        areaCoverage: totalArea > 0 ? coveredArea / totalArea : 0,
        placement: diagnostics,
        sizingDebug,
    };
    console.log(LOG_PREFIX,
        `Coverage: ${analytics.islandsCovered}/${islands.length} islands (${(analytics.areaCoverage * 100).toFixed(0)}% of area). ` +
        `${analytics.islandsUncovered} islands uncovered.`);

    timingEnd('analytics');
    timingStart('fanning');

    // ── Post-placement leaf fanning (iterative convergence) ──────────
    const fanRadiusMm = Math.max(MIN_LEAF_FAN_RADIUS_MM, autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM);
    const fanMaxAngleDeg = Math.min(
        autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
        memberMaxAngleFromVerticalDeg(),
    );

    console.log(LOG_PREFIX,
        `Leaf fanning: ${analytics.islandsUncovered} uncovered islands, ${placedHostCount()} hosts available. ` +
        `Max ${MAX_FANNING_PASSES} passes, fan radius ${fanRadiusMm}mm, max angle ${fanMaxAngleDeg}°.`);

    for (let pass = 0; pass < MAX_FANNING_PASSES && analytics.islandsUncovered > 0; pass++) {
        const shaftPoints = collectFanShaftPoints(draft);
        if (shaftPoints.length === 0) {
            console.log(LOG_PREFIX, `Leaf fanning pass ${pass}: no shaft points — breaking.`);
            break;
        }

        let fannedCount = 0;

        let skippedDist = 0;
        let skippedAngle = 0;
        let skippedSameZ = 0;
        let skippedCross = 0;
        let skippedOther = 0;

        for (const island of islands) {
            if (supportedIds.has(island.id)) continue;
            const fan = fanLeafToHost(
                { x: island.contact.x, y: island.contact.y, z: island.contact.z },
                modelId,
                shaftPoints,
                gridHostIds,
                `auto-fan-${island.id}-p${pass}`,
                fanRadiusMm,
                GRID_HOST_FAN_RADIUS_MM,
                fanMaxAngleDeg,
                autoSettings.maxAttachmentsPerTrunk,
                draft,
                resolvedMesh ?? undefined,
                island.source === 'overhang' ? 'overhang' : 'island',
            );
            if (!fan.ok) {
                if (fan.reason === 'noHost') skippedDist++;
                else if (fan.reason === 'angle') skippedAngle++;
                else if (fan.reason === 'sameZ') skippedSameZ++;
                else if (fan.reason === 'cross') skippedCross++;
                else skippedOther++;
                continue;
            }
            draft = fan.draft;
            fannedCount++;
            placed[fan.kind]++;
            supportedIds.add(island.id);
            coveredArea += (island.areaMm2 ?? 0);
            forestLedger.push({
                displayId: island.id,
                kind: fan.kind,
                entityId: fan.entityId,
                areaMm2: island.areaMm2 ?? 0,
                zHeight: island.contact.z,
                preset: presetForArea(island.areaMm2 ?? 0),
                bandShaftMm: activeSizingBand().shaftDiameterMm,
            });
            console.log(LOG_PREFIX,
                `${typeWord(fan.kind)} (fan p${pass}) ${island.id} → ${typeWord(fan.hostTypeId).toLowerCase()} ${fan.hostId} ` +
                `dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
        }

        if (fannedCount > 0) {
            analytics.islandsCovered += fannedCount;
            analytics.islandsUncovered -= fannedCount;
            analytics.areaCoverage = totalArea > 0 ? coveredArea / totalArea : 0;
            console.log(LOG_PREFIX,
                `Leaf fanning pass ${pass}: ${fannedCount} leaves, ` +
                `${analytics.islandsUncovered} islands still uncovered.`);
        } else {
            console.log(LOG_PREFIX,
                `Leaf fanning pass ${pass}: 0 leaves — ` +
                `${skippedDist} too far (>${fanRadiusMm}mm), ` +
                `${skippedAngle} angle too steep (>${LEAF_FAN_MAX_ANGLE_DEG}°), ` +
                `${skippedSameZ} same Z (can't attach), ` +
                `${skippedCross} crossing another support, ` +
                `${skippedOther} blocked/build/capacity.`);
            break;
        }
    }

    timingEnd('fanning');
    timingStart('surface-coverage');

    // ── Overhang surface coverage ──────────────────────────────────
    // Large flat overhangs need more than one support to distribute
    // peel forces evenly.  Use the island's contactVoxels footprint
    // to place additional supports across the surface.
    const OVERHANG_AREA_THRESHOLD_MM2 = 1.5;
    const OVERHANG_GRID_SPACING_MM = 2.5;

    let overhangSupportsPlaced = 0;
    // A coverage branch is a STUB off a trunk, never a bridge across the
    // island: the same reach a placement fan allows.
    const COVERAGE_STUB_REACH_MM = Math.max(MIN_LEAF_FAN_RADIUS_MM, autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM);
    // Host shafts for the stubs, sampled once. The host set is stable here:
    // the pass only adds branches.
    const stubHosts: Array<{ hostTypeId: SupportTypeId; hostId: string; pos: { x: number; y: number; z: number }; diameter: number }> = [];
    for (const { hostTypeId, hostId, entity } of collectHostEntities(draft)) {
        // Stubs hang off this model's hosts only, like every other fan.
        if (entity.modelId !== modelId) continue;
        const lastSeg = entity.segments[entity.segments.length - 1];
        const knotPos = lastSeg?.topJoint?.pos ?? entity.contactCone?.pos;
        if (!knotPos) continue;
        stubHosts.push({ hostTypeId, hostId, pos: knotPos, diameter: lastSeg?.diameter ?? 1.0 });
    }

    for (const island of islands) {
        // Overhang regions are gridded by the grid phase — this pass covers
        // flat voxel islands only.
        if (island.source === 'overhang') continue;

        const area = island.areaMm2 ?? 0;
        const voxels = island.contactVoxels;
        if (area < OVERHANG_AREA_THRESHOLD_MM2 || !voxels || voxels.count < 3) continue;

        // Compute bounding box of contact voxels.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let vi = 0; vi < voxels.count; vi++) {
            const vx = footprintX(voxels, vi);
            const vy = footprintY(voxels, vi);
            if (vx < minX) minX = vx;
            if (vy < minY) minY = vy;
            if (vx > maxX) maxX = vx;
            if (vy > maxY) maxY = vy;
        }
        const width = maxX - minX;
        const height = maxY - minY;
        if (width < OVERHANG_GRID_SPACING_MM && height < OVERHANG_GRID_SPACING_MM) continue;

        // Place a grid of support points across the footprint.
        const cols = Math.max(2, Math.round(width / OVERHANG_GRID_SPACING_MM));
        const rows = Math.max(2, Math.round(height / OVERHANG_GRID_SPACING_MM));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const gx = minX + (width * (c + 0.5)) / cols;
                const gy = minY + (height * (r + 0.5)) / rows;

                // Check if this grid point is within the voxel footprint
                // (simple containment: near any contact voxel). The nearest
                // footprint voxel also supplies the CELL's surface height —
                // the island's single contact Z used to stamp every cell,
                // leaving stepped islands with tips floating in air.
                let inFootprint = false;
                let cellZ = island.contact.z;
                let cellDist2 = OVERHANG_GRID_SPACING_MM * OVERHANG_GRID_SPACING_MM;
                for (let vi = 0; vi < voxels.count; vi++) {
                    const dx = gx - footprintX(voxels, vi);
                    const dy = gy - footprintY(voxels, vi);
                    const d2 = dx * dx + dy * dy;
                    if (d2 > cellDist2) continue;
                    cellDist2 = d2;
                    inFootprint = true;
                    cellZ = footprintZ(voxels, vi) ?? island.contact.z;
                }
                if (!inFootprint) continue;

                // Skip the centroid (already covered by the island's support).
                const cDist = (gx - island.contact.x) ** 2 + (gy - island.contact.y) ** 2;
                if (cDist < 1.0) continue;

                // Nearest trunk within stub reach. Reach is LATERAL (XY), the
                // same measure the fan radius uses — the trunk stands under
                // the island, so its top joint sits at the contact height and
                // a 3D distance would spend most of the budget on that gap.
                // Walking trunks and stamping the whole bbox from each of
                // them is what produced 10–24 mm near-horizontal branches
                // across the lattice.
                let host: typeof stubHosts[number] | null = null;
                let hostDist2 = COVERAGE_STUB_REACH_MM * COVERAGE_STUB_REACH_MM;
                for (const candidate of stubHosts) {
                    const dx = gx - candidate.pos.x;
                    const dy = gy - candidate.pos.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > hostDist2) continue;
                    hostDist2 = d2;
                    host = candidate;
                }
                if (!host) continue;
                if (isHostAtAttachmentCapacity(host.hostTypeId, host.hostId, autoSettings.maxAttachmentsPerTrunk, draft)) continue;

                try {
                    const resolved = resolveSurfaceNormal({ x: gx, y: gy, z: cellZ }, mesh);
                    // The id carries the host: without it two writers share a
                    // knot id and the earlier branch re-parents onto the later
                    // host (the "dozens of branches on one host" report).
                    const parentKnot = {
                        id: `auto-overhang-${host.hostId}-${island.id}-${r}-${c}`,
                        parentShaftId: host.hostId,
                        pos: host.pos,
                        diameter: host.diameter + 0.1,
                    };
                    const bm: THREE.Mesh | undefined = resolvedMesh ?? undefined;
                    const { branch, supportData: sd } = buildBranchData({
                        tipPos: resolved.point,
                        tipNormal: resolved.normal,
                        modelId,
                        parentKnot,
                        mesh: bm,
                        shaftDiameterMm: activeSizingBand().shaftDiameterMm,
                        tipContactDiameterMm: activeSizingBand().tipContactDiameterMm,
                        rootsDiameterMm: activeSizingBand().rootDiameterMm,
                    });
                    if (sd.error) continue;
                    // Every other member-creating path refuses geometry that
                    // pierces the model; this pass used to stamp it and let
                    // the validator flag it afterwards (blocked members are
                    // reported, not culled).
                    if (bm && branchCollidesWithSDF(branch, bm)) continue;
                    // The tips are voxel-island footprints — island origin.
                    branch.origin = 'island';
                    const memberTypeId = builtMemberTypeId(branch);
                    draft = draftAddPrimitive(draft, 'knots', parentKnot);
                    draft = draftAddEntity(draft, memberTypeId, branch);
                    overhangSupportsPlaced++;
                    placed[memberTypeId]++;
                } catch {
                    // Skip this grid point.
                }
            }
        }
    }

    if (overhangSupportsPlaced > 0) {
        console.log(LOG_PREFIX,
            `Overhang coverage: ${overhangSupportsPlaced} additional branches placed for flat surfaces.`);
    }
    } catch (e) {
        // Safety net: no path here commits mid-run, so the live store still
        // holds the pre-run snapshot — restore it explicitly and report the
        // failure rather than letting a half-built plan escape.
        console.error(LOG_PREFIX,
            `Auto-support failed mid-run — rolling back.`,
            e instanceof Error ? e.message : String(e));
        setSnapshot(before);
        return null;
    }

    const changed = Object.values(placed).some((count) => count > 0);

    timingEnd('surface-coverage');
    timingStart('resize');

    // ------------------------------------------------------------------
    // 4. Forest resize pass — re-derive every trunk's stepwise diameter
    //    profile from its final attachment tree (a trunk carrying four
    //    branches gets thicker; a lone trunk stays at its placed diameter).
    // ------------------------------------------------------------------

    if (changed) {
        try {
            const resized = computeForestDiameterProfile(draft);
            if (resized !== draft) {
                draft = resized;
                console.log(LOG_PREFIX, 'Forest resize pass applied (attachment-loaded trunks thickened).');
            }
            // Legacy fan knots used trunkId as parentShaftId — rehost to the nearest segment so
            // diameter demands and drift checks use segment ids.
            const rehosted = rehostLegacyKnots(draft);
            if (rehosted !== draft) {
                draft = rehosted;
                console.log(LOG_PREFIX, 'Legacy knot rehost: entity id → segment id');
            }
            // Post-resize validation: drift (>0.5mm), cross after thickening, or missing host.
            // This is where the "leaf attached to nowhere" shows up in the report.
            let orphanInfos: OrphanInfo[] = [];
            try {
                const preCullDraft = draft;
                const culled = validateAndCullOrphans(draft, resolvedMesh ?? undefined);
                if (culled.orphans.length > 0) {
                    draft = culled.draft;
                    orphanInfos = culled.orphans;
                    console.log(LOG_PREFIX, `Orphan cull: ${culled.orphans.length} leaves/branches removed — ${culled.orphans.map((o) => `${o.id}:${o.reason}${o.hostId ? `@${o.hostId.slice(0,8)}` : ''}`).join(', ')}`);
                    // Re-place members orphaned by a culled (blocked) host: the
                    // island still needs a support — run it back through
                    // standard placement (merge/fan/trunk decide fresh). Single
                    // pass; re-placed members are not themselves re-queued.
                    const requeue = culled.orphans.filter((o) =>
                        o.reason === 'missingHost' && (o.detail ?? '').includes('host trunk culled'));
                    if (requeue.length > 0) {
                        let replaced = 0;
                        for (const o of requeue) {
                            const member = preCullDraft.leaves[o.id] ?? preCullDraft.branches[o.id];
                            const cone = member?.contactCone;
                            if (!member || !cone?.pos) continue;
                            const recandidate: CandidatePoint = {
                                id: `${o.id}-requeue`,
                                tipPos: cone.pos,
                                tipNormal: cone.surfaceNormal ?? cone.normal,
                                modelId: member.modelId,
                                source: member.origin === 'overhang' ? 'overhang' : 'voxel',
                                islandAreaMm2: 0.05,
                                zHeight: cone.pos.z,
                                priority: 0,
                            };
                            try {
                                const result = placeOneCandidate(recandidate, draft, undefined, gridHostIds, resolvedMesh);
                                draft = result.draft;
                                if (result.kind === 'reject') rejectedCount++;
                                else placed[result.kind]++;
                                if (result.preset) presets[result.preset]++;
                                if (result.entityId && isLedgerKind(result.kind)) {
                                    forestLedger.push({
                                        displayId: recandidate.id,
                                        kind: result.kind,
                                        entityId: result.entityId,
                                        areaMm2: recandidate.islandAreaMm2,
                                        zHeight: recandidate.zHeight,
                                        preset: result.preset ?? presetForArea(recandidate.islandAreaMm2),
                                        bandShaftMm: activeSizingBand().shaftDiameterMm,
                                    });
                                    replaced++;
                                }
                            } catch {
                                rejectedCount++;
                            }
                        }
                        console.log(LOG_PREFIX, `Orphan re-place: ${replaced}/${requeue.length} culled-host members re-placed.`);
                        const recheck = validateAndCullOrphans(draft, resolvedMesh ?? undefined);
                        if (recheck.draft !== draft) {
                            draft = recheck.draft;
                            // The recheck re-reports everything still present
                            // (`cross`/`blocked` are flagged, never culled), so
                            // appending it raw double-counts the ORPHANS
                            // summary. Keep the first classification per entity.
                            const reported = new Set(orphanInfos.map((o) => o.id));
                            orphanInfos = [
                                ...orphanInfos,
                                ...recheck.orphans.filter((o) => !reported.has(o.id)),
                            ];
                        }
                    }
                }
            } catch (e) {
                console.warn(LOG_PREFIX, `Orphan validation failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
            }

            // Cone/shaft sync: the resize and merge passes thicken shafts and
            // rehost members, but a contact cone keeps whatever body diameter
            // it was built with — lagging its (thickened) shaft as a visible
            // step, or ending up wider than the shaft after a transplant.
            // Clicking the support rebuilt the cone from the shaft and
            // "snapped it correct"; do that globally instead of waiting
            // for a click.
            const coneSynced = syncContactConeDiameters(draft);
            if (coneSynced !== draft) {
                draft = coneSynced;
                console.log(LOG_PREFIX, 'Contact cone sync: matched cone bodies to their host shafts.');
            }

            timingEnd('resize');
            timingStart('report');

            // ── Forest Report ───────────────────────────────────────
            // Structured per-run summary: every placed support's id, size,
            // and sizing reasoning, plus the fan-out groups. Shown in the
            // Auto Supports panel; the log gets a one-line summary only.
            const forestReport = buildForestReport(draft, forestLedger);
            const bySource = { voxel: 0, minima: 0, intersection: 0, overhang: 0 };
            for (const island of islands) {
                (bySource as Record<string, number>)[island.source] = ((bySource as Record<string, number>)[island.source] ?? 0) + 1;
            }
            const scanTotalAreaMm2 = islands.reduce((sum, island) => sum + (island.areaMm2 ?? 0), 0);
            forestReport.scan = {
                islands: islands.length,
                bySource,
                overhangRegions: overhangIslands.length,
                anchorClusters: 0,
                anchorRegions: 0,
                candidates: candidates.length,
                totalAreaMm2: scanTotalAreaMm2,
                coveragePercent: analytics.areaCoverage * 100,
                uncoveredIslands: analytics.islandsUncovered,
                rejected: rejectedCount,
                dedupedAway: beforeDedup - dedupedCandidates,
                alreadySupported: beforeSupportFilter - filteredCandidates,
                rejectionReasons: { ...rejectionReasons },
            };
            if (orphanInfos.length > 0) {
                forestReport.orphans = orphanInfos;
            }
            forestReport.diagnostics = {
                candidatesBySource: diagnostics.candidatesBySource,
                hostsByKind: diagnostics.hostsByKind,
                fanRefusals: { ...diagnostics.fanRefusals },
                mergeRefusals: { ...diagnostics.mergeRefusals },
                consolidationRefusals: { ...conRefusals },
                cavityFallbacks: [...diagnostics.cavityFallbacks],
            };
            analytics.forestReport = forestReport;
            console.log(LOG_PREFIX,
                `Forest report: ${forestReport.hostCount} hosts, ${forestReport.leafCount} leaves, ` +
                `${forestReport.branchCount} branches, ${forestReport.stickCount} sticks — ` +
                `${forestReport.trees.length} fan-out trees, ${forestReport.bareHosts.length} bare hosts` +
                (orphanInfos.length > 0 ? ` — ${orphanInfos.length} orphans culled` : ''));
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Forest resize failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    timingEnd('report');
    timingStart('bracing');

    // ------------------------------------------------------------------
    // 5. Auto-bracing (draft-only, folded into the plan)
    // ------------------------------------------------------------------

    if (changed && !autoSettings.debugSkipAutoBracing) {
        console.log(LOG_PREFIX, 'Running auto-brace...');
        try {
            const braceResult = buildAutoBracedSnapshot(draft, getSettings().autoBracing);
            draft = braceResult.snapshot;
            console.log(LOG_PREFIX,
                `Auto-brace: ${braceResult.status} ` +
                `(generated ${braceResult.generatedBraceCount}, removed ${braceResult.removedBraceCount}, ` +
                `skipped ${braceResult.skippedSupportCount})`);
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Auto-brace failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    } else if (changed) {
        console.log(LOG_PREFIX, 'Auto-brace skipped (debug setting).');
    }

    timingEnd('bracing');
    const timings = collectTimings(perfEndFrame());
    if (timings) {
        // The distance field's own counters: the router's probes are most of a
        // run, and this says how much of that was cached.
        if (resolvedMesh) {
            const sdf = getOrCreateSDFCache(resolvedMesh);
            timings.sdf = {
                cellReads: sdf.stats.cellReads,
                bvhQueries: sdf.stats.bvhQueries,
                cachedCells: sdf.size,
                store: sdf.store.kind,
            };
        }
        const router = getRouterStats();
        if (router.placements > 0) timings.router = router;
        analytics.timings = timings;
    }
    logAutoPlaceTimings(timings);

    const result: AutoPlaceResult = {
        ...makeResult(placed, rejectedCount, changed, 'placed'),
        analytics,
    };

    console.log(LOG_PREFIX,
        `Placed ${SUPPORT_TYPES.map((d) => `${placed[d.id]} ${d.label.toLowerCase()}`).join(', ')}. ` +
        `${rejectedCount} rejected. ` +
        `Coverage: ${analytics.islandsCovered}/${islands.length} islands ` +
        `(${(analytics.areaCoverage * 100).toFixed(0)}%).`);

    return {
        before,
        support: draft,
        analytics,
        result,
    };
}

/**
 * Commit a computed plan: one store write and one history entry (supports +
 * braces + kickstands together). Split out so the worker path commits exactly
 * what the in-process path does, and so a `null` plan (auto-support disabled)
 * reports the same result either way.
 */
export function commitAutoPlacePlan(plan: AutoSupportPlan | null): AutoPlaceResult {
    if (!plan) {
        return makeResult(emptyPlacedCounts(), 0, false, 'disabled');
    }

    if (plan.result.changed) {
        // plan.support carries the kickstands now, so one write restores everything.
        setSnapshot(plan.support);
        try {
            pushSupportHistory({
                type: SUPPORT_AUTO_PLACE,
                payload: {
                    before: plan.before,
                    after: plan.support,
                },
            });
            console.log(LOG_PREFIX, 'History entry pushed — undo available.');
        } catch (e) {
            console.warn(LOG_PREFIX,
                `History push failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return plan.result;
}

export function runAutoPlace(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
): AutoPlaceResult {
    return commitAutoPlacePlan(computeAutoSupportPlan(islands, modelId, settingsOverride));
}
