import {
    buildContactOverride,
    contactBridgeTypes,
    contactEndpointsFor,
    getSupportTypeDescriptor,
    GRID_HOST_TYPES,
    isOriginConvertibleToTree,
    resolveSupportTypeIdOf,
    selectTypeForPlacement,
    SHAFT_HOSTED_MEMBER_TYPES,
    SUPPORT_STATE_TYPES,
    SUPPORT_TYPES,
    NEAR_PLATE_ORIGIN,
    parsePrefixedSegmentId,
} from '../supportTypeRegistry';
import type { SupportCollectionKey, ShaftHostedMemberType, ShaftHostedMemberTypeId } from '../supportTypeRegistry';
import type { SupportTypeId } from '../supportTypeRegistry';
import { footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import { memberShaftDiameterMm } from '../constants';
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
import type { AutoSupportSettings, SizingPreset } from './settings';
import type { AutoPlaceTimings } from './types';
import { normalizeAutoSupportSettings, AUTO_SUPPORT_CONSTRAINTS, MIN_CONTACT_TIP_DIAMETER_MM } from './settings';
import { activeSizingBand, applySizingOverridesToSettings, estimateHostCount, TIP_CONTACT_MIN_SHAFT_RATIO } from './parameterSizing';
import { candidateFromIsland, generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { applyContactTipCaps } from './contactTipCap';
import { baseOverhangWindowMm, generateGridCandidates, meshWorldZBounds, shouldUseDensityGrid } from './gridPlacement';
import { computeStabilizationAnchors } from './stabilization';
import { computeMinimaReinforcementPoints } from './minimaReinforcement';
import {
    isSlenderPart,
    measurePoseStability,
    needsToppleCoverage,
    posedPositions,
    STEEP_FLAT_ANCHOR_MIN_AREA_MM2,
    steepFlatNeedsCoverage,
} from './poseStability';
import { getRaftSettingsForModel } from '../Rafts/Crenelated/RaftState';
import { perfEndFrame, perfMark, perfMeasure, type PerfFrame } from '../PlacementLogic/Pathfinding/pathfindingPerf';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { getRouterStats, resetRouterStats } from '../PlacementLogicV3/SmartPlacementV3';
import {
    MAX_GAP_FILL_PASSES,
    buildGapFillCandidates,
    collectSupportTips,
    computeRegionCoverage,
    coverageRadiusForRegion,
    TIP_COVERAGE_RADIUS_MM,
} from './coverage';
import { sizeParameters, presetForArea, modelSizingFactors, RESIN_DENSITY_G_PER_MM3 } from './parameterSizing';
import { computeLoadBudget, type PlacedContact } from './loadBudget';
import { forceDrivenContactCount, selectForceCoveragePoints } from './tractionCovering';
import {
    START_SUPPORT_CONSTANTS,
    assessStartSupport,
    countIslandContacts,
    markStartIslands,
    sameLayerStartTips,
    startFootprintAreaMm2,
    startRecipeForArea,
} from './startIslands';
import type { ModelSizingContext } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { decodeSupportSettingsHex, encodeSupportSettingsHex } from '../Settings/supportSettingsCodec';
import { memberDepartureAngleFromVerticalDeg } from '../PlacementLogic/smartPlacementSearchUtils';

/**
 * Steepest lean from vertical a contact's rendered cone may take. Past this the
 * cone lies within 15° of flat: it pushes the model sideways rather than holding
 * it up, and it reads as a near-horizontal whisker off the model.
 */
import {
    isSideWallContact,
    MAX_SIDE_WALL_CONTACT_LEAN_DEG,
} from '../PlacementLogic/ConeAxisPolicy';
import { DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG } from '../Settings/defaults';
import { cloneSupportState, getSnapshot, setSnapshot } from '../state';
import { createOwnedDraft, draftAddEntity, draftAddPrimitive, draftCommitSupport, draftRemoveEntity, draftRemovePrimitive, draftVersion, bumpDraftVersion, sealOwnedDraft } from './supportDraft';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData, buildTrunkDataFromPlacement } from '../SupportTypes/Trunk/trunkBuilder';
import { getSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import {
    synthesizeTreeClusters,
    findOffsetSilhouetteRoute,
    TWO_LEVEL_BRANCH_REACH_MM,
    MAX_UNBRACED_BRANCH_SPAN_MM,
    MAX_ROUTED_TRUNK_DIAGONAL_SPAN_MM,
    maxEulerBucklingSpanMm,
    maxStableAngleForSpanDeg,
    type TreeSynthesisGridConfig,
} from './treeSynthesis';
import {
    optimizeContactsByTraction,
    type RepresentativeLayerProfile,
    type TractionOptimizationStats,
} from './tractionOptimization';
import {
    buildSupportGraph,
    reinforceOverloadedFrameMembers,
    reinforcementDiameterCapMm,
    solveSupportFrameStress,
} from './supportGraphStress';
import { computeForceBudgetFromGraph, collectForceBudgetSurfaces } from './forceBudget';
import { supportBreakStrengthMpa, DEFAULT_RESIN_TENSILE_STRENGTH_MPA } from './greenMaterialCalibration';
import { buildCavityBridge } from '../SupportTypes/Trunk/useTrunkPlacement';
import { geometryCentroidMm } from '@/features/printing/modelResinVolume';
import { evaluateToppleRisk, ROCKING_THRESHOLD_MM, toppleRiskNeedsCoverage, type ToppleRiskReport } from './toppleRisk';
import { planStressActions } from './stressActions';
import { getCachedRepresentativeLayers } from './frameStressState';
import { createCavityTester, type CavityTester } from '../interiorSupportGeometry';
import { closestSurfaceNormal } from './closestSurfaceNormal';
import { computeForestDiameterProfile, memberDiameterOf } from '../SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import type { BranchBuildInput, BranchBuildResult } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { addTargetedStressBraces, buildAutoBracedSnapshot, BRACE_CANOPY_KEEP_OUT_MM, type StressBraceRequest } from '../autoBracing/autoBrace';
import { buildKickstandData } from '../SupportTypes/Kickstand/kickstandBuilder';
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
    FAN_LINK_TIP_INSET_MM,
    CONSOLIDATION_BRANCH_MIN_HEIGHT_MM,
    MAX_LEAF_SPAN_BEFORE_BRANCH_MM,
    MAX_LEAF_FALLBACK_SPAN_MM,
    MERGE_HOST_LOAD_WEIGHT,
    MAX_CAVITY_BRIDGE_MM,
    MAX_CONSOLIDATION_CONTACTS_PER_CHUNK,
    MIN_TRUNK_SPACING_MM,
} from './constants';

const LOG_PREFIX = '[AutoSupport]';

/** Up to three batched action passes, each followed by a verification solve.
 *  The first pass applies every action it can from one solve; later passes only
 *  run when the verification still reports overload. Converged models stay at
 *  two solves, a residual member gets one more thickening/brace round instead
 *  of being left over the limit. */
const MAX_STRESS_REINFORCE_PASSES = 2;
/** Stress-driven braces a single feedback pass may add. The action list is
 *  severity-ordered; a cap keeps a rocking model from being wrapped at once. */
const MAX_STRESS_BRACES_PER_PASS = 4;
/** Plate buttresses a single feedback pass may add for shafts with no host in
 *  brace reach. A kickstand is the answer for a lone tall spire: it cannot be
 *  braced to a neighbour that does not exist, and it must not be clubbed. */
const MAX_STRESS_KICKSTANDS_PER_PASS = 2;
/** Strut reach for a shaft already at the diameter cap: a capped trunk with no
 *  neighbour inside the aesthetic brace length can still take a longer lateral
 *  tie instead of staying over its limit. Clearance/angle gates still apply. */
const MAX_CAPPED_STRUT_SPAN_MM = 16;
/** Last-resort cap lift for a capped member with no brace, plate strut or
 *  model-coupled bridge. Bounded: a trunk may reach 1.6 mm only in this case;
 *  the normal structure cap stays 1.4 mm. */
const MAX_CAPPED_EXCEPTION_DIA_MM = 1.6;
/** Cross repair is optional geometry hygiene: the local host knot first, then
 *  a bounded number of remote hosts. Unresolved crossings stay flagged; making
 *  every one pay for a forest-wide branch build was the resize phase's cost. */
const MAX_CROSS_REHOST_REMOTE_ATTEMPTS = 8;
const CROSS_REHOST_RADIUS_MM = 8;
/** Overloaded leaves a single feedback pass may promote to branches. */
const MAX_STRESS_LEAF_PROMOTIONS_PER_PASS = 2;
/** Most trunk-build failures retried as wide fans after gap-fill. The retry is
 *  a rescue, not a second placement pass; a run with dozens of blocked pillars
 *  should not spend its budget here. */
const MAX_TRUNK_ERROR_RETRIES = 48;
/** Add→re-evaluate rounds for the per-support force budget after gap-fill. */
/** Contacts a single force-budget round may add, worst-utilization first. */
const MAX_FORCE_BUDGET_ADDS_PER_PASS = 32;
/** Minimum plan distance between a budget addition and an existing contact. */
const MIN_FORCE_BUDGET_ADD_SPACING_MM = 1.2;

/**
 * The steepest angle from vertical an auto member or chunk link may lean —
 * derived from the user's branch-angle rule (`grid.minBranchAngleDeg`, 60°
 * above the horizontal), the same rule the grid engine and the trunk
 * promotion path already enforce on manual branches. Auto members used to
 * ignore it (fan 45°, merge 45° rise, consolidation 75°), which is where the
 * near-level bars came from: a member at 45° from vertical carries almost
 * nothing along its axis and reads as a stray branch off the host.
 */
/** Physical self-supporting photopolymer printability ceiling when grid mode
 *  is off: every member must rise at least 45° above horizontal (≤45° from
 *  vertical), preventing sagging 75° consolidation leaves and overly shallow
 *  off-grid branches while still honoring `leafFanMaxAngleDeg` (45°). */
const OFF_GRID_MAX_MEMBER_ANGLE_FROM_VERTICAL_DEG = 45;

function memberMaxAngleFromVerticalDeg(gridEnabled: boolean = Boolean(getSettings().grid?.enabled)): number {
    if (!gridEnabled) return OFF_GRID_MAX_MEMBER_ANGLE_FROM_VERTICAL_DEG;
    const minRiseDeg = getSettings().grid?.minBranchAngleDeg ?? DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG;
    return Math.max(0, Math.min(90, 90 - minRiseDeg));
}

/** True once a shaft kind is at the diameter the reinforcement pass may reach.
 *  Past it the answer is a shorter span (brace) or a plate buttress (kickstand),
 *  not a fatter pole. */
function memberAtReinforcementCap(draft: SupportState, kind: SupportTypeId, entityId: string): boolean {
    const cap = reinforcementDiameterCapMm(kind);
    if (!(cap > 0)) return false;
    const collection = draft[getSupportTypeDescriptor(kind).location.key] as unknown as
        | Record<string, { segments?: Array<{ diameter?: number }>; contactCone?: { profile?: { bodyDiameterMm?: number } } }>
        | undefined;
    const entity = collection?.[entityId];
    if (!entity) return false;
    if (entity.segments && entity.segments.length > 0) {
        return entity.segments.some((seg) => (seg.diameter ?? 0) >= cap - 1e-3);
    }
    const body = entity.contactCone?.profile?.bodyDiameterMm;
    return typeof body === 'number' && body >= cap - 1e-3;
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
/** The angle and length of a branch's shaft leaving its host knot. */
function branchDepartureShaftExceedsStability(
    branch: Branch,
    knotPos: { x: number; y: number; z: number },
    baseMaxAngleDeg: number,
    shaftDiameterMm: number,
): boolean {
    const firstJoint = branch.segments[0]?.topJoint?.pos;
    if (!firstJoint) return false;
    const shaftLenMm = Math.hypot(
        firstJoint.x - knotPos.x,
        firstJoint.y - knotPos.y,
        firstJoint.z - knotPos.z,
    );
    const depAngleDeg = memberDepartureAngleFromVerticalDeg(knotPos, firstJoint);
    return depAngleDeg > maxStableAngleForSpanDeg(shaftLenMm, baseMaxAngleDeg, shaftDiameterMm);
}

/** The angle this branch's shaft leaves its host at. 0 when it has no joints yet. */
function branchDepartureAngleDeg(
    branch: Branch,
    knotPos: { x: number; y: number; z: number },
): number {
    const firstJoint = branch.segments[0]?.topJoint?.pos;
    if (!firstJoint) return 0;
    return memberDepartureAngleFromVerticalDeg(knotPos, firstJoint);
}

/**
 * True when an auto-placed routed trunk contains an angled diagonal leg that
 * exceeds the cantilever stability envelope (`MAX_ROUTED_TRUNK_DIAGONAL_SPAN_MM`
 * or `maxStableAngleForSpanDeg`). Vertical risers (`lateral <= 0.5 mm`) are always
 * stable and skipped.
 */
function trunkHasUnstableDiagonal(
    trunk: { segments: Array<{ diameter?: number; bottomJoint?: { pos: Vec3 } | null; topJoint?: { pos: Vec3 } | null }>; contactCone?: { pos: Vec3 } },
    root: { transform: { pos: Vec3 }; diskHeight?: number; coneHeight?: number } | undefined,
    baseMaxAngleDeg: number,
): boolean {
    let prevPos: Vec3 | undefined = root
        ? {
            x: root.transform.pos.x,
            y: root.transform.pos.y,
            z: root.transform.pos.z + (root.diskHeight ?? 0) + (root.coneHeight ?? 0),
        }
        : undefined;

    for (const seg of trunk.segments ?? []) {
        const start = seg.bottomJoint?.pos ?? prevPos;
        const end = seg.topJoint?.pos ?? trunk.contactCone?.pos;
        if (start && end) {
            const lateral = Math.hypot(end.x - start.x, end.y - start.y);
            if (lateral > 0.5) {
                const vertical = Math.abs(end.z - start.z);
                const span = Math.hypot(lateral, vertical);
                const segDia = seg.diameter ?? 1.0;
                const maxSpan = Math.min(MAX_ROUTED_TRUNK_DIAGONAL_SPAN_MM, maxEulerBucklingSpanMm(segDia));
                const angleDeg = vertical > 1e-4 ? (Math.atan2(lateral, vertical) * 180) / Math.PI : 90;
                if (
                    span > maxSpan
                    || angleDeg > maxStableAngleForSpanDeg(span, baseMaxAngleDeg, segDia * 1.19) + 0.5
                ) {
                    return true;
                }
            }
            prevPos = end;
        }
    }
    return false;
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
    mesh.updateMatrixWorld();
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
    return Math.abs(vol) * Math.abs(mesh.matrixWorld.determinant());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stamp an explicit per-point tip diameter ceiling (`maxContactDiameterMm`) onto a
 * contact cone ONLY when `tipDiameterMm !== undefined`. Uncapped cones leave
 * `maxContactDiameterMm` undefined so `syncContactConeDiameters` may raise them
 * to the 20%-of-shaft floor.
 */
function applyExplicitTipCapToCone(
    cone: ContactCone | undefined,
    tipDiameterMm: number | undefined,
): ContactCone | undefined {
    if (!cone || tipDiameterMm === undefined) return cone;
    const capped = Math.max(MIN_CONTACT_TIP_DIAMETER_MM, tipDiameterMm);
    return {
        ...cone,
        profile: {
            ...cone.profile,
            contactDiameterMm: Math.min(cone.profile.contactDiameterMm ?? capped, capped),
            maxContactDiameterMm: capped,
        },
    };
}

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
    contactCone?: { pos: Vec3; normal?: Vec3; profile?: { maxContactDiameterMm?: number } };
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

/**
 * Drop the pillar a chunk-consolidation link replaced, plus its root.
 *
 * The link was built against a draft in which the pillar still stood (it is
 * excluded from the search by id), so the removal happens here, once the build
 * has succeeded. Deleting from the owned draft keeps the collection's key order
 * for every other host, which a copy-then-delete shuffle would not.
 */
function removeConvertedHost(
    draft: SupportState,
    hostTypeId: SupportTypeId,
    hostId: string,
    rootId: string | undefined,
): SupportState {
    let next = draftRemoveEntity(draft, hostTypeId, hostId);
    if (rootId) next = draftRemovePrimitive(next, 'roots', rootId);
    return next;
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
): { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number }; hit: boolean } {
    if (!mesh) {
        return { point: tipPos, normal: { x: 0, y: 0, z: -1 }, hit: false };
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
            hit: true,
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
            hit: true,
        };
    }

    // Fallback: keep the existing normal. `hit` says so, so the steepness
    // check can ask the nearest triangle instead of trusting "down".
    return { point: tipPos, normal: { x: 0, y: 0, z: -1 }, hit: false };
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
export function collectContactPositions(snapshot: SupportState, modelId?: string): Array<{ x: number; y: number; z: number }> {
    const positions: Array<{ x: number; y: number; z: number }> = [];

    for (const descriptor of SUPPORT_TYPES) {
        const collection = snapshot[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;
        for (const entity of Object.values(collection ?? {})) {
            if (modelId !== undefined && entity.modelId !== modelId) continue;
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
function filterAlreadySupported(candidates: CandidatePoint[], draft: SupportState, modelId?: string): CandidatePoint[] {
    const snapshot = draft;
    const existingTips: Array<{ x: number; y: number; z: number }> = [];

    existingTips.push(...collectContactPositions(snapshot, modelId));

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

/** The origin each candidate source stamps on the support it builds. Declared
 *  as a table so a new source is a compile error here rather than a silent
 *  'island'; `convertibleToTree` on that origin is what lets the consolidation
 *  pass chunk the support later. */
const ORIGIN_BY_SOURCE: Record<CandidatePoint['source'], SupportOrigin> = {
    voxel: 'island',
    minima: 'island',
    intersection: 'island',
    overhang: 'standalone',
    stabilization: 'island',
    reinforcement: 'reinforcement',
};

function hostedOriginForSource(source: CandidatePoint['source']): SupportOrigin {
    return source === 'overhang' ? 'overhang' : ORIGIN_BY_SOURCE[source];
}

/** Find the closest existing host (shaft or tip) within merge radius.
 *  Stump-origin entities never host merges: they are load-bearing standalone
 *  pillars, leaves are not. */
export function findMergeHost(
    tipPos: { x: number; y: number; z: number },
    modelId: string,
    draft: SupportState,
): MergeHost | null {
    const snapshot = draft;
    const reach2 = GRIDLESS_MERGE_RADIUS_MM * GRIDLESS_MERGE_RADIUS_MM;
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

        // Reach is measured in PLAN, the way the fan measures it. The
        // attachment is chosen on the host's SHAFT, by the knot search below
        // that owns the rise and angle rules; this search only says which
        // hosts are candidates. Measured in 3D, every legal attachment point
        // fell outside a ball drawn around the tip, because a joint ten
        // millimetres down a neighbouring pillar is ten millimetres away even
        // when the pillar stands three millimetres away on the plate. Two
        // pillars of equal height, the common case on a mini, reported `noHost`
        // and stood as two plate contacts. Height is not a gate here at all: a
        // candidate level with, or above, a host's joints still attaches lower
        // down its shaft. Ranking stays on the 3D span, so the shorter, steeper
        // link wins.

        // Check the host's tip (contact cone).
        const tp = entity.contactCone?.pos;
        if (tp) {
            const dx = tipPos.x - tp.x;
            const dy = tipPos.y - tp.y;
            if (dx * dx + dy * dy <= reach2) {
                const dz = tipPos.z - tp.z;
                const score = scoreFor(hostTypeId, hostId, dx * dx + dy * dy + dz * dz);
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
            if (dx * dx + dy * dy > reach2) continue;
            const dz = tipPos.z - jp.z;
            const adjustedD2 = (dx * dx + dy * dy + dz * dz) * 0.9;
            const score = scoreFor(hostTypeId, hostId, adjustedD2);
            if (score < bestScore) {
                bestScore = score;
                best = { hostTypeId, hostId, tipPos: jp };
            }
        }
    }
    return best;
}

/**
 * Build a hosted branch at the host-relative floor, retrying at the profile
 * band when the thicker member is refused.
 *
 * `memberShaftDiameterMm` is a fit rule for the visible step at the knot, not a
 * licence to lose a link: a member that clears the site's gates at its band
 * diameter is placed exactly as it was before the floor existed, and one that
 * clears thick keeps the floor. `rejected` is the site's *clearance* gate (build
 * error, SDF collision) — the only one the shaft diameter can move: the
 * departure angle, the cross check and the host capacity are properties of the
 * chord and the snapshot, identical at either diameter, so they stay where they
 * were, after the build. Evaluated twice at most. Returns null when neither
 * diameter passes — the site's own refusal, unchanged.
 */
function buildHostedBranch(
    input: Omit<BranchBuildInput, 'shaftDiameterMm'>,
    bandShaftMm: number,
    hostDiameterMm: number,
    rejected: (built: BranchBuildResult) => boolean,
    autoSettings?: Partial<AutoSupportSettings>,
): BranchBuildResult | null {
    const hostRatio = autoSettings?.memberHostShaftRatio
        ?? getSettings().autoSupport?.memberHostShaftRatio
        ?? AUTO_SUPPORT_CONSTRAINTS.memberHostShaftRatio.defaultValue;
    const flooredShaftMm = memberShaftDiameterMm(bandShaftMm, hostDiameterMm, hostRatio);
    const floored = buildBranchData({ ...input, shaftDiameterMm: flooredShaftMm });
    if (!rejected(floored)) return floored;
    if (flooredShaftMm <= bandShaftMm) return null;
    const atBand = buildBranchData({ ...input, shaftDiameterMm: bandShaftMm });
    return rejected(atBand) ? null : atBand;
}

export interface LeafPromotionResult {
    draft: SupportState;
    promoted: boolean;
    reason?: 'missingLeaf' | 'missingKnot' | 'buildFailed' | 'unstable' | 'crosses';
}

/** Host entity that owns a knot's parent shaft, inside the draft (the global
 *  lookup cannot see an uncommitted draft). */
function shaftOwnerInDraft(draft: SupportState, shaftId: string): string {
    if (draft.trunks[shaftId] || draft.branches[shaftId] || draft.sticks[shaftId]
        || draft.kickstands[shaftId] || draft.stumps[shaftId]) {
        return shaftId;
    }
    const prefixed = parsePrefixedSegmentId(shaftId);
    if (prefixed) return prefixed.entityId;
    const collections = [draft.trunks, draft.branches, draft.sticks, draft.kickstands, draft.stumps];
    for (const collection of collections) {
        for (const entity of Object.values(collection ?? {})) {
            if ((entity.segments ?? []).some((segment: { id: string }) => segment.id === shaftId)) return entity.id;
        }
    }
    return shaftId;
}

/**
 * Replace an overloaded leaf with a branch on the same host knot.
 *
 * A leaf is a bare tapered cone with no shaft, so neither thickening (the cone
 * body caps) nor bracing (a brace needs a shaft to knot onto) can fix it. The
 * branch keeps the same parent knot and contact point but gains real segments,
 * which the reinforcement loop can then thicken or the brace loop can tie.
 * The replacement frees and reuses one host attachment, so host capacity is
 * unchanged.
 */
export function promoteOverloadedLeaf(
    draft: SupportState,
    leafId: string,
    mesh: THREE.Mesh | undefined,
    autoSettings: Partial<AutoSupportSettings>,
): LeafPromotionResult {
    const leaf = draft.leaves[leafId];
    if (!leaf) return { draft, promoted: false, reason: 'missingLeaf' };
    const knot = draft.knots[leaf.parentKnotId];
    if (!knot) return { draft, promoted: false, reason: 'missingKnot' };

    const band = activeSizingBand(autoSettings);
    const tipNormal = leaf.contactCone.surfaceNormal ?? leaf.contactCone.normal;
    try {
        const built = buildHostedBranch(
            {
                tipPos: leaf.contactCone.pos,
                tipNormal,
                modelId: leaf.modelId,
                parentKnot: knot,
                mesh,
                tipContactDiameterMm: leaf.contactCone.profile?.contactDiameterMm
                    ?? band.tipContactDiameterMm,
                rootsDiameterMm: band.rootDiameterMm,
            },
            band.shaftDiameterMm,
            knot.diameter ?? band.shaftDiameterMm,
            (attempt) => Boolean(attempt.supportData.error)
                || Boolean(mesh && branchCollidesWithSDF(attempt.branch, mesh)),
            autoSettings,
        );
        if (!built) return { draft, promoted: false, reason: 'buildFailed' };
        if (branchDepartureShaftExceedsStability(
            built.branch,
            knot.pos,
            Math.min(50, memberMaxAngleFromVerticalDeg(false)),
            band.shaftDiameterMm,
        )) {
            return { draft, promoted: false, reason: 'unstable' };
        }
        if (branchPathCrossesSupports(
            built.branch,
            draft,
            shaftOwnerInDraft(draft, knot.parentShaftId),
            undefined,
            leafId,
            knot.pos,
        )) {
            return { draft, promoted: false, reason: 'crosses' };
        }

        built.branch.origin = leaf.origin ?? 'overhang';
        if (leaf.generatedBy) built.branch.generatedBy = leaf.generatedBy;
        let next = draftRemoveEntity(draft, 'leaf', leafId);
        next = draftAddEntity(next, 'branch', built.branch);
        return { draft: next, promoted: true };
    } catch {
        return { draft, promoted: false, reason: 'buildFailed' };
    }
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
    /** Hosts still standing in `pruned` that this link replaces; see
     *  `leafPathCrossesSupports`. */
    excludeHostIds?: ReadonlySet<string>;
    autoSettings?: Partial<AutoSupportSettings>;
    tipDiameterMm?: number;
    gridEnabled?: boolean;
    origin?: SupportOrigin;
}): { draft: SupportState; branchId: string; kind: AttachmentKind } | null {
    const { tip, tipNormal, modelId, pool, pruned, mesh, radiusMm, maxAttachments, knotId, excludeHostIds, autoSettings, tipDiameterMm, gridEnabled, origin } = args;

    // Steepest eligible host sample (≤ the branch-angle rule from vertical —
    // the leaf fan's cap is looser). Steepest, not nearest: the contact cone
    // is clamped to the surface normal, so the shaft loses its last couple of
    // millimeters of rise to the cone bend and a link picked at the angle cap
    // always leaves the host a few degrees too flat. Reaching further down the
    // shaft buys that rise back; the angle cap keeps the link short anyway.
    const bandShaftDiaMm = activeSizingBand(autoSettings).shaftDiameterMm;
    const maxBranchBuckleMm = maxEulerBucklingSpanMm(bandShaftDiaMm);
    let best: FanShaftPoint | null = null;
    let bestAngleDeg = Infinity;
    let currentHostId: string | null = null;
    let currentHostModelId: string | undefined;
    for (const sp of pool) {
        // Same rule as the leaf fan: only this model's shafts can host.
        // Resolved once per host: the pool holds samples in host order.
        if (sp.hostId !== currentHostId) {
            currentHostId = sp.hostId;
            currentHostModelId = excludeHostIds?.has(sp.hostId)
                ? undefined
                : hostEntityOf(pruned, sp.hostTypeId, sp.hostId)?.modelId;
        }
        if (currentHostModelId !== modelId) continue;
        const ddx = sp.pos.x - tip.x;
        const ddy = sp.pos.y - tip.y;
        const ddz = sp.pos.z - tip.z;
        const spanSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (spanSq > radiusMm * radiusMm) continue;
        const spanMm = Math.sqrt(spanSq);
        if (spanMm > maxBranchBuckleMm) continue;
        const vDist = tip.z - sp.pos.z;
        if (vDist < 1.5) continue;
        const angleDeg = (Math.atan2(Math.hypot(ddx, ddy), vDist) * 180) / Math.PI;
        const maxAllowedAngle = maxStableAngleForSpanDeg(spanMm, Math.min(50, memberMaxAngleFromVerticalDeg(gridEnabled)), bandShaftDiaMm);
        if (angleDeg > maxAllowedAngle) continue;
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
        const band = activeSizingBand(autoSettings);
        const cappedTip = tipDiameterMm !== undefined
            ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, tipDiameterMm)
            : undefined;
        const built = buildHostedBranch(
            {
                tipPos: tip,
                tipNormal,
                modelId,
                parentKnot,
                mesh,
                tipContactDiameterMm: cappedTip ?? band.tipContactDiameterMm,
                rootsDiameterMm: band.rootDiameterMm,
            },
            band.shaftDiameterMm,
            best.diameter,
            (attempt) => Boolean(attempt.supportData.error)
                || Boolean(mesh && branchCollidesWithSDF(attempt.branch, mesh)),
            autoSettings,
        );
        if (!built) return null;
        if (branchDepartureShaftExceedsStability(built.branch, parentKnot.pos, Math.min(50, memberMaxAngleFromVerticalDeg(gridEnabled)), bandShaftDiaMm)) return null;
        if (branchPathCrossesSupports(built.branch, pruned, best.hostId, excludeHostIds, undefined, parentKnot.pos)) return null;

        if (cappedTip !== undefined && built.branch.contactCone) {
            built.branch.contactCone = applyExplicitTipCapToCone(built.branch.contactCone, cappedTip);
        }
        let d = draftAddPrimitive(pruned, 'knots', parentKnot);
        built.branch.origin = origin ?? 'overhang';
        const memberTypeId = builtMemberTypeId(built.branch);
        d = draftAddEntity(d, memberTypeId, built.branch);
        return { draft: d, branchId: built.branch.id, kind: memberTypeId };
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
    autoSettings: AutoSupportSettings | undefined,
    gridHostIds?: ReadonlySet<string>,
    mesh?: THREE.Mesh,
    sizingCtx?: ModelSizingContext,
    /**
     * Place this candidate as if grid mode were off. Set by the retry below, and
     * never by the caller's own request: the run's grid setting still decides
     * whether other candidates are node placements.
     */
    ignoreGrid = false,
    preResolvedCandidates?: WeakSet<CandidatePoint>,
    deferUnstableRoutedTrunk = false,
    cavity?: CavityTester,
): { kind: PlacementOutcomeKind; draft: SupportState; rejectedReason?: RejectReason; preset?: 'detail' | 'structure' | 'anchor'; entityId?: string; stickCount?: number; fanRefusal?: FanLeafRefusal; mergeRefusal?: 'noHost' | 'rejected'; cavityFanRefusal?: string; gridFallback?: boolean } {
    const supportSettings = getSettings();
    const auto: Partial<AutoSupportSettings> = autoSettings ?? supportSettings.autoSupport ?? {};
    const gridEnabled = supportSettings.grid?.enabled === true && !ignoreGrid;
    const snapshot = draft;
    let d = draft;

    // Grid points carry the region's exact surface position and normal (from
    // the classifier's own triangles, world space). Re-resolving via a
    // whole-mesh raycast hits the wrong face on sloped geometry (side walls
    // below the region face at the same XY), so trust the region data.
    const resolved = (preResolvedCandidates?.has(candidate)
        || (candidate.gridPoint && candidate.tipNormal && candidate.tipNormal.z < 0))
        ? { point: candidate.tipPos, normal: candidate.tipNormal }
        : resolveSurfaceNormal(candidate.tipPos, mesh);
    const tipPos = resolved.point;
    const tipNormal = resolved.normal;

    // Determine preset band for analytics + empirical sizing.
    const area = candidate.islandAreaMm2;
    const preset = presetForArea(area);

    if (candidate.interior) {
        // Internal support: the only legal shape is a bridge that stays in the
        // cavity. A plate trunk would leave through a wall or a bore, which is
        // what put supports through the shell.
        const band = activeSizingBand(auto);
        const bridgeSizing = sizeParameters(candidate, auto.sizeScale ?? 1, sizingCtx, auto);
        const cappedBridgeTip = candidate.tipDiameterMm !== undefined
            ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm)
            : (bridgeSizing.tipContactDiameterMm ?? band.tipContactDiameterMm);
        const bridge = mesh
            ? buildCavityBridge(tipPos, tipNormal, candidate.modelId, mesh, {
                shaftDiameterMm: bridgeSizing.shaftDiameterMm ?? band.shaftDiameterMm,
                tipContactDiameterMm: cappedBridgeTip,
            })
            : null;
        if (bridge) {
            d = draftAddEntity(d, bridge.kind, bridge.entity);
            logPlacement(`${bridge.kind} (interior) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
            return { kind: bridge.kind, preset, draft: d, entityId: bridge.entity.id };
        }
        logPlacement(`Rejected ${candidate.id}: interior tip has no cavity surface within reach`);
        return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
    }

    // The fan pool is a walk of every host segment with its 10 samples, and
    // this function asks for it up to three times (island fan, overhang fan,
    // cavity fan) against an unchanged draft. Build it once, lazily — each
    // attempt returns as soon as it succeeds, so nothing mutates in between.
    // Keep only hosts whose plan distance can reach any of those tiers; the
    // widest is the cavity rescue.
    let fanPool: FanShaftPoint[] | null = null;
    const fanPoolRadiusMm = Math.max(
        LEAF_FAN_RADIUS_MM,
        auto.leafFanRadiusMm ?? 0,
        GRID_HOST_FAN_RADIUS_MM,
        CAVITY_FAN_RADIUS_MM,
    );
    const fanShaftPoints = (): FanShaftPoint[] => (fanPool ??= collectFanShaftPoints(
        draft,
        { x: tipPos.x, y: tipPos.y },
        fanPoolRadiusMm,
    ));

    // ── Gridless merge check ──────────────────────────────────────
    // Density-grid points force standalone trunks (a flat region needs
    // independent supports, not a bush of branches off one shaft).
    let mergeHostFound = false;
    let fanRefusal: FanLeafRefusal | undefined;
    if (!gridEnabled) {
        // Grid/poisson points fan into ISLAND trunks only (hosts not placed
        // from gridPoint candidates). Only ORGANIC Poisson + coverage-fill
        // points — flat-lattice grid infill and the anchor band stay
        // standalone (peel distribution). A pillar standing next to an island
        // trunk attaches as a leaf instead of duplicating it; grid points
        // never attach to other grid trunks.
        if (candidate.gridPoint && candidate.source === 'overhang' && gridHostIds
            && !candidate.id.startsWith('grid-')) {
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
                    Math.min(auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG, memberMaxAngleFromVerticalDeg(gridEnabled)),
                    auto.maxAttachmentsPerTrunk ?? 12,
                    draft,
                    mesh,
                    'overhang',
                    undefined,
                    undefined,
                    undefined,
                    auto,
                    candidate.tipDiameterMm,
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
    // Stabilization anchors attach only while the brace pass is running.
    // Their job is to resist topple, and a member off a rooted host resists
    // the same moment with one plate contact instead of one per tooth. With
    // bracing off nothing else holds that moment, so an anchor stays a
    // standalone buttress and keeps the base it widens; merging it there
    // would trade the only thing resisting the tip for a shorter member.
    // Reinforcement points are ordinary contacts that happen to ring a
    // minima, so they attach like any island contact in either case: the
    // minima's own tip pillar is 2.5mm away, and a crown of leaves on it
    // leaves ONE plate contact instead of seven. Ringing them standalone was
    // the rule until a mini report showed 18 of its 61 bare trunks were ring
    // points, all within 5mm of each other.
    const anchorsMayAttach = candidate.source !== 'stabilization'
        || auto.debugSkipAutoBracing !== true;
    if (!gridEnabled && !candidate.gridPoint && anchorsMayAttach) {
        // Overhang-derived candidates (sub-threshold, non-anchor regions)
        // attach via the regular leaf-fanning path — a standalone straight
        // trunk next to fan leaves reads as a misplaced island support. No
        // host in fan range → fall through to the merge/trunk fallbacks.
        if (candidate.source === 'overhang' && gridHostIds) {
            const fan = fanLeafToHost(
                tipPos,
                candidate.modelId,
                fanShaftPoints(),
                gridHostIds,
                `auto-fan-${candidate.id}`,
                Math.max(MIN_LEAF_FAN_RADIUS_MM, auto.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                GRID_HOST_FAN_RADIUS_MM,
                Math.min(auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG, memberMaxAngleFromVerticalDeg(gridEnabled)),
                auto.maxAttachmentsPerTrunk ?? 12,
                draft,
                mesh,
                'overhang',
                undefined,
                undefined,
                undefined,
                auto,
                candidate.tipDiameterMm,
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
                90 - memberMaxAngleFromVerticalDeg(gridEnabled),
            );
            const MAX_MERGE_ATTACH_SPAN_MM = 12;
            // Walk the host span in fixed steps from its top and take the FIRST
            // sample that clears the steep minimum: that is the highest legal
            // knot, and the member ends up as short as the rule allows. It used
            // to take the highest of 11 fixed fractions, which on a 20mm shaft
            // lands up to 2mm below the rung it was after — enough to push a
            // member across the 6mm leaf/branch threshold by sampling error
            // alone. A ring contact 2.5mm off its pillar measured 6.9mm instead
            // of its 5.0mm minimum, became a branch, and the branch's first
            // segment left the host at 45° from vertical, which the angle rule
            // refuses — so the contact stood alone. 0.5mm keeps that error well
            // inside the threshold.
            const ATTACH_SEARCH_STEP_MM = 0.5;
            const MAX_ATTACH_SAMPLES = 256;
            let maxRiseDeg = 0;
            if (hostEntity) {
                for (const seg of hostEntity.segments) {
                    // The SAME span the drift check measures against — a knot
                    // placed on any other line is culled as an orphan.
                    const span = hostSegmentSpan(snapshot, hostEntity, seg);
                    if (!span) continue;
                    const { start, end } = span;
                    const spanMm = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
                    const steps = Math.max(1, Math.min(
                        MAX_ATTACH_SAMPLES,
                        Math.ceil(spanMm / ATTACH_SEARCH_STEP_MM),
                    ));
                    for (let i = steps; i >= 0; i--) {
                        const t = i / steps;
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
                        // First legal sample from the top of this segment is the
                        // highest one it can offer.
                        break;
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
                            const cappedTip = candidate.tipDiameterMm !== undefined
                                ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm)
                                : undefined;
                            const { leaf, supportData: sd } = buildLeafData({
                                tipPos,
                                surfaceNormal: tipNormal,
                                modelId: candidate.modelId,
                                parentKnot,
                                // Cone body = the HOST shaft, not the knot —
                                // otherwise the cone's wide base swallows the
                                // junction ball and the knot stays invisible.
                                hostDiameterMm: knotDiameter,
                                tipContactDiameterMm: cappedTip ?? activeSizingBand(auto).tipContactDiameterMm,
                                mesh,
                            });
                            if (cappedTip !== undefined) {
                                leaf.contactCone = applyExplicitTipCapToCone(leaf.contactCone, cappedTip)!;
                            }
                            if (sd.error) {
                                logPlacement(
                                    `Leaf (merge) ${candidate.id}: sd.error, trying branch...`);
                            } else if (mesh && contactConeCollides(parentKnot.pos, leaf.contactCone, mesh)) {
                                logPlacement(
                                    `Leaf (merge) ${candidate.id}: triangle collision, trying branch...`);
                            } else {
                                const cap = auto.maxAttachmentsPerTrunk ?? 12;
                                if (isHostAtAttachmentCapacity(host.hostTypeId, host.hostId, cap, draft)) {
                                    logPlacement(
                                        `Merge skip ${candidate.id}: host ${host.hostId} at capacity (${cap} attachments)`);
                                    // fall through to standalone trunk
                                } else {
                                    d = draftAddPrimitive(d, 'knots', parentKnot);
                                    leaf.origin = hostedOriginForSource(candidate.source);
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
                    const mergeBandDiaMm = activeSizingBand(auto).shaftDiameterMm;
                    const maxMergeSpanMm = maxEulerBucklingSpanMm(mergeBandDiaMm);
                    const maxMergeAngleDeg = maxStableAngleForSpanDeg(
                        leafSpanMm,
                        Math.min(50, memberMaxAngleFromVerticalDeg(gridEnabled)),
                        mergeBandDiaMm,
                    );
                    if (leafSpanMm > maxMergeSpanMm || mergeAngleDeg > maxMergeAngleDeg) {
                        logPlacement(
                            `Merge skip ${candidate.id}: cantilever unstable (${mergeAngleDeg.toFixed(0)}° > ${maxMergeAngleDeg.toFixed(0)}° @ span=${leafSpanMm.toFixed(1)}mm)`);
                    } else try {
                        const band = activeSizingBand(auto);
                        const cappedTip = candidate.tipDiameterMm !== undefined
                            ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm)
                            : undefined;
                        const built = buildHostedBranch(
                            {
                                tipPos, tipNormal, modelId: candidate.modelId, parentKnot, mesh,
                                tipContactDiameterMm: cappedTip ?? band.tipContactDiameterMm,
                                rootsDiameterMm: band.rootDiameterMm,
                            },
                            band.shaftDiameterMm,
                            knotDiameter,
                            (attempt) => Boolean(attempt.supportData.error)
                                || Boolean(mesh && branchCollidesWithSDF(attempt.branch, mesh)),
                            auto,
                        );
                        if (!built) {
                            logPlacement(`Branch (merge) ${candidate.id}: collision, falling back`);
                        } else if (branchDepartureShaftExceedsStability(built.branch, knotPos, Math.min(50, memberMaxAngleFromVerticalDeg(gridEnabled)), mergeBandDiaMm)) {
                            logPlacement(
                                `Merge skip ${candidate.id}: shaft leaves the host too flat ` +
                                `(${branchDepartureAngleDeg(built.branch, knotPos).toFixed(0)}° from vertical) span=${leafSpanMm.toFixed(1)}mm`);
                        } else {
                            const cap = auto.maxAttachmentsPerTrunk ?? 12;
                            if (isHostAtAttachmentCapacity(host.hostTypeId, host.hostId, cap, draft)) {
                                logPlacement(
                                    `Merge skip ${candidate.id}: host ${host.hostId} at capacity (${cap} attachments)`);
                                // fall through to standalone trunk
                            } else {
                                if (cappedTip !== undefined && built.branch.contactCone) {
                                    built.branch.contactCone = applyExplicitTipCapToCone(built.branch.contactCone, cappedTip);
                                }
                                d = draftAddPrimitive(d, 'knots', parentKnot);
                                built.branch.origin = hostedOriginForSource(candidate.source);
                                const memberTypeId = builtMemberTypeId(built.branch);
                                d = draftAddEntity(d, memberTypeId, built.branch);
                                const ma = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                                logPlacement(
                                    `Branch (merge) ${candidate.id} → ${typeWord(host.hostTypeId).toLowerCase()} ${host.hostId} ` +
                                    `span=${leafSpanMm.toFixed(1)}mm angle=${ma.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                                return { kind: memberTypeId, preset, draft: d, entityId: built.branch.id };
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
        auto.sizeScale ?? 1,
        sizingCtx,
        auto,
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
        ignoreGrid,
    });
    if (candidate.tipDiameterMm !== undefined && trunkResult.trunk.contactCone) {
        trunkResult.trunk = {
            ...trunkResult.trunk,
            contactCone: applyExplicitTipCapToCone(trunkResult.trunk.contactCone, candidate.tipDiameterMm),
        };
    }
    // A pillar through a drain hole is geometrically clear, so the mesh tests
    // cannot refuse it. Treat it like a blocked plate route: re-plan onto a
    // cavity fan/bridge, and reject only if neither can serve the tip without
    // crossing the cavity itself.
    const trunkCrossesCavity = !trunkResult.error && cavity
        ? crossesCavityBoundary(rawCavityPaths(trunkResult.trunk), cavity, candidate.modelId)
        : false;
    // A near-plate type builds different geometry. Its own validation, not an
    // unused out-of-bounds trunk, decides whether that contact can be served.
    const claimedType = trunkResult.error === 'OUT_OF_BOUNDS'
        ? selectTypeForPlacement('tipHeight', tipPos.z)
        : null;
    const deferToTypeOverride = claimedType ? Boolean(buildContactOverride(claimedType)) : false;
    if ((trunkResult.error || trunkCrossesCavity) && !deferToTypeOverride) {
        // Cavity fallback: if the trunk can't reach the build plate (or would
        // thread a cavity opening), try bridging to a lower surface with a
        // Stick (model-to-model) or carry the tip on a nearby host.
        if ((trunkResult.error === 'COLLISION_WITH_MODEL' || trunkCrossesCavity) && mesh) {
            // Before bridging model-to-model, try to carry the tip as a fan
            // leaf on a nearby host. A jaw tip whose straight pillar pierces
            // the chest often has a trunk within 5 mm that can host it — that
            // reads as a regular tree, not a "stick under the jaw". The trunk
            // build's COLLISION_WITH_MODEL means "no plate route found", not
            // "nowhere to attach".
            let cavityFanRefusal: string | undefined;
            try {
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
                    auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
                    auto.maxAttachmentsPerTrunk ?? 12,
                    draft,
                    mesh,
                    hostedOriginForSource(candidate.source),
                    'steepest',
                    MAX_UNBRACED_BRANCH_SPAN_MM,
                    undefined,
                    auto,
                    candidate.tipDiameterMm,
                );
                if (fan.ok) {
                    const fanEntity = supportEntityById(fan.draft, fan.kind, fan.entityId);
                    const fanCrossesCavity = cavity && fanEntity
                        ? crossesCavityBoundary(memberCavityPaths(fan.draft, fan.kind, fanEntity), cavity, candidate.modelId)
                        : false;
                    if (!fanCrossesCavity) {
                        const fanKind = typeWord(fan.kind);
                        logPlacement(`${fanKind} (cavity-fan) ${candidate.id} → ${typeWord(fan.hostTypeId).toLowerCase()} ${fan.hostId} dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                        return { kind: fan.kind, preset, draft: fan.draft, entityId: fan.entityId };
                    }
                    cavityFanRefusal = 'cavityCross';
                } else {
                    // Carry the numbers: `noHost` cannot say whether there was
                    // no host at all or only a far one, and that decides whether
                    // the reach is the lever or the angle gate is.
                    const nearest = fan.nearestHostMm;
                    const steep = fan.nearestSteepMm;
                    cavityFanRefusal = nearest === undefined
                        ? fan.reason
                        : `${fan.reason} (nearest ${nearest.toFixed(1)}mm plan${
                            steep === undefined
                                ? ', no legal host'
                                : `, nearest legal ${steep.toFixed(1)}mm @ ${(fan.steepAngleDeg ?? 0).toFixed(0)}°`
                        })`;
                }
            } catch {}
            const band = activeSizingBand(auto);
            const cappedBridgeTip = candidate.tipDiameterMm !== undefined
                ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm)
                : (overrides.tipContactDiameterMm ?? band.tipContactDiameterMm);
            const cavityResult = buildCavityBridge(tipPos, tipNormal, candidate.modelId, mesh, {
                shaftDiameterMm: overrides.shaftDiameterMm ?? band.shaftDiameterMm,
                tipContactDiameterMm: cappedBridgeTip,
            });
            if (cavityResult && cavity
                && crossesCavityBoundary(memberCavityPaths(draft, cavityResult.kind, cavityResult.entity), cavity, candidate.modelId)) {
                logPlacement(`Cavity ${cavityResult.kind} rejected (crosses the cavity boundary) ${candidate.id}`);
            } else if (cavityResult) {
                // Keep short cavity twigs but cap long bridges at 12mm; a
                // rejected tip is reconsidered by fan/merge in a later pass.
                const entity = cavityResult.entity;
                const record = entity as unknown as Record<string, { pos?: Vec3 } | undefined>;
                let maxSpanMm = -1;
                for (const { field } of contactEndpointsFor(cavityResult.kind)) {
                    const p = record[field]?.pos;
                    if (!p) continue;
                    const d = Math.hypot(tipPos.x - p.x, tipPos.y - p.y, tipPos.z - p.z);
                    if (d > maxSpanMm) maxSpanMm = d;
                }
                const bridgeLen = maxSpanMm >= 0 ? maxSpanMm : null;

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
        const failureReason = trunkResult.error ?? 'CAVITY_SHOOT_THROUGH';
        logPlacement(
            `Rejected ${candidate.id}: trunk build error \"${failureReason}\" ` +
            `tip=(${tipPos.x.toFixed(1)},${tipPos.y.toFixed(1)},${tipPos.z.toFixed(1)}) ` +
            `mesh=${mesh ? 'yes' : 'no'} ` +
            `bbox=${bbox ? `(${bbox.min.x.toFixed(0)},${bbox.min.y.toFixed(0)},${bbox.min.z.toFixed(0)})-(${bbox.max.x.toFixed(0)},${bbox.max.y.toFixed(0)},${bbox.max.z.toFixed(0)})` : 'none'}`);
        return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
    }

    // Side-wall guard at placement time: do not build a trunk whose contact
    // points sideways. Previously this was a post-resize cull that orphaned
    // leaves; rejecting at placement prevents the trunk and its leaves from
    // ever being created.
    //
    // Measured on the cone the contact will render, not on the raw normal, and
    // held to one bound: a cone leaning past 75° from vertical lies within 15°
    // of flat, which is the "near-horizontal cone" this refuses. Minima used to
    // get 85° and kept contacts at 80.8° whose cones render sideways; under
    // `adaptive` those same contacts now measure ~69° (the policy tilts the axis
    // toward the plate) and stay.
    {
        const n = trunkResult.trunk.contactCone?.normal ?? trunkResult.trunk.contactCone?.surfaceNormal;
        if (n) {
            const settings = getSettings();
            if (isSideWallContact(n, settings.tip.coneAngleMode ?? 'normal', settings.tip.adaptiveConeAngleOffsetDeg)) {
                logPlacement(`Rejected ${candidate.id}: side-wall trunk too shallow (cone within ${90 - MAX_SIDE_WALL_CONTACT_LEAN_DEG}° of flat)`);
                return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
            }
        }
    }

    // Cantilever stability guard on routed trunks: `SmartPlacementV3` can route a
    // long 45° diagonal detour around a lower obstacle (e.g. a 12 mm sideways boom
    // across a limb). During Pass 2a/2b (`deferUnstableRoutedTrunk`), defer it to
    // Phase 3 rescue so a stable steep branch or compact silhouette dogleg wins;
    // on final fallback, prefer a short `<= MAX_CAVITY_BRIDGE_MM` bridge when available,
    // keeping the routed trunk only as last resort so no island is left uncovered.
    if (
        mesh
        && !deferToTypeOverride
        && trunkHasUnstableDiagonal(
            trunkResult.trunk,
            trunkResult.root,
            Math.max(OFF_GRID_MAX_MEMBER_ANGLE_FROM_VERTICAL_DEG, memberMaxAngleFromVerticalDeg(gridEnabled)),
        )
    ) {
        if (deferUnstableRoutedTrunk) {
            logPlacement(`Deferred ${candidate.id}: routed trunk diagonal exceeds cantilever stability envelope`);
            return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
        }
        const band = activeSizingBand(auto);
        const cappedBridgeTip = candidate.tipDiameterMm !== undefined
            ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm)
            : (overrides.tipContactDiameterMm ?? band.tipContactDiameterMm);
        const cavityResult = buildCavityBridge(tipPos, tipNormal, candidate.modelId, mesh, {
            shaftDiameterMm: overrides.shaftDiameterMm ?? band.shaftDiameterMm,
            tipContactDiameterMm: cappedBridgeTip,
        });
        if (cavityResult) {
            const entity = cavityResult.entity;
            const record = entity as unknown as Record<string, { pos?: Vec3 } | undefined>;
            let maxSpanMm = -1;
            for (const { field } of contactEndpointsFor(cavityResult.kind)) {
                const p = record[field]?.pos;
                if (!p) continue;
                const dist = Math.hypot(tipPos.x - p.x, tipPos.y - p.y, tipPos.z - p.z);
                if (dist > maxSpanMm) maxSpanMm = dist;
            }
            if (maxSpanMm >= 0 && maxSpanMm <= MAX_CAVITY_BRIDGE_MM) {
                d = draftAddEntity(d, cavityResult.kind, entity);
                logPlacement(`${cavityResult.kind} (unstable-diagonal-bridge) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                return { kind: cavityResult.kind, preset, draft: d, entityId: entity.id };
            }
        }
    }

    // Route through the standard grid placement engine.
    // This handles grid snapping, SDF collision checks, host-trunk
    // attachment (branch/leaf), anchor short-circuit, and rejection.
    const decision = decideGridPlacement({
        settings: gridEnabled ? supportSettings : { ...supportSettings, grid: { ...supportSettings.grid, enabled: false } },
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
                const cap = auto.maxAttachmentsPerTrunk ?? 12;
                if (isHostAtAttachmentCapacity(hostedBy.typeId, hostedBy.id, cap, draft)) {
                    logPlacement(
                        `Grid skip ${candidate.id}: host ${hostedBy.id} at capacity (${cap})`);
                    return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
                }
            }

            // Whether this type records an origin is declared.
            const entity = { ...placed.entity } as typeof placed.entity & {
                origin?: SupportOrigin;
                contactCone?: ContactCone;
                settingsCodeHex?: string;
            };
            if (getSupportTypeDescriptor(typeId).hasOrigin) {
                entity.origin = candidate.gridPoint ? 'overhang' : ORIGIN_BY_SOURCE[candidate.source];
            }
            if (candidate.tipDiameterMm !== undefined && entity.contactCone) {
                const capped = Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm);
                entity.contactCone = applyExplicitTipCapToCone(entity.contactCone, capped);
                if (typeof entity.settingsCodeHex === 'string' && entity.settingsCodeHex.length > 0) {
                    const decoded = decodeSupportSettingsHex(entity.settingsCodeHex, supportSettings) ?? supportSettings;
                    entity.settingsCodeHex = encodeSupportSettingsHex(
                        applySizingOverridesToSettings(decoded, { tipContactDiameterMm: capped }),
                    );
                }
            }
            d = draftCommitSupport(d, typeId, entity, supplied);
            logPlacement(
                `${typeWord(typeId)} ${candidate.id} @ grid ${decision.nodeKey} ` +
                `area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm ${preset}` +
                (fanRefusal ? ` fan:${fanRefusal}` : '') +
                (mergeHostFound ? ' merge:rejected' : ''));
            const mergeChecked = !gridEnabled && !candidate.gridPoint;
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
            if (gridEnabled) {
                // The lattice could not serve this tip: its node and the ones
                // near it were occupied, unreachable, or refused by the
                // attachment gates. The tip still needs a support, so it is
                // retried with the grid off for this candidate alone before it
                // counts as rejected. That retry cannot recurse: it passes
                // `ignoreGrid`, which leaves `gridEnabled` false inside.
                const fallback = placeOneCandidate(
                    candidate, draft, autoSettings, gridHostIds, mesh, sizingCtx, true, preResolvedCandidates,
                    false, cavity,
                );
                logPlacement(fallback.kind === 'reject'
                    ? `Grid fallback failed ${candidate.id}: ${fallback.rejectedReason}`
                    : `Grid fallback placed ${candidate.id} as ${fallback.kind} (no lattice node could take it)`);
                return fallback.kind === 'reject' ? fallback : { ...fallback, gridFallback: true };
            }
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
 *
 * `excludedHostIds` is for a host that is about to be REPLACED by the link it
 * is being tested for (chunk consolidation): it still stands in the draft while
 * the link is built, so it has to be ignored here or every link would cross
 * the pillar it is converting.
 */
/**
 * Fast AABB + segment distance test against an obstacle segment `(start, end)`.
 */
function pathIntersectsSegment(
    pMinX: number,
    pMinY: number,
    pMinZ: number,
    pMaxX: number,
    pMaxY: number,
    pMaxZ: number,
    pStart: { x: number; y: number; z: number },
    pEnd: { x: number; y: number; z: number },
    pathRadiusMm: number,
    segStart: { x: number; y: number; z: number },
    segEnd: { x: number; y: number; z: number },
    segRadiusMm: number,
): boolean {
    const clearance = pathRadiusMm + segRadiusMm;
    const sMinX = Math.min(segStart.x, segEnd.x);
    const sMaxX = Math.max(segStart.x, segEnd.x);
    if (pMaxX + clearance < sMinX || pMinX - clearance > sMaxX) return false;
    const sMinY = Math.min(segStart.y, segEnd.y);
    const sMaxY = Math.max(segStart.y, segEnd.y);
    if (pMaxY + clearance < sMinY || pMinY - clearance > sMaxY) return false;
    const sMinZ = Math.min(segStart.z, segEnd.z);
    const sMaxZ = Math.max(segStart.z, segEnd.z);
    if (pMaxZ + clearance < sMinZ || pMinZ - clearance > sMaxZ) return false;
    return segmentDistanceSq(pStart, pEnd, segStart, segEnd) < clearance * clearance;
}

/**
 * True when a segment (`knotPos → tipPos`) passes within `leafRadiusMm + segRadiusMm`
 * of any OTHER support member across the forest:
 * - all host shafts (`trunks` / `GRID_HOST_TYPES`, resolving bottom root spans via `hostSegmentSpan`),
 * - all `branches` (actual segments),
 * - all `leaves` (knot → cone body),
 * - all `braces` (knot → knot),
 * trimming the root `<= 0.6 mm` launch zone on same-host sibling branches/leaves so
 * non-overlapping members fanning off one trunk never false-trigger at the host surface.
 *
 * `excludedHostIds` ignores hosts about to be replaced (chunk consolidation / trunk merge).
 * `excludeMemberId` ignores the entity currently being re-validated or re-hosted.
 */

/** A broad-phase record for the support-vs-path crossing test. The exact
 *  pathIntersectsSegment checks are unchanged; this only narrows which
 *  supports are worth testing. `hostSegmentSpan` runs once per draft, not once
 *  per fan host and candidate. */
type LeafPathRecord =
    | {
        kind: 'host';
        id: string;
        hostTypeId: SupportTypeId;
        segments: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; radius: number }>;
        minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
    }
    | {
        kind: 'branch';
        id: string;
        parentShaftId?: string;
        segments: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; radius: number }>;
        minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
    }
    | {
        kind: 'leaf';
        id: string;
        parentShaftId?: string;
        parentKnotPos: { x: number; y: number; z: number };
        tip: { x: number; y: number; z: number };
        bodyDiameterMm: number;
        minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
    }
    | {
        kind: 'brace';
        id: string;
        a: { x: number; y: number; z: number };
        b: { x: number; y: number; z: number };
        radius: number;
        minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
    };

interface LeafPathIndex {
    records: LeafPathRecord[];
    buckets: Map<string, number[]>;
}

const LEAF_PATH_CELL_MM = 8;
const leafPathIndexCache = new WeakMap<SupportState, { version: number; index: LeafPathIndex }>();

function leafPathCellKey(ix: number, iy: number, iz: number): string {
    return `${ix},${iy},${iz}`;
}

function buildLeafPathIndex(draft: SupportState): LeafPathIndex {
    const records: LeafPathRecord[] = [];
    const push = (record: LeafPathRecord) => { records.push(record); };

    for (const descriptor of GRID_HOST_TYPES) {
        const collection = draft[descriptor.location.key] as unknown as
            Record<string, { rootId?: string; parentKnotId?: string; segments: Segment[]; contactCone?: { pos: { x: number; y: number; z: number } } }> | undefined;
        if (!collection) continue;
        for (const candidateId in collection) {
            const entity = collection[candidateId];
            const segments: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; radius: number }> = [];
            let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (const seg of entity.segments ?? []) {
                const span = hostSegmentSpan(draft, entity, seg);
                if (!span) continue;
                const radius = (seg.diameter ?? 1.0) * 0.5;
                segments.push({ start: span.start, end: span.end, radius });
                minX = Math.min(minX, span.start.x - radius, span.end.x - radius);
                minY = Math.min(minY, span.start.y - radius, span.end.y - radius);
                minZ = Math.min(minZ, span.start.z - radius, span.end.z - radius);
                maxX = Math.max(maxX, span.start.x + radius, span.end.x + radius);
                maxY = Math.max(maxY, span.start.y + radius, span.end.y + radius);
                maxZ = Math.max(maxZ, span.start.z + radius, span.end.z + radius);
            }
            if (segments.length > 0) {
                push({ kind: 'host', id: candidateId, hostTypeId: descriptor.id, segments, minX, minY, minZ, maxX, maxY, maxZ });
            }
        }
    }

    const knots = draft.knots ?? {};
    for (const branchId in draft.branches ?? {}) {
        const branch = draft.branches[branchId];
        if (!branch) continue;
        const parentShaftId = branch.parentKnotId ? knots[branch.parentKnotId]?.parentShaftId : undefined;
        const segments: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; radius: number }> = [];
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const seg of branch.segments ?? []) {
            const span = hostSegmentSpan(draft, branch, seg);
            if (!span) continue;
            const radius = (seg.diameter ?? 0.9) * 0.5;
            segments.push({ start: span.start, end: span.end, radius });
            minX = Math.min(minX, span.start.x - radius, span.end.x - radius);
            minY = Math.min(minY, span.start.y - radius, span.end.y - radius);
            minZ = Math.min(minZ, span.start.z - radius, span.end.z - radius);
            maxX = Math.max(maxX, span.start.x + radius, span.end.x + radius);
            maxY = Math.max(maxY, span.start.y + radius, span.end.y + radius);
            maxZ = Math.max(maxZ, span.start.z + radius, span.end.z + radius);
        }
        if (segments.length > 0) {
            push({ kind: 'branch', id: branchId, parentShaftId, segments, minX, minY, minZ, maxX, maxY, maxZ });
        }
    }

    for (const leafId in draft.leaves ?? {}) {
        const leaf = draft.leaves[leafId];
        const tip = leaf?.contactCone?.pos;
        const parentKnot = leaf?.parentKnotId ? knots[leaf.parentKnotId] : undefined;
        if (!tip || !parentKnot) continue;
        const bodyDiameterMm = leaf.contactCone.profile?.bodyDiameterMm ?? 0.8;
        const radius = Math.max(0.18, bodyDiameterMm * 0.25);
        push({
            kind: 'leaf',
            id: leafId,
            parentShaftId: parentKnot.parentShaftId,
            parentKnotPos: parentKnot.pos,
            tip,
            bodyDiameterMm,
            minX: Math.min(parentKnot.pos.x, tip.x) - radius,
            minY: Math.min(parentKnot.pos.y, tip.y) - radius,
            minZ: Math.min(parentKnot.pos.z, tip.z) - radius,
            maxX: Math.max(parentKnot.pos.x, tip.x) + radius,
            maxY: Math.max(parentKnot.pos.y, tip.y) + radius,
            maxZ: Math.max(parentKnot.pos.z, tip.z) + radius,
        });
    }

    for (const braceId in draft.braces ?? {}) {
        const brace = draft.braces[braceId];
        if (!brace) continue;
        const a = knots[brace.startKnotId]?.pos;
        const b = knots[brace.endKnotId]?.pos;
        if (!a || !b) continue;
        const radius = (brace.profile?.diameter ?? 0.9) * 0.5;
        push({
            kind: 'brace', id: braceId, a, b, radius,
            minX: Math.min(a.x, b.x) - radius,
            minY: Math.min(a.y, b.y) - radius,
            minZ: Math.min(a.z, b.z) - radius,
            maxX: Math.max(a.x, b.x) + radius,
            maxY: Math.max(a.y, b.y) + radius,
            maxZ: Math.max(a.z, b.z) + radius,
        });
    }

    const buckets = new Map<string, number[]>();
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const x0 = Math.floor(r.minX / LEAF_PATH_CELL_MM);
        const x1 = Math.floor(r.maxX / LEAF_PATH_CELL_MM);
        const y0 = Math.floor(r.minY / LEAF_PATH_CELL_MM);
        const y1 = Math.floor(r.maxY / LEAF_PATH_CELL_MM);
        const z0 = Math.floor(r.minZ / LEAF_PATH_CELL_MM);
        const z1 = Math.floor(r.maxZ / LEAF_PATH_CELL_MM);
        for (let ix = x0; ix <= x1; ix++) {
            for (let iy = y0; iy <= y1; iy++) {
                for (let iz = z0; iz <= z1; iz++) {
                    const key = leafPathCellKey(ix, iy, iz);
                    const list = buckets.get(key);
                    if (list) list.push(i);
                    else buckets.set(key, [i]);
                }
            }
        }
    }
    return { records, buckets };
}

function queryLeafPathIndex(index: LeafPathIndex, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): LeafPathRecord[] {
    const x0 = Math.floor(minX / LEAF_PATH_CELL_MM);
    const x1 = Math.floor(maxX / LEAF_PATH_CELL_MM);
    const y0 = Math.floor(minY / LEAF_PATH_CELL_MM);
    const y1 = Math.floor(maxY / LEAF_PATH_CELL_MM);
    const z0 = Math.floor(minZ / LEAF_PATH_CELL_MM);
    const z1 = Math.floor(maxZ / LEAF_PATH_CELL_MM);
    const seen = new Set<number>();
    const out: LeafPathRecord[] = [];
    for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
            for (let iz = z0; iz <= z1; iz++) {
                const list = index.buckets.get(leafPathCellKey(ix, iy, iz));
                if (!list) continue;
                for (const idx of list) {
                    if (seen.has(idx)) continue;
                    seen.add(idx);
                    const r = index.records[idx];
                    if (r.maxX < minX || r.minX > maxX || r.maxY < minY || r.minY > maxY || r.maxZ < minZ || r.minZ > maxZ) continue;
                    out.push(r);
                }
            }
        }
    }
    return out;
}

function leafPathIndexFor(draft: SupportState): LeafPathIndex {
    const version = draftVersion(draft);
    const cached = leafPathIndexCache.get(draft);
    if (cached && cached.version === version) return cached.index;
    const index = buildLeafPathIndex(draft);
    leafPathIndexCache.set(draft, { version, index });
    return index;
}

/**
 * Does the line from a knot to a leaf tip cross any other support?
 *
 * A cached broad phase (one WeakMap per draft) narrows the support set by the
 * path's AABB; the exact `pathIntersectsSegment` checks and same-host trimming
 * below are unchanged. Fanning asks this once per candidate host, so walking
 * every support segment there made placement O(candidates × supports).
 */
export function leafPathCrossesSupports(
    knotPos: { x: number; y: number; z: number },
    tipPos: { x: number; y: number; z: number },
    leafRadiusMm: number,
    draft: SupportState,
    hostId: string | null,
    excludedHostIds?: ReadonlySet<string>,
    excludeMemberId?: string,
): boolean {
    const pMinX = Math.min(knotPos.x, tipPos.x);
    const pMaxX = Math.max(knotPos.x, tipPos.x);
    const pMinY = Math.min(knotPos.y, tipPos.y);
    const pMaxY = Math.max(knotPos.y, tipPos.y);
    const pMinZ = Math.min(knotPos.z, tipPos.z);
    const pMaxZ = Math.max(knotPos.z, tipPos.z);

    const dx = tipPos.x - knotPos.x;
    const dy = tipPos.y - knotPos.y;
    const dz = tipPos.z - knotPos.z;
    const spanLen = Math.hypot(dx, dy, dz);
    const trimFrac = spanLen > 0.5 ? Math.min(0.45, 1.5 / spanLen) : 0;
    const trimmedStart = trimFrac > 0
        ? { x: knotPos.x + dx * trimFrac, y: knotPos.y + dy * trimFrac, z: knotPos.z + dz * trimFrac }
        : knotPos;
    const tMinX = Math.min(trimmedStart.x, tipPos.x);
    const tMaxX = Math.max(trimmedStart.x, tipPos.x);
    const tMinY = Math.min(trimmedStart.y, tipPos.y);
    const tMaxY = Math.max(trimmedStart.y, tipPos.y);
    const tMinZ = Math.min(trimmedStart.z, tipPos.z);
    const tMaxZ = Math.max(trimmedStart.z, tipPos.z);

    const sameHostSegmentIds = new Set<string>();
    if (hostId) {
        sameHostSegmentIds.add(hostId);
        const hostTrunk = draft.trunks?.[hostId];
        if (hostTrunk) {
            for (const s of hostTrunk.segments ?? []) sameHostSegmentIds.add(s.id);
        } else {
            const hostBranch = draft.branches?.[hostId];
            if (hostBranch) {
                for (const s of hostBranch.segments ?? []) sameHostSegmentIds.add(s.id);
            }
        }
    }

    const excludeOwnSegmentIds = new Set<string>();
    if (excludeMemberId) {
        excludeOwnSegmentIds.add(excludeMemberId);
        const exBranch = draft.branches?.[excludeMemberId];
        if (exBranch) {
            for (const s of exBranch.segments ?? []) excludeOwnSegmentIds.add(s.id);
        } else {
            const exTrunk = draft.trunks?.[excludeMemberId];
            if (exTrunk) {
                for (const s of exTrunk.segments ?? []) excludeOwnSegmentIds.add(s.id);
            }
        }
    }

    const trimSameHostStart = (
        start: { x: number; y: number; z: number },
        end: { x: number; y: number; z: number },
    ) => {
        const sx = end.x - start.x;
        const sy = end.y - start.y;
        const sz = end.z - start.z;
        const len = Math.hypot(sx, sy, sz);
        const frac = len > 0.5 ? Math.min(0.45, 1.5 / len) : 0;
        return frac > 0
            ? { x: start.x + sx * frac, y: start.y + sy * frac, z: start.z + sz * frac }
            : start;
    };

    const index = leafPathIndexFor(draft);
    const candidates = queryLeafPathIndex(
        index,
        pMinX - leafRadiusMm, pMinY - leafRadiusMm, pMinZ - leafRadiusMm,
        pMaxX + leafRadiusMm, pMaxY + leafRadiusMm, pMaxZ + leafRadiusMm,
    );

    for (const record of candidates) {
        if (record.kind === 'host') {
            if (record.id === hostId || record.id === excludeMemberId) continue;
            if (excludedHostIds?.has(record.id)) continue;
            for (const seg of record.segments) {
                if (pathIntersectsSegment(
                    pMinX, pMinY, pMinZ, pMaxX, pMaxY, pMaxZ,
                    knotPos, tipPos, leafRadiusMm,
                    seg.start, seg.end, seg.radius,
                )) return true;
            }
            continue;
        }

        if (record.kind === 'branch') {
            if (record.id === hostId || record.id === excludeMemberId) continue;
            if (excludedHostIds?.has(record.id)) continue;
            const parentShaftId = record.parentShaftId;
            if (parentShaftId && (excludedHostIds?.has(parentShaftId) || excludeOwnSegmentIds.has(parentShaftId))) continue;
            const sameHost = Boolean(parentShaftId && sameHostSegmentIds.has(parentShaftId));
            const rStart = sameHost ? trimmedStart : knotPos;
            const rMinX = sameHost ? tMinX : pMinX;
            const rMaxX = sameHost ? tMaxX : pMaxX;
            const rMinY = sameHost ? tMinY : pMinY;
            const rMaxY = sameHost ? tMaxY : pMaxY;
            const rMinZ = sameHost ? tMinZ : pMinZ;
            const rMaxZ = sameHost ? tMaxZ : pMaxZ;
            for (let segIdx = 0; segIdx < record.segments.length; segIdx++) {
                const seg = record.segments[segIdx];
                const segStart = sameHost && segIdx === 0 ? trimSameHostStart(seg.start, seg.end) : seg.start;
                const pathR = sameHost ? Math.min(leafRadiusMm, 0.18) : leafRadiusMm;
                const segRadius = sameHost ? 0.18 : seg.radius;
                if (pathIntersectsSegment(
                    rMinX, rMinY, rMinZ, rMaxX, rMaxY, rMaxZ,
                    rStart, tipPos, pathR,
                    segStart, seg.end, segRadius,
                )) return true;
            }
            continue;
        }

        if (record.kind === 'leaf') {
            if (record.id === excludeMemberId) continue;
            if (excludedHostIds?.has(record.parentShaftId ?? '') || excludeOwnSegmentIds.has(record.parentShaftId ?? '')) continue;
            const sameHost = Boolean(record.parentShaftId && sameHostSegmentIds.has(record.parentShaftId));
            const rStart = sameHost ? trimmedStart : knotPos;
            const rMinX = sameHost ? tMinX : pMinX;
            const rMaxX = sameHost ? tMaxX : pMaxX;
            const rMinY = sameHost ? tMinY : pMinY;
            const rMaxY = sameHost ? tMaxY : pMaxY;
            const rMinZ = sameHost ? tMinZ : pMinZ;
            const rMaxZ = sameHost ? tMaxZ : pMaxZ;
            const sibStart = sameHost ? trimSameHostStart(record.parentKnotPos, record.tip) : record.parentKnotPos;
            const pathR = sameHost ? Math.min(leafRadiusMm, 0.18) : leafRadiusMm;
            const effRadius = sameHost ? 0.18 : Math.max(0.18, record.bodyDiameterMm * 0.25);
            if (pathIntersectsSegment(
                rMinX, rMinY, rMinZ, rMaxX, rMaxY, rMaxZ,
                rStart, tipPos, pathR,
                sibStart, record.tip, effRadius,
            )) return true;
            continue;
        }

        if (record.id === excludeMemberId) continue;
        if (pathIntersectsSegment(
            pMinX, pMinY, pMinZ, pMaxX, pMaxY, pMaxZ,
            knotPos, tipPos, leafRadiusMm,
            record.a, record.b, record.radius,
        )) return true;
    }

    return false;
}

/**
 * Multi-segment crossing check for a hosted Branch (every shaft segment plus
 * final contact cone chord) against all other supports in the draft.
 */
export function branchPathCrossesSupports(
    branch: { id?: string; parentKnotId?: string; segments: Segment[]; contactCone?: { pos: { x: number; y: number; z: number }; profile?: { bodyDiameterMm?: number } } },
    draft: SupportState,
    hostId: string | null,
    excludedHostIds?: ReadonlySet<string>,
    excludeMemberId?: string,
    parentKnotPos?: { x: number; y: number; z: number },
): boolean {
    const memberExclude = excludeMemberId ?? branch.id;
    let lastEnd: { x: number; y: number; z: number } | undefined =
        parentKnotPos ?? (branch.parentKnotId ? draft.knots?.[branch.parentKnotId]?.pos : undefined);
    let lastRadius = 0.25;

    for (const seg of branch.segments ?? []) {
        const span = hostSegmentSpan(draft, branch, seg);
        const segStart = span?.start ?? seg.bottomJoint?.pos ?? lastEnd;
        const segEnd = span?.end ?? seg.topJoint?.pos ?? branch.contactCone?.pos;
        if (!segStart || !segEnd) continue;
        const segRadius = Math.max(0.2, (seg.diameter ?? 0.9) * 0.5);
        if (leafPathCrossesSupports(segStart, segEnd, segRadius, draft, hostId, excludedHostIds, memberExclude)) {
            return true;
        }
        lastEnd = segEnd;
        lastRadius = segRadius;
    }

    const tipPos = branch.contactCone?.pos;
    if (tipPos && lastEnd && Math.hypot(tipPos.x - lastEnd.x, tipPos.y - lastEnd.y, tipPos.z - lastEnd.z) > 1e-3) {
        const coneRadius = Math.max(0.18, (branch.contactCone?.profile?.bodyDiameterMm ?? lastRadius * 2) * 0.25);
        if (leafPathCrossesSupports(lastEnd, tipPos, coneRadius, draft, hostId, excludedHostIds, memberExclude)) {
            return true;
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
export function collectFanShaftPoints(
    draft: SupportState,
    near?: { x: number; y: number },
    radiusMm?: number,
): FanShaftPoint[] {
    const shaftPoints: FanShaftPoint[] = [];
    for (const { hostTypeId, hostId, entity } of collectHostEntities(draft)) {
        if (entity.origin === NEAR_PLATE_ORIGIN) continue;
        for (const seg of entity.segments ?? []) {
            // Resolve through hostSegmentSpan so bottom segments (which rise
            // from the root top with no bottomJoint entity) are sampled along
            // the exact same line validateAndCullOrphans checks. Segments with
            // neither joints nor a root/cone anchor still return null.
            const span = hostSegmentSpan(draft, entity, seg);
            if (!span) continue;
            const { start, end } = span;
            if (near && radiusMm !== undefined) {
                // Only segments whose plan distance to the tip can put a
                // sample inside the fan radius. Without this every candidate
                // walked every host segment's 10 samples; the fan was the
                // dominant placement cost on a few-hundred-support forest.
                const sx = end.x - start.x;
                const sy = end.y - start.y;
                const lenSq = sx * sx + sy * sy;
                const t = lenSq > 1e-9
                    ? Math.min(1, Math.max(0, ((near.x - start.x) * sx + (near.y - start.y) * sy) / lenSq))
                    : 0;
                const dx = start.x + sx * t - near.x;
                const dy = start.y + sy * t - near.y;
                if (dx * dx + dy * dy > radiusMm * radiusMm) continue;
            }
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
 * Sample upper shaft points (`t ∈ [0.35, 0.90]`) on placed Branches for
 * 2-level `Trunk -> Branch -> Leaf` crown attachments. Excludes the lowest
 * 35% of the branch shaft so child leaves sprout near the upper crown rather
 * than bunching onto the trunk's parent knot.
 */
export function collectBranchFanShaftPoints(
    draft: SupportState,
    modelId: string,
    onlyBranchIds?: ReadonlySet<string>,
): FanShaftPoint[] {
    const shaftPoints: FanShaftPoint[] = [];
    for (const [branchId, branch] of Object.entries(draft.branches ?? {})) {
        if (branch.modelId !== modelId) continue;
        if (onlyBranchIds && !onlyBranchIds.has(branchId)) continue;
        for (const seg of branch.segments ?? []) {
            const span = hostSegmentSpan(draft, branch, seg);
            if (!span) continue;
            const { start, end } = span;
            const diameter = seg.diameter ?? 1.0;
            const sampleCount = 7;
            for (let i = 0; i <= sampleCount; i++) {
                const t = 0.45 + (i / sampleCount) * 0.55;
                shaftPoints.push({
                    hostTypeId: 'branch',
                    hostId: branchId,
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
    host: { rootId?: string; parentKnotId?: string; segments: Array<{ bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null }>; contactCone?: { pos: { x: number; y: number; z: number } } },
    seg: { bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null },
): { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } } | null {
    // Bottom segments carry no bottomJoint by design (trunks rise from the root
    // plate; branches rise from their parentKnot). Using anything else here is
    // what produced the `drift` culls.
    const root = draft.roots[host.rootId ?? ''];
    const parentKnot = host.parentKnotId ? draft.knots[host.parentKnotId] : undefined;
    const start = seg.bottomJoint?.pos ?? (root ? {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + (root.diskHeight ?? 0) + (root.coneHeight ?? 0),
    } : parentKnot?.pos);
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
export function rehostLegacyKnots(draft: SupportState, modelId?: string): SupportState {
    let nextKnots = draft.knots;
    let changed = false;
    // Whichever host type owns the id, not trunks by name: a legacy knot points
    // at a host entity, and which type that is, is the collection it lives in.
    const hostByEntityId = new Map(
        collectHostEntities(draft)
            .filter(({ entity }) => modelId === undefined || entity.modelId === modelId)
            .map(({ hostId, entity }) => [hostId, entity]),
    );
    for (const [kid, knot] of Object.entries(draft.knots)) {
        const legacyHost = hostByEntityId.get(knot.parentShaftId);
        if (legacyHost) {
            let bestSeg: typeof legacyHost.segments[0] | null = null;
            let bestDist2 = Infinity;
            let bestT = 0;
            for (const seg of legacyHost.segments) {
                const span = hostSegmentSpan(draft, legacyHost, seg);
                if (!span) continue;
                const { start, end } = span;
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
 * The contact diameter moves only upward, to the same 20%-of-shaft floor the
 * sizing applies (clamped by `maxContactDiameterMm` when explicitly capped):
 * the forest resize can thicken a trunk long after its cone was built, and a
 * fat trunk under a needle-thin contact is the visible mismatch this pass
 * exists to stop. An explicit larger contact is kept.
 */
export function syncContactConeDiameters(
    draft: SupportState,
    modelId?: string,
    autoSettings?: Partial<AutoSupportSettings>,
): SupportState {
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
        const contact = cone.profile.contactDiameterMm ?? 0;
        const cap = cone.profile.maxContactDiameterMm;
        const minContact = Math.max(hostDia * TIP_CONTACT_MIN_SHAFT_RATIO, MIN_CONTACT_TIP_DIAMETER_MM);
        const uncapped = Math.max(contact, minContact);
        const nextContact = cap !== undefined
            ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, Math.min(cap, uncapped))
            : uncapped;
        if (Math.abs(body - hostDia) > 1e-6 || Math.abs(contact - nextContact) > 1e-6) {
            changed = true;
            return { ...cone, profile: { ...cone.profile, bodyDiameterMm: hostDia, contactDiameterMm: nextContact } };
        }
        return cone;
    };

    const reencodeConeSettingsHex = (
        hex: string | undefined,
        cone: ContactCone,
        shaftDiameterMm: number | undefined,
    ): string | undefined => {
        if (typeof hex !== 'string' || hex.length === 0) return hex;
        const fallback = getSettings();
        const decoded = decodeSupportSettingsHex(hex, fallback) ?? fallback;
        return encodeSupportSettingsHex(
            applySizingOverridesToSettings(decoded, {
                tipContactDiameterMm: cone.profile.contactDiameterMm,
                tipBodyDiameterMm: cone.profile.bodyDiameterMm,
                ...(shaftDiameterMm !== undefined ? { shaftDiameterMm } : {}),
            }),
        );
    };

    const nextTrunks: SupportState['trunks'] = { ...draft.trunks };
    for (const [tid, t] of Object.entries(draft.trunks)) {
        if (modelId !== undefined && t.modelId !== modelId) continue;
        const topSeg = t.segments[t.segments.length - 1];
        const cone = syncCone(t.contactCone, topSeg?.diameter);
        if (cone && cone !== t.contactCone) {
            nextTrunks[tid] = {
                ...t,
                contactCone: cone,
                settingsCodeHex: reencodeConeSettingsHex(
                    t.settingsCodeHex,
                    cone,
                    t.segments[0]?.diameter ?? topSeg?.diameter,
                ),
            };
        }
    }
    const bandShaftDia = activeSizingBand(autoSettings).shaftDiameterMm;
    const memberRatio = autoSettings?.memberHostShaftRatio
        ?? getSettings().autoSupport?.memberHostShaftRatio
        ?? AUTO_SUPPORT_CONSTRAINTS.memberHostShaftRatio.defaultValue;
    const nextLeaves: SupportState['leaves'] = { ...draft.leaves };
    for (const [lid, l] of Object.entries(draft.leaves)) {
        if (modelId !== undefined && l.modelId !== modelId) continue;
        const knot = draft.knots[l.parentKnotId];
        if (!knot) continue;
        const hostDia = diameterBySegmentId.get(knot.parentShaftId);
        if (hostDia === undefined) continue;
        // Cap leaf cone body diameter to member proportions (matching hosted
        // branches via memberHostShaftRatio) so detail leaves never bloat into
        // full thickened trunk diameter clubs (e.g. Ø1.35–1.60 mm).
        const leafBodyDia = Math.min(
            hostDia,
            Math.max(bandShaftDia, Math.round(hostDia * memberRatio * 1000) / 1000),
        );
        const cone = syncCone(l.contactCone, leafBodyDia);
        if (cone && cone !== l.contactCone) {
            nextLeaves[lid] = {
                ...l,
                contactCone: cone,
                settingsCodeHex: reencodeConeSettingsHex(
                    l.settingsCodeHex,
                    cone,
                    cone.profile.bodyDiameterMm,
                ),
            };
        }
    }

    const nextBranches: SupportState['branches'] = { ...draft.branches };
    for (const [bid, b] of Object.entries(draft.branches)) {
        if (modelId !== undefined && b.modelId !== modelId) continue;
        const firstSeg = b.segments[0];
        const cone = syncCone(b.contactCone, firstSeg?.diameter);
        if (cone && cone !== b.contactCone) {
            nextBranches[bid] = {
                ...b,
                contactCone: cone,
                settingsCodeHex: reencodeConeSettingsHex(
                    b.settingsCodeHex,
                    cone,
                    firstSeg?.diameter,
                ),
            };
        }
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
    modelId?: string;
    origin?: SupportOrigin;
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

const HOST_SHAFT_CLEARANCE_MARGIN_MM = 0.15;
const HOST_TIP_PULLBACK_MM = 0.35;

/**
 * True when any shaft segment of a host support pierces the model mesh within
 * `radius + HOST_SHAFT_CLEARANCE_MARGIN_MM`. Checks each segment's actual
 * `bottomJoint -> topJoint` endpoints without pulling routed intermediate knees
 * sideways toward `contactCone.pos`.
 */
function isHostShaftBlocked(
    entity: {
        segments: ReadonlyArray<{
            diameter?: number;
            bottomJoint?: { pos: Vec3 } | null;
            topJoint?: { pos: Vec3 } | null;
        }>;
        contactCone?: { pos: Vec3 };
    },
    mesh: THREE.Mesh,
): boolean {
    const tip = entity.contactCone?.pos;
    for (const seg of entity.segments) {
        const start = seg.bottomJoint?.pos;
        const end = seg.topJoint?.pos;
        if (!start || !end) continue;
        let checkEnd = end;
        if (tip && Math.hypot(end.x - tip.x, end.y - tip.y, end.z - tip.z) < HOST_TIP_PULLBACK_MM) {
            const dx = start.x - end.x;
            const dy = start.y - end.y;
            const dz = start.z - end.z;
            const segLen = Math.hypot(dx, dy, dz);
            if (segLen > 1e-4) {
                const pull = Math.min(HOST_TIP_PULLBACK_MM, segLen * 0.25) / segLen;
                checkEnd = {
                    x: end.x + dx * pull,
                    y: end.y + dy * pull,
                    z: end.z + dz * pull,
                };
            }
        }
        const radius = (seg.diameter ?? 1.0) / 2;
        if (isShaftBlocked(start, checkEnd, radius + HOST_SHAFT_CLEARANCE_MARGIN_MM, mesh)) {
            return true;
        }
    }
    return false;
}


/**
 * Sample a member's shaft path for a point strictly inside the cavity void.
 * A member that never enters the void cannot have threaded a hole.
 */
function pathEntersCavityVoid(
    paths: ReadonlyArray<{ start: Vec3; end: Vec3 }>,
    cavity: CavityTester,
    modelId: string | undefined,
    stepMm = 0.75,
): boolean {
    for (const { start, end } of paths) {
        const span = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
        const steps = Math.max(1, Math.ceil(span / stepMm));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            if (cavity.isInsideVoid({
                x: start.x + (end.x - start.x) * t,
                y: start.y + (end.y - start.y) * t,
                z: start.z + (end.z - start.z) * t,
            }, modelId)) return true;
        }
    }
    return false;
}

/**
 * True when a member enters the cavity void even though one of its terminals
 * is outside the cavity side of the wall — a support routed through a drain
 * hole or bore. A member wholly outside is normal; a member wholly inside (the
 * cavity bridge a `cavity`/interior contact gets) is the intended shape, and
 * its terminals sit ON the cavity wall, which `isOnInteriorSide` accepts.
 */
function crossesCavityBoundary(
    paths: ReadonlyArray<{ start: Vec3; end: Vec3 }>,
    cavity: CavityTester,
    modelId: string | undefined,
): boolean {
    if (paths.length === 0) return false;
    const first = paths[0].start;
    const last = paths[paths.length - 1].end;
    const endsOutside = !cavity.isOnInteriorSide(first, modelId)
        || !cavity.isOnInteriorSide(last, modelId);
    if (!endsOutside) return false;
    return pathEntersCavityVoid(paths, cavity, modelId);
}

/** A not-yet-inserted host's path from its own joints. `hostSegmentSpan`
 *  resolves a missing joint from the root in the draft, which does not hold
 *  this trunk yet; the plate end is assumed vertical to the tip instead. */
function rawCavityPaths(entity: {
    segments: ReadonlyArray<{ bottomJoint?: { pos: Vec3 } | null; topJoint?: { pos: Vec3 } | null }>;
    contactCone?: { pos: Vec3 };
}): Array<{ start: Vec3; end: Vec3 }> {
    const tip = entity.contactCone?.pos;
    const paths: Array<{ start: Vec3; end: Vec3 }> = [];
    let previous: Vec3 | undefined;
    for (const seg of entity.segments) {
        const start = seg.bottomJoint?.pos ?? previous ?? (tip ? { x: tip.x, y: tip.y, z: 0 } : undefined);
        const end = seg.topJoint?.pos ?? tip;
        if (start && end && Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) > 1e-4) {
            paths.push({ start, end });
        }
        previous = end;
    }
    return paths;
}

/** The shaft path of a host entity, as the spans the drift check measures. */
function hostCavityPaths(
    draft: SupportState,
    entity: { segments: Segment[]; contactCone?: { pos: Vec3 } },
): Array<{ start: Vec3; end: Vec3 }> {
    const paths: Array<{ start: Vec3; end: Vec3 }> = [];
    for (const seg of entity.segments) {
        const span = hostSegmentSpan(draft, entity as never, seg);
        if (span) paths.push(span);
    }
    return paths;
}

/** The path a hosted member actually bridges: its segments when it has
 *  them, otherwise knot -> contact(s) (leaf, stick, twig). */
function memberCavityPaths(
    draft: SupportState,
    kind: SupportTypeId,
    entity: unknown,
): Array<{ start: Vec3; end: Vec3 }> {
    const record = entity as Record<string, unknown>;
    if (Array.isArray(record.segments) && record.segments.length > 0) {
        return hostCavityPaths(draft, record as never);
    }
    const points: Vec3[] = [];
    const parentKnotId = record.parentKnotId;
    const knot = typeof parentKnotId === 'string' ? draft.knots[parentKnotId] : undefined;
    if (knot?.pos) points.push(knot.pos);
    for (const { field } of contactEndpointsFor(kind)) {
        const pos = (record[field] as { pos?: Vec3 } | undefined)?.pos;
        if (pos) points.push(pos);
    }
    const paths: Array<{ start: Vec3; end: Vec3 }> = [];
    for (let i = 1; i < points.length; i++) paths.push({ start: points[i - 1], end: points[i] });
    return paths;
}

/** Look up a built member in the draft by the collection its type owns. */
function supportEntityById(draft: SupportState, kind: SupportTypeId, id: string): unknown {
    const collection = draft[getSupportTypeDescriptor(kind).location.key] as unknown as
        | Record<string, unknown>
        | undefined;
    return collection?.[id];
}

/** Validate hosted members' attachment after forest resize; cull orphans and return them for reporting. */
export function validateAndCullOrphans(
    draft: SupportState,
    mesh: THREE.Mesh | undefined,
    modelId?: string,
    cavity?: CavityTester,
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
            if (modelId !== undefined && entity.modelId !== modelId) continue;
            // A host is a vertical pillar — any segment that is blocked (excluding the tip contact itself)
            // is a mis-placed pillar that would print through the model.
            if (isHostShaftBlocked(entity, mesh)) {
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
    // A trunk/branch routed through a drain hole into the cavity prints it
    // in place and cannot be pulled out without breaking the part. The mesh
    // test above cannot see this: the bore is open space.
    if (cavity) {
        for (const { hostTypeId, hostId, entity } of collectHostEntities(nextDraft)) {
            if (modelId !== undefined && entity.modelId !== modelId) continue;
            if (!crossesCavityBoundary(hostCavityPaths(nextDraft, entity), cavity, entity.modelId)) continue;
            const tip = entity.contactCone?.pos;
            const where = tip ? ` @ (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)}, Z${tip.z.toFixed(1)})` : '';
            const typeName = getSupportTypeDescriptor(hostTypeId).singular;
            culledHostTypeNameById.set(hostId, typeName);
            orphans.push({
                id: hostId,
                kind: hostTypeId,
                reason: 'cavityCrossing',
                detail: `${typeName} shaft crosses the cavity through an opening${where}`,
            });
            hostsToRemove.add(hostId);
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
            if (cavity) {
                const path = getSupportTypeDescriptor(kind).hasSegments
                    ? hostCavityPaths(nextDraft, member as never)
                    : [{ start: knot.pos, end: tipPos }];
                if (crossesCavityBoundary(path, cavity, member.modelId)) {
                    orphans.push({
                        id,
                        kind,
                        reason: 'cavityCrossing',
                        hostId: host.hostId,
                        knotId: knot.id,
                        detail: 'member crosses the cavity through an opening',
                    });
                    return false;
                }
            }
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
            const crosses = getSupportTypeDescriptor(kind).hasSegments
                ? branchPathCrossesSupports(
                    member as unknown as { id: string; parentKnotId?: string; segments: Segment[]; contactCone?: { pos: { x: number; y: number; z: number }; profile?: { bodyDiameterMm?: number } } },
                    nextDraft,
                    host.hostId,
                    undefined,
                    id,
                )
                : leafPathCrossesSupports(knot.pos, tipPos, 0.25, nextDraft, host.hostId, undefined, id);
            if (crosses) {
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
            if (modelId !== undefined && member.modelId !== modelId) continue;
            const tipPos = member.contactCone?.pos;
            if (!checkAttachment(memberId, typeId, knotField, member, tipPos)) removal.add(memberId);
        }
    }
    // Members whose host was culled (hostBlocked trunk, or a culled 1st-level
    // branch hosting 2nd-level leaves) are also orphaned. Propagate to fixpoint
    // so multi-level Trunk -> Branch -> Leaf cascades never leave stranded leaves.
    for (const { typeId } of SHAFT_HOSTED_MEMBER_TYPES) {
        if (!getSupportTypeDescriptor(typeId).hasSegments) continue;
        const typeName = typeWord(typeId);
        for (const culledMemberId of removedFor(typeId)) {
            if (!culledHostTypeNameById.has(culledMemberId)) {
                culledHostTypeNameById.set(culledMemberId, typeName);
            }
        }
    }
    let propagatedHostCull = true;
    while (propagatedHostCull) {
        propagatedHostCull = false;
        for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
            const removal = removedFor(typeId);
            const hasSegments = getSupportTypeDescriptor(typeId).hasSegments;
            const typeName = typeWord(typeId);
            for (const [memberId, member] of Object.entries(hostedMemberEntities(nextDraft, collectionKey))) {
                if (modelId !== undefined && member.modelId !== modelId) continue;
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
                    orphans.push({
                        id: memberId,
                        kind: typeId,
                        reason: 'missingHost',
                        hostId: culledHostId,
                        knotId: knot.id,
                        detail: `${culledTypeName} culled (blocked)`,
                        hostCulled: true,
                    });
                    removal.add(memberId);
                    if (hasSegments && !culledHostTypeNameById.has(memberId)) {
                        culledHostTypeNameById.set(memberId, typeName);
                        propagatedHostCull = true;
                    }
                }
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
    /** Hosts that still stand in the draft but must not be offered or crossed:
     *  chunk consolidation converts a pillar into the link it is testing for. */
    excludeHostIds?: ReadonlySet<string>,
    autoSettings?: Partial<AutoSupportSettings>,
    tipDiameterMm?: number,
    /** Existing hosted member ID to ignore during cross-support collision checks (used during re-hosting). */
    excludeMemberId?: string,
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
    // The model lookup is a dictionary read per SAMPLE, and a pool holds tens
    // of thousands of samples from a few hundred hosts. Samples come in host
    // order, so resolve the model once per host instead of once per sample.
    let currentHostId: string | null = null;
    let currentHostModelId: string | undefined;
    let currentHostIsGrid = false;

    const fanBand = activeSizingBand(autoSettings);
    const fanBandShaftDiaMm = fanBand.shaftDiameterMm;
    const fanBandTipLenMm = fanBand.tipLengthMm;
    const explicitUnlimitedRescue = rescueSpanOverrideMm === Number.POSITIVE_INFINITY;
    const maxUnbracedSpanMm = maxEulerBucklingSpanMm(fanBandShaftDiaMm);
    const maxUnbracedSpanSq = maxUnbracedSpanMm * maxUnbracedSpanMm;

    for (const sp of shaftPoints) {
        // Host-level answers are cached per host: the pool holds tens of
        // thousands of samples from a few hundred hosts, in host order.
        if (sp.hostId !== currentHostId) {
            currentHostId = sp.hostId;
            currentHostIsGrid = gridHostIds.has(sp.hostId);
            // A host must belong to the model being supported. The shaft pool
            // is collected from the whole snapshot, which holds every model's
            // forest — an unfiltered pool attaches this model's leaf to a
            // neighbouring model's shaft (and its knot to that model's
            // segment).
            currentHostModelId = excludeHostIds?.has(sp.hostId)
                ? undefined
                : hostEntityOf(draft, sp.hostTypeId, sp.hostId)?.modelId;
        }
        if (currentHostModelId !== modelId) continue;
        const isGrid = currentHostIsGrid;
        const limit = isGrid ? gridHostFanRadiusMm : fanRadiusMm;
        const ddx = sp.pos.x - target.x;
        const ddy = sp.pos.y - target.y;
        const ddz = sp.pos.z - target.z;
        const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
        const lateral2 = ddx * ddx + ddy * ddy;
        const lateralMm = Math.sqrt(lateral2);
        if (lateralMm < nearestHostMm) nearestHostMm = lateralMm;
        if (lateral2 > limit * limit) continue;
        const inReach = dist2 <= limit * limit && dist2 <= maxUnbracedSpanSq;
        const derivedRescueSpanMm = rescueSpanOverrideMm
            ?? (maxAngleDeg > 0 ? limit / Math.sin((maxAngleDeg * Math.PI) / 180) : maxUnbracedSpanMm);
        const rescueSpanMm = explicitUnlimitedRescue
            ? Number.POSITIVE_INFINITY
            : Math.min(maxUnbracedSpanMm, derivedRescueSpanMm);
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
        const spanMm = Math.sqrt(dist2);
        const angleDeg = (Math.atan2(lateralMm, vDist) * 180) / Math.PI;
        const estShaftLenMm = Math.max(0.5, spanMm - fanBandTipLenMm);
        const effectiveMaxAngleDeg = explicitUnlimitedRescue
            ? maxAngleDeg
            : maxStableAngleForSpanDeg(estShaftLenMm, maxAngleDeg, fanBandShaftDiaMm);
        if (angleDeg > effectiveMaxAngleDeg) {
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
    // pillar or rescues a high/occluded contact onto a deeper clear knot — so
    // it runs in shortest-first order if every Tier-1 sample fails.
    if (candidates.length === 0 && rescue.length === 0) {
        return {
            ok: false,
            reason: refusal,
            nearestHostMm: Number.isFinite(nearestHostMm) ? nearestHostMm : undefined,
            nearestSteepMm: Number.isFinite(nearestSteepMm) ? nearestSteepMm : undefined,
            steepAngleDeg: Number.isFinite(steepAngleDeg) ? steepAngleDeg : undefined,
        };
    }

    // Spread crowded fan crowns around each host: penalize candidate spots sitting
    // close in Z AND aligned in azimuth with an already attached sibling leaf/branch.
    const crowdPenaltyByIndex = new Float64Array(candidates.length);
    if (hostOrder === 'steepest' && candidates.length > 1) {
        const siblingsByHost = new Map<string, Array<{ z: number; ux: number; uy: number }>>();
        const knots = draft.knots ?? {};
        const hostBySegmentId = new Map<string, string>();
        for (const { hostId, entity } of collectHostEntities(draft)) {
            if (entity.modelId !== modelId) continue;
            hostBySegmentId.set(hostId, hostId);
            for (const s of entity.segments ?? []) hostBySegmentId.set(s.id, hostId);
        }
        for (const { collectionKey, knotField } of SHAFT_HOSTED_MEMBER_TYPES) {
            const coll = hostedMemberEntities(draft, collectionKey);
            for (const [mId, member] of Object.entries(coll)) {
                if (mId === excludeMemberId || member.modelId !== modelId) continue;
                const knotId = memberKnotId(member, knotField);
                const knot = knotId ? knots[knotId] : undefined;
                const tip = member.contactCone?.pos;
                if (!knot || !tip) continue;
                const hId = hostBySegmentId.get(knot.parentShaftId);
                if (!hId) continue;
                const ox = tip.x - knot.pos.x;
                const oy = tip.y - knot.pos.y;
                const oLen = Math.hypot(ox, oy);
                if (oLen < 1e-4) continue;
                const list = siblingsByHost.get(hId);
                const entry = { z: knot.pos.z, ux: ox / oLen, uy: oy / oLen };
                if (list) list.push(entry);
                else siblingsByHost.set(hId, [entry]);
            }
        }
        const cosSector = Math.cos((45 * Math.PI) / 180);
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const sibs = siblingsByHost.get(c.sp.hostId);
            if (!sibs || sibs.length === 0) continue;
            const lx = target.x - c.sp.pos.x;
            const ly = target.y - c.sp.pos.y;
            const lLen = Math.hypot(lx, ly);
            if (lLen < 1e-4) continue;
            const ux = lx / lLen;
            const uy = ly / lLen;
            let penalty = 0;
            for (const sib of sibs) {
                if (Math.abs(sib.z - c.sp.pos.z) <= 1.2 && (ux * sib.ux + uy * sib.uy) >= cosSector) {
                    penalty += 3.5;
                }
            }
            crowdPenaltyByIndex[i] = penalty;
        }
    }

    const rankedCandidates = hostOrder === 'steepest'
        ? candidates
            .map((c, idx) => ({ ...c, scoreAngle: c.angleDeg + crowdPenaltyByIndex[idx] }))
            .sort((a, b) => a.scoreAngle - b.scoreAngle || a.dist2 - b.dist2)
        : [...candidates].sort((a, b) => a.dist2 - b.dist2 || a.angleDeg - b.angleDeg);
    rescue.sort((a, b) => a.dist2 - b.dist2 || a.angleDeg - b.angleDeg);
    const pool = rankedCandidates.length > 0 && rescue.length > 0
        ? [...rankedCandidates, ...rescue.slice(0, 6)]
        : (rankedCandidates.length > 0 ? rankedCandidates : rescue);

    const tryAttachPool = (leafSpanCeilingMm: number, allowBranch: boolean) => {
        let lastBlockedReason: FanLeafRefusal | null = null;
        for (const { sp, dist2, angleDeg } of pool) {
            const spanMm = Math.sqrt(dist2);
            if (!allowBranch && spanMm > leafSpanCeilingMm) continue;
            const parentKnot = {
                id: freeKnotId(draft, knotIdPrefix),
                parentShaftId: sp.segmentId ?? sp.hostId,
                t: sp.t,
                pos: sp.pos,
                diameter: sp.diameter + 0.125,
            };
            const resolved = resolveSurfaceNormal(target, mesh ?? undefined);
            /**
             * The pre-test asks the question the member will have to answer at build
             * time, and no more. A leaf is one tapered cone from the host to the tip,
             * and a contact cone is allowed to touch the surface it points at (that is
             * what `contactConeCollides` exempts), so testing a bare ray all the way to
             * the tip refused every link onto a flat: the tip sits *on* the surface,
             * and the last stretch of a ray to it is inside the shaft keep-out however
             * steep the link is. Measured on a dense flat in gridless mode: 976
             * consolidation links refused that way, 308 of 438 hosts left bare. A
             * branch, which is a real shaft, still has to reach a point short of the
             * tip, because its own collision test runs after it is built.
             */
            const isBranchHost = sp.hostTypeId === 'branch';
            if (isBranchHost && spanMm > MAX_LEAF_FALLBACK_SPAN_MM) continue;
            const isBranchAttempt = allowBranch && !isBranchHost && spanMm > leafSpanCeilingMm;
            if (mesh) {
                const toTip = {
                    x: target.x - sp.pos.x,
                    y: target.y - sp.pos.y,
                    z: target.z - sp.pos.z,
                };
                const length = Math.hypot(toTip.x, toTip.y, toTip.z) || 1;
                const inset = Math.min(FAN_LINK_TIP_INSET_MM, length * 0.5);
                const shortOfTip = {
                    x: target.x - (toTip.x / length) * inset,
                    y: target.y - (toTip.y / length) * inset,
                    z: target.z - (toTip.z / length) * inset,
                };
                const blocked = isBranchAttempt
                    ? isShaftBlocked(sp.pos, shortOfTip, 0.2, mesh)
                    : contactConeCollides(sp.pos, { pos: target, normal: resolved.normal }, mesh);
                if (blocked) {
                    lastBlockedReason = 'blocked';
                    continue;
                }
            }

            // Long spans route to branches with real shafts instead of long tapered
            // leaf cones (spindly spikes), for EVERY origin. Overhang fanning used to
            // stay a leaf past this threshold, which is how an 11.6mm cone got built;
            // the leaf's own rule — past ~4.5mm prefer a real branch — does not care
            // which surface the tip touches. Failed branch attempts fall through to
            // deeper samples (and finally to a strict <=5.5mm slim-leaf fallback if
            // no branch shaft fits below the contact cone).
            const cappedTip = tipDiameterMm !== undefined
                ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, tipDiameterMm)
                : undefined;
            if (isBranchAttempt) {
                const estShaftLenMm = Math.max(0.5, spanMm - fanBandTipLenMm);
                const branchMaxAngleDeg = explicitUnlimitedRescue
                    ? Math.min(50, maxAngleDeg)
                    : maxStableAngleForSpanDeg(estShaftLenMm, Math.min(50, maxAngleDeg), fanBandShaftDiaMm);
                if (angleDeg > branchMaxAngleDeg) {
                    lastBlockedReason = 'angle';
                    continue;
                }
                try {
                    const band = activeSizingBand(autoSettings);
                    const built = buildHostedBranch(
                        {
                            tipPos: resolved.point,
                            tipNormal: resolved.normal,
                            modelId,
                            parentKnot,
                            mesh: mesh ?? undefined,
                            tipContactDiameterMm: cappedTip ?? band.tipContactDiameterMm,
                            rootsDiameterMm: band.rootDiameterMm,
                        },
                        band.shaftDiameterMm,
                        sp.diameter,
                        (attempt) => Boolean(attempt.supportData.error)
                            || Boolean(mesh && branchCollidesWithSDF(attempt.branch, mesh)),
                        autoSettings,
                    );
                    if (!built) {
                        lastBlockedReason = 'blocked';
                        continue;
                    }
                    const depTooFlat = explicitUnlimitedRescue
                        ? branchDepartureAngleDeg(built.branch, parentKnot.pos) > Math.min(50, maxAngleDeg)
                        : branchDepartureShaftExceedsStability(built.branch, parentKnot.pos, Math.min(50, maxAngleDeg), fanBandShaftDiaMm);
                    if (depTooFlat) {
                        lastBlockedReason = 'angle';
                        continue;
                    }
                    if (branchPathCrossesSupports(
                        built.branch,
                        draft,
                        sp.hostId,
                        excludeHostIds,
                        excludeMemberId,
                        parentKnot.pos,
                    )) {
                        lastBlockedReason = 'cross';
                        continue;
                    }
                    if (maxAttachments > 0 && isHostAtAttachmentCapacity(sp.hostTypeId, sp.hostId, maxAttachments, draft)) {
                        lastBlockedReason = 'capacity';
                        continue;
                    }
                    if (cappedTip !== undefined && built.branch.contactCone) {
                        built.branch.contactCone = applyExplicitTipCapToCone(built.branch.contactCone, cappedTip);
                    }
                    const next = draftAddPrimitive(draft, 'knots', parentKnot);
                    built.branch.origin = origin ?? 'island';
                    const memberTypeId = builtMemberTypeId(built.branch);
                    return {
                        ok: true as const,
                        kind: memberTypeId,
                        draft: draftAddEntity(next, memberTypeId, built.branch),
                        hostTypeId: sp.hostTypeId,
                        hostId: sp.hostId,
                        entityId: built.branch.id,
                        distMm: spanMm,
                        angleDeg,
                    };
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
                    tipContactDiameterMm: cappedTip ?? activeSizingBand(autoSettings).tipContactDiameterMm,
                    mesh: mesh ?? undefined,
                });
                if (built.supportData.error) {
                    lastBlockedReason = 'build';
                    continue;
                }
                leaf = built.leaf;
                if (cappedTip !== undefined) {
                    leaf.contactCone = applyExplicitTipCapToCone(leaf.contactCone, cappedTip)!;
                }
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
                excludeHostIds,
                excludeMemberId,
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
                ok: true as const,
                kind: memberTypeId,
                draft: draftAddEntity(next, memberTypeId, leaf),
                hostTypeId: sp.hostTypeId,
                hostId: sp.hostId,
                entityId: leaf.id,
                distMm: spanMm,
                angleDeg,
            };
        }
        return { ok: false as const, reason: lastBlockedReason ?? refusal };
    };

    const primary = tryAttachPool(MAX_LEAF_SPAN_BEFORE_BRANCH_MM, true);
    if (primary.ok) return primary;
    // Fallback for the 4.5–5.5 mm transition band where tipLengthMm leaves no
    // legal branch shaft rise (e.g. near-plate contacts): prefer a slim leaf
    // over spawning a redundant standalone trunk. Never exceeds 5.5 mm.
    const fallback = tryAttachPool(MAX_LEAF_FALLBACK_SPAN_MM, false);
    if (fallback.ok) return fallback;
    return primary;
}

// ---------------------------------------------------------------------------
// Forest Report
// ---------------------------------------------------------------------------
// A structured per-run summary of the placed forest: every support's id, size,
// and sizing reasoning, plus the fan-out groups (host trunk → attached leaves
// and branches). Shown in the Auto Supports panel after a run; the per-entity
// placement log spam is off by default (see setAutoSupportVerboseLogging).

/** The sizing reasoning for one placed support: island area + active band + height factor. */
export function forestSizingNote(entry: ForestLedgerEntry, actualShaftMm: number): string {
    const areaInput = Math.max(entry.areaMm2, 0.01);
    // The placed/sized ratio, including the height and model terms. The old
    // note printed a display-only "height factor" that was not the factor the
    // sizing used, so a 1.61 mm trunk read as "h1.14" and looked unexplained.
    const sized = entry.bandShaftMm > 0 ? actualShaftMm / entry.bandShaftMm : 1;
    return `area ${areaInput.toFixed(2)}mm² · base Ø${entry.bandShaftMm.toFixed(2)} · sized ×${sized.toFixed(2)}` +
        ` → Ø${actualShaftMm.toFixed(2)}mm`;
}

/**
 * Root-merge radius: trunks whose plate roots stand this close are candidates
 * for sharing one host. Kept tight so this is a de-duplication of columns that
 * already touch, not a re-layout.
 */
export const ROOT_MERGE_RADIUS_MM = 3;
/** Mid-air shaft centerline threshold (mm) below which two trunks are merge candidates.
 *  Floored: a surface-close pair may sit wider than this when the shafts are fat. */
export const MID_SHAFT_MERGE_DISTANCE_MM = 1.6;
/** Surface clearance (mm) counted on top of both shaft radii for the mid-shaft test. */
const MID_SHAFT_MERGE_CLEARANCE_MM = 0.5;

export interface RootMergeOptions {
    mesh?: THREE.Mesh;
    maxRootDistanceMm?: number;
    maxShaftDistanceMm?: number;
    /** Angle ceiling for the re-fanned members (same rule as placement). */
    maxAngleDeg: number;
    /** Per-host attachment cap (`maxAttachmentsPerTrunk`). */
    maxAttachments: number;
    fanRadiusMm: number;
    gridHostFanRadiusMm: number;
    /** Trunks placed on the density grid fan only up close. */
    gridHostIds: ReadonlySet<string>;
    autoSettings?: Partial<AutoSupportSettings>;
}

export interface RootMergeResult {
    draft: SupportState;
    merged: number;
    mergedTrunkIds: string[];
    refusals: Partial<Record<FanLeafRefusal | 'noTips', number>>;
}

/**
 * Co-located and mid-shaft crossing trunks share existing hosts.
 *
 * The consolidation pass only converts *bare* pillars; two established trunks
 * that both carry members, or whose routed shafts pass within
 * `MID_SHAFT_MERGE_DISTANCE_MM` mid-air, stand side by side and read as one
 * intersecting cluster. For each pair within root or mid-shaft distance, the
 * shorter trunk is dissolved: every contact it served — its own tip and each
 * hosted member's tip — is re-fanned onto the taller survivor (or across nearby
 * clear hosts if the survivor hits capacity/angle gates) using SDF/cone mesh
 * collision checks instead of raw shaft-to-tip rays.
 *
 * Deterministic: pairs sorted by min(rootDist, midShaftDist) then coordinates.
 */
export function mergeNearbyTrunkRoots(
    draftIn: SupportState,
    modelId: string,
    options: RootMergeOptions,
): RootMergeResult {
    const maxRootDistanceMm = options.maxRootDistanceMm ?? ROOT_MERGE_RADIUS_MM;
    const maxShaftDistanceMm = options.maxShaftDistanceMm ?? MID_SHAFT_MERGE_DISTANCE_MM;
    const refusals: RootMergeResult['refusals'] = {};
    const mergedTrunkIds: string[] = [];
    let draft = draftIn;
    const consumed = new Set<string>();

    const tipOf = (entity: { contactCone?: { pos: { x: number; y: number; z: number } } }) => entity.contactCone?.pos;
    const maxShaftDiameterOf = (trunk: { segments: Segment[] }): number =>
        (trunk.segments ?? []).reduce((max, segment) => Math.max(max, segment.diameter ?? 0), 0);

    const trunks = () => Object.values(draft.trunks).filter((trunk) => trunk.modelId === modelId);

    const rootPos = (trunk: { rootId?: string }) => {
        const root = trunk.rootId ? draft.roots[trunk.rootId] : undefined;
        return root ? root.transform.pos : null;
    };

    const trunkSpans = (trunk: { rootId?: string; segments: Segment[]; contactCone?: { pos: { x: number; y: number; z: number } } }) => {
        const spans: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }> = [];
        for (const seg of trunk.segments ?? []) {
            const sp = hostSegmentSpan(draft, trunk, seg);
            if (sp) spans.push(sp);
        }
        return spans;
    };

    interface Pair {
        survivorId: string;
        victimId: string;
        distanceMm: number;
        survivorRoot: { x: number; y: number; z: number };
        victimRoot: { x: number; y: number; z: number };
        survivorTipZ: number;
    }
    const pairs: Pair[] = [];
    const current = trunks();
    // Survivor tie-breaks read each trunk's live attachment count. Counting
    // scans every hosted member, and the pair loop used to do it twice per
    // pair (O(pairs x members)). Cache by host id and invalidate only the
    // survivor after a merge, which is the only tree whose fan changed.
    const attachmentCounts = new Map<string, number>();
    const attachmentCountFor = (trunkId: string): number => {
        const cached = attachmentCounts.get(trunkId);
        if (cached !== undefined) return cached;
        const count = countAttachmentsOnHost('trunk', trunkId, draft);
        attachmentCounts.set(trunkId, count);
        return count;
    };
    const spansByTrunkId = new Map<string, Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }>>();
    for (const t of current) spansByTrunkId.set(t.id, trunkSpans(t));

    for (let i = 0; i < current.length; i++) {
        const a = current[i];
        const ta = tipOf(a);
        const spansA = spansByTrunkId.get(a.id) ?? [];
        for (let j = i + 1; j < current.length; j++) {
            const b = current[j];
            const tb = tipOf(b);
            if (!ta || !tb) continue;
            const ra = rootPos(a);
            const rb = rootPos(b);
            if (!ra || !rb) continue;
            const rootDist = Math.hypot(ra.x - rb.x, ra.y - rb.y);
            let minDist = rootDist;
            if (rootDist > maxRootDistanceMm) {
                const spansB = spansByTrunkId.get(b.id) ?? [];
                let bestShaftSq = Infinity;
                for (const sa of spansA) {
                    for (const sb of spansB) {
                        const d2 = segmentDistanceSq(sa.start, sa.end, sb.start, sb.end);
                        if (d2 < bestShaftSq) bestShaftSq = d2;
                    }
                }
                // The centerline floor assumed thin placement shafts; two
                // post-placement shafts of ~1.7 mm overlap at 1.6 mm and
                // 'almost touch' well past it. Add both radii plus a small
                // surface clearance so a fat near-touching pair is a candidate.
                const radiusA = maxShaftDiameterOf(a) / 2;
                const radiusB = maxShaftDiameterOf(b) / 2;
                const shaftLimitMm = Math.max(
                    maxShaftDistanceMm,
                    radiusA + radiusB + MID_SHAFT_MERGE_CLEARANCE_MM,
                );
                if (bestShaftSq > shaftLimitMm * shaftLimitMm) continue;
                minDist = Math.sqrt(bestShaftSq);
            }
            // Taller tip survives; more attachments then root/tip position
            // break ties, so the choice never depends on generated ids.
            const aCount = attachmentCountFor(a.id);
            const bCount = attachmentCountFor(b.id);
            const aWins = ta.z !== tb.z
                ? ta.z > tb.z
                : aCount !== bCount
                    ? aCount > bCount
                    : ra.x !== rb.x
                        ? ra.x < rb.x
                        : ra.y !== rb.y
                            ? ra.y < rb.y
                            : ta.x !== tb.x
                                ? ta.x < tb.x
                                : ta.y !== tb.y
                                    ? ta.y < tb.y
                                    : a.id < b.id;
            pairs.push(aWins
                ? { survivorId: a.id, victimId: b.id, distanceMm: minDist, survivorRoot: ra, victimRoot: rb, survivorTipZ: ta.z }
                : { survivorId: b.id, victimId: a.id, distanceMm: minDist, survivorRoot: rb, victimRoot: ra, survivorTipZ: tb.z });
        }
    }
    pairs.sort((x, y) => x.distanceMm - y.distanceMm
        || x.survivorRoot.x - y.survivorRoot.x
        || x.survivorRoot.y - y.survivorRoot.y
        || x.victimRoot.x - y.victimRoot.x
        || x.victimRoot.y - y.victimRoot.y
        || y.survivorTipZ - x.survivorTipZ
        || x.survivorId.localeCompare(y.survivorId));

    for (const pair of pairs) {
        if (consumed.has(pair.survivorId) || consumed.has(pair.victimId)) continue;
        const survivor = draft.trunks[pair.survivorId];
        const victim = draft.trunks[pair.victimId];
        if (!survivor || !victim) continue;

        const victimSegmentIds = new Set(victim.segments.map((segment) => segment.id));
        victimSegmentIds.add(victim.id);
        const victimKnots = Object.values(draft.knots).filter((knot) => victimSegmentIds.has(knot.parentShaftId));
        const victimKnotIds = new Set(victimKnots.map((knot) => knot.id));

        type Contact = { tip: { x: number; y: number; z: number }; origin?: SupportOrigin; tipDiameterMm?: number };
        const contacts: Contact[] = [];
        const ownedMembers: Array<{ id: string; typeId: SupportTypeId }> = [];
        for (const memberType of SHAFT_HOSTED_MEMBER_TYPES) {
            const collection = draft[memberType.collectionKey] as unknown as
                | Record<string, { id: string; modelId?: string; origin?: SupportOrigin; contactCone?: { pos: { x: number; y: number; z: number }; profile?: { maxContactDiameterMm?: number } } }>
                | undefined;
            for (const member of Object.values(collection ?? {})) {
                if (member.modelId !== modelId) continue;
                const knotId = (member as unknown as Record<string, string | undefined>)[memberType.knotField];
                if (!knotId || !victimKnotIds.has(knotId)) continue;
                const tip = member.contactCone?.pos;
                if (tip) {
                    contacts.push({ tip, origin: member.origin, tipDiameterMm: member.contactCone?.profile?.maxContactDiameterMm });
                }
                ownedMembers.push({ id: member.id, typeId: memberType.typeId as SupportTypeId });
            }
        }
        const ownTip = tipOf(victim);
        if (ownTip) {
            contacts.unshift({
                tip: ownTip,
                origin: victim.origin,
                tipDiameterMm: victim.contactCone?.profile?.maxContactDiameterMm,
            });
        }
        if (contacts.length === 0) {
            refusals.noTips = (refusals.noTips ?? 0) + 1;
            continue;
        }
        contacts.sort((x, y) => y.tip.z - x.tip.z);

        const allModelTrunkSamples = collectFanShaftPoints(draft).filter(
            (sample) => sample.hostTypeId === 'trunk' && sample.hostId !== pair.victimId && !consumed.has(sample.hostId),
        );
        const survivorPool = allModelTrunkSamples.filter((sample) => sample.hostId === pair.survivorId);
        const excluded = new Set<string>([pair.victimId, ...victimSegmentIds, ...ownedMembers.map((m) => m.id)]);
        for (const m of ownedMembers) {
            if (m.typeId === 'branch') {
                for (const s of draft.branches?.[m.id]?.segments ?? []) excluded.add(s.id);
            }
        }
        let attempt = draft;
        let refused: FanLeafRefusal | null = null;
        const created: Array<{ entityId: string; kind: SupportTypeId }> = [];
        for (const contact of contacts) {
            // Try primary survivor first (local deduplication), then allow nearby
            // clear trunks in the forest to absorb overflow when survivor is full/steep.
            // A merge replaces a whole pillar, so the survivor may use the
            // full fan radius even when it is a grid host. The 2.5 mm lattice
            // reach exists to keep ordinary placement fans tight; applied to a
            // consolidation it refuses the exact pairs that stand closest
            // together, because the victim's members were fanned up to
            // `fanRadiusMm` from its own shaft.
            let result = fanLeafToHost(
                contact.tip,
                modelId,
                survivorPool,
                options.gridHostIds,
                'rm',
                options.fanRadiusMm,
                options.fanRadiusMm,
                options.maxAngleDeg,
                options.maxAttachments,
                attempt,
                options.mesh,
                contact.origin,
                'steepest',
                undefined,
                excluded,
                options.autoSettings,
                contact.tipDiameterMm,
            );
            if (!result.ok && allModelTrunkSamples.length > survivorPool.length) {
                const multiResult = fanLeafToHost(
                    contact.tip,
                    modelId,
                    allModelTrunkSamples,
                    options.gridHostIds,
                    'rm',
                    options.fanRadiusMm,
                    options.fanRadiusMm,
                    options.maxAngleDeg,
                    options.maxAttachments,
                    attempt,
                    options.mesh,
                    contact.origin,
                    'steepest',
                    undefined,
                    excluded,
                    options.autoSettings,
                    contact.tipDiameterMm,
                );
                if (multiResult.ok) result = multiResult;
            }
            if (!result.ok) {
                refused = result.reason;
                break;
            }
            created.push({ entityId: result.entityId, kind: result.kind });
            attempt = result.draft;
        }
        if (!refused && options.mesh) {
            // Validate built members with contactConeCollides / branchCollidesWithSDF
            // rather than raw isShaftBlocked-to-tip (which falsely flagged the tip surface).
            for (const member of created) {
                const branch = attempt.branches?.[member.entityId];
                if (branch) {
                    if (branchCollidesWithSDF(branch, options.mesh)) {
                        refused = 'blocked';
                        break;
                    }
                    continue;
                }
                const leaf = attempt.leaves?.[member.entityId];
                const cone = leaf?.contactCone;
                const knot = leaf?.parentKnotId ? attempt.knots[leaf.parentKnotId] : undefined;
                if (!cone?.pos || !knot) continue;
                if (contactConeCollides(
                    knot.pos,
                    { pos: cone.pos, normal: cone.normal ?? { x: 0, y: 0, z: -1 }, surfaceNormal: cone.surfaceNormal },
                    options.mesh,
                )) {
                    refused = 'blocked';
                    break;
                }
            }
        }
        if (refused) {
            refusals[refused] = (refusals[refused] ?? 0) + 1;
            continue;
        }

        let next = attempt;
        for (const member of ownedMembers) {
            next = draftRemoveEntity(next, member.typeId, member.id);
        }
        for (const knot of victimKnots) {
            next = draftRemovePrimitive(next, 'knots', knot.id);
        }
        next = draftRemoveEntity(next, 'trunk', pair.victimId);
        const rootStillUsed = Object.values(next.trunks).some((trunk) => trunk.rootId === victim.rootId)
            || Object.values(next.kickstands ?? {}).some((kickstand) => kickstand.rootId === victim.rootId);
        if (!rootStillUsed && victim.rootId) {
            next = draftRemovePrimitive(next, 'roots', victim.rootId);
        }

        draft = next;
        consumed.add(pair.victimId);
        mergedTrunkIds.push(pair.victimId);
    }

    return { draft, merged: mergedTrunkIds.length, mergedTrunkIds, refusals };
}

export function buildForestReport(draft: SupportState, ledger: ForestLedgerEntry[], modelId?: string): ForestReport {
    const displayByEntity = new Map<string, string>();
    const entryByEntity = new Map<string, ForestLedgerEntry>();
    for (const entry of ledger) {
        displayByEntity.set(entry.entityId, entry.displayId);
        entryByEntity.set(entry.entityId, entry);
    }

    const memberById = new Map<string, { id: string; kind: ShaftHostedMemberTypeId; spanMm: number; angleDeg: number; diameterMm: number }>();
    const membersByHost = new Map<string, ForestTree['members']>();

    const hostEntities = collectHostEntities(draft)
        .filter(({ entity }) => modelId === undefined || entity.modelId === modelId);

    // Knots reference their host SEGMENT (or the entity directly for legacy
    // data) — normalize to the host id for grouping, across every host type.
    const hostIdByShaftId = new Map<string, string>();
    for (const { hostId, entity } of hostEntities) {
        hostIdByShaftId.set(hostId, hostId);
        for (const seg of entity.segments) hostIdByShaftId.set(seg.id, hostId);
    }

    const pushMember = (
        entityId: string,
        kind: ShaftHostedMemberTypeId,
        hostShaftId: string,
        tipPos: { x: number; y: number; z: number } | undefined,
        knotPos: { x: number; y: number; z: number } | undefined,
        diameterMm: number,
    ) => {
        const memberHostId = hostIdByShaftId.get(hostShaftId) ?? hostShaftId;
        const hDist = knotPos && tipPos ? Math.hypot(tipPos.x - knotPos.x, tipPos.y - knotPos.y) : 0;
        const vDist = knotPos && tipPos ? tipPos.z - knotPos.z : 0;
        const spanMm = knotPos && tipPos
            ? Math.hypot(tipPos.x - knotPos.x, tipPos.y - knotPos.y, tipPos.z - knotPos.z)
            : 0;
        const angleDeg = vDist > 0.01 ? (Math.atan2(hDist, vDist) * 180) / Math.PI : 90;
        const member = { id: displayByEntity.get(entityId) ?? entityId.slice(0, 8), kind, spanMm, angleDeg, diameterMm };
        memberById.set(entityId, member);
        const list = membersByHost.get(memberHostId);
        if (list) list.push(member);
        else membersByHost.set(memberHostId, [member]);
    };

    // Registry walk order, which the member list depends on: a host's leaves
    // come before its branches, as they did when this named the two collections.
    for (const { typeId, knotField, collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
        const descriptor = getSupportTypeDescriptor(typeId);
        for (const member of Object.values(hostedMemberEntities(draft, collectionKey))) {
            if (modelId !== undefined && member.modelId !== modelId) continue;
            const knotId = memberKnotId(member, knotField);
            const knot = knotId ? draft.knots[knotId] : undefined;
            if (!knot) continue;
            pushMember(
                member.id,
                typeId,
                knot.parentShaftId,
                member.contactCone?.pos,
                knot.pos,
                memberDiameterOf(descriptor, member as unknown as Record<string, unknown>),
            );
        }
    }

    const trees: ForestTree[] = [];
    const bareHosts: ForestReport['bareHosts'] = [];

    for (const { hostId, entity } of hostEntities) {
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

    const countCollection = (collection: Record<string, { modelId?: string }> | undefined): number => {
        if (!collection) return 0;
        return modelId === undefined
            ? Object.keys(collection).length
            : Object.values(collection).filter((e) => e.modelId === modelId).length;
    };

    return {
        hostCount: hostEntities.length,
        stumpCount: countCollection(draft.stumps),
        leafCount: countCollection(draft.leaves),
        branchCount: countCollection(draft.branches),
        stickCount: countCollection(draft.sticks),
        twigCount: countCollection(draft.twigs),
        trees,
        bareHosts,
    };
}

/** Plain-text rendering of the forest report (copy-to-clipboard format). */
export function forestReportToText(report: ForestReport, autoSettings?: Partial<AutoSupportSettings>): string {
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
    if (report.starts && report.starts.count > 0) {
        lines.push('STARTS');
        lines.push(`  Starts: ${report.starts.count} (${report.starts.underSupported} under-supported)`);
        for (const row of report.starts.rows) {
            lines.push(
                `    ${row.id} ${row.areaMm2.toFixed(2)}mm² · ${row.contacts}/${row.minContacts} contacts · ` +
                `cov ${row.coveragePct.toFixed(1)}% · Z${row.zMm.toFixed(1)}` +
                `${row.pancakeRisk ? ' — PANCAKE RISK' : ''}`);
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
        lines.push(`  Candidates by source: voxel ${d.candidatesBySource.voxel} · minima ${d.candidatesBySource.minima} · intersection ${d.candidatesBySource.intersection} · overhang ${d.candidatesBySource.overhang} · stabilization ${d.candidatesBySource.stabilization} · reinforcement ${d.candidatesBySource.reinforcement}`);
        const fanEntries = Object.entries(d.fanRefusals).filter(([, v]) => v);
        const mergeEntries = Object.entries(d.mergeRefusals).filter(([, v]) => v);
        if (fanEntries.length > 0 || mergeEntries.length > 0) {
            const fanStr = fanEntries.length > 0 ? fanEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
            const mergeStr = mergeEntries.length > 0 ? mergeEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
            const fanMaxDeg = autoSettings?.leafFanMaxAngleDeg ?? getSettings().autoSupport?.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;
            lines.push(`  Fan refusals: ${fanStr} (noHost=too far in plan >5mm/2.5mm grid, angle=>${Math.min(fanMaxDeg, memberMaxAngleFromVerticalDeg())}° too flat, sameZ|cross|blocked|capacity=host full)`);
            const conEntries = Object.entries(d.consolidationRefusals ?? {}).filter(([, v]) => v);
            if (conEntries.length > 0) {
                const conStr = conEntries.map(([k, v]) => `${k}=${v}`).join(', ');
                lines.push(`  Consolidation refusals: ${conStr} (sameZ=surface too flat for side-leaves — chunking needs ≥0.4 mm neighbour height rise)`);
            }
            lines.push(`  Merge refusals: ${mergeStr} (noHost=no host within 4mm, rejected=host at capacity or collision)`);
            if (d.trunkErrorRetries) {
                lines.push(`  Trunk-error retry: ${d.trunkErrorRetries.rescued}/${d.trunkErrorRetries.attempted} rescued as wide fans (pillar occluded, contact kept)`);
            }
            if (d.rootMerges) {
                const rmEntries = Object.entries(d.rootMerges.refusals).filter(([, v]) => v);
                const rmStr = rmEntries.length > 0 ? rmEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
                lines.push(`  Root merges: ${d.rootMerges.merged} co-located trunk(s) dissolved into a shared host` +
                    (d.rootMerges.merged > 0 || rmEntries.length > 0 ? ` (refusals: ${rmStr})` : ''));
            }
        } else {
            lines.push(`  Fan/Merge refusals: none (all fanned or standalone)`);
        }
        if ((d.gridFallbacks ?? 0) > 0) {
            lines.push(`  Grid fallbacks: ${d.gridFallbacks} — the lattice could not serve these tips, so they were placed without it`);
        }
        if (d.tractionOptimization) {
            const tr = d.tractionOptimization;
            lines.push(
                `  Traction Voronoi: ${tr.representativeLayers} representative layers `
                + `(peak ${tr.peakCrossSectionMm2.toFixed(0)}mm²) · +${tr.added} added, −${tr.pruned} pruned`,
            );
        }
        if (report.loadBudget) {
            const budget = report.loadBudget;
            lines.push(
                `  Load budget (report only): demand ${budget.totalDemandMm2.toFixed(0)}mm² vs capacity `
                + `${budget.totalCapacityMm2.toFixed(0)}mm² — would add ${budget.wouldAdd}, could cull ${budget.wouldCull} `
                + `(deficit on ${budget.islandsInDeficit} islands, surplus on ${budget.islandsInSurplus})`,
            );
            if (budget.worst) {
                lines.push(
                    `    worst deficit: ${budget.worst.islandId} ${budget.worst.deficitMm2.toFixed(1)}mm² `
                    + `(demand ${budget.worst.demandMm2.toFixed(1)}, capacity ${budget.worst.capacityMm2.toFixed(1)})`,
                );
            }
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
    if (report.frameStress) {
        const fs = report.frameStress;
        const modeTag = fs.solverMode === 'frame3d' ? '3D frame' : 'rigid-body';
        lines.push('FRAME STRESS (SUPPORT GRAPH)');
        lines.push(
            `  Graph: ${fs.nodeCount} nodes (${fs.rootCount} roots, ${fs.tipCount} tips) · `
            + `${fs.memberCount} beams (${fs.braceCount} braces) [${modeTag}]`,
        );
        lines.push(
            `  Critical layers (${fs.layersEvaluated}): peak ${fs.peakLayerPeelForceN.toFixed(2)}N @ Z=${fs.peakLayerZMm.toFixed(1)}mm · `
            + `tip util max ${fs.maxTipUtilizationPct.toFixed(0)}% (${fs.overloadedTips} overloaded) · `
            + `member util max ${fs.maxMemberUtilizationPct.toFixed(0)}% (${fs.overloadedMembers} overloaded) · `
            + `max defl ${fs.maxTipDeflectionMm.toFixed(3)}mm`
            + ((fs.reinforcedCount ?? 0) > 0 ? ` · reinforced ${fs.reinforcedCount}` : ''),
        );
        const warmSpots = fs.hotspots.filter((h) => h.utilizationPct >= 75);
        for (const h of warmSpots) {
            const stressInfo = h.peakStressMpa !== undefined
                ? ` ${h.peakStressMpa.toFixed(1)}MPa`
                : (h.tipLoadN !== undefined ? ` ${h.tipLoadN.toFixed(2)}N` : '');
            lines.push(
                `    ${h.kind} ${h.entityKind} ${h.entityId.slice(0, 8)} `
                + `${h.utilizationPct.toFixed(0)}%${stressInfo} @ (${h.pos.x.toFixed(1)}, ${h.pos.y.toFixed(1)}, Z${h.pos.z.toFixed(1)}) [layer Z${h.layerZMm.toFixed(1)}]`,
            );
        }
        lines.push('');
    }
    lines.push(`${report.hostCount} ${hostLabel.toLowerCase()} · ${report.leafCount} leaves · ${report.branchCount} branches · ` +
        `${report.bareHosts.length} bare ${hostLabel.toLowerCase()}`);
    if (report.trees.length > 0) {
        lines.push('');
        lines.push('FAN-OUT GROUPS');
        {
            const fanMaxDeg = autoSettings?.leafFanMaxAngleDeg ?? getSettings().autoSupport?.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;
            const cap = autoSettings?.maxAttachmentsPerTrunk ?? getSettings().autoSupport?.maxAttachmentsPerTrunk ?? 12;
            const maxFromVertical = memberMaxAngleFromVerticalDeg();
            const effectiveFan = Math.min(fanMaxDeg, maxFromVertical);
            const effectiveLink = Math.min(fanMaxDeg, maxFromVertical);
            const riseClause = getSettings().grid?.enabled
                ? `Every member must rise ≥${90 - maxFromVertical}° above horizontal (grid.minBranchAngleDeg), so placement `
                : `Every member must rise ≥${90 - maxFromVertical}° above horizontal (photopolymer self-support floor), so placement `;
            lines.push(
                `  (host trunk → its leaves/branches. ${riseClause}fans ≤${effectiveFan}° from vertical within 5mm ` +
                `(2.5mm for grid hosts) and chunk-consolidation links ≤${effectiveLink}° within ` +
                `${CONSOLIDATION_FAN_RADIUS_MM}mm; cap ${cap} members per host. ` +
                `each member's own Ø (a branch's widest segment, a leaf's cone body) follows its span/angle; ` +
                `spans/angles are post-resize knot→tip — drift can make a link read shallower than its placement gate)`);
        }
        for (const tree of report.trees) {
            const members = tree.members
                .map((m) => `${m.id}(${typeWord(m.kind).charAt(0)} ${m.spanMm.toFixed(1)}mm/${m.angleDeg.toFixed(0)}° Ø${m.diameterMm.toFixed(2)})`)
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

export function isExemptFromSteepWallCull(
    island: Pick<DetectedIsland, 'source' | 'class' | 'isDetached' | 'interior'>,
): boolean {
    return island.source === 'overhang'
        || island.source === 'minima'
        || island.class === 'intersection'
        || Boolean(island.isDetached)
        || Boolean(island.interior);
}

/** The trunk a stress action belongs to: the entity itself when it is a trunk,
 *  otherwise the trunk owning the segment its knot hangs from. */
function owningTrunkId(draft: SupportState, entityId: string): string | undefined {
    if (draft.trunks[entityId]) return entityId;
    const knotId = draft.branches[entityId]?.parentKnotId ?? draft.leaves[entityId]?.parentKnotId;
    const knot = knotId ? draft.knots[knotId] : undefined;
    if (!knot) return undefined;
    return Object.values(draft.trunks).find((trunk) =>
        trunk.segments.some((seg) => seg.id === knot.parentShaftId))?.id;
}

/**
 * Buttress a trunk to the build plate with a Kickstand at 30-45° from
 * vertical when no neighbouring shaft is in brace reach. This is the structural
 * answer for a lonely tall spire: the closed loop prefers it to a fatter pole,
 * and the kickstand is an existing support type (same builder as placement).
 *
 * Returns the draft unchanged when the trunk already carries a kickstand, has
 * no segment left below its contact canopy, or no candidate root/column clears
 * the shape and mesh gates.
 */
export function buttressTrunkWithKickstand(
    draftIn: SupportState,
    modelId: string,
    trunkId: string,
    atZMm: number,
    mesh?: THREE.Mesh,
    options?: { allowAdditional?: boolean },
): { draft: SupportState; added: boolean } {
    const trunk = draftIn.trunks[trunkId];
    if (!trunk || trunk.modelId !== modelId) return { draft: draftIn, added: false };
    const segmentIds = new Set(trunk.segments.map((seg) => seg.id));
    const existingKickstands = Object.values(draftIn.kickstands ?? {})
        .filter((ks) => segmentIds.has(ks.hostSegmentId)).length;
    // One plate buttress is the normal answer; a second (opposite azimuth) is
    // the capped-shaft strut fallback. Never more than two.
    if (existingKickstands >= 2 || (existingKickstands >= 1 && !options?.allowAdditional)) {
        return { draft: draftIn, added: false };
    }

    const plateZ = trunk.rootId ? (draftIn.roots[trunk.rootId]?.transform.pos.z ?? 0) : 0;
    let host: { segment: Segment; start: Vec3; end: Vec3; z: number } | null = null;
    for (const segment of trunk.segments) {
        const span = hostSegmentSpan(draftIn, trunk, segment);
        if (!span) continue;
        const lo = Math.min(span.start.z, span.end.z) + 0.25;
        const hi = Math.max(span.start.z, span.end.z) - BRACE_CANOPY_KEEP_OUT_MM;
        if (hi <= lo) continue;
        const z = Math.min(hi, Math.max(lo, atZMm));
        if (!host || z > host.z) host = { segment, start: span.start, end: span.end, z };
    }
    if (!host || host.z - plateZ < 3) return { draft: draftIn, added: false };

    const dz = host.end.z - host.start.z;
    if (Math.abs(dz) < 0.5) return { draft: draftIn, added: false };
    const t = Math.min(1, Math.max(0, (host.z - host.start.z) / dz));
    const hostPos = {
        x: host.start.x + (host.end.x - host.start.x) * t,
        y: host.start.y + (host.end.y - host.start.y) * t,
        z: host.start.z + dz * t,
    };

    // 30-45° from vertical: lateral run ~0.7-1.0 × rise. Try a few distances
    // and all eight azimuths; the builder's own shape/clearance gate decides.
    const rise = hostPos.z - plateZ;
    const baseRun = Math.min(6, Math.max(2.5, rise * 0.7));
    const rootPositions = Object.values(draftIn.roots);
    for (const scale of [1, 0.75, 1.3]) {
        const run = baseRun * scale;
        for (let k = 0; k < 8; k++) {
            const angle = (k * Math.PI) / 4;
            const rootPos = { x: hostPos.x + Math.cos(angle) * run, y: hostPos.y + Math.sin(angle) * run, z: plateZ };
            if (rootPositions.some((r) =>
                Math.hypot(r.transform.pos.x - rootPos.x, r.transform.pos.y - rootPos.y) < 1.5)) continue;

            const seed = `stress-ks-${trunkId}-${Math.round(hostPos.z * 10)}-${Math.round(run * 10)}-${k}`;
            if (draftIn.roots[`${seed}-root`] || draftIn.knots[`${seed}-host-knot`] || draftIn.kickstands[`${seed}-kickstand`]) continue;
            const build = buildKickstandData({
                modelId,
                rootPos,
                host: {
                    segmentId: host.segment.id,
                    supportKind: 'trunk',
                    t,
                    pos: hostPos,
                    diameterMm: host.segment.diameter ?? 1,
                },
                collisionMesh: mesh,
                // The buttress's overall lean is set by `run` (~35°); the
                // builder's last terminal leg is shallower than that, so the
                // per-segment gate keeps the manual-placement ceiling (80°).
                maxShaftAngleDeg: 80,
                idSeed: seed,
            });
            if (build.error) continue;
            let next = draftIn;
            next = draftAddPrimitive(next, 'roots', build.root);
            next = draftAddPrimitive(next, 'knots', build.hostKnot);
            next = draftAddEntity(next, 'kickstand', build.kickstand);
            return { draft: next, added: true };
        }
    }
    return { draft: draftIn, added: false };
}

export function computeAutoSupportPlan(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
    baseState?: SupportState,
    mesh?: THREE.Mesh,
    onProgress?: AutoPlaceProgressCallback,
    cavityMesh?: THREE.Mesh,
    /** Print profile layer height for the peel/traction sampling and the stress
     *  report this run attaches. Omitted → the slicer's default ~1 mm grid. */
    layerHeightMm?: number,
    /** Datasheet tensile strength of the active resin (MPa); the support
     *  break strength is derived from it. Omitted → the standard-resin default. */
    resinTensileMpa?: number,
): AutoSupportPlan | null {
    // One derate from the profile's datasheet tensile to the thin-green-section
    // contact break strength, shared by the placement capacities and the force
    // budget. Member bending stress is compared against the bulk tensile
    // instead: the 4.8 MPa coupon is a 0.5 × 0.5 mm contact, not a 2.2 mm shaft.
    const bulkTensileMpa = Math.max(0.01, resinTensileMpa ?? DEFAULT_RESIN_TENSILE_STRENGTH_MPA);
    const supportStrengthMpa = supportBreakStrengthMpa(bulkTensileMpa);
    const memberStrengthMpa = bulkTensileMpa;
    // ------------------------------------------------------------------
    // 0. Settings
    // ------------------------------------------------------------------

    const definedOverrides = settingsOverride
        ? Object.fromEntries(Object.entries(settingsOverride).filter(([, v]) => v !== undefined))
        : {};
    const autoSettings = normalizeAutoSupportSettings({
        ...(getSettings().autoSupport ?? {}),
        ...definedOverrides,
    });

    if (!autoSettings.enabled) {
        return null;
    }

    // The modal's bar used to start at the placement pass, so the worker
    // startup, the BVH build, the pose measurement and candidate generation
    // looked like a freeze. Every pass reports its own short progress now.
    const reportPhase = (phase: string, done: number, total: number) => {
        onProgress?.({ phase, done, total });
    };
    reportPhase('Preparing model', 0, 1);

    const before = baseState ?? cloneSupportState(getSnapshot());
    // The run is the only holder of the draft, so its writes mutate in place.
    // `before` stays untouched: the shallow copy plus copy-on-write is what
    // keeps it intact without copying a collection per placement.
    let draft: SupportState = createOwnedDraft(before);

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
            startIslands: 0,
            startsUnderSupported: 0,
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

    // Classify internal contacts before anything reads the islands: a tip on
    // a cavity surface must not be routed out to the build plate (that path
    // crosses the shell or fills a bore).
    //
    // The cavity mesh is literally the inner wall of the hollowed model mesh,
    // so an interior contact lies ON it (distance ~0) and an exterior contact
    // is at least one shell thickness away (minimum 0.2 mm). Distance is also
    // normal-agnostic: a winding-convention mismatch cannot invert it.
    let cavityTester: CavityTester | undefined;
    if (cavityMesh && resolvedMesh) {
        cavityMesh.updateMatrixWorld();
        const tester = createCavityTester(
            new Map([[modelId, cavityMesh.geometry]]),
            new Map([[modelId, new THREE.Matrix4().copy(cavityMesh.matrixWorld).invert()]]),
        );
        cavityTester = tester;
        const ON_CAVITY_MM = 0.15;
        let flagged = 0;
        islands = islands.map((island) => {
            if (island.interior !== undefined) return island;
            const interior = tester.distanceToSurface(island.contact, modelId) <= ON_CAVITY_MM;
            if (interior) flagged += 1;
            return interior ? { ...island, interior: true } : island;
        });
        console.log(LOG_PREFIX,
            `Interior classification: cavity mesh present, ${flagged}/${islands.length} islands inside the cavity.`);
    } else if (resolvedMesh) {
        console.log(LOG_PREFIX,
            'Interior classification: no cavity mesh in this run (model not hollowed, or hollowing not applied).');
    }

    // A voxel island records that material starts with nothing below it; it
    // does not record how steep the surface is. On a wall steeper than the
    // self-support angle the layer shift is small enough to print, and a
    // contact there spends a shaft to resist nothing — the "supports on the
    // side of the bow" report. The mesh's nearest triangle gives the angle for
    // any orientation; the vertical-ray resolver cannot.
    if (resolvedMesh) {
        const selfSupportDeg = autoSettings.overhangSelfSupportAngleDeg;
        const before = islands.length;
        islands = islands.filter((island) => {
            if (isExemptFromSteepWallCull(island)) return true;
            // A hole-tolerant vertical ray is the right answer wherever it
            // hits; only when both rays miss (a side wall) does the nearest
            // triangle answer, so a punched ceiling is not mistaken for the
            // hole's vertical rim.
            const resolved = resolveSurfaceNormal(island.contact, resolvedMesh);
            const normal = resolved.hit
                ? resolved.normal
                : (closestSurfaceNormal(resolvedMesh, island.contact) ?? resolved.normal);
            const inclinationDeg = Math.acos(Math.min(1, Math.abs(normal.z))) * (180 / Math.PI);
            return inclinationDeg <= selfSupportDeg + 0.5;
        });
        const dropped = before - islands.length;
        if (dropped > 0) {
            console.log(LOG_PREFIX,
                `Skipped ${dropped} island(s) on surfaces steeper than ${selfSupportDeg}° (self-supporting).`);
        }
    }

    // ------------------------------------------------------------------
    // 1. Generate candidates
    // ------------------------------------------------------------------

    // Does this pose need anti-topple contact at all? The same rule the
    // stabilization anchors use: no bearing polygon, the mass outside the base,
    // or an adhesion ratio below the conservative p/sigma. A part that stands
    // on a wide patch with its centroid well inside it does not need contact on
    // a self-supporting wall just because the wall is steep, and covering it
    // anyway is how a squat cylinder came back wrapped in a support forest.
    // A raft under the part changes what the contact IS, so the report has to
    // know: with one, the patch is the model's XY shadow rather than the 2mm
    // cap on its own bottom, which is the cap whose centre wanders with the
    // tilt and flips the verdict on a fraction of a degree.
    const hasRaft = getRaftSettingsForModel(modelId).bottomMode !== 'off';
    const poseStability = resolvedMesh
        ? measurePoseStability(
              posedPositions(resolvedMesh),
              resolvedMesh.geometry.index?.array ?? null,
              0,
              0,
              undefined,
              hasRaft,
          )
        : null;
    let toppleProfile: RepresentativeLayerProfile | undefined;
    let prePlacementTopple: ToppleRiskReport | undefined;
    if (
        resolvedMesh
        && poseStability
        && poseStability.bearingEdges > 0
        && poseStability.bearingAreaMm2 > 0
        && poseStability.dragMomentMm3 > 1e-9
        && poseStability.worstEdgePoint
        && poseStability.worstEdgeNormal
        && Math.hypot(poseStability.worstEdgeNormal.x, poseStability.worstEdgeNormal.y) > 1e-6
    ) {
        // Shared with the analysis panel: an in-process run seeds the cache the
        // panel reads, so the same mesh is not sliced twice at the same height.
        toppleProfile = getCachedRepresentativeLayers(resolvedMesh, layerHeightMm);
        const localCentroid = geometryCentroidMm(resolvedMesh.geometry);
        if (localCentroid) {
            const worldCentroid = new THREE.Vector3(localCentroid.x, localCentroid.y, localCentroid.z)
                .applyMatrix4(resolvedMesh.matrixWorld);
            prePlacementTopple = evaluateToppleRisk({
                profile: toppleProfile,
                centroid: { x: worldCentroid.x, y: worldCentroid.y },
                edge: { point: poseStability.worstEdgePoint, normal: poseStability.worstEdgeNormal },
                bearingAreaMm2: poseStability.bearingAreaMm2,
                contactDepthMm: poseStability.contactDepthMm,
            });
        }
    }
    const toppleCoverageNeeded = (!poseStability || poseStability.bearingEdges === 0 || poseStability.bearingAreaMm2 <= 0)
        ? true
        : poseStability.dragMomentMm3 <= 1e-9
            ? false
            : prePlacementTopple
                ? toppleRiskNeedsCoverage(prePlacementTopple)
                : needsToppleCoverage(poseStability);
    const islandsToCover = islands.filter(
        (i) =>
            !i.steepFlat ||
            steepFlatNeedsCoverage(i.surfaceAreaMm2, toppleCoverageNeeded),
    );
    // A wall sways under the peel's lateral load while it prints, and a contact
    // only stops the sway at its own height, so a slender part's anchoring
    // ladder climbs its face instead of sitting in a band at the bottom.
    const slenderPart = poseStability ? isSlenderPart(poseStability) : false;
    if (slenderPart) {
        console.log(LOG_PREFIX,
            `Slender part (${poseStability?.slenderness.toFixed(1)}x taller than thick, ` +
            `${poseStability?.thicknessMm.toFixed(1)}mm thick) — anchoring contacts ladder up ` +
            `steep flats instead of banding low, spaced no wider than the thickness`);
    }
    const steepFlats = islands.filter((i) => i.steepFlat).length;
    const dropped = steepFlats - islandsToCover.filter((i) => i.steepFlat).length;
    if (dropped > 0) {
        const liftNote = prePlacementTopple
            ? `lift ${(prePlacementTopple.requiredAdhesionMpa * 1000).toFixed(1)}kPa, `
            : `adhesion ${poseStability?.adhesionRatio.toFixed(3)}, `;
        console.log(LOG_PREFIX,
            `Topple coverage not needed — ${dropped} of ${steepFlats} steep flats left uncovered ` +
            `(${liftNote}` +
            `centroid depth ${poseStability?.centroidDepthMm.toFixed(2)}mm, ` +
            `bearing ${poseStability?.bearingAreaMm2.toFixed(1)}mm²; ` +
            `any flat at least ${STEEP_FLAT_ANCHOR_MIN_AREA_MM2.toFixed(0)}mm² keeps its anchoring contacts)`);
    }

    // One start definition for placement, reporting and tests: the scan's own
    // detached-island flag is the first cross-section with nothing below it.
    islands = markStartIslands(islands);

    console.log(LOG_PREFIX, `Input: ${islands.length} islands from scan`);
    resetRouterStats();
    reportPhase('Preparing model', 1, 1);
    reportPhase('Finding candidates', 0, 1);
    timingStart('candidates');

    let candidates = generateCandidates(islandsToCover, autoSettings, { mesh: resolvedMesh, modelId });
    candidates = candidates.map((c): CandidatePoint => ({ ...c, modelId }));

    // Stabilization pass: when the oriented mesh bears on a point or edge,
    // formation detection sees nothing to support, so a dedicated bearing
    // analysis adds anchor contacts to broaden the base. They attach to a
    // nearby host when the brace pass will run, and stay standalone when it
    // will not (see the placement gate below).
    let stabilizationAnchors = 0;
    if (autoSettings.stabilizationEnabled !== false && resolvedMesh) {
        const anchors = computeStabilizationAnchors(resolvedMesh, { hasRaft, toppleCoverageNeeded });
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

    // Minima reinforcement pass: a mesh minima is the first point of a
    // section, so its own tip support holds a POINT while the section's whole
    // cross-section hangs off it. Ring that minima with contacts on its own
    // flank (see `minimaReinforcement.ts`). Standalone trunks like the
    // stabilization anchors — broadening the section's base IS the job, so
    // they must not fan onto the tip support they ring. Gated on
    // `minimaOnly` islands: a minima the voxel mask already saw sits on a
    // surface the island/overhang passes cover.
    let reinforcementPoints = 0;
    if (autoSettings.minimaReinforcementEnabled !== false && resolvedMesh) {
        const points = computeMinimaReinforcementPoints(islandsToCover, resolvedMesh, autoSettings);
        if (points.length > 0) {
            const reinforcementCandidates: CandidatePoint[] = points.map((p, i) => ({
                id: `reinf-${p.islandId}-${i}`,
                tipPos: { x: p.x, y: p.y, z: p.z },
                tipNormal: { x: 0, y: 0, z: -1 }, // placeholder — caller raycasts for the real normal
                modelId,
                source: 'reinforcement',
                islandAreaMm2: 0.05,
                zHeight: p.z,
                priority: 0,
            }));
            reinforcementPoints = reinforcementCandidates.length;
            candidates = [...candidates, ...reinforcementCandidates];
        }
    }

    // Candidate generation phase: every overhang region above the threshold
    // gets the unified fixed-density distribution (2D-projected boundary ring
    // + grid infill). Shape decides the degenerate cases — slivers get a ring
    // only, small patches stay on the single-candidate path below. A
    // generation failure must not kill the whole run — fall back to the
    // region's single candidate.
    const overhangIslands = islandsToCover.filter((i) => i.source === 'overhang');
    // Class-2 force-augmented surfaces: self-supporting steep flats are never
    // formation targets, but an over-budget cell may have no closer down-facing
    // surface. They are eligible for force-budget additions only.
    const forceBudgetSurfaces = collectForceBudgetSurfaces(islands, overhangIslands);
    const { minZ: modelMinZ, heightMm: modelHeightMm } = meshWorldZBounds(resolvedMesh);
    const baseWindowMm = baseOverhangWindowMm(modelHeightMm);
    const eligible = overhangIslands.filter((i) => shouldUseDensityGrid(i, autoSettings, modelMinZ, baseWindowMm));
    if (eligible.length > 0) {
        let generated: CandidatePoint[] = [];
        try {
            generated = generateGridCandidates(
                eligible,
                autoSettings,
                resolvedMesh,
                modelId,
                slenderPart,
                poseStability?.thicknessMm ?? 0,
                modelMinZ,
                baseWindowMm,
                islandsToCover.filter((i) => i.source !== 'overhang' && (i.isDetached || i.class === 'intersection')),
            )
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
        `stabilization: ${stabilizationAnchors} anchors, ` +
        `reinforcement: ${reinforcementPoints} points)`);
    if (candidates.length === 0) {
        return noopPlan(makeResult(emptyPlacedCounts(), 0, false, 'no-candidates'));
    }

    timingEnd('candidates');
    reportPhase('Finding candidates', 1, 1);
    reportPhase('Removing duplicates', 0, 1);
    timingStart('dedup');
    // ------------------------------------------------------------------
    // 2. Deduplicate
    // ------------------------------------------------------------------

    const beforeDedup = candidates.length;
    candidates = deduplicateCandidates(candidates, autoSettings, resolvedMesh);
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
    reportPhase('Removing duplicates', 1, 1);
    reportPhase('Filtering supports', 0, 1);
    timingStart('support-filter');
    const beforeSupportFilter = candidates.length;
    candidates = filterAlreadySupported(candidates, draft, modelId);
    const filteredCandidates = candidates.length;
    console.log(LOG_PREFIX,
        `Step 2b: ${candidates.length} candidates after support filter ` +
        `(removed ${beforeSupportFilter - candidates.length} already supported within ${ALREADY_SUPPORTED_RADIUS_MM}mm)`);

    if (candidates.length === 0) {
        return noopPlan(makeResult(emptyPlacedCounts(), 0, false, 'already-supported'));
    }

    const preResolvedCandidates = new WeakSet<CandidatePoint>();
    if (resolvedMesh) {
        for (const c of candidates) {
            if (!(c.gridPoint && c.tipNormal && c.tipNormal.z < 0)) {
                const resolved = resolveSurfaceNormal(c.tipPos, resolvedMesh);
                c.tipNormal = resolved.normal;
                if (resolved.hit) {
                    c.tipPos = resolved.point;
                    c.zHeight = resolved.point.z;
                }
            }
            preResolvedCandidates.add(c);
        }
    }

    // ------------------------------------------------------------------
    // 2c. Phase 1c: Representative-layer Voronoi traction optimization
    //     Runs after normal resolution so Pass C's global cross-region
    //     pruner reads exact underside angles and normal compatibility,
    //     and before tip capping so pruned candidates skip SDF probes.
    // ------------------------------------------------------------------
    let tractionStats: TractionOptimizationStats | undefined;
    // Plan-level so the forest report can carry them: the add pass itself sits
    // inside a placement block that closes before the report.
    let forceBudgetAdds = 0;
    let forceBudgetAttempts = 0;
    let forceBudgetAugmentedAttempts = 0;
    let forceBudgetAugmentedPlaced = 0;
    // The pre-placement topple evaluation already sampled this mesh at the print
    // layer height; the frame report must use the same profile even when the
    // traction pass does not run (no overhang islands), or it falls back to the
    // single synthetic layer and a coarse peel curve.
    let tractionProfile: RepresentativeLayerProfile | undefined = toppleProfile;
    if (overhangIslands.length > 0) {
        const tractionResult = optimizeContactsByTraction(
            candidates,
            eligible,
            autoSettings,
            resolvedMesh,
            modelId,
            { layerHeightMm, profile: toppleProfile, supportStrengthMpa },
        );
        candidates = tractionResult.candidates;
        tractionStats = tractionResult.stats;
        tractionProfile = tractionResult.profile;
        if (resolvedMesh) {
            for (const c of candidates) {
                if (!preResolvedCandidates.has(c)) {
                    const resolved = resolveSurfaceNormal(c.tipPos, resolvedMesh);
                    c.tipNormal = resolved.normal;
                    if (resolved.hit) {
                        c.tipPos = resolved.point;
                        c.zHeight = resolved.point.z;
                    }
                    preResolvedCandidates.add(c);
                }
            }
        }
        if (tractionStats.added > 0 || tractionStats.pruned > 0 || tractionStats.representativeLayers > 0) {
            console.log(LOG_PREFIX,
                `Step 2c (Traction Voronoi): ${tractionStats.representativeLayers} rep layers ` +
                `(peak ${tractionStats.peakCrossSectionMm2.toFixed(0)}mm²) · ` +
                `+${tractionStats.added} added, −${tractionStats.pruned} pruned → ${candidates.length} candidates`);
        }
    }

    if (resolvedMesh) {
        applyContactTipCaps(candidates, resolvedMesh, autoSettings.tipContactMarginScale, autoSettings);
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

    // ── Model sizing context (mesh volume/extent for the sizing terms) ──
    let modelCtx: ModelSizingContext | undefined;
    if (resolvedMesh) {
        const bbox = new THREE.Box3().setFromObject(resolvedMesh);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const outerVolMm3 = resolvedMesh ? computeMeshVolumeMm3(resolvedMesh) : 0;
        const cavityVolMm3 = cavityMesh ? computeMeshVolumeMm3(cavityMesh) : 0;
        const modelVolumeMm3 = Math.max(0, outerVolMm3 - cavityVolMm3);
        modelCtx = {
            modelVolumeMm3,
            modelZMaxMm: bbox.max.z,
            totalCandidates: estimateHostCount(candidates, getSettings().grid),
            // The print's own geometric scale, as oriented: a part rotated to
            // stand taller is the part the supports have to hold.
            modelSizeMm: size.length(),
        };
        const f = modelSizingFactors(modelCtx, autoSettings);
        console.log(LOG_PREFIX,
            `Sizing: model ${f.sizeMm.toFixed(0)}mm · ${(modelCtx.modelVolumeMm3 * RESIN_DENSITY_G_PER_MM3).toFixed(0)}g · ` +
            `${f.loadShareG.toFixed(2)}g/support (${modelCtx.totalCandidates} candidates) → ` +
            `size ×${f.sizeFactor.toFixed(2)}, load ×${f.loadFactor.toFixed(2)}, ` +
            `trunk ×${(f.sizeFactor * f.loadFactor).toFixed(2)} over the profile band`);
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
        candidatesBySource: { voxel: 0, minima: 0, intersection: 0, overhang: 0, stabilization: 0, reinforcement: 0 },
        hostsByKind: { gridInfill: 0, coverageFill: 0, standalone: 0 },
        fanRefusals: {},
        mergeRefusals: {},
        gridFallbacks: 0,
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
    reportPhase('Filtering supports', 1, 1);
    reportPhase('Placing supports', 0, candidates.length);
    timingStart('placement');

    const placeOne = (candidate: CandidatePoint, deferTrunkError = false): string => {
        try {
            const result = placeOneCandidate(candidate, draft, autoSettings, gridHostIds, resolvedMesh, modelCtx, false, preResolvedCandidates, deferTrunkError, cavityTester);
            if (deferTrunkError && result.kind === 'reject' && result.rejectedReason === 'trunk_build_error') {
                return 'defer_rescue';
            }
            if (result.kind === 'reject' && result.rejectedReason === 'trunk_build_error'
                && !trunkErrorBacklogIds.has(candidate.id)) {
                trunkErrorBacklogIds.add(candidate.id);
                trunkErrorBacklog.push(candidate);
            }
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
                if (result.gridFallback) diagnostics.gridFallbacks++;
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
                        bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
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

    // ── Phase 2: Cluster-First Tree Synthesis ────────────────────────
    // Partition candidates into near-plate/interior, well-spaced plate-clear
    // trunk anchors, clustered members, and vertically occluded contacts.
    // Placing ALL trunk anchors first builds a sparse, well-spaced skeleton
    // before any leaves or branches are attached.
    const liveGrid = getSettings().grid;
    const synthesisGridConfig: TreeSynthesisGridConfig | undefined = gridEnabled
        ? { enabled: true, spacingMm: liveGrid?.spacingMm ?? 2.0 }
        : undefined;
    const synthesisMaxAngleDeg = memberMaxAngleFromVerticalDeg(Boolean(gridEnabled));
    const treePlan = synthesizeTreeClusters(candidates, {
        maxAngleFromVerticalDeg: synthesisMaxAngleDeg,
        maxReachMm: gridEnabled
            ? Math.max(GRID_HOST_FAN_RADIUS_MM, (liveGrid?.spacingMm ?? 2.0) * 1.5)
            : Math.max(autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM, CONSOLIDATION_FAN_RADIUS_MM),
        maxAttachmentsPerTrunk: autoSettings.maxAttachmentsPerTrunk,
        minTrunkSpacingMm: MIN_TRUNK_SPACING_MM,
        shaftDiameterMm: activeSizingBand(autoSettings).shaftDiameterMm,
        grid: synthesisGridConfig,
        mesh: resolvedMesh ?? undefined,
    });

    const occludedRescueQueue: CandidatePoint[] = [...treePlan.occludedQueue];
    /** Candidates a trunk build refused and that were not already deferred to
     *  the rescue queue; retried as wide fans after gap-fill. */
    const trunkErrorBacklog: CandidatePoint[] = [];
    const trunkErrorBacklogIds = new Set<string>();
    let placementIndex = 0;
    const placementTotal = candidates.length;
    const tickProgress = () => {
        if (onProgress !== undefined
            && (placementIndex % 16 === 0 || placementIndex + 1 === placementTotal)) {
            onProgress({ phase: 'Placing supports', done: placementIndex + 1, total: placementTotal });
        }
        placementIndex++;
    };

    // Pass 2a: Near-plate overrides (stumps / interior bridges) + ALL cluster trunk anchors.
    // Track anchorId -> placed hostId so Pass 2b can target each member's
    // assigned cluster trunk first before searching the wider skeleton.
    const anchorHostIdByCandidateId = new Map<string, string>();
    for (const candidate of treePlan.nearPlate) {
        tickProgress();
        placeOne(candidate);
    }
    for (const anchor of treePlan.trunkAnchors) {
        tickProgress();
        const prevLedgerLen = forestLedger.length;
        const outcome = placeOne(anchor, Boolean(resolvedMesh));
        if (outcome === 'defer_rescue') {
            occludedRescueQueue.push(anchor);
        } else if (forestLedger.length > prevLedgerLen) {
            const placedEntry = forestLedger[forestLedger.length - 1];
            if (placedEntry.kind === 'trunk') {
                anchorHostIdByCandidateId.set(anchor.id, placedEntry.entityId);
            }
        }
    }

    // Pass 2b: Clustered members attach directly onto the completed trunk skeleton
    // (trying their assigned cluster trunk first, then any clear skeleton host)
    // instead of spawning redundant standalone trunks.
    let clusterSkeletonPool: FanShaftPoint[] | null = null;
    const clusterFanRadiusMm = Math.max(autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM, CONSOLIDATION_FAN_RADIUS_MM);
    const clusterFanMaxAngleDeg = Math.min(
        autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
        synthesisMaxAngleDeg,
    );
    for (const { candidate, preferredAnchorId } of treePlan.clusteredMembers) {
        tickProgress();
        const anchorsMayAttach = candidate.source !== 'stabilization'
            || autoSettings.debugSkipAutoBracing !== true;

        if (!gridEnabled && anchorsMayAttach && !candidate.interior) {
            if (!clusterSkeletonPool) clusterSkeletonPool = collectFanShaftPoints(draft);
            const preferredHostId = anchorHostIdByCandidateId.get(preferredAnchorId);
            const targetPool = preferredHostId
                ? clusterSkeletonPool.filter((sp) => sp.hostId === preferredHostId)
                : [];
            const attachOrigin = hostedOriginForSource(candidate.source);
            const preset = presetForArea(candidate.islandAreaMm2);

            const tryAttach = (poolToUse: FanShaftPoint[]) => poolToUse.length > 0
                ? fanLeafToHost(
                    candidate.tipPos,
                    candidate.modelId,
                    poolToUse,
                    new Set(),
                    `auto-cluster-${candidate.id}`,
                    clusterFanRadiusMm,
                    clusterFanRadiusMm,
                    clusterFanMaxAngleDeg,
                    autoSettings.maxAttachmentsPerTrunk,
                    draft,
                    resolvedMesh ?? undefined,
                    attachOrigin,
                    'nearest',
                    undefined,
                    undefined,
                    autoSettings,
                    candidate.tipDiameterMm,
                )
                : ({ ok: false as const, reason: 'noHost' as const });

            let attached = tryAttach(targetPool);
            if (!attached.ok) {
                attached = tryAttach(clusterSkeletonPool);
            }
            if (attached.ok) {
                draft = attached.draft;
                placed[attached.kind]++;
                presets[preset]++;
                diagnostics.candidatesBySource[candidate.source] =
                    (diagnostics.candidatesBySource[candidate.source] ?? 0) + 1;
                if (attached.entityId && isLedgerKind(attached.kind)) {
                    forestLedger.push({
                        displayId: candidate.id,
                        kind: attached.kind,
                        entityId: attached.entityId,
                        areaMm2: candidate.islandAreaMm2,
                        zHeight: candidate.zHeight,
                        preset,
                        bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                    });
                }
                continue;
            }
        }

        const outcome = placeOne(candidate, Boolean(resolvedMesh));
        if (outcome === 'defer_rescue') {
            occludedRescueQueue.push(candidate);
        } else if (outcome === 'trunk') {
            // A fallback trunk joined the skeleton; refresh pool lazily.
            clusterSkeletonPool = null;
        }
    }

    // Pass 2c: 2-level `Trunk -> Branch -> Leaf` crown synthesis for elevated
    // and occluded upper clusters (chin/snout/jaw/hilt). Routes ONE angled arm
    // Branch from a nearby clear trunk up to the cluster's anchor contact, then
    // fans close sibling contacts (<=4.5mm) as slim 2nd-level Leaves off that
    // branch's upper shaft — avoiding parallel vertical flagpoles across the model.
    if (treePlan.upperClusters.length > 0) {
        if (!clusterSkeletonPool) clusterSkeletonPool = collectFanShaftPoints(draft);
        for (const group of treePlan.upperClusters) {
            tickProgress();
            const anchorCand = group.anchor;
            const preferredHostId = anchorHostIdByCandidateId.get(group.preferredTrunkAnchorId);
            const preferredPool = preferredHostId
                ? clusterSkeletonPool.filter((sp) => sp.hostId === preferredHostId)
                : [];
            const attachOrigin = hostedOriginForSource(anchorCand.source);
            const anchorPreset = presetForArea(anchorCand.islandAreaMm2);

            const tryArm = (poolToUse: FanShaftPoint[]) => poolToUse.length > 0
                ? fanLeafToHost(
                    anchorCand.tipPos,
                    anchorCand.modelId,
                    poolToUse,
                    new Set(),
                    `auto-crown-arm-${anchorCand.id}`,
                    TWO_LEVEL_BRANCH_REACH_MM,
                    TWO_LEVEL_BRANCH_REACH_MM,
                    clusterFanMaxAngleDeg,
                    autoSettings.maxAttachmentsPerTrunk,
                    draft,
                    resolvedMesh ?? undefined,
                    attachOrigin,
                    'nearest',
                    MAX_UNBRACED_BRANCH_SPAN_MM,
                    undefined,
                    autoSettings,
                    anchorCand.tipDiameterMm,
                )
                : ({ ok: false as const, reason: 'noHost' as const });

            let arm = tryArm(preferredPool);
            if (!arm.ok) arm = tryArm(clusterSkeletonPool);

            if (arm.ok) {
                draft = arm.draft;
                placed[arm.kind]++;
                presets[anchorPreset]++;
                diagnostics.candidatesBySource[anchorCand.source] =
                    (diagnostics.candidatesBySource[anchorCand.source] ?? 0) + 1;
                if (arm.entityId && isLedgerKind(arm.kind)) {
                    forestLedger.push({
                        displayId: anchorCand.id,
                        kind: arm.kind,
                        entityId: arm.entityId,
                        areaMm2: anchorCand.islandAreaMm2,
                        zHeight: anchorCand.zHeight,
                        preset: anchorPreset,
                        bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                    });
                }

                // Fan sibling contacts as 2nd-level slim Leaves off the new Branch arm.
                const branchPool = arm.kind === 'branch' && arm.entityId
                    ? collectBranchFanShaftPoints(draft, modelId, new Set([arm.entityId]))
                    : [];
                for (const sib of group.siblings) {
                    tickProgress();
                    const sibOrigin = hostedOriginForSource(sib.source);
                    const sibPreset = presetForArea(sib.islandAreaMm2);
                    let sibAttached = branchPool.length > 0
                        ? fanLeafToHost(
                            sib.tipPos,
                            sib.modelId,
                            branchPool,
                            new Set(),
                            `auto-crown-leaf-${sib.id}`,
                            MAX_LEAF_FALLBACK_SPAN_MM,
                            MAX_LEAF_FALLBACK_SPAN_MM,
                            clusterFanMaxAngleDeg,
                            6,
                            draft,
                            resolvedMesh ?? undefined,
                            sibOrigin,
                            'nearest',
                            undefined,
                            undefined,
                            autoSettings,
                            sib.tipDiameterMm,
                        )
                        : ({ ok: false as const, reason: 'noHost' as const });
                    // If the branch shaft couldn't catch this sibling, try the main trunk skeleton.
                    if (!sibAttached.ok && clusterSkeletonPool.length > 0) {
                        sibAttached = fanLeafToHost(
                            sib.tipPos,
                            sib.modelId,
                            clusterSkeletonPool,
                            new Set(),
                            `auto-crown-trunk-${sib.id}`,
                            TWO_LEVEL_BRANCH_REACH_MM,
                            TWO_LEVEL_BRANCH_REACH_MM,
                            clusterFanMaxAngleDeg,
                            autoSettings.maxAttachmentsPerTrunk,
                            draft,
                            resolvedMesh ?? undefined,
                            sibOrigin,
                            'nearest',
                            MAX_UNBRACED_BRANCH_SPAN_MM,
                            undefined,
                            autoSettings,
                            sib.tipDiameterMm,
                        );
                    }
                    if (sibAttached.ok) {
                        draft = sibAttached.draft;
                        placed[sibAttached.kind]++;
                        presets[sibPreset]++;
                        diagnostics.candidatesBySource[sib.source] =
                            (diagnostics.candidatesBySource[sib.source] ?? 0) + 1;
                        if (sibAttached.entityId && isLedgerKind(sibAttached.kind)) {
                            forestLedger.push({
                                displayId: sib.id,
                                kind: sibAttached.kind,
                                entityId: sibAttached.entityId,
                                areaMm2: sib.islandAreaMm2,
                                zHeight: sib.zHeight,
                                preset: sibPreset,
                                bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                            });
                        }
                    } else {
                        const sibOutcome = placeOne(sib, Boolean(resolvedMesh));
                        if (sibOutcome === 'defer_rescue') occludedRescueQueue.push(sib);
                        else if (sibOutcome === 'trunk') clusterSkeletonPool = null;
                        if (!clusterSkeletonPool) clusterSkeletonPool = collectFanShaftPoints(draft);
                    }
                }
            } else {
                // Primary arm blocked/unreachable — fall back cleanly for anchor and siblings.
                const anchorOutcome = placeOne(anchorCand, Boolean(resolvedMesh));
                if (anchorOutcome === 'defer_rescue') occludedRescueQueue.push(anchorCand);
                else if (anchorOutcome === 'trunk') clusterSkeletonPool = collectFanShaftPoints(draft);
                for (const sib of group.siblings) {
                    tickProgress();
                    const sibOutcome = placeOne(sib, Boolean(resolvedMesh));
                    if (sibOutcome === 'defer_rescue') occludedRescueQueue.push(sib);
                    else if (sibOutcome === 'trunk') clusterSkeletonPool = collectFanShaftPoints(draft);
                }
            }
        }
    }

    // ── Phase 3: Plate-First Occluded Rescue Ladder ──────────────────
    // (1) Wide clear-trunk branch/leaf across the completed skeleton (<=12mm),
    // (2) Silhouette offset/dogleg trunk around lower mesh (0 extra scars),
    // (3) Short cavity bridge (twig/stick <=12mm) via placeOne fallback.
    const collectModelRootPoints = (): Array<{ x: number; y: number }> => {
        const pts: Array<{ x: number; y: number }> = [];
        for (const r of Object.values(draft.roots)) {
            if (r.modelId === modelId) {
                pts.push({ x: r.transform.pos.x, y: r.transform.pos.y });
            }
        }
        return pts;
    };

    const tryBuildSilhouetteDogleg = (candidate: CandidatePoint) => {
        if (!resolvedMesh || candidate.interior) return null;
        const overrides = sizeParameters(candidate, autoSettings.sizeScale, modelCtx, autoSettings);
        const supportSettings = getSettings();
        const tipProfile = {
            type: 'disk' as const,
            contactDiameterMm: overrides.tipContactDiameterMm ?? supportSettings.tip.contactDiameterMm,
            bodyDiameterMm: overrides.tipBodyDiameterMm ?? supportSettings.tip.bodyDiameterMm,
            lengthMm: overrides.tipLengthMm ?? supportSettings.tip.lengthMm,
            penetrationMm: overrides.tipPenetrationMm ?? supportSettings.tip.penetrationMm,
            diskThicknessMm: supportSettings.tip.diskThicknessMm ?? 0.1,
            maxStandoffMm: supportSettings.tip.maxStandoffMm ?? 1.5,
            standoffAngleThreshold: supportSettings.tip.standoffAngleThreshold ?? Math.PI / 4,
        };
        const socketPos = getSocketPosition(candidate.tipPos, candidate.tipNormal, tipProfile);
        const escapeRoute = findOffsetSilhouetteRoute(
            socketPos,
            resolvedMesh,
            (overrides.shaftDiameterMm ?? activeSizingBand(autoSettings).shaftDiameterMm) * 0.5,
            synthesisMaxAngleDeg,
            collectModelRootPoints(),
            synthesisGridConfig,
            MIN_TRUNK_SPACING_MM,
            (a, b, rad) => isShaftBlocked(a, b, rad, resolvedMesh),
        );
        if (!escapeRoute) return null;
        const trunkBuilt = buildTrunkDataFromPlacement(
            {
                tipPos: candidate.tipPos,
                tipNormal: candidate.tipNormal,
                modelId: candidate.modelId,
                mesh: resolvedMesh,
                overrides,
                ignoreGrid: !gridEnabled,
            },
            {
                basePos: escapeRoute.basePos,
                joints: [escapeRoute.bendJoint],
                socketPos,
                coneAxis: candidate.tipNormal,
            },
        );
        if (trunkBuilt.error || !trunkBuilt.trunk || !trunkBuilt.root) return null;
        const rootTop: Vec3 = {
            x: trunkBuilt.root.transform.pos.x,
            y: trunkBuilt.root.transform.pos.y,
            z: trunkBuilt.root.transform.pos.z
                + trunkBuilt.root.diskHeight
                + trunkBuilt.root.coneHeight,
        };
        const firstSeg = trunkBuilt.trunk.segments[0];
        if (firstSeg && !firstSeg.bottomJoint && firstSeg.topJoint?.pos) {
            const rad = Math.max(0.2, (firstSeg.diameter ?? 1.0) * 0.5) + HOST_SHAFT_CLEARANCE_MARGIN_MM;
            if (isShaftBlocked(rootTop, firstSeg.topJoint.pos, rad, resolvedMesh)) {
                return null;
            }
        }
        if (isHostShaftBlocked(trunkBuilt.trunk, resolvedMesh)) {
            return null;
        }
        const rescuedTrunk = {
            ...trunkBuilt.trunk,
            origin: candidate.gridPoint ? ('overhang' as SupportOrigin) : ORIGIN_BY_SOURCE[candidate.source],
        };
        if (candidate.tipDiameterMm !== undefined && rescuedTrunk.contactCone) {
            rescuedTrunk.contactCone = applyExplicitTipCapToCone(
                rescuedTrunk.contactCone,
                Math.max(MIN_CONTACT_TIP_DIAMETER_MM, candidate.tipDiameterMm),
            );
        }
        return { root: trunkBuilt.root, trunk: rescuedTrunk };
    };

    const commitDoglegTrunk = (
        candidate: CandidatePoint,
        built: { root: NonNullable<ReturnType<typeof tryBuildSilhouetteDogleg>>['root']; trunk: NonNullable<ReturnType<typeof tryBuildSilhouetteDogleg>>['trunk'] },
        preset: SizingPreset,
    ) => {
        draft = draftAddPrimitive(draft, 'roots', built.root);
        draft = draftAddEntity(draft, 'trunk', built.trunk);
        placed.trunk++;
        presets[preset]++;
        diagnostics.candidatesBySource[candidate.source] =
            (diagnostics.candidatesBySource[candidate.source] ?? 0) + 1;
        if (candidate.gridPoint) {
            gridHostIds.add(built.trunk.id);
            diagnostics.hostsByKind.gridInfill++;
            hostOriginById.set(built.trunk.id, 'gridInfill');
        } else {
            diagnostics.hostsByKind.standalone++;
        }
        forestLedger.push({
            displayId: candidate.id,
            kind: 'trunk',
            entityId: built.trunk.id,
            areaMm2: candidate.islandAreaMm2,
            zHeight: candidate.zHeight,
            preset,
            bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
        });
    };

    let rescuePool: FanShaftPoint[] | null = null;
    for (const candidate of occludedRescueQueue) {
        tickProgress();
        const preset = presetForArea(candidate.islandAreaMm2);

        // Tier 1: Wide branch/leaf onto any unobstructed trunk in the full skeleton.
        if (resolvedMesh && !candidate.interior) {
            if (!rescuePool) rescuePool = collectFanShaftPoints(draft);
            const fan = fanLeafToHost(
                candidate.tipPos,
                candidate.modelId,
                rescuePool,
                gridHostIds,
                `auto-rescue-fan-${candidate.id}`,
                CAVITY_FAN_RADIUS_MM,
                CAVITY_FAN_RADIUS_MM,
                synthesisMaxAngleDeg,
                autoSettings.maxAttachmentsPerTrunk,
                draft,
                resolvedMesh,
                hostedOriginForSource(candidate.source),
                'steepest',
                MAX_UNBRACED_BRANCH_SPAN_MM,
                undefined,
                autoSettings,
                candidate.tipDiameterMm,
            );
            if (fan.ok) {
                draft = fan.draft;
                placed[fan.kind]++;
                presets[preset]++;
                diagnostics.candidatesBySource[candidate.source] =
                    (diagnostics.candidatesBySource[candidate.source] ?? 0) + 1;
                if (fan.entityId && isLedgerKind(fan.kind)) {
                    forestLedger.push({
                        displayId: candidate.id,
                        kind: fan.kind,
                        entityId: fan.entityId,
                        areaMm2: candidate.islandAreaMm2,
                        zHeight: candidate.zHeight,
                        preset,
                        bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                    });
                }
                continue;
            }

            // Tier 2: Silhouette offset / dogleg trunk routed around the lower mesh.
            const dogleg = tryBuildSilhouetteDogleg(candidate);
            if (dogleg) {
                commitDoglegTrunk(candidate, dogleg, preset);
                // Invalidate pool so subsequent occluded neighbors on the same
                // feature can branch off this new dogleg trunk in Tier 1.
                rescuePool = null;
                continue;
            }
        }

        // Tier 3: Standard placement fallback (short cavity bridge <=12mm or reject).
        placeOne(candidate, false);
        rescuePool = null;
    }

    timingEnd('placement');
    reportPhase('Consolidating supports', 0, 1);
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
    const configuredFanAngleDeg = autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;
    const conFanMaxAngleDeg = Math.min(
        configuredFanAngleDeg,
        memberMaxAngleFromVerticalDeg(Boolean(gridEnabled)),
    );
    let consolidated = 0;
    // Reused per attempt: the pillar being converted is the host that must not
    // be offered or crossed. Hosts converted earlier are already gone from the
    // draft, so their samples are skipped by the model lookup.
    const excludeHostId = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
        let convertedThisPass = 0;
        // One pool per pass. A conversion deletes the pillar it replaces, and
        // `collectFanShaftPoints` walks every host segment with its 10 samples
        // — rebuilding that per host made this loop O(n²) with an allocation
        // per sample. The pool keeps every sample; a converted host's samples
        // no longer resolve in the draft, so they are skipped.
        const pool = collectFanShaftPoints(draft);
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
            //
            // Reinforcement pillars are the exception among non-overhang
            // hosts, and the reason the convertibility flag exists: a minima's
            // ring is one to six contacts 2.5mm apart, the closest neighbours
            // in the forest, so a crown of pillars becomes a crown of leaves
            // on the pillar it rings. Read through the origin, never by id.
            const originKind = hostOriginById.get(hostId);
            const isConvertible = isOriginConvertibleToTree(entity.origin)
                && (originKind === 'gridInfill'
                    || originKind === 'coverageFill'
                    || entity.origin === 'standalone'
                    || entity.origin === 'reinforcement');
            if (!isConvertible) continue;
            if (countAttachmentsOnHost(hostTypeId, hostId, draft) > 0) continue;
            const tip = entity.contactCone?.pos;
            if (!tip) continue;
            const tipNormal = entity.contactCone?.normal ?? { x: 0, y: 0, z: -1 };
            // The pillar this attempt replaces still stands in the draft until
            // the link that replaces it is built successfully, so it is
            // excluded from the host search and the crossing test instead of
            // being removed from a copied state. Copying the collection and the
            // roots map for every host was the single largest cost here.
            excludeHostId.clear();
            excludeHostId.add(hostId);
            const explicitTipCapMm = entity.contactCone?.profile?.maxContactDiameterMm;
            const consolidatedOrigin: SupportOrigin = entity.origin === 'reinforcement' ? 'reinforcement' : 'overhang';
            const fan = fanLeafToHost(
                tip,
                modelId,
                pool,
                new Set(),
                `auto-con-${hostId}-p${pass}`,
                conFanRadiusMm,
                GRID_HOST_FAN_RADIUS_MM,
                conFanMaxAngleDeg,
                Math.min(autoSettings.maxAttachmentsPerTrunk, MAX_CONSOLIDATION_CONTACTS_PER_CHUNK),
                draft,
                resolvedMesh ?? undefined,
                consolidatedOrigin,
                'nearest',
                undefined,
                excludeHostId,
                autoSettings,
                explicitTipCapMm,
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
                        pool,
                        pruned: draft,
                        mesh: resolvedMesh ?? undefined,
                        radiusMm: conFanRadiusMm,
                        maxAttachments: autoSettings.maxAttachmentsPerTrunk,
                        knotId: `auto-con-branch-${hostId}`,
                        excludeHostIds: excludeHostId,
                        autoSettings,
                        tipDiameterMm: explicitTipCapMm,
                        gridEnabled: Boolean(gridEnabled),
                        origin: consolidatedOrigin,
                    })
                    : null;
                if (branchResult) {
                    draft = removeConvertedHost(branchResult.draft, hostTypeId, hostId, entity.rootId);
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
            draft = removeConvertedHost(fan.draft, hostTypeId, hostId, entity.rootId);
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
    reportPhase('Consolidating supports', 1, 1);
    reportPhase('Filling gaps', 0, 1);
    timingStart('gap-fill');

    // ── Coverage convergence (gap-fill) ─────────────────────────────
    // Footprint-aware: an overhang region is covered when its projected
    // footprint is covered by tips, not just its centroid. Under-covered
    // regions get additional standalone trunks at uncovered footprint
    // clusters (the gridPoint path — region normal, no wrong-face raycast),
    // iterating until the coverage target is met or nothing more places.
    let gapFilledTrunks = 0;
    for (let pass = 0; pass < MAX_GAP_FILL_PASSES; pass++) {
        const tips = collectSupportTips(draft, modelId);
        const gapCandidates = buildGapFillCandidates(overhangIslands, autoSettings, tips, 0.05, resolvedMesh)
            .map((c): CandidatePoint => ({ ...c, modelId }));
        if (gapCandidates.length === 0) break;
        applyContactTipCaps(gapCandidates, resolvedMesh, autoSettings.tipContactMarginScale, autoSettings);
        let placedThisPass = 0;
        for (const c of gapCandidates) {
            const kind = placeOne(c) as PlacementOutcomeKind;
            if (kind !== 'reject') placedThisPass++;
        }
        gapFilledTrunks += placedThisPass;
        if (placedThisPass === 0) break;
    }
    if (gapFilledTrunks > 0) {
        console.log(LOG_PREFIX, `Coverage convergence: ${gapFilledTrunks} gap-fill trunks placed`);
    }

    // ── Island coverage closure (starts first, then every island) ─────
    // The generic passes are overhang/area-driven; a start can slip through a
    // 4 mm² candidate floor, and an above-layer contact can suppress one via
    // the 3 mm 3D dedupe. This final placement step closes both gaps and is
    // the densification pass: starts need their recipe count plus 99%
    // same-layer coverage, and any island the generic passes missed gets a
    // holding contact and its normal coverage target. Same-layer tips only,
    // so a contact several mm up/down can never suppress the contact a start
    // actually needs.
    // Without a model mesh a contact cannot be validated (no surface, no
    // collision path); the unit paths that run meshless keep their legacy
    // rejection behavior and the closure does not retry them.
    const closureIslands = resolvedMesh
        ? islands.filter((island) => !island.grounded && !island.interior)
        : [];
    let closureContactsAdded = 0;
    if (closureIslands.length > 0) {
        for (let pass = 0; pass < START_SUPPORT_CONSTANTS.maxPasses; pass++) {
            const tips = collectSupportTips(draft, modelId);
            let placedThisPass = 0;
            for (const island of closureIslands) {
                const isStart = island.startIsland === true;
                const area = startFootprintAreaMm2(island);
                const recipe = startRecipeForArea(area);
                const radius = isStart
                    ? recipe.coverageRadiusMm
                    : island.source === 'overhang'
                        ? coverageRadiusForRegion(island)
                        : TIP_COVERAGE_RADIUS_MM;
                const eligible = isStart
                    ? sameLayerStartTips(tips, island.baseZ)
                    // Non-start islands take the normal coverage view (a sloped
                    // region's higher-layer tips are legal); a point-only island
                    // still ignores contacts above its own apex, since those
                    // cannot hold the minimum below them.
                    : island.contactVoxels && island.contactVoxels.count > 0
                        ? tips
                        : tips.filter((tip) => tip.z <= island.baseZ + 0.5);

                let countFloor: number;
                let coverageTarget: number;
                if (isStart) {
                    const status = assessStartSupport(island, tips, resolvedMesh);
                    if (!status.pancakeRisk) continue;
                    countFloor = Math.max(0, recipe.minContacts - status.contacts);
                    coverageTarget = recipe.coverageTarget;
                } else {
                    coverageTarget = (autoSettings.coverageTargetPercent ?? 95) / 100;
                    const contacts = countIslandContacts(island, eligible, radius);
                    const coverage = island.contactVoxels && island.contactVoxels.count > 0
                        ? computeRegionCoverage(island, eligible, radius, resolvedMesh)
                        : contacts > 0 ? 1 : 0;
                    if (contacts > 0 && coverage >= coverageTarget) continue;
                    countFloor = contacts === 0 ? 1 : 0;
                }

                let candidates = buildGapFillCandidates([island], autoSettings, eligible, 0.05, resolvedMesh, {
                    coverageTarget,
                    radiusMm: radius,
                    minClusterMm2: isStart ? 0.05 : undefined,
                    minCandidatesPerRegion: countFloor,
                    includeNonOverhang: true,
                    source: island.source,
                    idPrefix: isStart ? 'start' : 'island',
                }).map((c): CandidatePoint => ({ ...c, modelId, interior: false }));

                // Point-only islands (no contact footprint) still get the
                // contact their recipe asks for.
                if (candidates.length === 0 && countFloor > 0) {
                    candidates = [{
                        id: `${isStart ? 'start' : 'island'}-${island.id}-point`,
                        tipPos: { x: island.contact.x, y: island.contact.y, z: island.contact.z },
                        tipNormal: island.surfaceNormal ?? { x: 0, y: 0, z: -1 },
                        modelId,
                        source: island.source,
                        islandAreaMm2: autoSettings.areaPerSupportMm2,
                        zHeight: island.contact.z,
                        priority: 0,
                        gridPoint: true,
                        interior: false,
                    }];
                }
                if (candidates.length === 0) continue;
                applyContactTipCaps(candidates, resolvedMesh, autoSettings.tipContactMarginScale, autoSettings);
                for (const candidate of candidates) {
                    if (placeOne(candidate) === 'reject') continue;
                    placedThisPass++;
                }
            }
            closureContactsAdded += placedThisPass;
            if (placedThisPass === 0) break;
        }
    }
    if (closureContactsAdded > 0) {
        console.log(LOG_PREFIX, `Island coverage closure: ${closureContactsAdded} contact(s) placed`);
    }

    // ── Force budget: add contacts where a placed support carries more peel
    // than its contact can hold ─────────────────────────────────────
    // Coverage says every patch is *reached*; it cannot say the support
    // reaching it can hold the layer's peel. This pass splits the critical
    // layers' force across the placed tips by nearest cell (the nearest-support
    // allocation), compares each tip's share with the break load of its contact
    // and own shaft, and adds a contact at the over-budget cell's farthest
    // down-facing surface. Formation overhangs are the class-1 targets; a
    // class-2 self-supporting steep flat is eligible only when it is the nearest
    // surface, because the geometry forms on its own and would not otherwise be
    // supported. Class-1 adds are plate pillars (the density-grid path);
    // class-2 adds are force repairs and go through the fan/merge path, since a
    // vertical pillar to a leaning face is usually blocked by the part.
    // Everything still passes the usual gates (tip caps, clearance, trunk retry).
    if (tractionProfile && forceBudgetSurfaces.length > 0) {
        const budgetGraph = buildSupportGraph(draft, modelId);
        if (budgetGraph.tipCount > 0) {
            const budget = computeForceBudgetFromGraph(
                budgetGraph,
                tractionProfile,
                forceBudgetSurfaces,
                supportStrengthMpa,
            );
            const overBudget = budget.rows
                .filter((row) => row.addPoint && row.deficitN > 0)
                .sort((a, b) => Number(a.addPoint!.steepFlat) - Number(b.addPoint!.steepFlat));

            // Paper-aligned one-shot densification (Cao et al. 2025): turn the
            // tip force deficit into a capacity count and a Gaussian traction
            // field, then pick the new contacts geometrically. No second frame
            // or force solve is needed to choose the points.
            const surfaceById = new Map(forceBudgetSurfaces.map((island) => [island.id, island]));
            interface DeficitGroup {
                island: DetectedIsland | undefined;
                rows: typeof overBudget;
                deficitN: number;
                capacityN: number;
            }
            const groups = new Map<string, DeficitGroup>();
            for (const row of overBudget) {
                const point = row.addPoint!;
                let group = groups.get(point.islandId);
                if (!group) {
                    group = { island: surfaceById.get(point.islandId), rows: [], deficitN: 0, capacityN: 0 };
                    groups.set(point.islandId, group);
                }
                group.rows.push(row);
                group.deficitN += row.deficitN;
                group.capacityN = Math.max(group.capacityN, row.capacityN);
            }

            const existingTips = collectSupportTips(draft, modelId);
            const candidates: CandidatePoint[] = [];
            for (const [islandId, group] of groups) {
                if (candidates.length >= MAX_FORCE_BUDGET_ADDS_PER_PASS) break;
                const needed = forceDrivenContactCount(group.deficitN, group.capacityN);
                if (needed <= 0) continue;
                const remaining = MAX_FORCE_BUDGET_ADDS_PER_PASS - candidates.length;
                const seedRows = group.rows;
                const firstPoint = seedRows[0].addPoint!;
                const island = group.island;
                const seeds = seedRows.map((row) => ({
                    x: row.addPoint!.pos.x,
                    y: row.addPoint!.pos.y,
                    demandN: row.demandN,
                    capacityN: row.capacityN,
                }));
                const points = island && island.contactVoxels && island.contactVoxels.count > 0
                    ? selectForceCoveragePoints(
                        island,
                        seeds,
                        existingTips,
                        Math.min(needed, remaining),
                        {
                            sigmaMm: Math.max(1.2, coverageRadiusForRegion(island)),
                            minSpacingMm: MIN_FORCE_BUDGET_ADD_SPACING_MM,
                        },
                    )
                    : [];
                if (points.length === 0) {
                    // No footprint (a point surface): fall back to the deficit
                    // cells themselves, still respecting the plant spacing.
                    for (const row of seedRows) {
                        if (points.length >= Math.min(needed, remaining)) break;
                        const p = row.addPoint!.pos;
                        if (points.some((other) => Math.hypot(other.x - p.x, other.y - p.y) < MIN_FORCE_BUDGET_ADD_SPACING_MM)) continue;
                        points.push({ x: p.x, y: p.y, z: p.z, score: 0 });
                    }
                }

                for (const point of points) {
                    if (candidates.length >= MAX_FORCE_BUDGET_ADDS_PER_PASS) break;
                    const augmented = firstPoint.steepFlat;
                    const candidate: CandidatePoint = {
                        id: `force-${islandId}-${point.x.toFixed(2)}-${point.y.toFixed(2)}`,
                        tipPos: { x: point.x, y: point.y, z: point.z },
                        tipNormal: augmented
                            ? { ...(island?.surfaceNormal ?? firstPoint.normal) }
                            : { ...firstPoint.normal },
                        modelId,
                        source: 'overhang',
                        islandAreaMm2: island?.areaMm2 ?? autoSettings.areaPerSupportMm2,
                        zHeight: point.z,
                        priority: augmented ? -1 : 0,
                        // A formation patch is a density point (standalone
                        // pillar). A class-2 steep face is a force repair: let
                        // the fan/merge path attach it to a host.
                        gridPoint: !augmented,
                    };
                    if (augmented) {
                        preResolvedCandidates.add(candidate);
                        forceBudgetAugmentedAttempts++;
                    }
                    forceBudgetAttempts++;
                    candidates.push(candidate);
                }
            }

            if (candidates.length > 0) {
                applyContactTipCaps(candidates, resolvedMesh, autoSettings.tipContactMarginScale, autoSettings);
                for (const candidate of candidates) {
                    if (placeOne(candidate) === 'reject') continue;
                    forceBudgetAdds++;
                    if (!candidate.gridPoint) forceBudgetAugmentedPlaced++;
                }
            }
        }
    }
    if (forceBudgetAdds > 0 || forceBudgetAttempts > 0) {
        console.log(LOG_PREFIX,
            `Force budget: ${forceBudgetAdds}/${forceBudgetAttempts} contact(s) added on over-loaded cells` +
            (forceBudgetAugmentedAttempts > 0
                ? ` (${forceBudgetAugmentedPlaced}/${forceBudgetAugmentedAttempts} force-augmented)`
                : ''));
    }

    // ── Trunk-error retry ────────────────────────────────────────────
    // A candidate whose trunk cannot be built used to be dropped whenever it did
    // not come through the trunk-anchor pass (gap-fill, near-plate, clustered
    // members). Retry those as a wide fan onto any clear host: the same leaf/
    // branch the rescue queue builds for anchors, so a contact whose pillar is
    // occluded still gets a load path instead of nothing.
    let trunkErrorRetriesAttempted = 0;
    let trunkErrorRetriesRescued = 0;
    if (trunkErrorBacklog.length > 0 && resolvedMesh) {
        let retryPool: FanShaftPoint[] | null = null;
        for (const candidate of trunkErrorBacklog.slice(0, MAX_TRUNK_ERROR_RETRIES)) {
            trunkErrorRetriesAttempted++;
            const preset = presetForArea(candidate.islandAreaMm2);
            try {
                if (!retryPool) retryPool = collectFanShaftPoints(draft);
                const fan = fanLeafToHost(
                    candidate.tipPos,
                    candidate.modelId,
                    retryPool,
                    gridHostIds,
                    `auto-retry-${candidate.id}`,
                    CAVITY_FAN_RADIUS_MM,
                    CAVITY_FAN_RADIUS_MM,
                    synthesisMaxAngleDeg,
                    autoSettings.maxAttachmentsPerTrunk,
                    draft,
                    resolvedMesh,
                    hostedOriginForSource(candidate.source),
                    'steepest',
                    MAX_UNBRACED_BRANCH_SPAN_MM,
                    undefined,
                    autoSettings,
                    candidate.tipDiameterMm,
                );
                if (fan.ok) {
                    draft = fan.draft;
                    trunkErrorRetriesRescued++;
                    placed[fan.kind]++;
                    presets[preset]++;
                    diagnostics.candidatesBySource[candidate.source] =
                        (diagnostics.candidatesBySource[candidate.source] ?? 0) + 1;
                    if (rejectionReasons.trunk_build_error) {
                        rejectionReasons.trunk_build_error--;
                        rejectedCount = Math.max(0, rejectedCount - 1);
                    }
                    if (fan.entityId && isLedgerKind(fan.kind)) {
                        forestLedger.push({
                            displayId: candidate.id,
                            kind: fan.kind,
                            entityId: fan.entityId,
                            areaMm2: candidate.islandAreaMm2,
                            zHeight: candidate.zHeight,
                            preset,
                            bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                        });
                    }
                    continue;
                }
                const dogleg = tryBuildSilhouetteDogleg(candidate);
                if (dogleg) {
                    commitDoglegTrunk(candidate, dogleg, preset);
                    retryPool = null;
                    trunkErrorRetriesRescued++;
                    if (rejectionReasons.trunk_build_error) {
                        rejectionReasons.trunk_build_error--;
                        rejectedCount = Math.max(0, rejectedCount - 1);
                    }
                }
            } catch {
                // A rescue is best-effort; the original rejection stands.
            }
        }
        if (trunkErrorRetriesAttempted > 0) {
            diagnostics.trunkErrorRetries = {
                attempted: trunkErrorRetriesAttempted,
                rescued: trunkErrorRetriesRescued,
            };
            console.log(LOG_PREFIX,
                `Trunk-error retry: ${trunkErrorRetriesRescued}/${trunkErrorRetriesAttempted} rescued as fan/dogleg links`);
        }
    }

    console.log(LOG_PREFIX,
        `Step 3/3: ${SUPPORT_TYPES.map((d) => `${placed[d.id]}${typeWord(d.id).charAt(0)}`).join(' ')} — ${rejectedCount} rejected ` +
        `| presets: detail=${presets.detail} structure=${presets.structure} anchor=${presets.anchor}`);

    timingEnd('gap-fill');
    reportPhase('Filling gaps', 1, 1);
    reportPhase('Analysing supports', 0, 1);
    timingStart('analytics');

    // ── Coverage analytics ────────────────────────────────────────
    const snapshot = draft;
    const supportedIds = new Set<string>();
    const SUPPORT_COVERAGE_RADIUS_MM = 4.0;
    const covR2 = SUPPORT_COVERAGE_RADIUS_MM * SUPPORT_COVERAGE_RADIUS_MM;

    // Collect all support tips from the post-placement snapshot.
    const allTips: Array<{ x: number; y: number; z: number }> = [];
    allTips.push(...collectContactPositions(snapshot, modelId));

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
            fraction = computeRegionCoverage(island, allTips, coverageRadiusForRegion(island, SUPPORT_COVERAGE_RADIUS_MM), resolvedMesh);
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
        const weightG = modelCtx.modelVolumeMm3 * RESIN_DENSITY_G_PER_MM3;
        const factors = modelSizingFactors(modelCtx, autoSettings);
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
        const sizeScale = autoSettings.sizeScale;
        const sMin = sizeParameters(makeSample(minArea, 10), sizeScale, modelCtx, autoSettings);
        const sMax = sizeParameters(makeSample(maxArea, zMax), sizeScale, modelCtx, autoSettings);
        const sAvg = sizeParameters(makeSample(avgArea, zMax / 2), sizeScale, modelCtx, autoSettings);
        sizingDebug = {
            modelVolumeMm3: Math.round(modelCtx.modelVolumeMm3),
            estimatedWeightG: round2Mm(weightG),
            totalCandidates: modelCtx.totalCandidates,
            // Honest mass share: total model weight divided by the number of
            // placed supports. A load share, not a force estimate.
            weightPerSupportG: round2Mm(placedHostCount() > 0 ? weightG / placedHostCount() : 0),
            // What the sizing itself read: the estimated share at placement
            // time (candidates, not placed hosts) and the factors it produced.
            modelSizeMm: round2Mm(factors.sizeMm),
            loadShareG: round2Mm(factors.loadShareG),
            sizeFactor: round2Mm(factors.sizeFactor),
            loadFactor: round2Mm(factors.loadFactor),
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
        startIslands: 0,
        startsUnderSupported: 0,
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
    reportPhase('Analysing supports', 1, 1);
    reportPhase('Fanning leaves', 0, 1);
    timingStart('fanning');

    // ── Post-placement leaf fanning (iterative convergence) ──────────
    const fanRadiusMm = Math.max(MIN_LEAF_FAN_RADIUS_MM, autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM);
    const fanMaxAngleDeg = Math.min(
        autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
        memberMaxAngleFromVerticalDeg(Boolean(gridEnabled)),
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

        // `islandsToCover`, not `islands`: the steep-flat gate drops
        // self-supporting walls from coverage when the pose is stable. Fanning
        // the raw island list bypassed that gate and stuck leaves onto the
        // steep side of a part, where the contact resists nothing.
        for (const island of islandsToCover) {
            if (supportedIds.has(island.id)) continue;
            // An internal contact may not fan to an exterior host; its only
            // legal support is the cavity bridge tried at placement time.
            if (island.interior) continue;
            const fanCandidate = candidateFromIsland(island);
            fanCandidate.modelId = modelId;
            if (resolvedMesh) {
                const resolvedFan = resolveSurfaceNormal(fanCandidate.tipPos, resolvedMesh);
                fanCandidate.tipNormal = resolvedFan.normal;
                if (resolvedFan.hit) {
                    fanCandidate.tipPos = resolvedFan.point;
                    fanCandidate.zHeight = resolvedFan.point.z;
                }
                applyContactTipCaps([fanCandidate], resolvedMesh, autoSettings.tipContactMarginScale, autoSettings);
            }
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
                undefined,
                undefined,
                undefined,
                autoSettings,
                fanCandidate.tipDiameterMm,
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
                bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
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
                `${skippedAngle} angle too steep (>${fanMaxAngleDeg}°), ` +
                `${skippedSameZ} same Z (can't attach), ` +
                `${skippedCross} crossing another support, ` +
                `${skippedOther} blocked/build/capacity.`);
            break;
        }
    }

    timingEnd('fanning');
    reportPhase('Fanning leaves', 1, 1);
    reportPhase('Checking coverage', 0, 1);
    timingStart('surface-coverage');

    // ── Overhang surface coverage ──────────────────────────────────
    // Large flat overhangs need more than one support to distribute
    // peel forces evenly.  Use the island's contactVoxels footprint
    // to place additional supports across the surface.
    const OVERHANG_AREA_THRESHOLD_MM2 = 1.5;
    const OVERHANG_GRID_SPACING_MM = 2.5;

    let overhangSupportsPlaced = 0;
    let detachedTipPositions: Array<{ x: number; y: number; z: number }> | null = null;
    // A coverage branch is a STUB off a trunk, never a bridge across the
    // island: the same reach a placement fan allows.
    const COVERAGE_STUB_REACH_MM = Math.max(MIN_LEAF_FAN_RADIUS_MM, autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM);
    // Host shafts for the stubs, sampled once. The host set is stable here:
    // the pass only adds branches.
    const stubHosts: Array<{ hostTypeId: SupportTypeId; hostId: string; segmentId: string; t: number; pos: { x: number; y: number; z: number }; diameter: number }> = [];
    for (const { hostTypeId, hostId, entity } of collectHostEntities(draft)) {
        // Stubs hang off this model's hosts only, like every other fan.
        if (entity.modelId !== modelId) continue;
        if (entity.origin === NEAR_PLATE_ORIGIN) continue;
        for (const seg of entity.segments) {
            const span = hostSegmentSpan(draft, entity, seg);
            if (!span) continue;
            const ts = seg.topJoint ? [0.25, 0.5, 0.75, 1] : [0.25, 0.5, 0.75];
            for (const t of ts) {
                stubHosts.push({
                    hostTypeId,
                    hostId,
                    segmentId: seg.id,
                    t,
                    pos: {
                        x: span.start.x + (span.end.x - span.start.x) * t,
                        y: span.start.y + (span.end.y - span.start.y) * t,
                        z: span.start.z + (span.end.z - span.start.z) * t,
                    },
                    diameter: seg.diameter ?? 1.0,
                });
            }
        }
    }

    for (const island of islands) {
        // Overhang regions and islands already covered by an overhang region are
        // gridded by the grid phase — this pass covers remaining flat voxel islands only.
        if (island.source === 'overhang' || island.coveredByOverhangId != null) continue;

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
                let hostScore = Infinity;
                const reachSq = COVERAGE_STUB_REACH_MM * COVERAGE_STUB_REACH_MM;
                for (const candidate of stubHosts) {
                    const vHeadroom = cellZ - candidate.pos.z;
                    // Leave room for the ~2.6 mm contact cone plus a rising shaft segment so
                    // stub branches never attach level with their own cone base (0° wire).
                    if (vHeadroom < 4.0) continue;
                    const dx = gx - candidate.pos.x;
                    const dy = gy - candidate.pos.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > reachSq) continue;
                    const score = d2 + vHeadroom * 0.25;
                    if (score >= hostScore) continue;
                    hostScore = score;
                    host = candidate;
                }
                if (!host) {
                    if (!island.isDetached) continue;
                    detachedTipPositions ??= collectContactPositions(draft, modelId);
                    const tooClose = detachedTipPositions.some(
                        (tp) =>
                            Math.hypot(tp.x - gx, tp.y - gy) <= 1.0 &&
                            Math.abs(tp.z - cellZ) <= 1.0,
                    );
                    if (tooClose) continue;
                    const bm: THREE.Mesh | undefined = resolvedMesh ?? undefined;
                    const resolved = resolveSurfaceNormal({ x: gx, y: gy, z: cellZ }, bm);
                    const standaloneCandidate: CandidatePoint = {
                        id: `detached-plate-${island.id}-${r}-${c}`,
                        tipPos: resolved.point,
                        tipNormal: resolved.normal,
                        modelId,
                        source: 'voxel',
                        islandAreaMm2: area / (rows * cols),
                        zHeight: resolved.point.z,
                        priority: 0,
                        interior: island.interior,
                    };
                    if (bm) {
                        applyContactTipCaps([standaloneCandidate], bm, autoSettings.tipContactMarginScale, autoSettings);
                        preResolvedCandidates.add(standaloneCandidate);
                    }
                    const outcome = placeOne(standaloneCandidate);
                    if (outcome !== 'reject') {
                        overhangSupportsPlaced++;
                        detachedTipPositions.push(resolved.point);
                    }
                    continue;
                }
                if (isHostAtAttachmentCapacity(host.hostTypeId, host.hostId, autoSettings.maxAttachmentsPerTrunk, draft)) continue;

                try {
                    const bm: THREE.Mesh | undefined = resolvedMesh ?? undefined;
                    const resolved = resolveSurfaceNormal({ x: gx, y: gy, z: cellZ }, bm);
                    // The id carries the host: without it two writers share a
                    // knot id and the earlier branch re-parents onto the later
                    // host (the "dozens of branches on one host" report).
                    const parentKnot = {
                        id: `auto-overhang-${host.hostId}-${island.id}-${r}-${c}`,
                        parentShaftId: host.segmentId,
                        t: host.t,
                        pos: host.pos,
                        diameter: host.diameter + 0.1,
                    };
                    const band = activeSizingBand(autoSettings);
                    let stubTipMm: number | undefined;
                    if (bm) {
                        const probe: CandidatePoint = {
                            id: `stub-${island.id}-${r}-${c}`,
                            tipPos: resolved.point,
                            tipNormal: resolved.normal,
                            modelId,
                            source: 'voxel',
                            islandAreaMm2: area,
                            zHeight: resolved.point.z,
                            priority: 0,
                        };
                        applyContactTipCaps([probe], bm, autoSettings.tipContactMarginScale, autoSettings);
                        stubTipMm = probe.tipDiameterMm !== undefined
                            ? Math.max(MIN_CONTACT_TIP_DIAMETER_MM, probe.tipDiameterMm)
                            : undefined;
                    }
                    const built = buildHostedBranch(
                        {
                            tipPos: resolved.point,
                            tipNormal: resolved.normal,
                            modelId,
                            parentKnot,
                            mesh: bm,
                            tipContactDiameterMm: stubTipMm ?? band.tipContactDiameterMm,
                            rootsDiameterMm: band.rootDiameterMm,
                        },
                        band.shaftDiameterMm,
                        host.diameter,
                        (attempt) => {
                            if (attempt.supportData.error) return true;
                            if (bm && branchCollidesWithSDF(attempt.branch, bm)) return true;
                            let prevZ = parentKnot.pos.z;
                            const coneZ = attempt.branch.contactCone?.pos.z ?? resolved.point.z;
                            for (const seg of attempt.branch.segments) {
                                const bz = seg.bottomJoint?.pos.z ?? prevZ;
                                const tz = seg.topJoint?.pos.z ?? coneZ;
                                if (tz - bz < 0.5) return true;
                                prevZ = tz;
                            }
                            return false;
                        },
                        autoSettings,
                    );
                    if (!built) continue;
                    if (stubTipMm !== undefined && built.branch.contactCone) {
                        built.branch.contactCone = applyExplicitTipCapToCone(built.branch.contactCone, stubTipMm);
                    }
                    // The tips are voxel-island footprints — island origin.
                    built.branch.origin = 'island';
                    const memberTypeId = builtMemberTypeId(built.branch);
                    draft = draftAddPrimitive(draft, 'knots', parentKnot);
                    draft = draftAddEntity(draft, memberTypeId, built.branch);
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
    reportPhase('Checking coverage', 1, 1);

    // ── Root merge: trunks whose plate roots stand together share one host ──
    let rootMergeStats: { merged: number; refusals: Partial<Record<string, number>> } | undefined;
    if (changed) {
        try {
            const mergeResult = mergeNearbyTrunkRoots(draft, modelId, {
                mesh: resolvedMesh ?? undefined,
                gridHostIds,
                maxAttachments: autoSettings.maxAttachmentsPerTrunk ?? 12,
                maxAngleDeg: Math.min(
                    autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
                    memberMaxAngleFromVerticalDeg(Boolean(gridEnabled)),
                ),
                fanRadiusMm: Math.max(MIN_LEAF_FAN_RADIUS_MM, autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                gridHostFanRadiusMm: GRID_HOST_FAN_RADIUS_MM,
                autoSettings,
            });
            if (mergeResult.merged > 0) {
                draft = mergeResult.draft;
                bumpDraftVersion(draft);
                rootMergeStats = { merged: mergeResult.merged, refusals: mergeResult.refusals };
                const refusalText = Object.entries(mergeResult.refusals)
                    .map(([reason, count]) => `${reason}=${count}`)
                    .join(', ');
                console.log(LOG_PREFIX,
                    `Root merge: ${mergeResult.merged} co-located trunk(s) re-fanned onto a shared host`
                    + (refusalText ? ` | refusals: ${refusalText}` : ''));
            }
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Root merge failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    reportPhase('Resizing supports', 0, 1);
    timingStart('resize');

    // ------------------------------------------------------------------
    // 4. Forest resize pass — re-derive every trunk's stepwise diameter
    //    profile from its final attachment tree (a trunk carrying four
    //    branches gets thicker; a lone trunk stays at its placed diameter).
    // ------------------------------------------------------------------

    if (changed) {
        try {
            // Legacy fan knots used trunkId as parentShaftId — rehost to the nearest segment so
            // diameter demands and drift checks use segment ids.
            const rehosted = rehostLegacyKnots(draft, modelId);
            if (rehosted !== draft) {
                draft = rehosted;
                console.log(LOG_PREFIX, 'Legacy knot rehost: entity id → segment id');
            }
            bumpDraftVersion(draft);
            const preResizeTrunks = draft.trunks;
            perfMark('resize:profile');
            const resized = computeForestDiameterProfile(draft, modelId);
            perfMeasure('resize:profile', 'resize:profile');
            if (resized !== draft) {
                if (resolvedMesh) {
                    // Guard against self-inflicted `hostBlocked` culls: if thickening
                    // a trunk pushed a previously clear shaft into the model mesh,
                    // keep that trunk at its collision-free pre-resize diameter instead
                    // of thickening it into a collision and culling the whole tree.
                    let revertedCount = 0;
                    let safeTrunks: SupportState['trunks'] | null = null;
                    for (const [tid, trunk] of Object.entries(resized.trunks)) {
                        if (trunk.modelId !== modelId) continue;
                        const prevTrunk = preResizeTrunks[tid];
                        if (!prevTrunk || trunk === prevTrunk) continue;
                        const prevMaxDia = Math.max(0, ...prevTrunk.segments.map((s) => s.diameter ?? 0));
                        const nextMaxDia = Math.max(0, ...trunk.segments.map((s) => s.diameter ?? 0));
                        if (nextMaxDia <= prevMaxDia + 1e-4) continue;
                        // The pre-resize trunk was placed and already vetted;
                        // re-testing it doubled every mesh query in this guard.
                        // A thickened trunk that is blocked is reverted whether
                        // or not the old one was; the old failure is unchanged.
                        if (isHostShaftBlocked(trunk, resolvedMesh)) {
                            if (!safeTrunks) safeTrunks = { ...resized.trunks };
                            safeTrunks[tid] = prevTrunk;
                            revertedCount++;
                        }
                    }
                    draft = safeTrunks ? { ...resized, trunks: safeTrunks } : resized;
                    if (revertedCount > 0) {
                        console.log(LOG_PREFIX, `Forest resize clearance guard: kept ${revertedCount} tight-clearance trunk(s) at placed diameter.`);
                    }
                } else {
                    draft = resized;
                }
                console.log(LOG_PREFIX, 'Forest resize pass applied (attachment-loaded trunks thickened).');
            }
            // Post-resize validation: drift (>0.5mm), cross after thickening, or missing host.
            // This is where the "leaf attached to nowhere" shows up in the report.
            let orphanInfos: OrphanInfo[] = [];
            try {
                const preCullDraft = draft;
                perfMark('resize:validate');
                const culled = validateAndCullOrphans(draft, resolvedMesh ?? undefined, modelId, cavityTester);
                perfMeasure('resize:validate', 'resize:validate');
                if (culled.orphans.length > 0) {
                    draft = culled.draft;
                    orphanInfos = culled.orphans;
                    console.log(LOG_PREFIX, `Orphan cull: ${culled.orphans.length} leaves/branches removed — ${culled.orphans.map((o) => `${o.id}:${o.reason}${o.hostId ? `@${o.hostId.slice(0,8)}` : ''}`).join(', ')}`);
                    // Re-place members orphaned by a culled (blocked) host as well
                    // as run-created hosts culled for `hostBlocked`: their islands
                    // still need supports. Single re-place pass followed by one
                    // bounded Wave-2 fan-only rescue if a re-placed host culls.
                    const extractRequeueContacts = (
                        orphans: ReadonlyArray<OrphanInfo>,
                        sourceDraft: SupportState,
                    ): Array<{ id: string; cone: ContactCone; origin?: SupportOrigin }> => {
                        const items: Array<{ id: string; cone: ContactCone; origin?: SupportOrigin }> = [];
                        for (const o of orphans) {
                            if (o.reason === 'missingHost' && o.hostCulled === true) {
                                let member: ShaftHostedMemberEntity | undefined;
                                for (const { collectionKey } of SHAFT_HOSTED_MEMBER_TYPES) {
                                    member = hostedMemberEntities(sourceDraft, collectionKey)[o.id];
                                    if (member) break;
                                }
                                if (member?.contactCone?.pos && member.modelId === modelId) {
                                    items.push({ id: o.id, cone: member.contactCone, origin: member.origin });
                                }
                            } else if (o.reason === 'hostBlocked') {
                                const descriptor = getSupportTypeDescriptor(o.kind);
                                const beforeColl = (before[descriptor.location.key] ?? {}) as Record<string, unknown>;
                                if (o.id in beforeColl) continue;
                                const sourceColl = (sourceDraft[descriptor.location.key] ?? {}) as Record<
                                    string,
                                    { modelId?: string; origin?: SupportOrigin; contactCone?: ContactCone }
                                >;
                                const hostEnt = sourceColl[o.id];
                                if (hostEnt?.contactCone?.pos && hostEnt.modelId === modelId) {
                                    items.push({ id: o.id, cone: hostEnt.contactCone, origin: hostEnt.origin });
                                }
                            }
                        }
                        return items;
                    };

                    perfMark('resize:requeue');
                    const requeueItems = extractRequeueContacts(culled.orphans, preCullDraft);
                    if (requeueItems.length > 0) {
                        let replaced = 0;
                        for (const item of requeueItems) {
                            const recandidate: CandidatePoint = {
                                id: `${item.id}-requeue`,
                                tipPos: item.cone.pos,
                                tipNormal: item.cone.surfaceNormal ?? item.cone.normal,
                                modelId,
                                source: item.origin === 'overhang' ? 'overhang' : item.origin === 'reinforcement' ? 'reinforcement' : 'voxel',
                                islandAreaMm2: 0.05,
                                zHeight: item.cone.pos.z,
                                priority: 0,
                                tipDiameterMm: item.cone.profile?.maxContactDiameterMm,
                            };
                            preResolvedCandidates.add(recandidate);
                            try {
                                const result = placeOneCandidate(recandidate, draft, autoSettings, gridHostIds, resolvedMesh, modelCtx, false, preResolvedCandidates, false, cavityTester);
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
                                        bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                                    });
                                    replaced++;
                                }
                            } catch {
                                rejectedCount++;
                            }
                        }
                        perfMeasure('resize:requeue', 'resize:requeue');
                        console.log(LOG_PREFIX, `Orphan re-place: ${replaced}/${requeueItems.length} culled contacts re-placed.`);
                        const preRecheckDraft = draft;
                        const recheck = validateAndCullOrphans(draft, resolvedMesh ?? undefined, modelId, cavityTester);
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
                            const wave2Items = extractRequeueContacts(recheck.orphans, preRecheckDraft);
                            if (wave2Items.length > 0 && resolvedMesh) {
                                const wave2Pool = collectFanShaftPoints(draft);
                                let wave2Rescued = 0;
                                for (const item of wave2Items) {
                                    const source: CandidatePoint['source'] = item.origin === 'overhang'
                                        ? 'overhang'
                                        : item.origin === 'reinforcement'
                                            ? 'reinforcement'
                                            : 'voxel';
                                    try {
                                        const fan = fanLeafToHost(
                                            item.cone.pos,
                                            modelId,
                                            wave2Pool,
                                            gridHostIds,
                                            `auto-wave2-${item.id}`,
                                            CAVITY_FAN_RADIUS_MM,
                                            CAVITY_FAN_RADIUS_MM,
                                            memberMaxAngleFromVerticalDeg(Boolean(gridEnabled)),
                                            autoSettings.maxAttachmentsPerTrunk,
                                            draft,
                                            resolvedMesh,
                                            hostedOriginForSource(source),
                                            'steepest',
                                            MAX_UNBRACED_BRANCH_SPAN_MM,
                                            undefined,
                                            autoSettings,
                                            item.cone.profile?.maxContactDiameterMm,
                                        );
                                        if (!fan.ok) continue;
                                        draft = fan.draft;
                                        placed[fan.kind]++;
                                        const wPreset = presetForArea(0.05);
                                        presets[wPreset]++;
                                        if (fan.entityId && isLedgerKind(fan.kind)) {
                                            forestLedger.push({
                                                displayId: `${item.id}-wave2`,
                                                kind: fan.kind,
                                                entityId: fan.entityId,
                                                areaMm2: 0.05,
                                                zHeight: item.cone.pos.z,
                                                preset: wPreset,
                                                bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                                            });
                                        }
                                        wave2Rescued++;
                                    } catch {
                                        // Best-effort fan rescue only.
                                    }
                                }
                                if (wave2Rescued > 0) {
                                    console.log(LOG_PREFIX, `Orphan wave-2 fan rescue: ${wave2Rescued}/${wave2Items.length} re-hosted.`);
                                }
                            }
                        }
                    }

                    // Active `cross` resolution: re-host leaves/branches that cross
                    // another shaft after thickening onto a clear non-crossing host
                    // (often the exact shaft they crossed) instead of leaving
                    // intersecting geometry in the forest.
                    perfMark('resize:cross-repair');
                    const crossOrphans = orphanInfos.filter((o) => o.reason === 'cross');
                    if (crossOrphans.length > 0) {
                        let crossResolved = 0;
                        const resolvedCrossIds = new Set<string>();
                        const crossMaxAngleDeg = Math.max(
                            autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
                            memberMaxAngleFromVerticalDeg(Boolean(gridEnabled)),
                        );
                        // One pass over the knots for the "does this branch
                        // still host a knot?" check, instead of scanning every
                        // knot per orphan.
                        const knotShaftIds = new Set(Object.values(draft.knots).map((k) => k.parentShaftId));
                        let remoteCrossAttempts = 0;
                        for (const o of crossOrphans) {
                            let member: ShaftHostedMemberEntity | undefined;
                            let memberTypeId: ShaftHostedMemberTypeId | undefined;
                            for (const mt of SHAFT_HOSTED_MEMBER_TYPES) {
                                const found = hostedMemberEntities(draft, mt.collectionKey)[o.id];
                                if (found) {
                                    member = found;
                                    memberTypeId = mt.typeId;
                                    break;
                                }
                            }
                            const cone = member?.contactCone;
                            if (!member || !memberTypeId || !cone?.pos || member.modelId !== modelId) continue;

                            if (memberTypeId === 'branch') {
                                const hostedSegIds = new Set<string>([
                                    o.id,
                                    ...((member as { segments?: Segment[] }).segments ?? []).map((s) => s.id),
                                ]);
                                if ([...hostedSegIds].some((id) => knotShaftIds.has(id))) {
                                    continue;
                                }
                            }

                            let draftWithoutOld = draftRemoveEntity(draft, memberTypeId, o.id);
                            if (o.knotId && draftWithoutOld.knots[o.knotId]) {
                                draftWithoutOld = draftRemovePrimitive(draftWithoutOld, 'knots', o.knotId);
                            }

                            const excludeOldHost = o.hostId ? new Set<string>([o.hostId]) : undefined;
                            // Only hosts whose plan position can be inside the
                            // 12mm rehost reach are candidates. The old full
                            // forest pool made fanLeafToHost walk every sample
                            // (and build a branch cone for every legal one) once
                            // per orphan — the dominant resize-phase cost.
                            const crossPool = collectFanShaftPoints(
                                draftWithoutOld,
                                { x: cone.pos.x, y: cone.pos.y },
                                CAVITY_FAN_RADIUS_MM + 1,
                            );
                            const sameHostPool = o.hostId
                                ? crossPool.filter((sample) => sample.hostId === o.hostId)
                                : [];
                            let rehost: ReturnType<typeof fanLeafToHost> = { ok: false } as never;
                            if (sameHostPool.length > 0) {
                                // Cheapest repair first: another legal Z on the
                                // host it already belongs to.
                                rehost = fanLeafToHost(
                                    cone.pos,
                                    modelId,
                                    sameHostPool,
                                    gridHostIds,
                                    `auto-cross-rehost-${o.id}`,
                                    CAVITY_FAN_RADIUS_MM,
                                    CAVITY_FAN_RADIUS_MM,
                                    crossMaxAngleDeg,
                                    autoSettings.maxAttachmentsPerTrunk,
                                    draftWithoutOld,
                                    resolvedMesh ?? undefined,
                                    member.origin ?? 'overhang',
                                    'steepest',
                                    undefined,
                                    undefined,
                                    autoSettings,
                                    cone.profile?.maxContactDiameterMm,
                                );
                            }
                            if (!rehost.ok && remoteCrossAttempts < MAX_CROSS_REHOST_REMOTE_ATTEMPTS) {
                                remoteCrossAttempts++;
                                // A nearby host other than the one it drifted
                                // off. Bounded: every remote attempt can build a
                                // branch cone, and unresolved crossings stay
                                // flagged rather than paying for a forest sweep.
                                rehost = fanLeafToHost(
                                    cone.pos,
                                    modelId,
                                    crossPool,
                                    gridHostIds,
                                    `auto-cross-rehost-${o.id}`,
                                    CROSS_REHOST_RADIUS_MM,
                                    CROSS_REHOST_RADIUS_MM,
                                    crossMaxAngleDeg,
                                    autoSettings.maxAttachmentsPerTrunk,
                                    draftWithoutOld,
                                    resolvedMesh ?? undefined,
                                    member.origin ?? 'overhang',
                                    'nearest',
                                    undefined,
                                    excludeOldHost,
                                    autoSettings,
                                    cone.profile?.maxContactDiameterMm,
                                );
                            }
                            if (rehost.ok) {
                                draft = rehost.draft;
                                resolvedCrossIds.add(o.id);
                                crossResolved++;
                                if (rehost.entityId && isLedgerKind(rehost.kind)) {
                                    forestLedger.push({
                                        displayId: `${o.id}-rehost`,
                                        kind: rehost.kind,
                                        entityId: rehost.entityId,
                                        areaMm2: 0.05,
                                        zHeight: cone.pos.z,
                                        preset: presetForArea(0.05),
                                        bandShaftMm: activeSizingBand(autoSettings).shaftDiameterMm,
                                    });
                                }
                            }
                        }
                        perfMeasure('resize:cross-repair', 'resize:cross-repair');
                        if (crossResolved > 0) {
                            console.log(LOG_PREFIX, `Cross re-host: resolved ${crossResolved}/${crossOrphans.length} shaft-crossing members.`);
                            const postCrossCheck = validateAndCullOrphans(draft, resolvedMesh ?? undefined, modelId, cavityTester);
                            draft = postCrossCheck.draft;
                            orphanInfos = [
                                ...orphanInfos.filter((o) => !resolvedCrossIds.has(o.id) && o.reason !== 'cross'),
                                ...postCrossCheck.orphans.filter((o) => o.reason === 'cross'),
                            ];
                        }
                    }
                }
            } catch (e) {
                console.warn(LOG_PREFIX, `Orphan validation failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
            }

            // Reconcile `placed` strictly from actual surviving run-created entities
            // so culled supports are subtracted, non-deleted `cross` warnings stay
            // counted, and pre-existing `before` supports never pollute run totals.
            for (const descriptor of SUPPORT_STATE_TYPES) {
                if (!descriptor.isAutoPlaced) continue;
                const key = descriptor.location.key;
                const beforeColl = (before[key] ?? {}) as Record<string, unknown>;
                const finalColl = (draft[key] ?? {}) as Record<string, { modelId?: string }>;
                let netRunCount = 0;
                for (const [id, ent] of Object.entries(finalColl)) {
                    if (id in beforeColl) continue;
                    if (ent.modelId !== modelId) continue;
                    netRunCount++;
                }
                placed[descriptor.id] = netRunCount;
            }

            // Cone/shaft sync: the resize and merge passes thicken shafts and
            // rehost members, but a contact cone keeps whatever body diameter
            // it was built with — lagging its (thickened) shaft as a visible
            // step, or ending up wider than the shaft after a transplant.
            // Clicking the support rebuilt the cone from the shaft and
            // "snapped it correct"; do that globally instead of waiting
            // for a click.
            perfMark('resize:cone-sync');
            const coneSynced = syncContactConeDiameters(draft, modelId, autoSettings);
            perfMeasure('resize:cone-sync', 'resize:cone-sync');
            bumpDraftVersion(coneSynced);
            if (coneSynced !== draft) {
                draft = coneSynced;
                console.log(LOG_PREFIX, 'Contact cone sync: matched cone bodies to their host shafts.');
            }

            timingEnd('resize');
    reportPhase('Resizing supports', 1, 1);
            reportPhase('Compiling report', 0, 1);
    timingStart('report');

            // ── Forest Report ───────────────────────────────────────
            // Structured per-run summary: every placed support's id, size,
            // and sizing reasoning, plus the fan-out groups. Shown in the
            // Auto Supports panel; the log gets a one-line summary only.
            const forestReport = buildForestReport(draft, forestLedger, modelId);
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
                gridFallbacks: diagnostics.gridFallbacks,
                ...(diagnostics.trunkErrorRetries ? { trunkErrorRetries: diagnostics.trunkErrorRetries } : {}),
                consolidationRefusals: { ...conRefusals },
                cavityFallbacks: [...diagnostics.cavityFallbacks],
                ...(rootMergeStats ? { rootMerges: rootMergeStats } : {}),
                ...(tractionStats ? { tractionOptimization: tractionStats } : {}),
                ...(forceBudgetAttempts > 0 ? {
                    forceBudgetAdds: {
                        attempted: forceBudgetAttempts,
                        placed: forceBudgetAdds,
                        augmentedAttempted: forceBudgetAugmentedAttempts,
                        augmentedPlaced: forceBudgetAugmentedPlaced,
                    },
                } : {}),
            };
            // Report only: what a deficit budget would add and cull, in mm² of
            // unsupported surface. Nothing here changes the forest.
            const presetByEntityId = new Map<string, SizingPreset>();
            for (const entry of forestLedger) {
                presetByEntityId.set(entry.entityId, entry.preset);
            }
            const postCullContacts: PlacedContact[] = [];
            for (const t of Object.values(draft.trunks ?? {})) {
                if (t.modelId !== modelId || !t.contactCone?.pos) continue;
                postCullContacts.push({
                    tip: t.contactCone.pos,
                    preset: presetByEntityId.get(t.id) ?? 'structure',
                    shaftDiameterMm: t.segments[t.segments.length - 1]?.diameter ?? t.contactCone.profile.bodyDiameterMm,
                });
            }
            for (const s of Object.values(draft.stumps ?? {})) {
                if (s.modelId !== modelId || !s.contactCone?.pos) continue;
                postCullContacts.push({
                    tip: s.contactCone.pos,
                    preset: presetByEntityId.get(s.id) ?? 'structure',
                    shaftDiameterMm: s.segments[s.segments.length - 1]?.diameter ?? s.contactCone.profile.bodyDiameterMm,
                });
            }
            for (const b of Object.values(draft.branches ?? {})) {
                if (b.modelId !== modelId || !b.contactCone?.pos) continue;
                postCullContacts.push({
                    tip: b.contactCone.pos,
                    preset: presetByEntityId.get(b.id) ?? 'structure',
                    shaftDiameterMm: b.segments[b.segments.length - 1]?.diameter ?? b.contactCone.profile.bodyDiameterMm,
                });
            }
            for (const l of Object.values(draft.leaves ?? {})) {
                if (l.modelId !== modelId || !l.contactCone?.pos) continue;
                postCullContacts.push({
                    tip: l.contactCone.pos,
                    preset: presetByEntityId.get(l.id) ?? 'structure',
                    shaftDiameterMm: l.contactCone.profile.bodyDiameterMm,
                });
            }
            for (const st of Object.values(draft.sticks ?? {})) {
                if (st.modelId !== modelId) continue;
                const cone = st.contactConeA.pos.z >= st.contactConeB.pos.z ? st.contactConeA : st.contactConeB;
                if (!cone?.pos) continue;
                postCullContacts.push({
                    tip: cone.pos,
                    preset: presetByEntityId.get(st.id) ?? 'structure',
                    shaftDiameterMm: st.segments[st.segments.length - 1]?.diameter ?? cone.profile.bodyDiameterMm,
                });
            }
            for (const tw of Object.values(draft.twigs ?? {})) {
                if (tw.modelId !== modelId) continue;
                const disk = tw.contactDiskA.pos.z >= tw.contactDiskB.pos.z ? tw.contactDiskA : tw.contactDiskB;
                if (!disk?.pos) continue;
                postCullContacts.push({
                    tip: disk.pos,
                    preset: presetByEntityId.get(tw.id) ?? 'structure',
                    shaftDiameterMm: tw.segments[tw.segments.length - 1]?.diameter,
                });
            }
            forestReport.loadBudget = computeLoadBudget({
                islands,
                contacts: postCullContacts,
                areaPerSupportMm2: autoSettings.areaPerSupportMm2,
                poseDragMomentMm3: poseStability?.dragMomentMm3,
                poseTotalDragMomentMm3: poseStability?.totalDragMomentMm3,
                toppleCoverageNeeded,
            });
            const budget = forestReport.loadBudget;
            if (budget.wouldAdd > 0 || budget.wouldCull > 0) {
                console.log(LOG_PREFIX,
                    `Load budget (report only): would add ${budget.wouldAdd} and could cull ${budget.wouldCull} ` +
                    `— demand ${budget.totalDemandMm2.toFixed(0)}mm² vs capacity ${budget.totalCapacityMm2.toFixed(0)}mm², ` +
                    `deficit on ${budget.islandsInDeficit} islands, surplus on ${budget.islandsInSurplus}`);
            }
            if (tractionProfile) {
                const forceBudgetGraph = buildSupportGraph(draft, modelId);
                if (forceBudgetGraph.tipCount > 0) {
                    const forceBudget = computeForceBudgetFromGraph(
                        forceBudgetGraph,
                        tractionProfile,
                        forceBudgetSurfaces,
                        supportStrengthMpa,
                    );
                    forestReport.forceBudget = forceBudget;
                    if (forceBudget.rows.length > 0) {
                        console.log(LOG_PREFIX,
                            `Force budget: ${forceBudget.overloadedTips} tip(s) over break load of ${forceBudget.rows.length} — ` +
                            `worst ${(forceBudget.worst?.utilizationPct ?? 0).toFixed(0)}% at z ` +
                            `${(forceBudget.worst?.layerZMm ?? 0).toFixed(1)}mm, demand ${forceBudget.totalDemandN.toFixed(2)}N ` +
                            `vs capacity ${forceBudget.totalCapacityN.toFixed(2)}N`);
                    }
                }
            }
            const startSupportTips = collectSupportTips(draft, modelId);
            const startRows = islands
                .filter((island) => island.startIsland === true && !island.interior && !island.grounded)
                .map((island) => {
                    const status = assessStartSupport(island, startSupportTips, resolvedMesh);
                    return {
                        id: island.id,
                        areaMm2: status.areaMm2,
                        contacts: status.contacts,
                        minContacts: status.minContacts,
                        coveragePct: status.coverage * 100,
                        uncoveredAreaMm2: status.uncoveredAreaMm2,
                        zMm: island.baseZ,
                        pancakeRisk: status.pancakeRisk,
                    };
                });
            forestReport.starts = {
                count: startRows.length,
                underSupported: startRows.filter((row) => row.pancakeRisk).length,
                rows: startRows,
            };
            analytics.startIslands = forestReport.starts.count;
            analytics.startsUnderSupported = forestReport.starts.underSupported;
            console.log(LOG_PREFIX,
                `Starts: ${forestReport.starts.count} (${forestReport.starts.underSupported} under-supported)`);
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
    reportPhase('Compiling report', 1, 1);
    reportPhase('Bracing supports', 0, 1);
    timingStart('bracing');

    // ------------------------------------------------------------------
    // 5. Auto-bracing (draft-only, folded into the plan)
    // ------------------------------------------------------------------

    if (changed && !autoSettings.debugSkipAutoBracing) {
        console.log(LOG_PREFIX, 'Running auto-brace...');
        try {
            perfMark('bracing:auto');
            const braceResult = buildAutoBracedSnapshot(draft, getSettings().autoBracing, { modelId });
            perfMeasure('bracing:auto', 'bracing:auto');
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

    if (changed && analytics.forestReport) {
        try {
            perfMark('bracing:stress');
            let supportGraph = buildSupportGraph(draft, modelId);
            if (supportGraph.rootCount > 0 && supportGraph.tipCount > 0) {
                let frameStress = solveSupportFrameStress(supportGraph, tractionProfile, {
                    areaPerSupportMm2: autoSettings.areaPerSupportMm2,
                    supportStrengthMpa,
                    memberStrengthMpa,
                });
                // Close the loop with the stress solver: brace / kickstand
                // first, re-solve, and only thicken when no structural action
                // could be applied this pass. The structure band is capped at
                // 1.4 mm, so a fatter pole is not an answer the loop can reach;
                // the shorter span or the plate buttress is.
                let reinforcedTotal = 0;
                let stressBracesAdded = 0;
                let stressLeafPromotions = 0;
                let stressKickstandsAdded = 0;
                let stressTwigStruts = 0;
                const struttedEntityIds = new Set<string>();
                const autoBracingSettings = getSettings().autoBracing;
                for (let pass = 0; pass < MAX_STRESS_REINFORCE_PASSES; pass++) {
                    const memberOverloaded = frameStress.overloadedMembers > 0;
                    const rockingOver = frameStress.maxTipRockingMm > ROCKING_THRESHOLD_MM;
                    if (!memberOverloaded && !rockingOver) break;

                    let changedThisPass = false;
                    let reinforcedThisPass = 0;
                    let bracedThisPass = 0;
                    let bracedIds: ReadonlySet<string> = new Set();
                    const cappedStrutTargets: Array<{ entityId: string; entityKind: SupportTypeId }> = [];
                    // Reset per pass: a member braced in pass 1 may still be
                    // over after the verification solve and can be thickened in
                    // pass 2.
                    const structurallyAddressed = new Set<string>();

                    const requests: StressBraceRequest[] = [];
                    let promotedThisPass = 0;
                    const promotionSkips: Partial<Record<string, number>> = {};
                    if (autoSettings.debugSkipAutoBracing !== true) {
                        for (const action of planStressActions(
                            frameStress,
                            { rockingLimitMm: ROCKING_THRESHOLD_MM },
                        )) {
                            if (action.kind === 'brace-rocking') {
                                if (requests.length >= MAX_STRESS_BRACES_PER_PASS) continue;
                                requests.push({
                                    aEntityId: action.aEntityId,
                                    bEntityId: action.bEntityId,
                                    atZMm: action.layerZMm,
                                    maxSpanMm: Math.min(60, Math.hypot(
                                        action.aPos.x - action.bPos.x,
                                        action.aPos.y - action.bPos.y,
                                        action.aPos.z - action.bPos.z,
                                    ) + 1),
                                });
                            } else if (action.kind === 'brace-member') {
                                if (memberAtReinforcementCap(draft, action.entityKind, action.entityId)) {
                                    cappedStrutTargets.push({ entityId: action.entityId, entityKind: action.entityKind });
                                }
                                if (action.entityKind === 'leaf') {
                                    // A leaf has no shaft to knot a brace onto.
                                    // Promote it to a branch first; the next
                                    // round can thicken or brace that shaft.
                                    if (promotedThisPass >= MAX_STRESS_LEAF_PROMOTIONS_PER_PASS) continue;
                                    const promoted = promoteOverloadedLeaf(
                                        draft,
                                        action.entityId,
                                        resolvedMesh ?? undefined,
                                        autoSettings,
                                    );
                                    if (promoted.promoted) {
                                        draft = promoted.draft;
                                        structurallyAddressed.add(action.entityId);
                                        promotedThisPass++;
                                        stressLeafPromotions++;
                                        changedThisPass = true;
                                    } else if (promoted.reason) {
                                        promotionSkips[promoted.reason] = (promotionSkips[promoted.reason] ?? 0) + 1;
                                    }
                                } else if (requests.length < MAX_STRESS_BRACES_PER_PASS) {
                                    const capped = memberAtReinforcementCap(draft, action.entityKind, action.entityId);
                                    if (capped) cappedStrutTargets.push({ entityId: action.entityId, entityKind: action.entityKind });
                                    requests.push({
                                        aEntityId: action.entityId,
                                        // A member's own midpoint is where the
                                        // solver measured the overload; the
                                        // critical layer can be metres away
                                        // from that shaft.
                                        atZMm: action.pos.z,
                                        near: action.pos,
                                        ...(capped ? { maxSpanMm: MAX_CAPPED_STRUT_SPAN_MM } : {}),
                                    });
                                }
                            } else if (action.kind === 'thicken-member') {
                                // A shaft at its reinforcement cap (or with
                                // scaling off) cannot grow; it needs a shorter
                                // span instead. A shaft below the cap is left to
                                // the thickening step below — one modest step is
                                // still cheaper than a brace.
                                if (requests.length >= MAX_STRESS_BRACES_PER_PASS) continue;
                                if (autoSettings.modelScaleEnabled === false
                                    || memberAtReinforcementCap(draft, action.entityKind, action.entityId)) {
                                    if (memberAtReinforcementCap(draft, action.entityKind, action.entityId)) {
                                        cappedStrutTargets.push({ entityId: action.entityId, entityKind: action.entityKind });
                                    }
                                    requests.push({
                                        aEntityId: action.entityId,
                                        atZMm: action.layerZMm,
                                        near: action.pos,
                                        maxSpanMm: MAX_CAPPED_STRUT_SPAN_MM,
                                    });
                                }
                            }
                        }
                    }
                    if (promotedThisPass > 0) {
                        console.log(LOG_PREFIX, `Stress closed loop: promoted ${promotedThisPass} overloaded leaf/leaves to branches`);
                    }
                    if (Object.keys(promotionSkips).length > 0) {
                        console.log(LOG_PREFIX, `Stress leaf promotions skipped: ${JSON.stringify(promotionSkips)}`);
                    }
                    if (requests.length > 0) {
                        const braced = addTargetedStressBraces(
                            draft,
                            requests,
                            autoBracingSettings,
                            new Set([modelId]),
                        );
                        if (braced.added > 0) {
                            draft = braced.snapshot;
                            stressBracesAdded += braced.added;
                            bracedThisPass = braced.added;
                            bracedIds = new Set(braced.bracedEntityIds);
                            // A brace and a diameter step are complementary:
                            // do not let a successful brace suppress the
                            // thickening that the member still needs. The
                            // 1.4 mm cap bounds the result; only a promoted
                            // leaf (removed by the promotion) is skipped.
                            changedThisPass = true;
                        } else if (braced.skipped > 0) {
                            console.log(LOG_PREFIX,
                                `Stress braces skipped: ${JSON.stringify(braced.reasons)}`);
                        }
                    }

                    // A shaft whose brace request did not land gets a plate
                    // buttress: a kickstand at 30-45°, not a fatter pole and not
                    // an unbraced flagpole. This is per trunk, so a batch where
                    // one pair was braced still buttresses the pair that had no
                    // host.
                    let kickstandsThisPass = 0;
                    if (requests.length > 0) {
                        const targetTrunks = new Map<string, { z: number; entityIds: string[] }>();
                        for (const request of requests) {
                            for (const entityId of [request.aEntityId, request.bEntityId]) {
                                if (!entityId) continue;
                                const trunkId = owningTrunkId(draft, entityId);
                                if (!trunkId) continue;
                                const entry = targetTrunks.get(trunkId) ?? { z: request.atZMm, entityIds: [] };
                                entry.entityIds.push(entityId);
                                targetTrunks.set(trunkId, entry);
                            }
                        }
                        for (const [trunkId, target] of targetTrunks) {
                            if (kickstandsThisPass >= MAX_STRESS_KICKSTANDS_PER_PASS) break;
                            if (target.entityIds.some((id) => bracedIds.has(id))) continue;
                            const buttress = buttressTrunkWithKickstand(
                                draft,
                                modelId,
                                trunkId,
                                target.z,
                                resolvedMesh ?? undefined,
                                { allowAdditional: pass > 0 },
                            );
                            if (!buttress.added) continue;
                            draft = buttress.draft;
                            // A kickstand shares some load but is not a brace
                            // on the member's own span; let the trunk thicken
                            // in the same batch rather than suppressing the
                            // only action that reduces its bending stress.
                            kickstandsThisPass++;
                            stressKickstandsAdded++;
                            changedThisPass = true;
                        }
                        if (kickstandsThisPass > 0) {
                            console.log(LOG_PREFIX,
                                `Stress buttress: ${kickstandsThisPass} kickstand(s) added for trunks whose brace did not land`);
                        }
                    }

                    // A capped member whose brace did not land gets a
                    // model-coupled twig/stick strut from its own contact to
                    // the model below. The frame graph now models such a bridge
                    // (the model end is fixed, the tip is shared), so this is a
                    // real secondary load path rather than decoration.
                    let twigStrutsThisPass = 0;
                    if (resolvedMesh) {
                        for (const target of cappedStrutTargets) {
                            if (bracedIds.has(target.entityId) || struttedEntityIds.has(target.entityId)) continue;
                            const descriptor = getSupportTypeDescriptor(target.entityKind);
                            const entity = (draft[descriptor.location.key] as unknown as Record<string, {
                                contactCone?: { pos: Vec3; normal?: Vec3; surfaceNormal?: Vec3; profile?: { maxContactDiameterMm?: number; bodyDiameterMm?: number } };
                                segments?: Segment[];
                            }>)[target.entityId];
                            const cone = entity?.contactCone;
                            if (!cone?.pos) continue;
                            const shaftDiameterMm = entity.segments?.[0]?.diameter
                                ?? cone.profile?.bodyDiameterMm
                                ?? activeSizingBand(autoSettings).shaftDiameterMm;
                            const bridge = buildCavityBridge(
                                cone.pos,
                                cone.surfaceNormal ?? cone.normal ?? { x: 0, y: 0, z: -1 },
                                modelId,
                                resolvedMesh,
                                {
                                    shaftDiameterMm,
                                    tipContactDiameterMm: cone.profile?.maxContactDiameterMm
                                        ?? activeSizingBand(autoSettings).tipContactDiameterMm,
                                },
                            );
                            if (!bridge) continue;
                            const record = bridge.entity as unknown as Record<string, { pos?: Vec3 } | undefined>;
                            let maxSpanMm = 0;
                            for (const { field } of contactEndpointsFor(bridge.kind)) {
                                const p = record[field]?.pos;
                                if (!p) continue;
                                maxSpanMm = Math.max(maxSpanMm, Math.hypot(p.x - cone.pos.x, p.y - cone.pos.y, p.z - cone.pos.z));
                            }
                            if (maxSpanMm > MAX_CAVITY_BRIDGE_MM) continue;
                            draft = draftAddEntity(draft, bridge.kind, bridge.entity);
                            struttedEntityIds.add(target.entityId);
                            twigStrutsThisPass++;
                            stressTwigStruts++;
                            changedThisPass = true;
                        }
                        if (twigStrutsThisPass > 0) {
                            console.log(LOG_PREFIX,
                                `Stress strut: ${twigStrutsThisPass} model-coupled twig/stick(s) for capped members`);
                        }
                    }

                    // A capped member with no brace/strut left gets a bounded
                    // cap exception (1.6 mm trunk / 1.5 branch), so the last
                    // residual is a shaft step rather than an unreachable
                    // action. The normal cap stays 1.4 mm.
                    const capOverrides = new Map<string, number>();
                    for (const target of cappedStrutTargets) {
                        // The cap exception is the last stage for a member that
                        // was already over at the cap in this solve. A brace or
                        // strut in the same batch may still be insufficient
                        // (the wedge brace is), so the bounded step applies
                        // alongside it rather than being suppressed.
                        const segmentSource = target.entityKind === 'trunk'
                            ? draft.trunks[target.entityId]
                            : target.entityKind === 'branch'
                                ? draft.branches[target.entityId]
                                : null;
                        const maxSegmentDia = segmentSource && segmentSource.segments.length > 0
                            ? Math.max(...segmentSource.segments.map((seg) => seg.diameter))
                            : 0;
                        const overloadedDias = frameStress.memberSegments
                            .filter((seg) => seg.entityId === target.entityId && seg.utilizationPct > 100)
                            .map((seg) => seg.diameterMm);
                        // A contact cone is a separate member at 0.7 x its
                        // body; a diameter step on the shaft cannot reduce it,
                        // and a fatter cone body would rise above the tip.
                        // Skip the exception when every overloaded member on
                        // the entity is that cone.
                        if (maxSegmentDia > 0 && overloadedDias.length > 0
                            && overloadedDias.every((dia) => dia < maxSegmentDia * 0.9)) {
                            continue;
                        }
                        if (target.entityKind === 'trunk') capOverrides.set(target.entityId, MAX_CAPPED_EXCEPTION_DIA_MM);
                        else if (target.entityKind === 'branch') capOverrides.set(target.entityId, 1.5);
                    }
                    if (capOverrides.size > 0) {
                        console.log(LOG_PREFIX,
                            `Stress cap exception: ${capOverrides.size} capped shaft(s) take a bounded diameter step`);
                    }

                    // Every action is applied from the same first solve: members
                    // that got a brace/promotion/kickstand are left to the
                    // verification solve, the rest take one thickening step up
                    // to the structure cap.
                    if (memberOverloaded && autoSettings.modelScaleEnabled !== false) {
                        const reinforced = reinforceOverloadedFrameMembers(
                            draft,
                            frameStress,
                            resolvedMesh ?? undefined,
                            modelId,
                            structurallyAddressed,
                            capOverrides,
                        );
                        if (reinforced.changed) {
                            draft = reinforced.snapshot;
                            reinforcedThisPass = reinforced.totalReinforced;
                            reinforcedTotal += reinforced.totalReinforced;
                            changedThisPass = true;
                        }
                    }

                    if (!changedThisPass) break;
                    supportGraph = buildSupportGraph(draft, modelId);
                    frameStress = solveSupportFrameStress(supportGraph, tractionProfile, {
                        areaPerSupportMm2: autoSettings.areaPerSupportMm2,
                        supportStrengthMpa,
                        memberStrengthMpa,
                    });
                    console.log(LOG_PREFIX,
                        `Stress feedback pass ${pass + 1}: reinforced ${reinforcedThisPass} member(s), `
                        + `braced ${bracedThisPass} pair/member(s), buttressed ${kickstandsThisPass} trunk(s) → `
                        + `${frameStress.overloadedMembers} member(s), ${frameStress.overloadedTips} tip(s) over, `
                        + `rocking ${frameStress.maxTipRockingMm.toFixed(3)}mm`);
                }
                if (reinforcedTotal > 0) {
                    frameStress = { ...frameStress, reinforcedCount: reinforcedTotal };
                }
                if (stressBracesAdded > 0 || stressLeafPromotions > 0 || stressKickstandsAdded > 0 || stressTwigStruts > 0) {
                    console.log(LOG_PREFIX,
                        `Stress closed loop: ${stressBracesAdded} brace(s), `
                        + `${stressKickstandsAdded} kickstand buttress(es), `
                        + `${stressTwigStruts} model-coupled twig/stick(s), `
                        + `${stressLeafPromotions} leaf promotion(s) applied`);
                }
                analytics.forestReport.frameStress = frameStress;
                // Solved-demand topple margin about the pose's worst edge: the
                // per-layer Stefan force at its own CoP, not the nominal
                // area-drag moment, with the frame's compliance as the rocking
                // check.
                const edgeNormal = poseStability?.worstEdgeNormal;
                if (resolvedMesh && poseStability?.worstEdgePoint && edgeNormal
                    && Math.hypot(edgeNormal.x, edgeNormal.y) > 1e-6) {
                    const localCentroid = geometryCentroidMm(resolvedMesh.geometry);
                    if (localCentroid) {
                        const worldCentroid = new THREE.Vector3(localCentroid.x, localCentroid.y, localCentroid.z)
                            .applyMatrix4(resolvedMesh.matrixWorld);
                        const toppleRisk = evaluateToppleRisk({
                            profile: tractionProfile,
                            centroid: { x: worldCentroid.x, y: worldCentroid.y },
                            edge: { point: poseStability.worstEdgePoint, normal: edgeNormal },
                            bearingAreaMm2: poseStability.bearingAreaMm2,
                            contactDepthMm: poseStability.contactDepthMm,
                            frameRockingMm: frameStress.maxTipRockingMm,
                        });
                        analytics.forestReport.toppleRisk = toppleRisk;
                        console.log(LOG_PREFIX,
                            `Topple risk: COM ${toppleRisk.comDepthMm.toFixed(2)}mm inside the worst edge · `
                            + `peel moment ${toppleRisk.peelMomentNmm.toFixed(1)}N·mm · `
                            + `lifts at ${(toppleRisk.requiredAdhesionMpa * 1000).toFixed(1)}kPa · `
                            + `rocking ${toppleRisk.complianceMm.toFixed(2)}mm · ${toppleRisk.outcome}`);
                    }
                }
                console.log(LOG_PREFIX,
                    `Frame stress (${frameStress.solverMode}): `
                    + `${frameStress.nodeCount} nodes · ${frameStress.memberCount} beams (${frameStress.braceCount} braces) · `
                    + `peak ${frameStress.peakLayerPeelForceN.toFixed(2)}N @ Z${frameStress.peakLayerZMm.toFixed(1)}mm · `
                    + `tip max ${frameStress.maxTipUtilizationPct.toFixed(0)}% (${frameStress.overloadedTips} over) · `
                    + `member max ${frameStress.maxMemberUtilizationPct.toFixed(0)}% (${frameStress.overloadedMembers} over) · `
                    + `max defl ${frameStress.maxTipDeflectionMm.toFixed(3)}mm · rocking ${frameStress.maxTipRockingMm.toFixed(3)}mm`
                    + ((frameStress.reinforcedCount ?? 0) > 0 ? ` · reinforced ${frameStress.reinforcedCount}` : ''));
            }
            perfMeasure('bracing:stress', 'bracing:stress');
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Frame stress analysis failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    timingEnd('bracing');
    reportPhase('Bracing supports', 1, 1);
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
export function commitAutoPlacePlan(plan: AutoSupportPlan | null, beforeOverride?: SupportState): AutoPlaceResult {
    if (!plan) {
        return makeResult(emptyPlacedCounts(), 0, false, 'disabled');
    }

    if (plan.result.changed) {
        const sealedAfter = sealOwnedDraft(plan.support);
        const beforeRaw = beforeOverride ?? plan.before;
        const sealedBefore = beforeRaw === sealedAfter ? cloneSupportState(beforeRaw) : sealOwnedDraft(beforeRaw);

        // plan.support carries the kickstands now, so one write restores everything.
        setSnapshot(sealedAfter);
        try {
            pushSupportHistory(
                {
                    type: SUPPORT_AUTO_PLACE,
                    payload: {
                        before: sealedBefore,
                        after: sealedAfter,
                    },
                },
                { payloadOwned: true },
            );
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
    cavityMesh?: THREE.Mesh,
    beforeOverride?: SupportState,
    layerHeightMm?: number,
    resinTensileMpa?: number,
): AutoPlaceResult {
    return commitAutoPlacePlan(
        computeAutoSupportPlan(islands, modelId, settingsOverride, undefined, undefined, undefined, cavityMesh, layerHeightMm, resinTensileMpa),
        beforeOverride,
    );
}
