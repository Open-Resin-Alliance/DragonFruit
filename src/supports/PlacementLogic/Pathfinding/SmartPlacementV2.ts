/**
 * SmartPlacement V2 — Grid A* pathfinding with lazy SDF
 *
 * Drop-in replacement for calculateSmartPlacement that uses:
 * - SDFCache for O(1) collision queries (vs 9-ray bundles)
 * - Grid A* for route search (vs angular/radial candidate expansion)
 * - SupportOccupancy for support-to-support avoidance
 * - Frame-coherent warm-start for preview continuity
 *
 * Same input/output interface as SmartPlacement so trunkBuilder
 * doesn't need changes.
 */

import * as THREE from 'three';
import { Vec3 } from '../../types';
import type { SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import {
    calculateStandardPlacement,
    type TrunkPlacementInput,
    type TrunkPlacementResult,
} from '../StandardPlacement';
import { getSettings } from '../../Settings';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from '../Grid/gridMath';
import { buildNearestCandidateNodeKeys } from '../Grid/nearestCandidateNodeKeys';
import { SDFCache } from './SDFCache';
import { gridAStar, type GridAStarDebugSnapshot, type WarmStartState } from './GridAStar';
import { solvePotentialField } from './PotentialFieldSolver';
import { solveDeterministicFieldPath } from './FieldDeterministicSolver';
import type { SupportOccupancy } from './SupportOccupancy';
import {
    getSupportPathfindingDebugEnabled,
    getSupportPathfindingDebugTuningEnabled,
    getPotentialFieldTuning,
    setSupportPathfindingDebugSnapshot,
    type SupportPathfindingDebugEvent,
    type SupportPathfindingDebugOutcome,
} from './pathfindingDebugState';
import { perfMark, perfMeasureWithSpike } from './pathfindingPerf';
import {
    distanceXY,
    distance3D,
    segmentAngleFromVerticalDeg,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
    segmentSatisfiesMaxAngleFromVertical,
} from '../smartPlacementSearchUtils';

// ---------- Types ----------

export interface SmartPlacementV2Input extends TrunkPlacementInput {
    mesh: THREE.Mesh;
    modelId: string;
}

export interface SmartPlacementV2Context {
    /** Cached SDF for the model mesh. Reuse across placements for same model. */
    sdfCache?: SDFCache;
    /** Tracks placed support geometry. Optional — omit to skip support-to-support avoidance. */
    occupancy?: SupportOccupancy;
    /** Warm-start state from previous frame's search. Pass null for first frame. */
    warmStart?: WarmStartState | null;
    /** Support ID being placed (to ignore self in occupancy). */
    placingSupportId?: string;
    /** Override the A* expansion budget (default 2000). Pass a lower value for
     *  hover preview to reduce first-frame cost at transition-zone positions. */
    maxExpansions?: number;
    /** When true, enables the preview-exhausted spatial cache so positions where A*
     *  exhausts its reduced preview budget are fast-failed on subsequent hover frames.
     *  Must NOT be set for click-time placement — only for hover preview. */
    isPreview?: boolean;
}

// ---------- Constants ----------

const MAX_NEAREST_NODE_SEARCH_RINGS = 4;

// Global standoff distance from model geometry to reduce resin overexposure
// fusion risk when supports are placed close to surfaces.
const COLLISION_AVOIDANCE_MM = 0.48;

/** Number of XY perimeter samples around the roots cone at each height slice. */
const ROOTS_DISK_PERIMETER_SAMPLES = 16;
/** Safety margin in mm added to all roots volume checks. */
const ROOTS_DISK_SAFETY_MM = COLLISION_AVOIDANCE_MM;
/** Small extra margin used only for contact-cone body collision sampling. */
const CONTACT_CONE_COLLISION_SAFETY_MM = 0.05;
/** Ignore the first tip-adjacent region so contact attachment is still allowed. */
const CONTACT_CONE_TIP_IGNORE_MM = 0.25;
/** Target sampling stride for cone frustum checks (adaptive with SDF cell size). */
const CONTACT_CONE_COLLISION_SAMPLE_STEP_MM = 0.2;

const ROUTED_DETOUR_ANGLE_SLACK_DEG = 10;
// Resin printing: only small lateral adjustments.  The A* should find the
// closest viable root, not the farthest reachable one.
const MIN_ROUTING_SEARCH_LATERAL_MM = 48;
const MAX_ROUTING_SEARCH_LATERAL_MM = 72;
const ROUTING_SEARCH_LATERAL_PER_VERTICAL_MM = 2.5;
const ROUTING_SEARCH_SWEEP_RADII_MM = [1, 2, 3, 4, 6, 8, 10, 14, 18, 24, 30, 36, 44, 52, 60, 72, 84, 96, 108];
// Rescue radii for cone-clear seed and socket-shift searches.
// Keep these tight — the A* handles large-scale routing.  These only need
// to cover nearby socket shifts to clear the contact cone attachment region.
const STRAIGHT_SOCKET_RESCUE_RADII_MM = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8];
const STRAIGHT_SOCKET_RESCUE_DIRECTIONS = 16;
const MIXED_SOCKET_RESCUE_RADII_MM = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12];
const MIXED_SOCKET_RESCUE_DIRECTIONS = 8;
const MIXED_SOCKET_RESCUE_JOINT_RADII_MM = [0, 0.8, 1.6];
const MIXED_SOCKET_RESCUE_JOINT_DIRECTIONS = 8;
const MIXED_SOCKET_RESCUE_JOINT_Z_STEP_MM = 4.0;
const MIXED_SOCKET_RESCUE_NOMINAL_JOINT_RADII_MM = [0, 0.6, 1.2, 2.0];
const MIXED_SOCKET_RESCUE_NOMINAL_JOINT_Z_STEP_MM = 1.5;
const BASE_WIDE_PASS_EXPANSIONS_AT_2MM = 400;
const BASE_PREVIEW_WIDE_PASS_EXPANSIONS_AT_2MM = 150;
const ENABLE_AGGRESSIVE_POST_PATH_STRAIGHTENING = false;

// Cone rescue scoring is intentionally biased toward preserving a short,
// near-normal tip.  Stretching the cone should be expensive enough that the
// solver prefers moving the socket/base instead of distorting the tip geometry.
const CONTACT_CONE_STRETCH_LINEAR_WEIGHT = 7.5;
const CONTACT_CONE_STRETCH_QUADRATIC_WEIGHT = 4.0;
const CONTACT_CONE_STRETCH_CUBIC_WEIGHT = 0.75;
const CONTACT_CONE_ANGLE_WEIGHT = 0.04;
const CONTACT_CONE_ANGLE_OVER_45_WEIGHT = 0.18;
const CONTACT_CONE_WORSENING_WEIGHT = 0.16;
const CONTACT_CONE_WORSENING_OVER_45_WEIGHT = 0.3;
const CONTACT_CONE_MAX_STRETCH_RATIO = 0.52;
const CONTACT_DISK_IDEAL_DIRECTION_DEVIATION_DEG = 20;
const CONTACT_DISK_DIRECTION_DEVIATION_WEIGHT = 0.06;
const CONTACT_DISK_DIRECTION_DEVIATION_QUADRATIC_WEIGHT = 0.04;
const CONTACT_DISK_MAX_CONE_AXIS_ANGLE_DEG = 78;

interface DebugAutoTuneProfile {
    envelopeLateralScale: number;
    rescueRadiusScale: number;
    coneSeedLateralScale: number;
    fineExpansionScale: number;
    wideExpansionScale: number;
    collisionAvoidanceScale: number;
    maxSegmentAngleBonusDeg: number;
    minRoutingZSpanScale: number;
    coneStretchRatioScale: number;
    coneAxisAngleBonusDeg: number;
}

const DEFAULT_PATHFINDING_PROFILE: DebugAutoTuneProfile = {
    envelopeLateralScale: 1,
    rescueRadiusScale: 1,
    coneSeedLateralScale: 1,
    fineExpansionScale: 1,
    wideExpansionScale: 1,
    collisionAvoidanceScale: 1,
    maxSegmentAngleBonusDeg: 0,
    minRoutingZSpanScale: 1,
    coneStretchRatioScale: 1,
    coneAxisAngleBonusDeg: 0,
};

const EXTRA_DEBUG_TUNE_PROFILE: DebugAutoTuneProfile = {
    envelopeLateralScale: 1.1,
    rescueRadiusScale: 1.1,
    coneSeedLateralScale: 1.1,
    fineExpansionScale: 1.2,
    wideExpansionScale: 1.15,
    collisionAvoidanceScale: 0.85,
    maxSegmentAngleBonusDeg: 2,
    minRoutingZSpanScale: 0.85,
    coneStretchRatioScale: 1.15,
    coneAxisAngleBonusDeg: 4,
};

interface ConeAutoTuneProfile {
    stretchRatioScale: number;
    axisAngleBonusDeg: number;
}

function combineDebugAutoTuneProfiles(base: DebugAutoTuneProfile, extra?: DebugAutoTuneProfile | null): DebugAutoTuneProfile {
    if (!extra) return base;
    return {
        envelopeLateralScale: base.envelopeLateralScale * extra.envelopeLateralScale,
        rescueRadiusScale: base.rescueRadiusScale * extra.rescueRadiusScale,
        coneSeedLateralScale: base.coneSeedLateralScale * extra.coneSeedLateralScale,
        fineExpansionScale: base.fineExpansionScale * extra.fineExpansionScale,
        wideExpansionScale: base.wideExpansionScale * extra.wideExpansionScale,
        collisionAvoidanceScale: base.collisionAvoidanceScale * extra.collisionAvoidanceScale,
        maxSegmentAngleBonusDeg: base.maxSegmentAngleBonusDeg + extra.maxSegmentAngleBonusDeg,
        minRoutingZSpanScale: base.minRoutingZSpanScale * extra.minRoutingZSpanScale,
        coneStretchRatioScale: base.coneStretchRatioScale * extra.coneStretchRatioScale,
        coneAxisAngleBonusDeg: base.coneAxisAngleBonusDeg + extra.coneAxisAngleBonusDeg,
    };
}

function buildUnitCircleDirections(count: number): Array<{ x: number; y: number }> {
    const directions: Array<{ x: number; y: number }> = [];
    for (let dir = 0; dir < count; dir++) {
        const angle = (dir / count) * Math.PI * 2;
        directions.push({ x: Math.cos(angle), y: Math.sin(angle) });
    }
    return directions;
}

/**
 * Computes a contact-cone axis that aligns with the actual first shaft segment
 * direction rather than the surface normal.  This prevents the visual disconnect
 * where the cone points one way (based on surface normal) but the shaft goes
 * another way (based on A* routing).
 *
 * The axis is the normalized direction from socketPos toward the first joint,
 * clamped to at most 45° from the surface-normal-derived axis so the cone
 * doesn't point radically away from the attachment surface.
 *
 * Additionally, the cone axis is never allowed to point upward (positive Z) —
 * in resin printing the cone must point toward the build plate.  If the
 * computed axis has a positive Z component, it is clamped to horizontal
 * (Z=0) or slightly downward.
 */
function computeConeAxisFromShaftDirection(
    socketPos: Vec3,
    firstJoint: Vec3,
    surfaceNormalAxis: Vec3,
): Vec3 {
    const shaftDir = new THREE.Vector3(
        firstJoint.x - socketPos.x,
        firstJoint.y - socketPos.y,
        firstJoint.z - socketPos.z,
    );
    const shaftLen = shaftDir.length();
    if (shaftLen < 0.01) return clampConeAxisDownward(surfaceNormalAxis);

    shaftDir.normalize();

    const normalAxis = new THREE.Vector3(
        surfaceNormalAxis.x, surfaceNormalAxis.y, surfaceNormalAxis.z,
    ).normalize();

    // Clamp: don't let the cone axis deviate more than 30° from the
    // surface-normal-derived axis.  This keeps the cone and contact disk
    // facing roughly the same direction — the disk is oriented along the
    // surface normal, so the cone must stay within a modest angle of it
    // to avoid a visual disconnect.
    const maxDeviationRad = Math.PI / 6; // 30°
    const deviationRad = shaftDir.angleTo(normalAxis);
    let result: Vec3;
    if (deviationRad <= maxDeviationRad + 1e-6) {
        result = { x: shaftDir.x, y: shaftDir.y, z: shaftDir.z };
    } else {
        // Clamp to max deviation: rotate the normal axis toward the shaft direction.
        const rotationAxis = new THREE.Vector3().crossVectors(normalAxis, shaftDir).normalize();
        if (rotationAxis.lengthSq() < 1e-10) {
            result = surfaceNormalAxis;
        } else {
            const clamped = normalAxis.clone().applyAxisAngle(rotationAxis, maxDeviationRad).normalize();
            result = { x: clamped.x, y: clamped.y, z: clamped.z };
        }
    }

    return clampConeAxisDownward(result);
}

/**
 * Ensures the cone axis never points upward (positive Z).
 * In resin printing, the cone must point toward the build plate.
 * If the axis has a positive Z component, it is projected to horizontal.
 */
function clampConeAxisDownward(axis: Vec3): Vec3 {
    if (axis.z <= 0) return axis;

    // Project to horizontal: keep XY direction, set Z to a slight downward tilt.
    const hLen = Math.sqrt(axis.x * axis.x + axis.y * axis.y);
    if (hLen < 0.001) {
        // Axis was pointing nearly straight up — default to straight down.
        return { x: 0, y: 0, z: -1 };
    }
    // 5° downward tilt from horizontal
    const tiltRad = Math.PI / 36; // 5°
    const scale = 1 / hLen;
    return {
        x: axis.x * scale * Math.cos(tiltRad),
        y: axis.y * scale * Math.cos(tiltRad),
        z: -Math.sin(tiltRad),
    };
}

const STRAIGHT_SOCKET_RESCUE_DIRECTION_VECTORS = buildUnitCircleDirections(STRAIGHT_SOCKET_RESCUE_DIRECTIONS);
const MIXED_SOCKET_RESCUE_DIRECTION_VECTORS = buildUnitCircleDirections(MIXED_SOCKET_RESCUE_DIRECTIONS);
const MIXED_SOCKET_RESCUE_JOINT_DIRECTION_VECTORS = buildUnitCircleDirections(MIXED_SOCKET_RESCUE_JOINT_DIRECTIONS);

// Minimum vertical span (mm) that routing joints must cover.
// If 2+ joints are all crammed into a small Z band at the tip (< this value),
// the path is squeezing through a model crack and should be rejected rather
// than placed as an embedded/mangled support.
const MIN_ROUTING_Z_SPAN_MM = 5.0;

// A* lattice resolution.
// Coarser step (0.5mm) for speed — the tight vertical-preference cost function
// means the A* doesn't need sub-millimeter precision for shaft routing.
const FINE_ASTAR_STEP_MM = 0.5;
const WIDE_ASTAR_STEP_MM = 0.6;
const LEGACY_BASE_STEP_MM = 2.0;

function scaleExpansionsForStep(baseExpansionsAt2mm: number, stepMm: number): number {
    // Keep approximate travel reach comparable to historical 2mm tuning by
    // scaling expansion budget with inverse step size.
    return Math.max(1, Math.round((baseExpansionsAt2mm * LEGACY_BASE_STEP_MM) / stepMm));
}

export interface SmartPlacementV2SearchEnvelope {
    maxTotalLateralMm: number;
    rescueSweepRadiiMm: number[];
}

export function getSmartPlacementV2SearchEnvelope(args: {
    socketPos: Vec3;
    rootTopZ: number;
    spacingMm: number;
}): SmartPlacementV2SearchEnvelope {
    const verticalSpanMm = Math.max(0, args.socketPos.z - args.rootTopZ);
    const unclampedLateralLimit = Math.max(
        MIN_ROUTING_SEARCH_LATERAL_MM,
        args.spacingMm * 15,
        verticalSpanMm * ROUTING_SEARCH_LATERAL_PER_VERTICAL_MM,
    );
    const maxTotalLateralMm = Math.round(
        Math.min(MAX_ROUTING_SEARCH_LATERAL_MM, unclampedLateralLimit) * 2,
    ) / 2;

    const rescueSweepRadiiMm = ROUTING_SEARCH_SWEEP_RADII_MM.filter((radius) => radius < maxTotalLateralMm - 0.000001);
    if (
        rescueSweepRadiiMm.length === 0
        || Math.abs(rescueSweepRadiiMm[rescueSweepRadiiMm.length - 1] - maxTotalLateralMm) > 0.000001
    ) {
        rescueSweepRadiiMm.push(maxTotalLateralMm);
    }

    return {
        maxTotalLateralMm,
        rescueSweepRadiiMm,
    };
}

function applyDebugTunedSearchEnvelope(
    envelope: SmartPlacementV2SearchEnvelope,
    tuning: DebugAutoTuneProfile | null,
): SmartPlacementV2SearchEnvelope {
    if (!tuning) return envelope;

    const tunedMaxLateral = Math.min(
        MAX_ROUTING_SEARCH_LATERAL_MM,
        Math.round(envelope.maxTotalLateralMm * tuning.envelopeLateralScale * 2) / 2,
    );
    const tunedRescueRadii = ROUTING_SEARCH_SWEEP_RADII_MM
        .map((radius) => Math.round(radius * tuning.rescueRadiusScale * 2) / 2)
        .filter((radius, index, arr) => radius > 0 && arr.indexOf(radius) === index)
        .filter((radius) => radius < tunedMaxLateral - 0.000001);

    if (
        tunedRescueRadii.length === 0
        || Math.abs(tunedRescueRadii[tunedRescueRadii.length - 1] - tunedMaxLateral) > 0.000001
    ) {
        tunedRescueRadii.push(tunedMaxLateral);
    }

    return {
        maxTotalLateralMm: tunedMaxLateral,
        rescueSweepRadiiMm: tunedRescueRadii,
    };
}

export function buildStraightSocketRescueCandidates(args: {
    socketPos: Vec3;
    maxTotalLateralMm: number;
}): Vec3[] {
    const maxRadius = Math.max(0, Math.min(args.maxTotalLateralMm, STRAIGHT_SOCKET_RESCUE_RADII_MM[STRAIGHT_SOCKET_RESCUE_RADII_MM.length - 1]));
    const candidates: Vec3[] = [{ ...args.socketPos }];

    for (const radius of STRAIGHT_SOCKET_RESCUE_RADII_MM) {
        if (radius <= 0 || radius > maxRadius + 0.000001) continue;
        for (const direction of STRAIGHT_SOCKET_RESCUE_DIRECTION_VECTORS) {
            candidates.push({
                x: args.socketPos.x + direction.x * radius,
                y: args.socketPos.y + direction.y * radius,
                z: args.socketPos.z,
            });
        }
    }

    return candidates;
}

function buildMixedSocketRescueCandidates(args: {
    socketPos: Vec3;
    maxTotalLateralMm: number;
}): Vec3[] {
    const maxRadius = Math.max(0, Math.min(args.maxTotalLateralMm, MIXED_SOCKET_RESCUE_RADII_MM[MIXED_SOCKET_RESCUE_RADII_MM.length - 1]));
    const candidates: Vec3[] = [{ ...args.socketPos }];

    for (const radius of MIXED_SOCKET_RESCUE_RADII_MM) {
        if (radius <= 0 || radius > maxRadius + 0.000001) continue;
        for (const direction of MIXED_SOCKET_RESCUE_DIRECTION_VECTORS) {
            candidates.push({
                x: args.socketPos.x + direction.x * radius,
                y: args.socketPos.y + direction.y * radius,
                z: args.socketPos.z,
            });
        }
    }

    return candidates;
}

interface MixedSocketRescueCandidate {
    socketPos: Vec3;
    base: ResolvedBaseCandidate;
    joints: Vec3[];
    coneAddedLengthMm: number;
    conePenaltyScore: number;
    socketShiftMm: number;
    metrics: ResolvedChainMetrics;
}

interface ContactConeRescueScoringInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    tipProfile: SupportTipProfile;
}

interface ContactConeRescuePenaltyMetrics {
    axis: Vec3;
    lengthMm: number;
    score: number;
    angleFromSurfaceNormalDeg: number;
    addedLengthMm: number;
    directionDeviationDeg: number;
    exceedsStretchLimit: boolean;
    exceedsDiskAngleLimit: boolean;
}

interface ContactConeClearSocketSeed {
    socketPos: Vec3;
    addedLengthMm: number;
    score: number;
    socketShiftMm: number;
}

type RootsDiskBlockedAt = (centerX: number, centerY: number) => boolean;
type SegmentBlockedBetween = (start: Vec3, end: Vec3) => boolean;
type ContactConeBlockedAt = (socketPos: Vec3) => boolean;

function vec3CacheKey(point: Vec3): string {
    return `${point.x}|${point.y}|${point.z}`;
}

function segmentCacheKey(start: Vec3, end: Vec3): string {
    const startKey = vec3CacheKey(start);
    const endKey = vec3CacheKey(end);
    return startKey <= endKey ? `${startKey}->${endKey}` : `${endKey}->${startKey}`;
}

function normalizeVectorOrFallback(vector: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
    if (vector.lengthSq() < 0.000001) {
        return fallback.clone().normalize();
    }

    return vector.clone().normalize();
}

function getContactConeRescuePenaltyMetrics(args: {
    socketPos: Vec3;
    coneScoring: ContactConeRescueScoringInput;
    reference?: Pick<ContactConeRescuePenaltyMetrics, 'lengthMm' | 'angleFromSurfaceNormalDeg' | 'axis'>;
    tuning?: ConeAutoTuneProfile | null;
}): ContactConeRescuePenaltyMetrics {
    const { socketPos, coneScoring, reference, tuning } = args;
    const surfaceNormal = normalizeVectorOrFallback(
        new THREE.Vector3(coneScoring.tipNormal.x, coneScoring.tipNormal.y, coneScoring.tipNormal.z),
        new THREE.Vector3(0, 0, 1),
    );
    const approxAxis = normalizeVectorOrFallback(
        new THREE.Vector3(
            socketPos.x - coneScoring.tipPos.x,
            socketPos.y - coneScoring.tipPos.y,
            socketPos.z - coneScoring.tipPos.z,
        ),
        surfaceNormal,
    );
    const thickness = coneScoring.tipProfile.type === 'disk'
        ? calculateDiskThickness(
            { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
            { x: approxAxis.x, y: approxAxis.y, z: approxAxis.z },
            coneScoring.tipProfile,
        )
        : 0;
    const coneStart = new THREE.Vector3(
        coneScoring.tipPos.x + surfaceNormal.x * thickness,
        coneScoring.tipPos.y + surfaceNormal.y * thickness,
        coneScoring.tipPos.z + surfaceNormal.z * thickness,
    );
    const finalAxis = normalizeVectorOrFallback(
        new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z).sub(coneStart),
        approxAxis,
    );
    const coneLengthMm = Math.max(0.05, coneStart.distanceTo(new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z)));
    const angleFromSurfaceNormalDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(finalAxis.dot(surfaceNormal), -1, 1)));
    const referenceLengthMm = reference?.lengthMm ?? coneScoring.tipProfile.lengthMm;
    const referenceAngleDeg = reference?.angleFromSurfaceNormalDeg ?? 0;
    const addedLengthMm = Math.max(0, coneLengthMm - referenceLengthMm);
    const stretchMm = Math.max(0, addedLengthMm - 0.05);
    const worsenedAngleDeg = Math.max(0, angleFromSurfaceNormalDeg - referenceAngleDeg);
    const shallownessScale = angleFromSurfaceNormalDeg / 90;
    const referenceAxis = reference
        ? normalizeVectorOrFallback(
            new THREE.Vector3(reference.axis.x, reference.axis.y, reference.axis.z),
            finalAxis,
        )
        : finalAxis;
    const directionDeviationDeg = reference
        ? THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(finalAxis.dot(referenceAxis), -1, 1)))
        : 0;
    const directionDeviationOverIdealDeg = coneScoring.tipProfile.type === 'disk'
        ? Math.max(0, directionDeviationDeg - CONTACT_DISK_IDEAL_DIRECTION_DEVIATION_DEG)
        : 0;
    const settings = getSettings();
    const isDev = settings.devToolsEnabled && settings.devTools;

    const stretchLinearWeight = isDev ? settings.devTools.coneStretchLinearWeight : CONTACT_CONE_STRETCH_LINEAR_WEIGHT;
    const stretchQuadraticWeight = isDev ? settings.devTools.coneStretchQuadraticWeight : CONTACT_CONE_STRETCH_QUADRATIC_WEIGHT;
    const coneAngleWeight = isDev ? settings.devTools.coneAngleWeight : CONTACT_CONE_ANGLE_WEIGHT;
    const maxConeStretchRatio = isDev ? settings.devTools.maxConeStretchRatio : CONTACT_CONE_MAX_STRETCH_RATIO;

    const absoluteShallownessPenalty =
        angleFromSurfaceNormalDeg * coneAngleWeight
        + Math.max(0, angleFromSurfaceNormalDeg - 45) * CONTACT_CONE_ANGLE_OVER_45_WEIGHT;
    const worsenedShallownessPenalty =
        worsenedAngleDeg * CONTACT_CONE_WORSENING_WEIGHT
        + Math.max(0, angleFromSurfaceNormalDeg - Math.max(referenceAngleDeg, 45)) * CONTACT_CONE_WORSENING_OVER_45_WEIGHT;
    const addedLengthPenalty =
        stretchMm * stretchLinearWeight
        + stretchMm * stretchMm * (stretchQuadraticWeight + shallownessScale * 1.75)
        + stretchMm * stretchMm * stretchMm * CONTACT_CONE_STRETCH_CUBIC_WEIGHT;
    const directionDeviationPenalty =
        directionDeviationOverIdealDeg * CONTACT_DISK_DIRECTION_DEVIATION_WEIGHT
        + directionDeviationOverIdealDeg * directionDeviationOverIdealDeg * CONTACT_DISK_DIRECTION_DEVIATION_QUADRATIC_WEIGHT;

    const stretchRatioScale = tuning?.stretchRatioScale ?? 1;
    const axisAngleBonusDeg = tuning?.axisAngleBonusDeg ?? 0;

    return {
        axis: { x: finalAxis.x, y: finalAxis.y, z: finalAxis.z },
        lengthMm: coneLengthMm,
        score: absoluteShallownessPenalty + worsenedShallownessPenalty + addedLengthPenalty + directionDeviationPenalty,
        angleFromSurfaceNormalDeg,
        addedLengthMm,
        directionDeviationDeg,
        exceedsStretchLimit: addedLengthMm > referenceLengthMm * maxConeStretchRatio * stretchRatioScale + 0.000001,
        exceedsDiskAngleLimit: coneScoring.tipProfile.type === 'disk'
            && angleFromSurfaceNormalDeg > CONTACT_DISK_MAX_CONE_AXIS_ANGLE_DEG + axisAngleBonusDeg + 0.000001,
    };
}

interface ContactConeGeometry {
    coneStart: Vec3;
    socketPos: Vec3;
    coneLengthMm: number;
    coneStartRadiusMm: number;
    coneEndRadiusMm: number;
}

function resolveContactConeGeometry(args: {
    tipPos: Vec3;
    tipNormal: Vec3;
    tipProfile: SupportTipProfile;
    socketPos: Vec3;
}): ContactConeGeometry {
    const surfaceNormal = normalizeVectorOrFallback(
        new THREE.Vector3(args.tipNormal.x, args.tipNormal.y, args.tipNormal.z),
        new THREE.Vector3(0, 0, 1),
    );
    const approxAxis = normalizeVectorOrFallback(
        new THREE.Vector3(
            args.socketPos.x - args.tipPos.x,
            args.socketPos.y - args.tipPos.y,
            args.socketPos.z - args.tipPos.z,
        ),
        surfaceNormal,
    );

    const diskThickness = args.tipProfile.type === 'disk'
        ? calculateDiskThickness(
            { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
            { x: approxAxis.x, y: approxAxis.y, z: approxAxis.z },
            args.tipProfile,
        )
        : 0;

    const coneStart: Vec3 = {
        x: args.tipPos.x + surfaceNormal.x * diskThickness,
        y: args.tipPos.y + surfaceNormal.y * diskThickness,
        z: args.tipPos.z + surfaceNormal.z * diskThickness,
    };

    const coneEnd = new THREE.Vector3(args.socketPos.x, args.socketPos.y, args.socketPos.z);
    const coneLengthMm = Math.max(0.05, coneEnd.distanceTo(new THREE.Vector3(coneStart.x, coneStart.y, coneStart.z)));

    return {
        coneStart,
        socketPos: args.socketPos,
        coneLengthMm,
        coneStartRadiusMm: args.tipProfile.contactDiameterMm / 2,
        coneEndRadiusMm: args.tipProfile.bodyDiameterMm / 2,
    };
}

function contactConeBlocked(args: {
    sdf: SDFCache;
    cone: ContactConeGeometry;
    mesh?: THREE.Mesh;
}): boolean {
    const cone = args.cone;
    const length = cone.coneLengthMm;
    if (length <= 0.000001) {
        return false;
    }

    const start = cone.coneStart;
    const end = cone.socketPos;
    const dirX = end.x - start.x;
    const dirY = end.y - start.y;
    const dirZ = end.z - start.z;

    // SDF sample loop — samples points along the cone axis and checks each
    // against the signed distance field.  The old raycast gate (checkShaftCollision
    // with THREE.Raycaster) was removed: it swapped the mesh material on every
    // call, modifying the scene graph, and this was called up to 168 times per
    // cone rescue frame (168 material swaps + 1500+ ray intersection tests).
    // The signed-distance check is sufficient — it correctly detects inside/outside
    // via face-normal dot product, and is fast (1 cached BVH query per sample).
    const minStep = Math.max(
        Math.min(CONTACT_CONE_COLLISION_SAMPLE_STEP_MM, args.sdf.cellSize * 0.8),
        0.1,
    );
    const startT = Math.min(1, CONTACT_CONE_TIP_IGNORE_MM / length);
    const sampleCount = Math.max(1, Math.ceil((1 - startT) * length / minStep));

    for (let i = 0; i <= sampleCount; i++) {
        const t = startT + ((1 - startT) * i) / sampleCount;
        const px = start.x + dirX * t;
        const py = start.y + dirY * t;
        const pz = start.z + dirZ * t;
        const radius = THREE.MathUtils.lerp(cone.coneStartRadiusMm, cone.coneEndRadiusMm, t) + CONTACT_CONE_COLLISION_SAFETY_MM;
        if (args.sdf.isBlocked(px, py, pz, radius)) {
            return true;
        }
    }

    return false;
}

function createContactConeBlockedMemo(args: {
    sdf: SDFCache;
    tipPos: Vec3;
    tipNormal: Vec3;
    tipProfile: SupportTipProfile;
    mesh?: THREE.Mesh;
}): ContactConeBlockedAt {
    const cache = new Map<string, boolean>();

    return (socketPos: Vec3): boolean => {
        const key = vec3CacheKey(socketPos);
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const blocked = contactConeBlocked({
            sdf: args.sdf,
            mesh: args.mesh,
            cone: resolveContactConeGeometry({
                tipPos: args.tipPos,
                tipNormal: args.tipNormal,
                tipProfile: args.tipProfile,
                socketPos,
            }),
        });

        cache.set(key, blocked);
        return blocked;
    };
}

function findContactConeClearSocketSeed(args: {
    socketPos: Vec3;
    maxTotalLateralMm: number;
    coneScoring: ContactConeRescueScoringInput;
    contactConeBlockedAt: ContactConeBlockedAt;
    coneTuning?: ConeAutoTuneProfile | null;
    sdf: SDFCache;
    clearance: number;
}): ContactConeClearSocketSeed | null {
    const T = args.coneScoring.tipPos;
    const N = new THREE.Vector3(args.coneScoring.tipNormal.x, args.coneScoring.tipNormal.y, args.coneScoring.tipNormal.z).normalize();
    const L_nominal = distance3D(T, args.socketPos);
    const L_max = L_nominal * (1 + CONTACT_CONE_MAX_STRETCH_RATIO);
    const maxRadius = args.maxTotalLateralMm;

    let currentPos = { ...args.socketPos };
    let iterations = 0;
    const maxIterations = 10;
    const stepAlpha = 0.5;

    while (iterations < maxIterations) {
        iterations++;

        // 1. Get SDF distance and gradient at current position
        const { distance: D, gradient: grad } = args.sdf.distanceAndGradientAt(currentPos.x, currentPos.y, currentPos.z, args.clearance);

        // 2. If we are inside clearance, calculate repulsion force
        let fx = 0, fy = 0, fz = 0;
        if (D < args.clearance) {
            const mag = stepAlpha * (args.clearance - D);
            const gLen = Math.sqrt(grad.x * grad.x + grad.y * grad.y + grad.z * grad.z);
            if (gLen > 1e-6) {
                fx = (grad.x / gLen) * mag;
                fy = (grad.y / gLen) * mag;
                fz = (grad.z / gLen) * mag;
            } else {
                fx = N.x * mag;
                fy = N.y * mag;
                fz = N.z * mag;
            }
        }

        // 3. Move candidate position
        let px = currentPos.x + fx;
        let py = currentPos.y + fy;
        let pz = currentPos.z + fz;

        // 4. Project relative to tip
        const uVec = new THREE.Vector3(px - T.x, py - T.y, pz - T.z);
        const uLen = uVec.length();
        if (uLen > 1e-6) {
            const dot = uVec.dot(N);
            const uParallel = N.clone().multiplyScalar(dot);
            const uOrthogonal = uVec.clone().sub(uParallel);
            const orthLen = uOrthogonal.length();

            const maxAngleRad = (CONTACT_DISK_MAX_CONE_AXIS_ANGLE_DEG * Math.PI) / 180;
            const maxOrthLen = Math.max(0, dot * Math.tan(maxAngleRad));

            if (dot < 0) {
                uParallel.copy(N).multiplyScalar(1e-3);
                uOrthogonal.set(0, 0, 0);
            } else if (orthLen > maxOrthLen) {
                uOrthogonal.normalize().multiplyScalar(maxOrthLen);
            }

            uVec.copy(uParallel).add(uOrthogonal);
        }

        // Clamp length
        let newLen = uVec.length();
        if (newLen < L_nominal) {
            uVec.normalize().multiplyScalar(L_nominal);
        } else if (newLen > L_max) {
            uVec.normalize().multiplyScalar(L_max);
        }

        // Clamp lateral shift
        const lateralShift = Math.sqrt(uVec.x * uVec.x + uVec.y * uVec.y);
        if (lateralShift > maxRadius) {
            uVec.x = (uVec.x / lateralShift) * maxRadius;
            uVec.y = (uVec.y / lateralShift) * maxRadius;
        }

        const nextPos = {
            x: T.x + uVec.x,
            y: T.y + uVec.y,
            z: T.z + uVec.z,
        };

        const distSq = (nextPos.x - currentPos.x) ** 2 + (nextPos.y - currentPos.y) ** 2 + (nextPos.z - currentPos.z) ** 2;
        currentPos = nextPos;
        if (distSq < 0.0001) {
            break;
        }
    }

    if (args.contactConeBlockedAt(currentPos)) {
        return null; // still blocked after gradient march
    }

    const metrics = getContactConeRescuePenaltyMetrics({
        socketPos: currentPos,
        coneScoring: args.coneScoring,
        tuning: args.coneTuning,
    });

    if (metrics.exceedsStretchLimit || metrics.exceedsDiskAngleLimit) {
        return null;
    }

    return {
        socketPos: currentPos,
        addedLengthMm: metrics.addedLengthMm,
        score: metrics.score,
        socketShiftMm: distanceXY(currentPos, args.socketPos),
    };
}

function isMixedSocketRescueCandidateBetter(
    candidate: MixedSocketRescueCandidate,
    current: MixedSocketRescueCandidate,
): boolean {
    const eps = 0.000001;

    // Hard preference: keep the cone as close as possible to nominal length.
    if (candidate.coneAddedLengthMm < current.coneAddedLengthMm - eps) {
        return true;
    }
    if (candidate.coneAddedLengthMm > current.coneAddedLengthMm + eps) {
        return false;
    }

    // Prefer preserving contact-cone quality over minimizing socket shift.
    // This lets the solver choose an extra shaft bend/joint when needed
    // rather than accepting an over-stretched cone just to keep XY shift tiny.
    if (candidate.conePenaltyScore < current.conePenaltyScore - eps) {
        return true;
    }
    if (candidate.conePenaltyScore > current.conePenaltyScore + eps) {
        return false;
    }

    if (candidate.socketShiftMm < current.socketShiftMm - eps) {
        return true;
    }
    if (candidate.socketShiftMm > current.socketShiftMm + eps) {
        return false;
    }

    return isResolvedChainReplacementBetter(candidate.metrics, current.metrics);
}

export function findMixedSocketRescueCandidate(args: {
    socketPos: Vec3;
    rootTopZ: number;
    maxTotalLateralMm: number;
    gridEnabled: boolean;
    spacingMm: number;
    maxNearestNodeSearchRings: number;
    sdf: SDFCache;
    diskHeight: number;
    coneHeight: number;
    rootsRadius: number;
    shaftRadius: number;
    clearance: number;
    maxAngleFromVerticalDeg: number;
    coneScoring: ContactConeRescueScoringInput;
    buildNearestCandidateNodeKeys?: (preferredKey: string, maxRings: number) => string[];
    subGridOffset?: { x: number; y: number } | null;
    rootsDiskBlockedAt?: RootsDiskBlockedAt;
    segmentBlockedBetween?: SegmentBlockedBetween;
    contactConeBlockedAt?: ContactConeBlockedAt;
    requireJoint?: boolean;
    coneTuning?: ConeAutoTuneProfile | null;
}): { socketPos: Vec3; base: ResolvedBaseCandidate; joints: Vec3[] } | null {
    const maxRadius = Math.max(0, Math.min(args.maxTotalLateralMm, MIXED_SOCKET_RESCUE_RADII_MM[MIXED_SOCKET_RESCUE_RADII_MM.length - 1]));
    const baselineConePenaltyMetrics = getContactConeRescuePenaltyMetrics({
        socketPos: args.socketPos,
        coneScoring: args.coneScoring,
        tuning: args.coneTuning,
    });
    const resolvedBaseCache = new Map<string, ResolvedBaseCandidate | null>();
    const segmentBlockedCache = new Map<string, boolean>();
    const conePenaltyCache = new Map<string, ContactConeRescuePenaltyMetrics>();

    const segmentBlockedBetween: SegmentBlockedBetween = args.segmentBlockedBetween ?? ((start, end) => {
        const key = segmentCacheKey(start, end);
        const cached = segmentBlockedCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const blocked = args.sdf.segmentBlocked(start.x, start.y, start.z, end.x, end.y, end.z, args.clearance);
        segmentBlockedCache.set(key, blocked);
        return blocked;
    });

    const getConePenaltyMetrics = (candidateSocketPos: Vec3): ContactConeRescuePenaltyMetrics => {
        const key = vec3CacheKey(candidateSocketPos);
        const cached = conePenaltyCache.get(key);
        if (cached) {
            return cached;
        }

        const metrics = getContactConeRescuePenaltyMetrics({
            socketPos: candidateSocketPos,
            coneScoring: args.coneScoring,
            reference: baselineConePenaltyMetrics,
            tuning: args.coneTuning,
        });
        conePenaltyCache.set(key, metrics);
        return metrics;
    };

    const getResolvedBaseForTerminalPoint = (terminalPoint: Vec3): ResolvedBaseCandidate | null => {
        const key = `${terminalPoint.x.toFixed(4)}|${terminalPoint.y.toFixed(4)}|${terminalPoint.z.toFixed(4)}`;
        if (resolvedBaseCache.has(key)) {
            return resolvedBaseCache.get(key) ?? null;
        }

        const resolvedBase = resolveCommittedBaseCandidate({
            preferredBottomPos: { x: terminalPoint.x, y: terminalPoint.y, z: 0 },
            lastSegmentStart: terminalPoint,
            rootTopZ: args.rootTopZ,
            gridEnabled: args.gridEnabled,
            spacingMm: args.spacingMm,
            maxNearestNodeSearchRings: args.maxNearestNodeSearchRings,
            sdf: args.sdf,
            diskHeight: args.diskHeight,
            coneHeight: args.coneHeight,
            rootsRadius: args.rootsRadius,
            shaftRadius: args.shaftRadius,
            clearance: args.clearance,
            buildNearestCandidateNodeKeys: args.buildNearestCandidateNodeKeys,
            subGridOffset: args.subGridOffset,
            rootsDiskBlockedAt: args.rootsDiskBlockedAt,
            segmentBlockedBetween,
        });

        resolvedBaseCache.set(key, resolvedBase);
        return resolvedBase;
    };

    let best: MixedSocketRescueCandidate | null = null;
    // Track whether we've found a "perfect" candidate to enable early termination
    // without relying on TypeScript's closure-aware narrowing of `best`.
    let foundPerfectCandidate = false;
    let foundGoodEnoughCandidate = false;

    const tipNormal = args.coneScoring.tipNormal;
    const thetaIdeal = (Math.abs(tipNormal.x) > 0.000001 || Math.abs(tipNormal.y) > 0.000001)
        ? Math.atan2(tipNormal.y, tipNormal.x)
        : 0;

    const angleOffsetsDeg = [0, 5, -5, 10, -10, 22.5, -22.5, 45, -45, 90, -90, 135, -135, 180];

    for (const radius of MIXED_SOCKET_RESCUE_RADII_MM) {
        if (radius > maxRadius + 0.000001) continue;

        let foundClearAtRadius = false;

        for (const offsetDeg of angleOffsetsDeg) {
            if (radius === 0 && offsetDeg !== 0) {
                continue;
            }

            const angle = thetaIdeal + (offsetDeg * Math.PI / 180);
            const candidateSocketPos = radius === 0
                ? { ...args.socketPos }
                : {
                    x: args.socketPos.x + Math.cos(angle) * radius,
                    y: args.socketPos.y + Math.sin(angle) * radius,
                    z: args.socketPos.z,
                };

            if (args.contactConeBlockedAt?.(candidateSocketPos)) {
                continue;
            }

            const socketShiftMm = distanceXY(candidateSocketPos, args.socketPos);
            const preferNominalReachAround = socketShiftMm <= 0.000001;

            let candidateValid = false;

            const considerCandidate = (joints: Vec3[]): boolean => {
                if (args.requireJoint && joints.length === 0) {
                    return false;
                }

                const chainPrefix = [candidateSocketPos, ...joints];
                for (let i = 0; i < chainPrefix.length - 1; i++) {
                    const start = chainPrefix[i];
                    const end = chainPrefix[i + 1];
                    if (segmentBlockedBetween(start, end)) {
                        return false;
                    }
                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(start, end, args.maxAngleFromVerticalDeg)) {
                        return false;
                    }
                }

                const terminalPoint = joints[joints.length - 1] ?? candidateSocketPos;
                const resolvedBase = getResolvedBaseForTerminalPoint(terminalPoint);
                if (!resolvedBase) {
                    return false;
                }

                const rootTopTarget = resolvedBase.rootTopTarget;
                if (segmentBlockedBetween(terminalPoint, rootTopTarget)) {
                    return false;
                }
                if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(terminalPoint, rootTopTarget, args.maxAngleFromVerticalDeg)) {
                    return false;
                }

                const conePenaltyMetrics = getConePenaltyMetrics(candidateSocketPos);
                if (conePenaltyMetrics.exceedsStretchLimit || conePenaltyMetrics.exceedsDiskAngleLimit) {
                    return false;
                }

                const candidate: MixedSocketRescueCandidate = {
                    socketPos: candidateSocketPos,
                    base: resolvedBase,
                    joints,
                    coneAddedLengthMm: conePenaltyMetrics.addedLengthMm,
                    conePenaltyScore: conePenaltyMetrics.score,
                    socketShiftMm,
                    metrics: getResolvedChainMetrics(candidateSocketPos, joints, rootTopTarget),
                };

                if (!best || isMixedSocketRescueCandidateBetter(candidate, best)) {
                    best = candidate;
                    foundPerfectCandidate = candidate.coneAddedLengthMm <= 0.001
                        && candidate.socketShiftMm <= 0.001
                        && candidate.joints.length === 0;
                    foundGoodEnoughCandidate = candidate.coneAddedLengthMm <= 0.001
                        && candidate.socketShiftMm <= 2.0;
                }

                return true;
            };

            const ok = considerCandidate([]);
            if (ok) {
                candidateValid = true;
            }

            if (foundPerfectCandidate) {
                break;
            }

            const skipJointSearch = foundGoodEnoughCandidate;
            const jointZStepMm = preferNominalReachAround
                ? MIXED_SOCKET_RESCUE_NOMINAL_JOINT_Z_STEP_MM
                : MIXED_SOCKET_RESCUE_JOINT_Z_STEP_MM;
            const jointRadii = preferNominalReachAround
                ? MIXED_SOCKET_RESCUE_NOMINAL_JOINT_RADII_MM
                : MIXED_SOCKET_RESCUE_JOINT_RADII_MM;
            const availableDrop = candidateSocketPos.z - args.rootTopZ;

            if (availableDrop > jointZStepMm + 0.000001 && !skipJointSearch) {
                for (
                    let jointZ = candidateSocketPos.z - jointZStepMm;
                    jointZ > args.rootTopZ + jointZStepMm;
                    jointZ -= jointZStepMm
                ) {
                    const centerX = candidateSocketPos.x;
                    const centerY = candidateSocketPos.y;

                    for (const jointRadius of jointRadii) {
                        if (jointRadius === 0) {
                            if (considerCandidate([{ x: centerX, y: centerY, z: jointZ }])) {
                                candidateValid = true;
                            }
                            continue;
                        }

                        for (const direction of MIXED_SOCKET_RESCUE_JOINT_DIRECTION_VECTORS) {
                            if (considerCandidate([{
                                x: centerX + direction.x * jointRadius,
                                y: centerY + direction.y * jointRadius,
                                z: jointZ,
                            }])) {
                                candidateValid = true;
                            }
                        }
                    }
                }
            }

            if (candidateValid) {
                foundClearAtRadius = true;
            }
        }

        if (foundPerfectCandidate) {
            break;
        }

        if (foundClearAtRadius) {
            break;
        }
    }

    if (!best) {
        return null;
    }

    const resolvedBest = best as unknown as MixedSocketRescueCandidate;

    return {
        socketPos: resolvedBest.socketPos,
        base: resolvedBest.base,
        joints: resolvedBest.joints,
    };
}

export function findStraightSocketRescueCandidate(args: {
    socketPos: Vec3;
    rootTopZ: number;
    maxTotalLateralMm: number;
    gridEnabled: boolean;
    spacingMm: number;
    maxNearestNodeSearchRings: number;
    sdf: SDFCache;
    diskHeight: number;
    coneHeight: number;
    rootsRadius: number;
    shaftRadius: number;
    clearance: number;
    coneScoring?: ContactConeRescueScoringInput;
    buildNearestCandidateNodeKeys?: (preferredKey: string, maxRings: number) => string[];
    subGridOffset?: { x: number; y: number } | null;
    rootsDiskBlockedAt?: RootsDiskBlockedAt;
    segmentBlockedBetween?: SegmentBlockedBetween;
    contactConeBlockedAt?: ContactConeBlockedAt;
    coneTuning?: ConeAutoTuneProfile | null;
}): { socketPos: Vec3; base: ResolvedBaseCandidate } | null {
    const maxRadius = Math.max(0, Math.min(args.maxTotalLateralMm, STRAIGHT_SOCKET_RESCUE_RADII_MM[STRAIGHT_SOCKET_RESCUE_RADII_MM.length - 1]));
    const baselineConePenaltyMetrics = args.coneScoring
        ? getContactConeRescuePenaltyMetrics({
            socketPos: args.socketPos,
            coneScoring: args.coneScoring,
            tuning: args.coneTuning,
        })
        : null;

    let bestCandidate: {
        socketPos: Vec3;
        base: ResolvedBaseCandidate;
        coneAddedLengthMm: number;
        conePenaltyScore: number;
        socketShiftMm: number;
    } | null = null;
    const conePenaltyCache = new Map<string, ContactConeRescuePenaltyMetrics>();

    const getConePenaltyMetrics = (candidateSocketPos: Vec3): ContactConeRescuePenaltyMetrics => {
        if (!args.coneScoring) {
            return {
                axis: { x: 0, y: 0, z: 1 },
                lengthMm: 0,
                score: 0,
                angleFromSurfaceNormalDeg: 0,
                addedLengthMm: 0,
                directionDeviationDeg: 0,
                exceedsStretchLimit: false,
                exceedsDiskAngleLimit: false,
            };
        }

        const key = vec3CacheKey(candidateSocketPos);
        const cached = conePenaltyCache.get(key);
        if (cached) {
            return cached;
        }

        const metrics = getContactConeRescuePenaltyMetrics({
            socketPos: candidateSocketPos,
            coneScoring: args.coneScoring,
            reference: baselineConePenaltyMetrics ?? undefined,
            tuning: args.coneTuning,
        });
        conePenaltyCache.set(key, metrics);
        return metrics;
    };

    const tipNormal = args.coneScoring?.tipNormal ?? { x: 0, y: 0, z: 1 };
    const thetaIdeal = (Math.abs(tipNormal.x) > 0.000001 || Math.abs(tipNormal.y) > 0.000001)
        ? Math.atan2(tipNormal.y, tipNormal.x)
        : 0;

    const angleOffsetsDeg = [0, 5, -5, 10, -10, 22.5, -22.5, 45, -45, 90, -90, 135, -135, 180];

    for (const radius of STRAIGHT_SOCKET_RESCUE_RADII_MM) {
        if (radius > maxRadius + 0.000001) continue;

        let foundClearAtRadius = false;

        for (const offsetDeg of angleOffsetsDeg) {
            if (radius === 0 && offsetDeg !== 0) {
                continue;
            }

            const angle = thetaIdeal + (offsetDeg * Math.PI / 180);
            const candidateSocketPos = radius === 0
                ? { ...args.socketPos }
                : {
                    x: args.socketPos.x + Math.cos(angle) * radius,
                    y: args.socketPos.y + Math.sin(angle) * radius,
                    z: args.socketPos.z,
                };

            if (args.contactConeBlockedAt?.(candidateSocketPos)) {
                continue;
            }

            const conePenaltyMetrics = getConePenaltyMetrics(candidateSocketPos);
            if (conePenaltyMetrics.exceedsStretchLimit || conePenaltyMetrics.exceedsDiskAngleLimit) {
                continue;
            }
            const conePenaltyScore = conePenaltyMetrics.score;
            const coneAddedLengthMm = conePenaltyMetrics.addedLengthMm;
            const socketShiftMm = distanceXY(candidateSocketPos, args.socketPos);
            const eps = 0.000001;

            if (bestCandidate) {
                if (coneAddedLengthMm > bestCandidate.coneAddedLengthMm + eps) {
                    continue;
                }
                if (coneAddedLengthMm < bestCandidate.coneAddedLengthMm - eps) {
                    // continue evaluating this better-length candidate
                } else if (conePenaltyScore > bestCandidate.conePenaltyScore + eps) {
                    continue;
                }
                if (conePenaltyScore > bestCandidate.conePenaltyScore + eps) {
                    continue;
                }
                if (
                    Math.abs(conePenaltyScore - bestCandidate.conePenaltyScore) <= eps
                    && socketShiftMm > bestCandidate.socketShiftMm + eps
                ) {
                    continue;
                }
            }

            const resolved = resolveCommittedBaseCandidate({
                preferredBottomPos: { x: candidateSocketPos.x, y: candidateSocketPos.y, z: 0 },
                lastSegmentStart: candidateSocketPos,
                rootTopZ: args.rootTopZ,
                gridEnabled: args.gridEnabled,
                spacingMm: args.spacingMm,
                maxNearestNodeSearchRings: args.maxNearestNodeSearchRings,
                sdf: args.sdf,
                diskHeight: args.diskHeight,
                coneHeight: args.coneHeight,
                rootsRadius: args.rootsRadius,
                shaftRadius: args.shaftRadius,
                clearance: args.clearance,
                buildNearestCandidateNodeKeys: args.buildNearestCandidateNodeKeys,
                subGridOffset: args.subGridOffset,
                rootsDiskBlockedAt: args.rootsDiskBlockedAt,
                segmentBlockedBetween: args.segmentBlockedBetween,
            });
            if (resolved) {
                const candidate = {
                    socketPos: candidateSocketPos,
                    base: resolved,
                    coneAddedLengthMm,
                    conePenaltyScore,
                    socketShiftMm,
                };

                let isBetter = false;
                if (!bestCandidate) {
                    isBetter = true;
                } else if (candidate.coneAddedLengthMm < bestCandidate.coneAddedLengthMm - eps) {
                    isBetter = true;
                } else if (candidate.coneAddedLengthMm > bestCandidate.coneAddedLengthMm + eps) {
                    isBetter = false;
                } else if (candidate.conePenaltyScore < bestCandidate.conePenaltyScore - eps) {
                    isBetter = true;
                } else if (candidate.conePenaltyScore > bestCandidate.conePenaltyScore + eps) {
                    isBetter = false;
                } else if (candidate.socketShiftMm < bestCandidate.socketShiftMm - eps) {
                    isBetter = true;
                } else if (candidate.socketShiftMm > bestCandidate.socketShiftMm + eps) {
                    isBetter = false;
                } else if ((candidate.base.inboundLateralMm ?? 0) < (bestCandidate.base.inboundLateralMm ?? 0) - eps) {
                    isBetter = true;
                } else if ((candidate.base.inboundLateralMm ?? 0) > (bestCandidate.base.inboundLateralMm ?? 0) + eps) {
                    isBetter = false;
                } else if (candidate.base.snapDistance < bestCandidate.base.snapDistance - eps) {
                    isBetter = true;
                }

                if (isBetter) {
                    bestCandidate = candidate;
                    foundClearAtRadius = true;
                }
            }
        }

        if (foundClearAtRadius) {
            break;
        }
    }

    return bestCandidate
        ? {
            socketPos: bestCandidate.socketPos,
            base: bestCandidate.base,
        }
        : null;
}

function getWidePassBaseExpansionsAt2mm(maxTotalLateralMm: number, isPreview: boolean): number {
    const baseBudget = isPreview
        ? BASE_PREVIEW_WIDE_PASS_EXPANSIONS_AT_2MM
        : BASE_WIDE_PASS_EXPANSIONS_AT_2MM;
    const radiusScale = Math.min(2, Math.max(1, maxTotalLateralMm / MIN_ROUTING_SEARCH_LATERAL_MM));
    return Math.round(baseBudget * radiusScale);
}

export interface ResolvedChainMetrics {
    firstSegmentAngleFromVerticalDeg: number;
    firstSegmentLateral: number;
    totalLateral: number;
    totalLength: number;
    jointCount: number;
}

export function getResolvedChainMetrics(
    socketPos: Vec3,
    joints: Vec3[],
    rootTopTarget: Vec3,
): ResolvedChainMetrics {
    const points = [socketPos, ...joints, rootTopTarget];
    const firstTarget = joints[0] ?? rootTopTarget;
    let totalLateral = 0;
    let totalLength = 0;

    for (let i = 0; i < points.length - 1; i++) {
        totalLateral += distanceXY(points[i], points[i + 1]);
        totalLength += distance3D(points[i], points[i + 1]);
    }

    return {
        firstSegmentAngleFromVerticalDeg: segmentAngleFromVerticalDeg(socketPos, firstTarget),
        firstSegmentLateral: distanceXY(socketPos, firstTarget),
        totalLateral,
        totalLength,
        jointCount: joints.length,
    };
}

export function isResolvedChainReplacementBetter(
    candidate: ResolvedChainMetrics,
    current: ResolvedChainMetrics,
): boolean {
    const eps = 0.000001;

    if (candidate.firstSegmentAngleFromVerticalDeg < current.firstSegmentAngleFromVerticalDeg - eps) {
        return true;
    }
    if (candidate.firstSegmentAngleFromVerticalDeg > current.firstSegmentAngleFromVerticalDeg + eps) {
        return false;
    }

    if (candidate.firstSegmentLateral < current.firstSegmentLateral - eps) {
        return true;
    }
    if (candidate.firstSegmentLateral > current.firstSegmentLateral + eps) {
        return false;
    }

    if (candidate.totalLateral < current.totalLateral - eps) {
        return true;
    }
    if (candidate.totalLateral > current.totalLateral + eps) {
        return false;
    }

    if (candidate.totalLength < current.totalLength - eps) {
        return true;
    }
    if (candidate.totalLength > current.totalLength + eps) {
        return false;
    }

    return candidate.jointCount < current.jointCount;
}

// ---------- Roots cone volume check ----------

/**
 * Returns true if the roots structure at (centerX, centerY) would physically
 * intersect the mesh geometry.
 *
 * Sweeps the full roots volume — disk (Z=0 to diskHeight, full rootsRadius)
 * and cone (diskHeight to rootTopZ, tapering from rootsRadius to shaftRadius)
 * — sampling center + 16 perimeter points at each Z slice using the actual
 * cross-section radius at that height. This correctly catches protrusions at
 * any Z level and any angle, unlike the previous Z=0-only perimeter check.
 */
function rootsDiskBlocked(
    sdf: SDFCache,
    centerX: number,
    centerY: number,
    diskHeight: number,
    coneHeight: number,
    rootsRadius: number,
    shaftRadius: number,
): boolean {
    const safety = ROOTS_DISK_SAFETY_MM;
    const rootTopZ = diskHeight + coneHeight;
    const zSlices = Math.max(4, Math.ceil(rootTopZ / sdf.cellSize));

    for (let zi = 0; zi <= zSlices; zi++) {
        const z = (zi / zSlices) * rootTopZ;

        // Compute the actual cross-section radius at this Z height.
        // Disk section (Z <= diskHeight): full rootsRadius.
        // Cone section (diskHeight < Z <= rootTopZ): linearly tapers.
        let radiusAtZ: number;
        if (z <= diskHeight) {
            radiusAtZ = rootsRadius;
        } else {
            const t = coneHeight > 0 ? (z - diskHeight) / coneHeight : 1;
            radiusAtZ = rootsRadius + t * (shaftRadius - rootsRadius);
        }

        // SDF bounding-ball early-out: by the 1-Lipschitz property, if the
        // distance at the slice center is at least `radiusAtZ + safety`, then
        // every perimeter point at this slice is at distance ≥ safety from any
        // surface → not blocked.  Skips ~17 isBlocked calls per open slice.
        const centerDist = sdf.distanceAt(centerX, centerY, z);
        if (centerDist >= radiusAtZ + safety) continue;

        // Center itself failing means this slice is blocked.
        if (centerDist < safety) return true;

        // Perimeter at actual cone radius at this height
        for (let i = 0; i < ROOTS_DISK_PERIMETER_SAMPLES; i++) {
            const angle = (i / ROOTS_DISK_PERIMETER_SAMPLES) * Math.PI * 2;
            const px = centerX + Math.cos(angle) * radiusAtZ;
            const py = centerY + Math.sin(angle) * radiusAtZ;
            if (sdf.isBlocked(px, py, z, safety)) return true;
        }
    }

    return false;
}

function createRootsDiskBlockedMemo(args: {
    sdf: SDFCache;
    diskHeight: number;
    coneHeight: number;
    rootsRadius: number;
    shaftRadius: number;
}): RootsDiskBlockedAt {
    const cache = new Map<string, boolean>();

    return (centerX: number, centerY: number): boolean => {
        const key = `${centerX}|${centerY}`;
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const blocked = rootsDiskBlocked(
            args.sdf,
            centerX,
            centerY,
            args.diskHeight,
            args.coneHeight,
            args.rootsRadius,
            args.shaftRadius,
        );
        cache.set(key, blocked);
        return blocked;
    };
}

function createSegmentBlockedMemo(args: {
    sdf: SDFCache;
    clearance: number;
}): SegmentBlockedBetween {
    const cache = new Map<string, boolean>();

    return (start: Vec3, end: Vec3): boolean => {
        const key = segmentCacheKey(start, end);
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const blocked = args.sdf.segmentBlocked(start.x, start.y, start.z, end.x, end.y, end.z, args.clearance);
        cache.set(key, blocked);
        return blocked;
    };
}

export interface ResolvedBaseCandidate {
    basePos: Vec3;
    rootTopTarget: Vec3;
    inboundLateralMm?: number;
    snapDistance: number;
    nodeKey: string | null;
}

function isResolvedBaseCandidateBetter(
    candidate: ResolvedBaseCandidate,
    current: ResolvedBaseCandidate | null,
    lastSegmentStart: Vec3 | null,
): boolean {
    if (!current) {
        return true;
    }

    const eps = 0.000001;

    if (lastSegmentStart) {
        const candidateInboundLateralMm = candidate.inboundLateralMm ?? 0;
        const currentInboundLateralMm = current.inboundLateralMm ?? 0;

        if (candidateInboundLateralMm < currentInboundLateralMm - eps) {
            return true;
        }
        if (candidateInboundLateralMm > currentInboundLateralMm + eps) {
            return false;
        }
    }

    if (candidate.snapDistance < current.snapDistance - eps) {
        return true;
    }
    if (candidate.snapDistance > current.snapDistance + eps) {
        return false;
    }

    return (candidate.inboundLateralMm ?? 0) < (current.inboundLateralMm ?? 0) - eps;
}

export function resolveCommittedBaseCandidate(args: {
    preferredBottomPos: Vec3;
    lastSegmentStart: Vec3 | null;
    rootTopZ: number;
    gridEnabled: boolean;
    spacingMm: number;
    maxNearestNodeSearchRings: number;
    sdf: SDFCache;
    diskHeight: number;
    coneHeight: number;
    rootsRadius: number;
    shaftRadius: number;
    clearance: number;
    buildNearestCandidateNodeKeys?: (preferredKey: string, maxRings: number) => string[];
    subGridOffset?: { x: number; y: number } | null;
    rootsDiskBlockedAt?: RootsDiskBlockedAt;
    segmentBlockedBetween?: SegmentBlockedBetween;
}): ResolvedBaseCandidate | null {
    const candidateNodeKeys = args.gridEnabled
        ? args.buildNearestCandidateNodeKeys?.(
            gridNodeKeyFromXY(args.preferredBottomPos.x, args.preferredBottomPos.y, args.spacingMm),
            args.maxNearestNodeSearchRings,
        ) ?? []
        : ['disabled'];

    let bestBase: ResolvedBaseCandidate | null = null;
    for (const nodeKey of candidateNodeKeys) {
        let snappedXY = args.gridEnabled
            ? gridSnappedXYFromKey(nodeKey, args.spacingMm)
            : { x: args.preferredBottomPos.x, y: args.preferredBottomPos.y };

        if (!args.gridEnabled && args.subGridOffset) {
            snappedXY = {
                x: snappedXY.x + args.subGridOffset.x,
                y: snappedXY.y + args.subGridOffset.y,
            };
        }

        const basePos: Vec3 = { x: snappedXY.x, y: snappedXY.y, z: 0 };
        const rootTopTarget: Vec3 = { x: snappedXY.x, y: snappedXY.y, z: args.rootTopZ };
        const baseBlocked = args.rootsDiskBlockedAt
            ? args.rootsDiskBlockedAt(basePos.x, basePos.y)
            : rootsDiskBlocked(
                args.sdf,
                basePos.x,
                basePos.y,
                args.diskHeight,
                args.coneHeight,
                args.rootsRadius,
                args.shaftRadius,
            );
        if (baseBlocked) {
            continue;
        }

        if (
            args.lastSegmentStart
            && (
                args.segmentBlockedBetween
                    ? args.segmentBlockedBetween(args.lastSegmentStart, rootTopTarget)
                    : args.sdf.segmentBlocked(
                        args.lastSegmentStart.x,
                        args.lastSegmentStart.y,
                        args.lastSegmentStart.z,
                        rootTopTarget.x,
                        rootTopTarget.y,
                        rootTopTarget.z,
                        args.clearance,
                    )
            )
        ) {
            continue;
        }

        const snapDistance = distanceXY(basePos, args.preferredBottomPos);
        const inboundLateralMm = args.lastSegmentStart
            ? distanceXY(rootTopTarget, args.lastSegmentStart)
            : 0;
        const candidateBase: ResolvedBaseCandidate = {
            basePos,
            rootTopTarget,
            inboundLateralMm,
            snapDistance,
            nodeKey: args.gridEnabled ? nodeKey : null,
        };
        if (isResolvedBaseCandidateBetter(candidateBase, bestBase, args.lastSegmentStart)) {
            bestBase = candidateBase;
        }
    }

    return bestBase;
}

// ---------- SDF Cache Pool ----------

/**
 * Per-mesh SDF cache pool. Keyed by mesh uuid so we build at most one
 * SDFCache per model geometry. The BVH is already present; this just
 * gives us the caching wrapper.
 */
const sdfCachePool = new Map<string, SDFCache>();

/** Dedupes explicit precomputation requests for the same mesh. */
const precomputationRequests = new Map<string, Promise<number>>();

export function getOrCreateSDFCache(mesh: THREE.Mesh, cellSize?: number): SDFCache {
    const key = mesh.uuid;
    const existing = sdfCachePool.get(key);
    if (existing) return existing;

    const cache = new SDFCache(mesh, { cellSize: cellSize ?? 0.5 });
    sdfCachePool.set(key, cache);
    return cache;
}

export function clearSDFCacheForMesh(meshUuid: string): void {
    const cache = sdfCachePool.get(meshUuid);
    if (cache) {
        cache.clear();
        sdfCachePool.delete(meshUuid);
    }
    stagnationCache.delete(meshUuid);
    previewExhaustedCache.delete(meshUuid);
    precomputationRequests.delete(meshUuid);
}

export function clearAllSDFCaches(): void {
    for (const cache of sdfCachePool.values()) cache.clear();
    sdfCachePool.clear();
    stagnationCache.clear();
    previewExhaustedCache.clear();
    precomputationRequests.clear();
}

/**
 * Attempt to load a pre-computed signed distance field from the Rust backend
 * and inject it into the SDFCache for the given mesh.
 *
 * Call this after mesh repair/replacement, once per model. The pre-computed
 * grid replaces BVH queries with O(1) hash lookups for all subsequent
 * pathfinding operations.
 *
 * Safe to call when running in the browser (non-Tauri) — it returns silently.
 *
 * @returns The number of pre-computed cells, or 0 if unavailable.
 */
export async function tryLoadPrecomputedSDFForMesh(
    mesh: THREE.Mesh,
): Promise<number> {
    const key = mesh.uuid;
    const cache = getOrCreateSDFCache(mesh);
    if (cache.hasPrecomputed) return 0; // already loaded

    const existingRequest = precomputationRequests.get(key);
    if (existingRequest) return existingRequest;

    const request = (async () => {
        try {
            // Dynamic import to avoid bundling the Tauri IPC module in browser builds.
            const { computePrecomputedSDF, computeHeightmap } = await import(
                '../../../utils/precomputedSDF'
            );
            const sdfResult = await computePrecomputedSDF({ cellSize: cache.cellSize });
            if (!sdfResult) return 0;

            cache.loadPrecomputed(sdfResult.grid);

            const heightmap = await computeHeightmap();
            if (heightmap) {
                cache.loadHeightmap(heightmap);
            }

            console.log(
                `[SDF] Precomputed ${sdfResult.cellCount.toLocaleString()} cells ` +
                `(cellSize=${cache.cellSize}mm) for mesh ${key.slice(0, 8)}...`
            );

            return sdfResult.cellCount;
        } catch (err) {
            if (process.env.NODE_ENV === 'development') {
                console.debug('SDF precomputation not available, using BVH fallback:', err);
            }
            return 0;
        }
    })().then((cellCount) => {
        if (cellCount <= 0) {
            precomputationRequests.delete(key);
        }
        return cellCount;
    });

    precomputationRequests.set(key, request);
    return request;
}

// ---------- Main API ----------

/** Warm-start storage keyed by modelId for frame-coherent preview. */
const warmStartByModel = new Map<string, WarmStartState>(); // full / click-time runs
/**
 * Separate warm-start map for hover-preview A* runs (600- or 1200-expansion,
 * endpointOnly collision checks). Preview warm states can traverse cells that
 * full segmentBlocked would reject — keeping them separate prevents parity
 * re-runs from starting at a biased search frontier.
 */
const previewWarmStartByModel = new Map<string, WarmStartState>(); // hover preview runs

/**
 * Spatial stagnation cache — records socketPos positions where the A*
 * search stagnated (trapped in a cavity). On subsequent hover frames,
 * if the socketPos is within STAGNATION_RADIUS_MM of a cached point,
 * the search is skipped entirely, turning cavity hover from ~150
 * A* expansions to a single distance check.
 *
 * Keyed by mesh uuid so it auto-invalidates when the model changes.
 * Entries are cleared when the model matrix changes (SDF refresh),
 * when SDF caches are cleared, or when warm-starts are cleared.
 *
 * IMPORTANT: stagnation entries become stale when the A* search envelope
 * changes (e.g. wider lateral limits, shallower routing angles).  To
 * prevent false-positive cache hits, entries are only trusted when the
 * current maxTotalLateralMm is at or below the envelope width that was
 * in effect when the entry was recorded.  With the wider 200mm envelope
 * active, old 144mm-era entries are silently ignored.
 */
// True-stagnation radius: tightened to 0.5mm (was 1.5mm).  Only positions
// within half a millimeter of a confirmed cavity skip A* — positions 0.5–1.5mm
// away now re-run A* with the current wider search envelope.
const STAGNATION_RADIUS_MM = 0.5;
const STAGNATION_RADIUS_SQ = STAGNATION_RADIUS_MM * STAGNATION_RADIUS_MM;
// Preview-exhausted radius: also tightened to 0.5mm to match stagnation.
const PREVIEW_EXHAUSTED_RADIUS_MM = 0.5;
const PREVIEW_EXHAUSTED_RADIUS_SQ = PREVIEW_EXHAUSTED_RADIUS_MM * PREVIEW_EXHAUSTED_RADIUS_MM;
// If the current search envelope's maxLateralMm exceeds this value, the
// stagnation cache is bypassed entirely — entries recorded with narrower
// historical envelope limits are not trustworthy.
const STAGNATION_CACHE_MAX_TRUSTED_ENVELOPE_MM = 80;
const MAX_STAGNATION_ENTRIES = 512;
const stagnationCache = new Map<string, Vec3[]>();

/**
 * Preview-exhausted cache — records socketPos positions where the A* exhausted
 * its REDUCED preview budget (≠ true stagnation) so that subsequent hover frames
 * at similar positions skip the 600-expansion A* run entirely.
 *
 * Separate from stagnationCache so click-time placement (full 2000-expansion
 * budget) is never affected — only hover preview fast-paths through this cache.
 * Keyed by mesh uuid; cleared alongside stagnationCache.
 */
const previewExhaustedCache = new Map<string, Vec3[]>();

function isNearSpatialPoint(cache: Map<string, Vec3[]>, meshUuid: string, pos: Vec3, radiusSq: number): boolean {
    const points = cache.get(meshUuid);
    if (!points || points.length === 0) return false;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const dx = pos.x - p.x;
        const dy = pos.y - p.y;
        const dz = pos.z - p.z;
        if (dx * dx + dy * dy + dz * dz < radiusSq) return true;
    }
    return false;
}

function recordSpatialPoint(cache: Map<string, Vec3[]>, meshUuid: string, pos: Vec3, radiusSq: number): void {
    let points = cache.get(meshUuid);
    if (!points) {
        points = [];
        cache.set(meshUuid, points);
    }
    if (isNearSpatialPoint(cache, meshUuid, pos, radiusSq)) return;
    if (points.length >= MAX_STAGNATION_ENTRIES) {
        points.splice(0, points.length - MAX_STAGNATION_ENTRIES + 1);
    }
    points.push({ x: pos.x, y: pos.y, z: pos.z });
}

function isNearStagnationPoint(meshUuid: string, pos: Vec3): boolean {
    return isNearSpatialPoint(stagnationCache, meshUuid, pos, STAGNATION_RADIUS_SQ);
}

function recordStagnation(meshUuid: string, pos: Vec3): void {
    recordSpatialPoint(stagnationCache, meshUuid, pos, STAGNATION_RADIUS_SQ);
}

/**
 * Calculates smart placement using grid A* pathfinding.
 *
 * Signature matches calculateSmartPlacement for drop-in replacement.
 * Optionally accepts a context object for SDF/occupancy reuse.
 */
export function calculateSmartPlacementV2(
    input: SmartPlacementV2Input,
    context?: SmartPlacementV2Context,
): TrunkPlacementResult {
    const { mesh, modelId } = input;
    const settings = getSettings();
    const routingAlgorithm = 'potential'; // permanent default
    const shaftRadius = settings.shaft.diameterMm / 2;
    const debugEnabled = getSupportPathfindingDebugEnabled();
    const debugTuningEnabled = getSupportPathfindingDebugTuningEnabled();
    const debugAutoTuneProfile = combineDebugAutoTuneProfiles(
        DEFAULT_PATHFINDING_PROFILE,
        debugTuningEnabled ? EXTRA_DEBUG_TUNE_PROFILE : null,
    );
        const debugConeTuning: ConeAutoTuneProfile | null = debugAutoTuneProfile
            ? {
                stretchRatioScale: debugAutoTuneProfile.coneStretchRatioScale,
                axisAngleBonusDeg: debugAutoTuneProfile.coneAxisAngleBonusDeg,
            }
            : null;
    const collisionAvoidanceMm = COLLISION_AVOIDANCE_MM * (debugAutoTuneProfile?.collisionAvoidanceScale ?? 1);
    const clearance = shaftRadius + collisionAvoidanceMm;
    const maxNearestNodeSearchRings = settings.devToolsEnabled && settings.devTools
        ? settings.devTools.maxNearestNodeSearchRings
        : MAX_NEAREST_NODE_SEARCH_RINGS;
    let debugPasses: GridAStarDebugSnapshot[] = [];
    const debugEvents: SupportPathfindingDebugEvent[] = [];
    let debugOutcome: SupportPathfindingDebugOutcome = {
        status: 'pending',
        reason: 'search in progress',
    };
    const debugBlockedReasons: string[] = [];
    let debugBasePos: Vec3 | undefined;
    let debugFinalChain: Vec3[] | undefined;
    const recordDebugEvent = (eventFactory: () => SupportPathfindingDebugEvent): void => {
        if (!debugEnabled) return;
        const event = eventFactory();
        debugEvents.push(event);
        if (debugEvents.length > 24) {
            debugEvents.splice(0, debugEvents.length - 24);
        }
    };
    const addBlockedReason = (reason: string): void => {
        if (!debugEnabled) return;
        if (!reason) return;
        if (debugBlockedReasons.includes(reason)) return;
        debugBlockedReasons.push(reason);
    };
    const setDebugOutcome = (
        status: SupportPathfindingDebugOutcome['status'],
        reason: string,
        blockedReasons?: string[],
    ): void => {
        if (!debugEnabled) return;
        const resolvedBlockedReasons = status === 'blocked'
            ? (blockedReasons ?? debugBlockedReasons)
            : undefined;
        debugOutcome = {
            status,
            reason,
            blockedReasons: resolvedBlockedReasons && resolvedBlockedReasons.length > 0
                ? [...resolvedBlockedReasons]
                : undefined,
        };
    };
    const rootsRadius = settings.roots.diameterMm / 2;
    const diskHeight = settings.roots.diskHeightMm;
    const coneHeight = settings.roots.coneHeightMm;
    const minRoutedTrunkAngleDeg = settings.grid.minRoutedTrunkAngleDeg;
    // maxSegmentAngleFromVerticalDeg is used for FINAL path validation — it enforces
    // the configured trunk angle on the resolved route.  A* exploration uses a
    // separate, more generous angle so the pathfinder can route around overhangs
    // without being artificially constrained by the same value.
    const maxSegmentAngleFromVerticalDeg = Math.min(
        89,
        (90 - minRoutedTrunkAngleDeg)
            + ROUTED_DETOUR_ANGLE_SLACK_DEG
            + (debugAutoTuneProfile?.maxSegmentAngleBonusDeg ?? 0),
    );
    const minRoutingZSpanMm = MIN_ROUTING_Z_SPAN_MM * (debugAutoTuneProfile?.minRoutingZSpanScale ?? 1);
    // ROUTING_ANGLE_FROM_VERTICAL_DEG: tight A* budget (60°) — the pathfinder
    // should only take small lateral steps to clear local obstructions, not
    // execute wild reach-around routes.  Final trunk angle is validated via
    // maxSegmentAngleFromVerticalDeg after the path is resolved.
    const ROUTING_ANGLE_FROM_VERTICAL_DEG = 60;

    // 1. Standard placement (baseline — no collision check)
    perfMark('trunk:v2-setup');
    const standard = calculateStandardPlacement(input);
    if (standard.error === 'ANGLE_TOO_STEEP') {
        return standard;
    }

    // 2. Get or create SDF cache; refresh matrix so stale cache from a previous
    //    model position does not produce wrong distances.
    const sdf = context?.sdfCache ?? getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();

    // 3. Quick check: is the straight-down path clear AND do the roots fit at the base?
    const rootTopZ = input.rootsTopZ;
    const nominalSocketPos = standard.socketPos;
    let socketPos = nominalSocketPos;
    if (debugEnabled) {
        setSupportPathfindingDebugSnapshot(null);
    }
    const publishPathfindingDebugSnapshot = () => {
        if (!debugEnabled) return;
        const activeConeMetrics = getContactConeRescuePenaltyMetrics({
            socketPos,
            coneScoring: {
                tipPos: input.tipPos,
                tipNormal: input.tipNormal,
                tipProfile: input.tipProfile,
            },
            tuning: debugConeTuning,
        });
        setSupportPathfindingDebugSnapshot(
            {
                modelId,
                socketPos,
                nominalSocketPos,
                rootTopZ,
                clearanceMm: clearance,
                basePos: debugBasePos,
                finalChain: debugFinalChain,
                outcome: debugOutcome,
                cone: {
                    nominalClear: coneClear,
                    activeClear: activeConeClear,
                    activeDiskAngleDeg: activeConeMetrics.angleFromSurfaceNormalDeg,
                    maxDiskAngleDeg: CONTACT_DISK_MAX_CONE_AXIS_ANGLE_DEG,
                    activeConeLengthMm: activeConeMetrics.lengthMm,
                    activeAddedLengthMm: activeConeMetrics.addedLengthMm,
                    stretchLimitExceeded: activeConeMetrics.exceedsStretchLimit,
                    diskAngleLimitExceeded: activeConeMetrics.exceedsDiskAngleLimit,
                },
                envelope: {
                    maxTotalLateralMm,
                    rescueRadiiMm: rescueSweepRadiiMm,
                    rootTopZ,
                    clearanceMm: clearance,
                },
                events: [...debugEvents],
                passes: debugPasses.map((pass) => ({
                    label: pass.label,
                    searchStepMm: pass.searchStepMm,
                    expansions: pass.expansions,
                    reached: pass.reached,
                    stagnated: pass.stagnated,
                    hitExpansionLimit: pass.hitExpansionLimit,
                    expandedNodes: pass.expandedNodes,
                    frontierNodes: pass.frontierNodes,
                    rawPath: pass.rawPath,
                    simplifiedPath: pass.simplifiedPath,
                })),
                updatedAtMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
                // Extended diagnostics
                isPreview,
                routingAngleDeg: ROUTING_ANGLE_FROM_VERTICAL_DEG,
                maxSegmentAngleDeg: maxSegmentAngleFromVerticalDeg,
                stagnationCacheBypassed: maxTotalLateralMm > STAGNATION_CACHE_MAX_TRUSTED_ENVELOPE_MM + 0.5,
                coneSeedMaxRadiusMm: Math.min(coneSeedMaxTotalLateralMm, MIXED_SOCKET_RESCUE_RADII_MM[MIXED_SOCKET_RESCUE_RADII_MM.length - 1]),
                straightPreflightClear: straightClear,
                rootsFitStraightDown: rootsFitStandard,
                fineStepMm: FINE_ASTAR_STEP_MM,
                wideStepMm: WIDE_ASTAR_STEP_MM,
            },
        );
    };
    const isPreview = context?.isPreview ?? false;
    const initialSearchEnvelope = getSmartPlacementV2SearchEnvelope({
        socketPos: nominalSocketPos,
        rootTopZ,
        spacingMm: settings.grid.spacingMm,
    });
    let {
        maxTotalLateralMm,
        rescueSweepRadiiMm,
    } = applyDebugTunedSearchEnvelope(initialSearchEnvelope, debugAutoTuneProfile);
    const nominalMaxTotalLateralMm = maxTotalLateralMm;
    const coneSeedMaxTotalLateralMm = debugAutoTuneProfile
        ? Math.min(MAX_ROUTING_SEARCH_LATERAL_MM, Math.round(nominalMaxTotalLateralMm * debugAutoTuneProfile.coneSeedLateralScale * 2) / 2)
        : nominalMaxTotalLateralMm;
    const rootsDiskBlockedAt = createRootsDiskBlockedMemo({
        sdf,
        diskHeight,
        coneHeight,
        rootsRadius,
        shaftRadius,
    });
    const segmentBlockedBetween = createSegmentBlockedMemo({ sdf, clearance });
    const raycastSegmentBlockedBetween = segmentBlockedBetween;
    // (Previously OR'd with checkShaftCollision as a redundant BVH double-check.
    //  The SDF's adaptive sphere tracing is more accurate than 9 whisker rays.)
    const contactConeBlockedAt = createContactConeBlockedMemo({
        sdf,
        tipPos: input.tipPos,
        tipNormal: input.tipNormal,
        tipProfile: input.tipProfile,
        mesh,
    });

    const coneClear = !contactConeBlockedAt(nominalSocketPos);
    if (debugTuningEnabled) {
        const activeTuningProfile = EXTRA_DEBUG_TUNE_PROFILE;
        recordDebugEvent(() => ({
            stage: 'tuning',
            severity: 'info',
            message: 'Extra debug tuning profile active',
            details: `envelope×${activeTuningProfile.envelopeLateralScale.toFixed(2)} fine×${activeTuningProfile.fineExpansionScale.toFixed(2)} wide×${activeTuningProfile.wideExpansionScale.toFixed(2)} clearance×${activeTuningProfile.collisionAvoidanceScale.toFixed(2)} angle+${activeTuningProfile.maxSegmentAngleBonusDeg.toFixed(0)}deg zSpan×${activeTuningProfile.minRoutingZSpanScale.toFixed(2)}`,
        }));
    }
    recordDebugEvent(() => ({
        stage: 'cone',
        severity: coneClear ? 'success' : 'warning',
        message: coneClear ? 'Nominal contact cone is clear' : 'Nominal contact cone intersects model',
    }));

    let straightRescueCache:
        | { socketPos: Vec3; base: ResolvedBaseCandidate }
        | null
        | undefined;
    let coneClearSocketSeedCache: ContactConeClearSocketSeed | null | undefined;
    const getConeClearSocketSeed = () => {
        if (coneClearSocketSeedCache !== undefined) {
            return coneClearSocketSeedCache;
        }

        coneClearSocketSeedCache = findContactConeClearSocketSeed({
            socketPos: nominalSocketPos,
            maxTotalLateralMm: coneSeedMaxTotalLateralMm,
            coneScoring: {
                tipPos: input.tipPos,
                tipNormal: input.tipNormal,
                tipProfile: input.tipProfile,
            },
            contactConeBlockedAt,
            coneTuning: debugConeTuning,
            sdf,
            clearance,
        });

        return coneClearSocketSeedCache;
    };
    const getStraightSocketRescueFallback = () => {
        if (straightRescueCache !== undefined) {
            return straightRescueCache;
        }

        straightRescueCache = findStraightSocketRescueCandidate({
            socketPos: nominalSocketPos,
            rootTopZ,
            maxTotalLateralMm: nominalMaxTotalLateralMm,
            gridEnabled: settings.grid.enabled,
            spacingMm: settings.grid.spacingMm,
            maxNearestNodeSearchRings: maxNearestNodeSearchRings,
            sdf,
            diskHeight,
            coneHeight,
            rootsRadius,
            shaftRadius,
            clearance,
            coneScoring: {
                tipPos: input.tipPos,
                tipNormal: input.tipNormal,
                tipProfile: input.tipProfile,
            },
            buildNearestCandidateNodeKeys,
            subGridOffset: null,
            rootsDiskBlockedAt,
            segmentBlockedBetween: raycastSegmentBlockedBetween,
            contactConeBlockedAt,
            coneTuning: debugConeTuning,
        });

        return straightRescueCache;
    };
    let mixedSocketRescueCache:
        | { socketPos: Vec3; base: ResolvedBaseCandidate; joints: Vec3[] }
        | null
        | undefined;
    let jointedMixedSocketRescueCache:
        | { socketPos: Vec3; base: ResolvedBaseCandidate; joints: Vec3[] }
        | null
        | undefined;
    const getMixedSocketRescueFallback = () => {
        if (mixedSocketRescueCache !== undefined) {
            return mixedSocketRescueCache;
        }

        mixedSocketRescueCache = findMixedSocketRescueCandidate({
            socketPos: nominalSocketPos,
            rootTopZ,
            maxTotalLateralMm: nominalMaxTotalLateralMm,
            gridEnabled: settings.grid.enabled,
            spacingMm: settings.grid.spacingMm,
            maxNearestNodeSearchRings: maxNearestNodeSearchRings,
            sdf,
            diskHeight,
            coneHeight,
            rootsRadius,
            shaftRadius,
            clearance,
            maxAngleFromVerticalDeg: maxSegmentAngleFromVerticalDeg,
            coneScoring: {
                tipPos: input.tipPos,
                tipNormal: input.tipNormal,
                tipProfile: input.tipProfile,
            },
            buildNearestCandidateNodeKeys,
            subGridOffset: null,
            rootsDiskBlockedAt,
            segmentBlockedBetween: raycastSegmentBlockedBetween,
            contactConeBlockedAt,
            coneTuning: debugConeTuning,
        });

        return mixedSocketRescueCache;
    };
    const getJointedMixedSocketRescueFallback = () => {
        if (jointedMixedSocketRescueCache !== undefined) {
            return jointedMixedSocketRescueCache;
        }

        jointedMixedSocketRescueCache = findMixedSocketRescueCandidate({
            socketPos: nominalSocketPos,
            rootTopZ,
            maxTotalLateralMm: nominalMaxTotalLateralMm,
            gridEnabled: settings.grid.enabled,
            spacingMm: settings.grid.spacingMm,
            maxNearestNodeSearchRings: maxNearestNodeSearchRings,
            sdf,
            diskHeight,
            coneHeight,
            rootsRadius,
            shaftRadius,
            clearance,
            maxAngleFromVerticalDeg: maxSegmentAngleFromVerticalDeg,
            coneScoring: {
                tipPos: input.tipPos,
                tipNormal: input.tipNormal,
                tipProfile: input.tipProfile,
            },
            buildNearestCandidateNodeKeys,
            subGridOffset: null,
            rootsDiskBlockedAt,
            segmentBlockedBetween: raycastSegmentBlockedBetween,
            contactConeBlockedAt,
            requireJoint: true,
            coneTuning: debugConeTuning,
        });

        return jointedMixedSocketRescueCache;
    };
    const buildStraightRescueFallback = (): TrunkPlacementResult | null => {
        const mixedSocketRescue = getMixedSocketRescueFallback();
        if (mixedSocketRescue) {
            setDebugOutcome('fallback', 'mixed socket rescue');
            if (debugEnabled) {
                debugBasePos = mixedSocketRescue.base.basePos;
                debugFinalChain = [
                    mixedSocketRescue.socketPos,
                    ...mixedSocketRescue.joints,
                    mixedSocketRescue.base.rootTopTarget,
                ];
            }
            recordDebugEvent(() => ({
                stage: 'fallback',
                severity: 'success',
                message: `Mixed rescue accepted (${mixedSocketRescue.joints.length} joint${mixedSocketRescue.joints.length === 1 ? '' : 's'})`,
                details: `base=(${mixedSocketRescue.base.basePos.x.toFixed(2)}, ${mixedSocketRescue.base.basePos.y.toFixed(2)})`,
            }));
            if (!isPreview) {
                console.log(
                    `[SmartPlacementV2] MIXED socket rescue fallback — socket=(${mixedSocketRescue.socketPos.x.toFixed(2)},${mixedSocketRescue.socketPos.y.toFixed(2)},${mixedSocketRescue.socketPos.z.toFixed(2)}) joints=[${mixedSocketRescue.joints.map((joint) => `(${joint.x.toFixed(2)},${joint.y.toFixed(2)},${joint.z.toFixed(2)})`).join(' ')}] base=(${mixedSocketRescue.base.basePos.x.toFixed(2)},${mixedSocketRescue.base.basePos.y.toFixed(2)},${mixedSocketRescue.base.basePos.z.toFixed(2)})`,
                );
            }

            publishPathfindingDebugSnapshot();
            return {
                ...standard,
                socketPos: mixedSocketRescue.socketPos,
                basePos: mixedSocketRescue.base.basePos,
                unsnappedBottomPos: mixedSocketRescue.base.basePos,
                snappedNodeKey: mixedSocketRescue.base.nodeKey,
                joints: mixedSocketRescue.joints,
                constructionJoints: [],
                error: undefined,
            };
        }

        const straightRescue = getStraightSocketRescueFallback();
        if (!straightRescue) return null;
        setDebugOutcome('fallback', 'straight socket rescue');
        if (debugEnabled) {
            debugBasePos = straightRescue.base.basePos;
            debugFinalChain = [
                straightRescue.socketPos,
                straightRescue.base.rootTopTarget,
            ];
        }
        recordDebugEvent(() => ({
            stage: 'fallback',
            severity: 'success',
            message: 'Straight rescue accepted',
            details: `socket shift=${distanceXY(straightRescue.socketPos, nominalSocketPos).toFixed(2)}mm`,
        }));
        if (!isPreview) {
            console.log(
                `[SmartPlacementV2] STRAIGHT rescue fallback — socket=(${straightRescue.socketPos.x.toFixed(2)},${straightRescue.socketPos.y.toFixed(2)},${straightRescue.socketPos.z.toFixed(2)}) base=(${straightRescue.base.basePos.x.toFixed(2)},${straightRescue.base.basePos.y.toFixed(2)},${straightRescue.base.basePos.z.toFixed(2)})`,
            );
        }
        publishPathfindingDebugSnapshot();
        return {
            ...standard,
            socketPos: straightRescue.socketPos,
            basePos: straightRescue.base.basePos,
            unsnappedBottomPos: { x: straightRescue.socketPos.x, y: straightRescue.socketPos.y, z: 0 },
            snappedNodeKey: straightRescue.base.nodeKey,
            joints: [],
            constructionJoints: [],
            error: undefined,
        };
    };

    let activeConeClear = coneClear;
    perfMeasureWithSpike('trunk:v2-setup', 'trunk:v2-setup');
    if (!coneClear) {
        perfMark('trunk:cone-rescue');
        const skipDiscreteRescues = true; // potential field handles routing — no discrete rescue needed
        perfMark('trunk:cone-rescue:jointed');
        const mixedSocketRescue = skipDiscreteRescues ? null : getJointedMixedSocketRescueFallback();
        perfMeasureWithSpike('trunk:cone-rescue:jointed', 'trunk:cone-rescue:jointed');
        if (mixedSocketRescue) {
            setDebugOutcome('fallback', 'cone-blocked jointed rescue');
            if (debugEnabled) {
                debugBasePos = mixedSocketRescue.base.basePos;
                debugFinalChain = [
                    mixedSocketRescue.socketPos,
                    ...mixedSocketRescue.joints,
                    mixedSocketRescue.base.rootTopTarget,
                ];
            }
            recordDebugEvent(() => ({
                stage: 'cone',
                severity: 'success',
                message: 'Cone-blocked placement rescued with a shaft bend',
                details: `joints=${mixedSocketRescue.joints.length}`,
            }));
            if (!isPreview) {
                console.log(
                    `[SmartPlacementV2] cone-blocked mixed rescue — socket=(${mixedSocketRescue.socketPos.x.toFixed(2)},${mixedSocketRescue.socketPos.y.toFixed(2)},${mixedSocketRescue.socketPos.z.toFixed(2)}) joints=[${mixedSocketRescue.joints.map((joint) => `(${joint.x.toFixed(2)},${joint.y.toFixed(2)},${joint.z.toFixed(2)})`).join(' ')}] base=(${mixedSocketRescue.base.basePos.x.toFixed(2)},${mixedSocketRescue.base.basePos.y.toFixed(2)},${mixedSocketRescue.base.basePos.z.toFixed(2)})`,
                );
            }
            publishPathfindingDebugSnapshot();
            return {
                ...standard,
                socketPos: mixedSocketRescue.socketPos,
                basePos: mixedSocketRescue.base.basePos,
                unsnappedBottomPos: mixedSocketRescue.base.basePos,
                snappedNodeKey: mixedSocketRescue.base.nodeKey,
                joints: mixedSocketRescue.joints,
                constructionJoints: [],
                error: undefined,
            };
        }

        perfMark('trunk:cone-rescue:seed');
        const coneClearSeed = getConeClearSocketSeed();
        perfMeasureWithSpike('trunk:cone-rescue:seed', 'trunk:cone-rescue:seed');
        const rescuedSocketPos = coneClearSeed?.socketPos ?? null;

        if (rescuedSocketPos) {
            socketPos = rescuedSocketPos;
            activeConeClear = true;
            recordDebugEvent(() => ({
                stage: 'cone',
                severity: 'warning',
                message: 'Used cone-clear socket seed',
                details: `shift=${coneClearSeed?.socketShiftMm.toFixed(2) ?? '0.00'}mm added cone=${coneClearSeed?.addedLengthMm.toFixed(2) ?? '0.00'}mm`,
            }));
            const rescuedEnvelope = getSmartPlacementV2SearchEnvelope({
                socketPos,
                rootTopZ,
                spacingMm: settings.grid.spacingMm,
            });
            ({ maxTotalLateralMm, rescueSweepRadiiMm } = applyDebugTunedSearchEnvelope(rescuedEnvelope, debugAutoTuneProfile));
            if (!isPreview) {
                console.log(
                    `[SmartPlacementV2] cone-clear seed — nominal=(${nominalSocketPos.x.toFixed(2)},${nominalSocketPos.y.toFixed(2)},${nominalSocketPos.z.toFixed(2)}) seed=(${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)}) addedLength=${coneClearSeed?.addedLengthMm.toFixed(2) ?? '0.00'} shift=${coneClearSeed?.socketShiftMm.toFixed(2) ?? '0.00'}`,
                );
            }
        } else {
            // No cone-clear socket seed found and no jointed rescue available.
            // DO NOT fail immediately in preview mode — the A* pathfinder may
            // still find a route where the shaft bends away from the blocked cone
            // region.  Only fail if A* also can't find a path (caught below).
            // Click-time placement still tries the expensive straight/mixed
            // rescue fallbacks since it has the full expansion budget.
            if (!isPreview && !skipDiscreteRescues) {
                const straightRescueFallback = buildStraightRescueFallback();
                if (straightRescueFallback) {
                    return straightRescueFallback;
                }
            }
            // Fall through: let potential field handle routing with the blocked cone socket.
            // The cone-blocked flag is recorded but doesn't prevent A* from trying.
            addBlockedReason('Contact cone blocked at nominal socket position');
            addBlockedReason('Cone-clear socket seed search failed');
            if (!isPreview) {
                addBlockedReason('Socket rescue fallback failed');
            }
            recordDebugEvent(() => ({
                stage: 'cone',
                severity: 'warning',
                message: isPreview
                    ? 'Cone blocked in preview — deferring to A* routing'
                    : 'Cone blocked and all socket rescues failed — deferring to A*',
            }));
        }
    }
    perfMeasureWithSpike('trunk:cone-rescue', 'trunk:cone-rescue');

    // Preflight check results — declared early so the debug snapshot closure
    // can capture them.  Initialised to false; overwritten before A* runs.
    let straightClear = false;
    let rootsFitStandard = false;
    // early-outs, so preview no longer needs the old coarse approximations —
    // the accurate versions are fast in open space and equally accurate.
    perfMark('trunk:preflight');
    straightClear = !raycastSegmentBlockedBetween(socketPos, { x: socketPos.x, y: socketPos.y, z: rootTopZ });
    const baseXY: Vec3 = { x: socketPos.x, y: socketPos.y, z: 0 };
    rootsFitStandard = !rootsDiskBlockedAt(baseXY.x, baseXY.y);
    perfMeasureWithSpike('trunk:preflight', 'trunk:preflight');

    if (!isPreview) {
        console.log(`[SmartPlacementV2] called — nominalSocket=(${nominalSocketPos.x.toFixed(2)},${nominalSocketPos.y.toFixed(2)},${nominalSocketPos.z.toFixed(2)}) activeSocket=(${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)}) rootTopZ=${rootTopZ.toFixed(2)} nominalConeClear=${coneClear} activeConeClear=${activeConeClear} straightClear=${straightClear} rootsFit=${rootsFitStandard}`);
    }
    recordDebugEvent(() => ({
        stage: 'preflight',
        severity: straightClear && rootsFitStandard ? 'success' : 'info',
        message: `straight=${straightClear ? 'clear' : 'blocked'} roots=${rootsFitStandard ? 'fit' : 'blocked'}`,
        details: `active socket=(${socketPos.x.toFixed(2)}, ${socketPos.y.toFixed(2)}, ${socketPos.z.toFixed(2)})`,
    }));

    if (activeConeClear && straightClear && rootsFitStandard) {
        if (!isPreview) console.log(`[SmartPlacementV2] STRAIGHT path — no routing needed`);
        setDebugOutcome('straight', 'straight path clear');
        if (debugEnabled) {
            debugBasePos = baseXY;
            debugFinalChain = [socketPos, { x: socketPos.x, y: socketPos.y, z: rootTopZ }];
        }
        recordDebugEvent(() => ({
            stage: 'result',
            severity: 'success',
            message: 'Placed straight support',
        }));
        publishPathfindingDebugSnapshot();
        return {
            ...standard,
            socketPos,
            basePos: baseXY,
            unsnappedBottomPos: baseXY,
            snappedNodeKey: null,
            joints: [],
            constructionJoints: [],
            error: undefined,
        }; // Cone, shaft, and roots are all clear — no routing needed
    }

    // 3b. Quick SDF pre-check for preview mode: if the socket is deep inside
    //     the model (SDF distance < -1.5mm), skip the expensive A* search.
    //     This catches interior positions where the cone-clear seed search
    //     already failed and A* is very unlikely to escape the cavity within
    //     the preview budget.  Single SDF query vs ~15k for a full A* run.
    perfMark('trunk:pre-a-star');
    if (isPreview && sdf.distanceAt(socketPos.x, socketPos.y, socketPos.z) < -1.5) {
        perfMeasureWithSpike('trunk:pre-a-star', 'trunk:pre-a-star');
        addBlockedReason('Socket deep inside model — preview fast-fail');
        setDebugOutcome('blocked', 'socket deep inside model');
        recordDebugEvent(() => ({
            stage: 'preflight',
            severity: 'info',
            message: 'Preview: socket deep inside model, skipping A*',
        }));
        publishPathfindingDebugSnapshot();
        return { ...standard, error: 'COLLISION_WITH_MODEL', stagnated: true };
    }

    // 3c. Spatial caches: skip A* if a previous search from a nearby socketPos
    //     already stagnated (cavity) or exhausted the preview budget.
    //     This turns repeated probes at similar positions from ~600 A* expansions
    //     to a single distance check — the primary performance win for interior hovers.
    //
    //     IMPORTANT: only trust the stagnation cache when the current search
    //     envelope width is within the range where old entries are valid.
    //     When maxTotalLateralMm > STAGNATION_CACHE_MAX_TRUSTED_ENVELOPE_MM
    //     (e.g. our new 200mm envelope), existing cache entries were recorded
    //     with a narrower search and may be stale — bypass the cache entirely.
    if (maxTotalLateralMm <= STAGNATION_CACHE_MAX_TRUSTED_ENVELOPE_MM + 0.5
        && isNearStagnationPoint(mesh.uuid, socketPos)) {
        perfMeasureWithSpike('trunk:pre-a-star', 'trunk:pre-a-star');
        addBlockedReason('Nearby stagnation cache hit');
        setDebugOutcome('blocked', 'nearby stagnation cache');
        publishPathfindingDebugSnapshot();
        return { ...standard, error: 'COLLISION_WITH_MODEL', stagnated: true };
    }
    // Preview-exhausted fast-fail: if this is a preview call and a nearby position
    // already exhausted the reduced budget, skip A* for this frame too.
    // Uses a tighter radius (PREVIEW_EXHAUSTED_RADIUS_SQ = 0.5mm) so we only
    // skip positions essentially identical to a previous exhausted query.
    if (context?.isPreview && isNearSpatialPoint(previewExhaustedCache, mesh.uuid, socketPos, PREVIEW_EXHAUSTED_RADIUS_SQ)) {
        perfMeasureWithSpike('trunk:pre-a-star', 'trunk:pre-a-star');
        addBlockedReason('Nearby preview query already exhausted expansion budget');
        setDebugOutcome('blocked', 'nearby preview budget exhausted');
        publishPathfindingDebugSnapshot();
        return { ...standard, error: 'COLLISION_WITH_MODEL', exhaustedBudget: true };
    }

    // 3c. (Removed) — The vertical solvability pre-check was a false optimisation.
    //     On overhang geometry the entire model body is directly below the socket,
    //     so all straight-down spine samples are inside the mesh (deeply negative SDF)
    //     AND the narrow (3–9mm) lateral probes can also be blocked by the wide
    //     overhang, causing instant stagnation before A* even runs. V1 had no such
    //     pre-check — it always passed the position to the search. True cavities are
    //     correctly detected by A*'s own STAGNATION_LIMIT (250 expansions with no Z
    //     progress) and cached in the stagnationCache afterwards.

    // 4. Run grid A* from socket down to rootTopZ.
    //    The goalValidator integrates roots collision into the search:
    //    when A* reaches a cell at rootTopZ, it checks that the full roots
    //    volume below that XY is clear. If not, the search continues laterally
    //    to find a valid position — proper 3D pathfinding for the whole support.
    // Preview runs borrow from the full warm-start map when their own map is cold,
    // giving 600-expansion preview A* a good starting frontier without polluting
    // the full map with endpoint-only states. Parity re-runs pass warmStart:null
    // explicitly via context so they always start clean.
    perfMeasureWithSpike('trunk:pre-a-star', 'trunk:pre-a-star');
    const warmStart = context?.warmStart !== undefined
        ? context.warmStart
        : isPreview
            ? (previewWarmStartByModel.get(modelId) ?? warmStartByModel.get(modelId) ?? null)
            : (warmStartByModel.get(modelId) ?? null);

    // Full-resolution roots validation for both preview and click-time —
    // the SDF bounding-ball early-out makes open slices effectively free.
    const goalValidator = (wx: number, wy: number, wz: number, parentPos: Vec3 | null) => {
        if (!settings.grid.enabled) {
            return !rootsDiskBlockedAt(wx, wy);
        }

        return resolveCommittedBaseCandidate({
            preferredBottomPos: { x: wx, y: wy, z: 0 },
            lastSegmentStart: parentPos,
            rootTopZ,
            gridEnabled: true,
            spacingMm: settings.grid.spacingMm,
            maxNearestNodeSearchRings: maxNearestNodeSearchRings,
            sdf,
            diskHeight,
            coneHeight,
            rootsRadius,
            shaftRadius,
            clearance,
            buildNearestCandidateNodeKeys,
            rootsDiskBlockedAt,
            segmentBlockedBetween,
        }) != null;
    };

    let result;
    const fieldDeterministic = routingAlgorithm === 'potential'; // always true

    if (fieldDeterministic) {
        const detResult = solveDeterministicFieldPath(sdf, socketPos, rootTopZ, {
            clearanceMm: clearance,
            marginMm: settings.devTools.marginMm,
            stepMm: settings.devTools.stepMm,
            maxLateralMm: settings.devTools.maxLateralMm,
        });
        result = {
            path: detResult.path,
            expansions: detResult.iterations,
            reached: detResult.reached,
            stagnated: detResult.stagnated,
            hitExpansionLimit: false,
            warmState: null,
            debug: undefined,
        };
    } else if (routingAlgorithm === 'potential') {
        const pfTuning = getSupportPathfindingDebugTuningEnabled() ? getPotentialFieldTuning() : null;
        const clearanceMm = clearance;
        const maxLateralMm = settings.devToolsEnabled && settings.devTools
            ? settings.devTools.maxLateralMm
            : (pfTuning ? pfTuning.maxLateralMm : maxTotalLateralMm);
        const marginMm = settings.devToolsEnabled && settings.devTools
            ? settings.devTools.marginMm
            : (pfTuning ? pfTuning.marginMm : undefined);
        const repulsionStrength = settings.devToolsEnabled && settings.devTools
            ? settings.devTools.repulsionStrength
            : (pfTuning ? pfTuning.repulsionStrength : undefined);
        const stepMm = settings.devToolsEnabled && settings.devTools
            ? settings.devTools.stepMm
            : (pfTuning ? pfTuning.stepMm : 1.0);
        const tangentWeight = settings.devToolsEnabled && settings.devTools
            ? settings.devTools.tangentWeight
            : (pfTuning ? pfTuning.tangentWeight : undefined);

        const pfResult = solvePotentialField(sdf, socketPos, rootTopZ, {
            clearanceMm,
            maxLateralMm,
            marginMm,
            repulsionStrength,
            stepMm,
            tangentWeight,
            simplify: true,
        });
        result = {
            path: pfResult.path,
            expansions: pfResult.iterations,
            reached: pfResult.reached,
            stagnated: pfResult.stagnated,
            hitExpansionLimit: !pfResult.reached && !pfResult.stagnated,
            warmState: null,
            debug: undefined,
        };
    } else {
        perfMark('astar:fine');
        result = gridAStar(sdf, socketPos, rootTopZ, {
            clearanceMm: clearance,
            shaftRadius: shaftRadius,
            maxLateralMm: maxTotalLateralMm,
            minAngleFromVerticalDeg: ROUTING_ANGLE_FROM_VERTICAL_DEG,
            occupancy: context?.occupancy,
            ignoreSupportId: context?.placingSupportId,
            maxExpansions: scaleExpansionsForStep(
                Math.round((context?.maxExpansions ?? 2000) * (debugAutoTuneProfile?.fineExpansionScale ?? 1)),
                FINE_ASTAR_STEP_MM,
            ),
            stepMm: FINE_ASTAR_STEP_MM,
            goalValidator,
            // For hover preview, use endpoint-only SDF checks in the A* neighbor loop.
            // The default segmentBlocked samples at 0.5mm intervals on a 2mm grid — all
            // intermediate sub-grid points are permanent cold BVH cache misses, causing
            // ~30k–60k uncacheable BVH queries per hover frame on interior surfaces.
            // Endpoint-only checks hit grid-aligned cells that ARE cached after first
            // visit, dropping first-frame cold cost from ~30k to ~600 BVH calls.
            endpointOnlyCollisionCheck: true,
            debugLabel: 'fine',
            captureDebug: debugEnabled,
        }, warmStart);
        perfMeasureWithSpike('astar:fine', 'trunk:astar');
    }
    if (debugEnabled && result.debug) {
        debugPasses = [result.debug];
    }
    recordDebugEvent(() => ({
        stage: 'astar:fine',
        severity: result.reached ? 'success' : result.stagnated || result.hitExpansionLimit ? 'warning' : 'info',
        message: result.reached
            ? `Fine A* reached in ${result.expansions} expansions`
            : `Fine A* failed after ${result.expansions} expansions`,
        details: result.stagnated ? 'stagnated' : result.hitExpansionLimit ? 'hit expansion limit' : undefined,
    }));

    // ---------- Wide-step fallback (V1 parity for large-detour overhangs) ----------
    //
    // V1 (SmartPlacement) used macro-jump candidates at radii 2–40mm × 16 directions,
    // letting it traverse a 40mm lateral detour in a SINGLE expansion. V2's 2mm grid
    // needs ~20 steps for the same distance, exhausting its 2000-expansion budget on
    // complex overhangs before finding the clear corridor.
    //
    // When the fine-step search fails (exhausted budget, stagnated, or simply hit
    // a pathfinding ceiling), retry with a coarser 0.6mm grid and a budget that
    // scales with the current lateral envelope. This rescue pass explores much
    // farther per unit of work than the 0.25mm fine pass while still keeping the
    // base position tight and validating every edge against the SDF.
    // Only retry if we didn't already reach a goal — don't double-process successes.
    // Wide-step fallback — uses endpoint-only checks and reduced budget for speed.
    if (!result.reached && routingAlgorithm !== 'potential') {
        perfMark('astar:wide');
        const wideResult = gridAStar(sdf, socketPos, rootTopZ, {
            clearanceMm: clearance,
            shaftRadius: shaftRadius,
            maxLateralMm: maxTotalLateralMm,
            minAngleFromVerticalDeg: ROUTING_ANGLE_FROM_VERTICAL_DEG,
            occupancy: context?.occupancy,
            ignoreSupportId: context?.placingSupportId,
            // Preview should remain responsive; use a smaller wide-step budget.
            maxExpansions: scaleExpansionsForStep(
                Math.round(getWidePassBaseExpansionsAt2mm(maxTotalLateralMm, isPreview) * (debugAutoTuneProfile?.wideExpansionScale ?? 1)),
                WIDE_ASTAR_STEP_MM,
            ),
            stepMm: WIDE_ASTAR_STEP_MM,
            goalValidator,
            endpointOnlyCollisionCheck: true,
            debugLabel: 'wide',
            captureDebug: debugEnabled,
        }, null); // always cold-start wide search (different grid quantisation)
        perfMeasureWithSpike('astar:wide', 'trunk:astar:wide');
        if (debugEnabled && wideResult.debug) {
            debugPasses = [...debugPasses, wideResult.debug];
        }
        recordDebugEvent(() => ({
            stage: 'astar:wide',
            severity: wideResult.reached ? 'success' : wideResult.stagnated || wideResult.hitExpansionLimit ? 'warning' : 'info',
            message: wideResult.reached
                ? `Wide A* reached in ${wideResult.expansions} expansions`
                : `Wide A* failed after ${wideResult.expansions} expansions`,
            details: wideResult.stagnated ? 'stagnated' : wideResult.hitExpansionLimit ? 'hit expansion limit' : undefined,
        }));
        if (wideResult.reached) {
            // Wide-step succeeded — use its result. Don't write to warm-start maps
            // since the 0.6mm grid state is incompatible with the normal 0.25mm warm-start.
            const widePathJoints = wideResult.path.slice(1, -1);
            const widePathEnd = wideResult.path[wideResult.path.length - 1];
            // Grid-snap the base and validate angle using the routing angle (looser than final)
            const _wpc = new Map<string, string[]>();
            const _bncCached = (pk: string, mr: number) => {
                const k2 = `${pk}|${mr}`;
                const cv = _wpc.get(k2);
                if (cv) return cv;
                const c2 = buildNearestCandidateNodeKeys(pk, mr);
                _wpc.set(k2, c2);
                return c2;
            };
            const _ge = settings.grid.enabled;
            const _sp = settings.grid.spacingMm;
            const _ubp: Vec3 = { x: widePathEnd.x, y: widePathEnd.y, z: 0 };
            const _wideSubGridOffset = !_ge ? {
                x: input.tipPos.x - Math.round(input.tipPos.x / WIDE_ASTAR_STEP_MM) * WIDE_ASTAR_STEP_MM,
                y: input.tipPos.y - Math.round(input.tipPos.y / WIDE_ASTAR_STEP_MM) * WIDE_ASTAR_STEP_MM,
            } : null;

            if (!_ge && _wideSubGridOffset) {
                for (const j of widePathJoints) {
                    j.x += _wideSubGridOffset.x;
                    j.y += _wideSubGridOffset.y;
                }
            }

            let _best = resolveCommittedBaseCandidate({
                preferredBottomPos: _ubp,
                lastSegmentStart: widePathJoints.length > 0 ? widePathJoints[widePathJoints.length - 1] : widePathEnd,
                rootTopZ,
                gridEnabled: _ge,
                spacingMm: _sp,
                maxNearestNodeSearchRings: maxNearestNodeSearchRings,
                sdf,
                diskHeight,
                coneHeight,
                rootsRadius,
                shaftRadius,
                clearance,
                buildNearestCandidateNodeKeys: _bncCached,
                subGridOffset: _wideSubGridOffset,
                rootsDiskBlockedAt,
                segmentBlockedBetween,
            });
            if (!_best) {
                _best = {
                    basePos: { x: _ubp.x, y: _ubp.y, z: 0 },
                    rootTopTarget: { x: _ubp.x, y: _ubp.y, z: rootTopZ },
                    snapDistance: 0,
                    nodeKey: null,
                };
            }
            const _resolvedWideBase = _best as ResolvedBaseCandidate;
            // Z-monotonicity filter (wide A* also allows limited upward moves)
            const _rawJoints = widePathJoints.map((j: Vec3) => ({ x: j.x, y: j.y, z: j.z }));
            const _zJoints: Vec3[] = [];
            let _prevZ = socketPos.z;
            for (const _wj of _rawJoints) {
                if (_wj.z < _prevZ) { _zJoints.push(_wj); _prevZ = _wj.z; }
            }

            const _wideRootTop: Vec3 = { x: _resolvedWideBase.basePos.x, y: _resolvedWideBase.basePos.y, z: rootTopZ };
            const _warning = standard.warning;

            if (contactConeBlockedAt(socketPos)) {
                const straightRescueFallback = buildStraightRescueFallback();
                if (straightRescueFallback) {
                    return straightRescueFallback;
                }
                addBlockedReason('Contact cone blocked after wide-pass route resolution');
                addBlockedReason('Socket rescue fallback failed');
                setDebugOutcome('blocked', 'contact cone blocked after wide pass');
                publishPathfindingDebugSnapshot();
                return {
                    ...standard,
                    error: 'COLLISION_WITH_MODEL',
                };
            }

            // Preview fast-path: skip expensive simplification/straightening passes.
            // Click-time placement still runs the full quality pipeline.
            if (isPreview) {
                publishPathfindingDebugSnapshot();
                return {
                    ...standard,
                    joints: _zJoints,
                    basePos: _resolvedWideBase.basePos,
                    unsnappedBottomPos: _ubp,
                    snappedNodeKey: _resolvedWideBase.nodeKey ?? null,
                    warning: _warning,
                    error: undefined,
                };
            }

            // Run the same simplification pipeline as the fine-step path.
            // simplifyJointsSDF collapses unnecessary bends; the zero-joint sweep
            // then checks if a completely straight line is possible.
            const _simplifiedJoints = simplifyJointsSDF(
                _zJoints,
                socketPos,
                _wideRootTop,
                sdf,
                clearance,
                maxSegmentAngleFromVerticalDeg,
                segmentBlockedBetween,
            );

            // Zero-joint sweep: try a straight line to the current base, below
            // the socket, and at small radial offsets.
            let _finalJoints = _simplifiedJoints;
            let _finalBase: ResolvedBaseCandidate = _resolvedWideBase;
            let _finalRootTop = _wideRootTop;
            let _oneJointStats: string | null = null;
            const _currentChainIsBetterThan = (candidateJoints: Vec3[], candidateRootTop: Vec3) => {
                const candidateMetrics = getResolvedChainMetrics(socketPos, candidateJoints, candidateRootTop);
                const currentMetrics = getResolvedChainMetrics(socketPos, _finalJoints, _finalRootTop);
                return isResolvedChainReplacementBetter(candidateMetrics, currentMetrics);
            };

            if (ENABLE_AGGRESSIVE_POST_PATH_STRAIGHTENING && _finalJoints.length > 0) {
                // Zero-joint sweep: try straight lines from socket to candidate bases,
                // expanding outward ring-by-ring with early termination once no ring
                // can improve the best distance found so far.
                const _distSA = distanceXY(socketPos, _resolvedWideBase.basePos);

                const _tryZeroCandidate = (sc: { x: number; y: number }): boolean => {
                    const _crt: Vec3 = { x: sc.x, y: sc.y, z: rootTopZ };
                    if (!segmentSatisfiesMaxAngleFromVertical(socketPos, _crt, ROUTING_ANGLE_FROM_VERTICAL_DEG)) return false;
                    if (rootsDiskBlockedAt(sc.x, sc.y)) return false;
                    if (segmentBlockedBetween(socketPos, _crt)) return false;
                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, _crt, maxSegmentAngleFromVerticalDeg)) return false;
                    if (!_currentChainIsBetterThan([], _crt)) return false;
                    const _dxy0 = distanceXY(socketPos, _crt);
                    if (_dxy0 < _bestZeroDxy) {
                        _bestZeroDxy = _dxy0;
                        _finalJoints = [];
                        _finalBase = {
                            basePos: { x: sc.x, y: sc.y, z: 0 },
                            rootTopTarget: _crt,
                            snapDistance: 0,
                            nodeKey: null,
                        };
                        _finalRootTop = _crt;
                    }
                    return true;
                };

                let _bestZeroDxy = Infinity;

                // Try seed candidates first (socket XY = dist 0, A* base).
                _tryZeroCandidate({ x: socketPos.x, y: socketPos.y });
                _tryZeroCandidate({ x: _resolvedWideBase.basePos.x, y: _resolvedWideBase.basePos.y });

                // Expand rings outward; terminate when no candidate in this ring
                // or any larger ring can beat the current best.
                for (const _r of rescueSweepRadiiMm) {
                    if (_r > maxTotalLateralMm) break;
                    // Socket-centered candidates at this ring have distance _r from socket.
                    // A*-base-centered candidates have minimum distance max(0, _distSA - _r).
                    const _minPossible = Math.min(_r, Math.max(0, _distSA - _r));
                    if (_minPossible >= _bestZeroDxy) break;
                    for (let _d = 0; _d < 16; _d++) {
                        const _a = (_d / 16) * Math.PI * 2;
                        _tryZeroCandidate({ x: socketPos.x + Math.cos(_a) * _r, y: socketPos.y + Math.sin(_a) * _r });
                        _tryZeroCandidate({ x: _resolvedWideBase.basePos.x + Math.cos(_a) * _r, y: _resolvedWideBase.basePos.y + Math.sin(_a) * _r });
                    }
                }

                // ---------- One-joint minimization fallback ----------
                // Run when: (a) zero-joint sweep failed and we still have 2+ joints, OR
                // (b) zero-joint sweep found a path but the base is laterally far from
                // the socket — a one-joint path with a closer base may be better.
                const _zeroLateral = distanceXY(socketPos, { x: _finalBase.basePos.x, y: _finalBase.basePos.y, z: socketPos.z });
                const _needOneJointSearch = _finalJoints.length >= 2 || (_finalJoints.length === 0 && _zeroLateral > 1.5);
                if (!isPreview && _needOneJointSearch) {
                    const _baseCandidates: Array<{ x: number; y: number }> = [];
                    _baseCandidates.push({ x: _finalBase.basePos.x, y: _finalBase.basePos.y });
                    _baseCandidates.push({ x: socketPos.x, y: socketPos.y });
                    for (const _j of _finalJoints) _baseCandidates.push({ x: _j.x, y: _j.y });

                    // Radial base sweep around current base and socket.
                    const _baseRadii = [0.5, 1, 1.5, 2, 3, 4, 6];
                    for (const _r of _baseRadii) {
                        for (let _d = 0; _d < 12; _d++) {
                            const _a = (_d / 12) * Math.PI * 2;
                            _baseCandidates.push({
                                x: _finalBase.basePos.x + Math.cos(_a) * _r,
                                y: _finalBase.basePos.y + Math.sin(_a) * _r,
                            });
                            _baseCandidates.push({
                                x: socketPos.x + Math.cos(_a) * _r,
                                y: socketPos.y + Math.sin(_a) * _r,
                            });
                        }
                    }

                    const _jointCandidates: Vec3[] = [];
                    for (const _j of _finalJoints) _jointCandidates.push(_j);

                    // Synthesize candidate bends across Z and around the interpolated centerline.
                    const _jointRadii = [0, 0.6, 1.2];
                    const _zStep = 2.0;
                    for (let _zz = socketPos.z - _zStep; _zz > rootTopZ + _zStep; _zz -= _zStep) {
                        const _t = (socketPos.z - _zz) / (socketPos.z - rootTopZ);
                        const _cx = socketPos.x + (_finalBase.basePos.x - socketPos.x) * _t;
                        const _cy = socketPos.y + (_finalBase.basePos.y - socketPos.y) * _t;
                        for (const _jr of _jointRadii) {
                            if (_jr === 0) {
                                _jointCandidates.push({ x: _cx, y: _cy, z: _zz });
                                continue;
                            }
                            for (let _d = 0; _d < 12; _d++) {
                                const _a = (_d / 12) * Math.PI * 2;
                                _jointCandidates.push({
                                    x: _cx + Math.cos(_a) * _jr,
                                    y: _cy + Math.sin(_a) * _jr,
                                    z: _zz,
                                });
                            }
                        }
                    }

                    let _bestOneJoint:
                        | { joint: Vec3; baseXY: { x: number; y: number }; score: number }
                        | null = null;

                    // Stats for debug visibility.
                    let _testedPairs = 0;
                    let _skipRoots = 0;
                    let _skipSeg1 = 0;
                    let _skipSeg2 = 0;
                    let _skipAngle = 0;
                    const _oneJointMinFirstDropMm = 4.0;
                    const _oneJointEarlyBendPenaltyPerMm = 12.0;

                    const _rootsFitCache = new Map<string, boolean>();
                    const _rootsFitAt = (x: number, y: number): boolean => {
                        const _k = `${x.toFixed(3)},${y.toFixed(3)}`;
                        const _c = _rootsFitCache.get(_k);
                        if (_c !== undefined) return _c;
                        const _ok = !rootsDiskBlockedAt(x, y);
                        _rootsFitCache.set(_k, _ok);
                        return _ok;
                    };

                    // Pre-filter bases upfront: rootsFitAt is cached so no extra SDF cost,
                    // but building this list avoids re-evaluating it in the inner loop.
                    const _validBases: Array<{ x: number; y: number; crt: Vec3 }> = [];
                    for (const _bxy of _baseCandidates) {
                        if (!_rootsFitAt(_bxy.x, _bxy.y)) { _skipRoots++; continue; }
                        _validBases.push({ x: _bxy.x, y: _bxy.y, crt: { x: _bxy.x, y: _bxy.y, z: rootTopZ } });
                    }

                    // Outer loop: joints. Check seg1 (socket→joint) ONCE per joint instead of
                    // once per base×joint — it's base-independent, so inverting the loops
                    // reduces seg1 SDF calls by a factor of ~|_validBases| (~170×).
                    for (const _j of _jointCandidates) {
                        // Joint must remain strictly between socket and rootTop in Z.
                        if (_j.z >= socketPos.z - 0.001 || _j.z <= rootTopZ + 0.001) { _skipAngle++; continue; }

                        // Cheap angle gate before expensive SDF (seg1).
                        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, _j, maxSegmentAngleFromVerticalDeg)) { _skipAngle++; continue; }

                        // socket → joint: evaluated once per joint, not once per base×joint.
                        if (segmentBlockedBetween(socketPos, _j)) { _skipSeg1++; continue; }

                        for (const _vb of _validBases) {
                            _testedPairs++;
                            const _crt = _vb.crt;

                            // Cheap angle gate before expensive SDF (seg2).
                            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_j, _crt, maxSegmentAngleFromVerticalDeg)) { _skipAngle++; continue; }

                            // joint → rootTop
                            if (segmentBlockedBetween(_j, _crt)) { _skipSeg2++; continue; }

                            // Score: prefer straighter + shorter-lateral supports.
                            // Include seg2Lateral (joint→base XY distance) so joints that
                            // force a highly angled bottom segment are penalised relative to
                            // deeper joints whose base can sit nearly directly below them.
                            const _v1x = _j.x - socketPos.x;
                            const _v1y = _j.y - socketPos.y;
                            const _v1z = _j.z - socketPos.z;
                            const _v2x = _crt.x - _j.x;
                            const _v2y = _crt.y - _j.y;
                            const _v2z = _crt.z - _j.z;
                            const _n1 = Math.sqrt(_v1x * _v1x + _v1y * _v1y + _v1z * _v1z);
                            const _n2 = Math.sqrt(_v2x * _v2x + _v2y * _v2y + _v2z * _v2z);
                            const _cos = _n1 > 1e-6 && _n2 > 1e-6
                                ? ((_v1x * _v2x + _v1y * _v2y + _v1z * _v2z) / (_n1 * _n2))
                                : 1;
                            const _bendPenalty = 1 - Math.max(-1, Math.min(1, _cos));
                            const _lateralPenalty = distanceXY({ x: socketPos.x, y: socketPos.y, z: 0 }, { x: _crt.x, y: _crt.y, z: 0 });
                            const _seg2LateralPenalty = Math.sqrt(_v2x * _v2x + _v2y * _v2y);
                            const _firstDropMm = socketPos.z - _j.z;
                            const _earlyBendPenalty = Math.max(0, _oneJointMinFirstDropMm - _firstDropMm) * _oneJointEarlyBendPenaltyPerMm;
                            const _score = _bendPenalty * 100 + _lateralPenalty + _seg2LateralPenalty * 2 + _earlyBendPenalty;

                            if (!_bestOneJoint || _score < _bestOneJoint.score) {
                                _bestOneJoint = { joint: { x: _j.x, y: _j.y, z: _j.z }, baseXY: { x: _vb.x, y: _vb.y }, score: _score };
                            }
                        }
                    }

                    const _bestSeg2Lateral = _bestOneJoint
                        ? distanceXY(
                            { x: _bestOneJoint.joint.x, y: _bestOneJoint.joint.y, z: 0 },
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                        )
                        : NaN;
                    const _bestFirstDrop = _bestOneJoint ? (socketPos.z - _bestOneJoint.joint.z) : NaN;
                    _oneJointStats = `pairs=${_testedPairs} rootsSkip=${_skipRoots} seg1Block=${_skipSeg1} seg2Block=${_skipSeg2} angleSkip=${_skipAngle} found=${_bestOneJoint ? 'yes' : 'no'}${_bestOneJoint ? ` bestSeg2Dxy=${_bestSeg2Lateral.toFixed(2)} bestFirstDrop=${_bestFirstDrop.toFixed(2)}` : ''}`;

                    let _twoJointTried = false;
                    let _twoJointFound = false;
                    if (_bestOneJoint) {
                        // When upgrading from a valid zero-joint, only accept the one-joint
                        // result if it actually brings the base closer to the socket.
                        const _oneJointBaseDxy = distanceXY(
                            socketPos,
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: socketPos.z },
                        );
                        let _skipOneJoint = _finalJoints.length === 0 && _oneJointBaseDxy >= _zeroLateral;
                        const _candidateRootTop: Vec3 = { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: rootTopZ };
                        if (!_skipOneJoint && !_currentChainIsBetterThan([_bestOneJoint.joint], _candidateRootTop)) {
                            _skipOneJoint = true;
                        }
                        if (!_skipOneJoint) {
                        // Base pull: the search found the best joint position for clearing the
                        // obstacle, but the base was chosen from A*-discovered candidates that
                        // can be far from the joint.  Now that we've fixed the joint, sweep
                        // candidates centred on the joint XY so seg2 is as close to
                        // straight-down as possible.
                        const _jFixed = _bestOneJoint.joint;
                        const _pullCandidates: Array<{ x: number; y: number }> = [
                            { x: _jFixed.x, y: _jFixed.y }, // directly below
                        ];
                        if (_ge && _sp > 0) {
                            // Include nearby grid nodes around directly-below.
                            const _nkNear = _bncCached(gridNodeKeyFromXY(_jFixed.x, _jFixed.y, _sp), 2);
                            for (const _nkp of _nkNear) {
                                const _sxy = gridSnappedXYFromKey(_nkp, _sp);
                                _pullCandidates.push({ x: _sxy.x, y: _sxy.y });
                            }
                        }
                        let _bestPullDxy = distanceXY(
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                            { x: _jFixed.x, y: _jFixed.y, z: 0 },
                        );
                        for (const _pb of _pullCandidates) {
                            if (!_rootsFitAt(_pb.x, _pb.y)) continue;
                            const _pcrt: Vec3 = { x: _pb.x, y: _pb.y, z: rootTopZ };
                            if (segmentBlockedBetween(_jFixed, _pcrt)) continue;
                            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_jFixed, _pcrt, maxSegmentAngleFromVerticalDeg)) continue;
                            const _pdxy = distanceXY({ x: _pb.x, y: _pb.y, z: 0 }, { x: _jFixed.x, y: _jFixed.y, z: 0 });
                            if (_pdxy < _bestPullDxy) {
                                _bestPullDxy = _pdxy;
                                _bestOneJoint = { ..._bestOneJoint, baseXY: { x: _pb.x, y: _pb.y } };
                            }
                        }

                        _finalJoints = [_bestOneJoint.joint];
                        _finalBase = {
                            basePos: { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                            rootTopTarget: { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: rootTopZ },
                            snapDistance: 0,
                            nodeKey: null,
                        };
                        _finalRootTop = { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: rootTopZ };

                        // Two-joint upgrade: if seg2 is still significantly angled after base
                        // pull, try inserting joint2 below the obstacle so the final leg drops
                        // nearly straight.  Strategy: walk down the Z axis at joint1's XY (and
                        // a small neighbourhood), find the first Z where both j1→j2 and
                        // j2→base(directly-below) are clear.
                        const _seg2Lateral = distanceXY(
                            { x: _bestOneJoint.joint.x, y: _bestOneJoint.joint.y, z: 0 },
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                        );
                        const _firstDropMm = socketPos.z - _bestOneJoint.joint.z;
                        if (_seg2Lateral > 1.5 || _firstDropMm < _oneJointMinFirstDropMm) {
                            _twoJointTried = true;
                            const _j1u = _bestOneJoint.joint;
                            const _bXY = _bestOneJoint.baseXY;
                            // XY candidates for j2:
                            // (a) directly below j1, + 8 cardinal offsets — handles cases
                            //     where a nearby path exists below j1
                            // (b) interpolated along j1→base + base XY itself — handles the
                            //     common case where the model body is below j1 but a
                            //     kink halfway along the diagonal opens a clear straight-down
                            //     final leg from the interpolated point.
                            const _j2XYCandidates: Array<{ x: number; y: number }> = [
                                { x: _j1u.x, y: _j1u.y },
                            ];
                            const _j2Off = 0.6; // mm
                            for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                                _j2XYCandidates.push({ x: _j1u.x + dx * _j2Off, y: _j1u.y + dy * _j2Off });
                            }
                            // Also probe around current base XY so the upgrade can pick a
                            // cleaner drop column near the already-valid one-joint base.
                            for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                                _j2XYCandidates.push({ x: _bXY.x + dx * _j2Off, y: _bXY.y + dy * _j2Off });
                            }
                            // Interpolate toward the base XY at 25%, 50%, 75%, 100%.
                            for (const _t of [0.25, 0.5, 0.75, 1.0]) {
                                _j2XYCandidates.push({
                                    x: _j1u.x + (_bXY.x - _j1u.x) * _t,
                                    y: _j1u.y + (_bXY.y - _j1u.y) * _t,
                                });
                            }
                            if (_ge && _sp > 0) {
                                const _near2 = _bncCached(gridNodeKeyFromXY(_j1u.x, _j1u.y, _sp), 1);
                                for (const _nkp of _near2) {
                                    const _s = gridSnappedXYFromKey(_nkp, _sp);
                                    _j2XYCandidates.push({ x: _s.x, y: _s.y });
                                }
                                const _nearBase = _bncCached(gridNodeKeyFromXY(_bXY.x, _bXY.y, _sp), 1);
                                for (const _nkp of _nearBase) {
                                    const _s = gridSnappedXYFromKey(_nkp, _sp);
                                    _j2XYCandidates.push({ x: _s.x, y: _s.y });
                                }
                            }

                            interface _TwoJointCandidate { j2: Vec3; baseXY: { x: number; y: number }; dxy: number }
                            let _bestTJ: _TwoJointCandidate | null = null;
                            const _j2ZStep = 0.5;
                            for (const _j2xy of _j2XYCandidates) {
                                if (!_rootsFitAt(_j2xy.x, _j2xy.y)) continue;
                                const _crt2: Vec3 = { x: _j2xy.x, y: _j2xy.y, z: rootTopZ };
                                for (let _z2 = _j1u.z - _j2ZStep; _z2 > rootTopZ + _j2ZStep; _z2 -= _j2ZStep) {
                                    const _j2c: Vec3 = { x: _j2xy.x, y: _j2xy.y, z: _z2 };
                                    // seg1b: j1 → j2
                                    if (segmentBlockedBetween(_j1u, _j2c)) continue;
                                    // IMPORTANT: for fixed XY, lowering z2 increases vertical
                                    // drop on seg1b, so an angle failure at a higher z2 can
                                    // become valid at a lower z2. Keep scanning downward.
                                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_j1u, _j2c, maxSegmentAngleFromVerticalDeg)) continue;
                                    // seg2: j2 → base (straight down)
                                    if (segmentBlockedBetween(_j2c, _crt2)) continue;
                                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_j2c, _crt2, maxSegmentAngleFromVerticalDeg)) break;
                                    const _dxy2 = distanceXY({ x: _j2xy.x, y: _j2xy.y, z: 0 }, { x: _j1u.x, y: _j1u.y, z: 0 });
                                    if (!_bestTJ || _dxy2 < _bestTJ.dxy || (_dxy2 === _bestTJ.dxy && _z2 > _bestTJ.j2.z)) {
                                        _bestTJ = { j2: _j2c, baseXY: { x: _j2xy.x, y: _j2xy.y }, dxy: _dxy2 };
                                    }
                                    break; // highest valid Z for this XY found, don't go lower
                                }
                            }

                            if (_bestTJ) {
                                const _candidateRootTop2: Vec3 = { x: _bestTJ.baseXY.x, y: _bestTJ.baseXY.y, z: rootTopZ };
                                if (_currentChainIsBetterThan([_j1u, _bestTJ.j2], _candidateRootTop2)) {
                                    _twoJointFound = true;
                                    _finalJoints = [_j1u, _bestTJ.j2];
                                    _finalBase = {
                                        basePos: { x: _bestTJ.baseXY.x, y: _bestTJ.baseXY.y, z: 0 },
                                        rootTopTarget: { x: _bestTJ.baseXY.x, y: _bestTJ.baseXY.y, z: rootTopZ },
                                        snapDistance: 0,
                                        nodeKey: null,
                                    };
                                    _finalRootTop = { x: _bestTJ.baseXY.x, y: _bestTJ.baseXY.y, z: rootTopZ };
                                }
                            }
                        }
                        } // !_skipOneJoint
                        if (_oneJointStats) {
                            _oneJointStats += ` twoJointTried=${_twoJointTried ? 'yes' : 'no'} twoJointFound=${_twoJointFound ? 'yes' : 'no'}`;
                        }
                    }
                }
            }

            // Quality gate: if still 2+ joints and they're all crammed into a
            // tight Z band (< MIN_ROUTING_Z_SPAN_MM), the path is squeezing
            // through a model crack — reject it rather than embed the support.
            if (_finalJoints.length >= 2) {
                const _routingSpan = socketPos.z - _finalJoints[_finalJoints.length - 1].z;
                if (_routingSpan < minRoutingZSpanMm) {
                    if (!isPreview) {
                        console.log(
                            `[SmartPlacementV2] WIDE-STEP rejected — tight crack (routingSpan=${_routingSpan.toFixed(2)}mm < ${minRoutingZSpanMm.toFixed(2)}mm with ${_finalJoints.length} joints)`,
                        );
                    }
                    // No usable path — fall through to COLLISION_WITH_MODEL.
                    addBlockedReason(`Routing Z span too small (${_routingSpan.toFixed(2)}mm)`);
                    setDebugOutcome('blocked', 'wide-pass route squeezed through a crack');
                    publishPathfindingDebugSnapshot();
                    return {
                        ...standard,
                        error: 'COLLISION_WITH_MODEL',
                    };
                }
            }

            // Angle check on final chain
            const _allSegs = [socketPos, ..._finalJoints, _finalRootTop];
            let _angleOk = true;
            for (let _si = 0; _si < _allSegs.length - 1; _si++) {
                if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_allSegs[_si], _allSegs[_si + 1], maxSegmentAngleFromVerticalDeg)) {
                    _angleOk = false; break;
                }
            }
            if (_angleOk) {
                if (!isPreview) {
                    const _wideChain = [socketPos, ..._finalJoints, _finalRootTop];
                    const _wideSegs = _wideChain.slice(0,-1).map((p,i) => {
                        const q = _wideChain[i+1];
                        const dz = q.z-p.z; const dxy = Math.sqrt((q.x-p.x)**2+(q.y-p.y)**2);
                        const dir = dz>0.001?'⬆️UP':dz<-0.001?'⬇️dn':'➡️hz';
                        return `  seg${i}: (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})→(${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}) dz=${dz.toFixed(2)} dxy=${dxy.toFixed(2)} ${dir}`;
                    });
                    const _wideHasRise = _wideChain.slice(0,-1).some((p,i)=>_wideChain[i+1].z>p.z+0.001);
                    console.log(
                        `[SmartPlacementV2] WIDE-STEP result — ${_finalJoints.length} joint(s) (raw=${_rawJoints.length} simplified=${_simplifiedJoints.length})${_wideHasRise?' ⚠️ HAS UPWARD SEGMENTS':' ✅ monotonic'}\n` +
                        `  socket: (${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)})\n` +
                        `  finalJoints: [${_finalJoints.map((p: Vec3)=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
                        `  base: (${_finalBase.basePos.x.toFixed(2)},${_finalBase.basePos.y.toFixed(2)}) rootTopZ=${rootTopZ.toFixed(2)}\n` +
                        (_oneJointStats ? `  oneJointSearch: ${_oneJointStats}\n` : '') +
                        _wideSegs.join('\n'),
                    );
                }
                publishPathfindingDebugSnapshot();
                return {
                    ...standard,
                    joints: _finalJoints,
                    basePos: _finalBase.basePos,
                    unsnappedBottomPos: _ubp,
                    snappedNodeKey: _finalBase.nodeKey ?? null,
                    warning: _warning,
                    error: undefined,
                };
            }
        }
    }
    // Record preview-exhaustion ONLY if both passes failed, not after just fine-step.
    if (!result.reached && isPreview && (result.hitExpansionLimit || result.stagnated)) {
        recordSpatialPoint(previewExhaustedCache, mesh.uuid, socketPos, PREVIEW_EXHAUSTED_RADIUS_SQ);
    }

    // Store warm-start for next frame — write to the correct map based on mode.
    if (result.warmState) {
        if (isPreview) {
            previewWarmStartByModel.set(modelId, result.warmState);
        } else {
            warmStartByModel.set(modelId, result.warmState);
        }
    }
    if (result.stagnated) {
        if (isPreview) {
            previewWarmStartByModel.delete(modelId);
        } else {
            warmStartByModel.delete(modelId);
        }
        if (!isPreview) {
            recordStagnation(mesh.uuid, socketPos);
        }
    }

    if (!result.reached || result.path.length < 2) {
        const straightRescueFallback = buildStraightRescueFallback();
        if (straightRescueFallback) {
            return straightRescueFallback;
        }
        if (result.stagnated) addBlockedReason('A* stagnated before reaching root target');
        if (result.hitExpansionLimit) addBlockedReason('A* hit expansion budget before reaching root target');
        if (!result.reached) addBlockedReason('No valid path reached root target');
        if (result.path.length < 2) addBlockedReason('Path result was too short to form a support chain');
        setDebugOutcome('blocked', 'pathfinding failed to reach a valid root target');
        publishPathfindingDebugSnapshot();
        return {
            ...standard,
            error: 'COLLISION_WITH_MODEL',
            stagnated: result.stagnated,
            exhaustedBudget: result.hitExpansionLimit,
        };
    }

    // 5. Convert A* path to joints + resolve grid snapping
    //    Path goes [socketPos, joint1, joint2, ..., baseRegion]
    //    We need to extract joints and find the best grid-snapped base.
    //    Safety: enforce Z-monotonicity on the joints (the A* allows limited
    //    upward moves to route around protrusions — strip any that survived
    //    simplification so the final support never rises).
    const rawPathJoints = result.path.slice(1, -1);
    const pathJoints: Vec3[] = [];
    let prevJointZ = socketPos.z;
    for (let ji = 0; ji < rawPathJoints.length; ji++) {
        if (rawPathJoints[ji].z < prevJointZ) {
            pathJoints.push(rawPathJoints[ji]);
            prevJointZ = rawPathJoints[ji].z;
        }
    }
    const pathEnd = result.path[result.path.length - 1];

    // 6. Grid snap the base position
    //    When grid is disabled, preserve the sub-grid offset from socketPos
    //    so that nearby placements don't all converge to the same 2mm grid cell.
    const gridEnabled = settings.grid.enabled;
    const spacingMm = settings.grid.spacingMm;
    const nearestCandidateNodeKeysCache = new Map<string, string[]>();
    const buildNearestCandidateNodeKeysCached = (preferredKey: string, maxRings: number) => {
        const key = `${preferredKey}|${maxRings}`;
        const cached = nearestCandidateNodeKeysCache.get(key);
        if (cached) return cached;
        const computed = buildNearestCandidateNodeKeys(preferredKey, maxRings);
        nearestCandidateNodeKeysCache.set(key, computed);
        return computed;
    };

    const unsnappedBottomPos: Vec3 = {
        x: pathEnd.x,
        y: pathEnd.y,
        z: 0,
    };

    // Pre-compute sub-grid offset when grid is disabled. This carries the
    // user-clicked position's fractional offset through the path to ensure
    // unique base positions even when underlying pathfinder quantizes to 2mm.
    const subGridOffset = !gridEnabled ? {
        x: input.tipPos.x - Math.round(input.tipPos.x / FINE_ASTAR_STEP_MM) * FINE_ASTAR_STEP_MM,
        y: input.tipPos.y - Math.round(input.tipPos.y / FINE_ASTAR_STEP_MM) * FINE_ASTAR_STEP_MM,
    } : null;

    if (!gridEnabled && subGridOffset) {
        for (const j of pathJoints) {
            j.x += subGridOffset.x;
            j.y += subGridOffset.y;
        }
    }

    // Find best grid node for the base
    let bestBase = resolveCommittedBaseCandidate({
        preferredBottomPos: unsnappedBottomPos,
        lastSegmentStart: pathJoints.length > 0 ? pathJoints[pathJoints.length - 1] : pathEnd,
        rootTopZ,
        gridEnabled,
        spacingMm,
        maxNearestNodeSearchRings: maxNearestNodeSearchRings,
        sdf,
        diskHeight,
        coneHeight,
        rootsRadius,
        shaftRadius,
        clearance,
        buildNearestCandidateNodeKeys: buildNearestCandidateNodeKeysCached,
        subGridOffset,
        rootsDiskBlockedAt,
        segmentBlockedBetween,
    });

    if (!bestBase) {
        const straightRescueFallback = buildStraightRescueFallback();
        if (straightRescueFallback) {
            return straightRescueFallback;
        }
        // No valid grid-snapped base found
        addBlockedReason('No valid committed base candidate found');
        setDebugOutcome('blocked', 'base candidate resolution failed');
        publishPathfindingDebugSnapshot();
        return {
            ...standard,
            error: 'COLLISION_WITH_MODEL',
        };
    }

    // If the final segment from the last joint (or socket) to the root
    // bends laterally, try going straight down from that point instead.
    // This keeps the bottom-most shaft section vertical, preventing the
    // "skirt to the side" visual artifact near the root.
    const lastPointBeforeBase = pathJoints.length > 0
        ? pathJoints[pathJoints.length - 1]
        : { x: socketPos.x, y: socketPos.y, z: socketPos.z };
    const finalSegmentLateralMm = distanceXY(lastPointBeforeBase, bestBase.rootTopTarget);
    const FINAL_SEGMENT_STRAIGHTEN_THRESHOLD_MM = !gridEnabled ? 0.05 : 1.5;
    if (finalSegmentLateralMm > FINAL_SEGMENT_STRAIGHTEN_THRESHOLD_MM) {
        const straightDownBase: Vec3 = {
            x: lastPointBeforeBase.x,
            y: lastPointBeforeBase.y,
            z: 0,
        };
        const straightDownRootTop: Vec3 = {
            x: lastPointBeforeBase.x,
            y: lastPointBeforeBase.y,
            z: rootTopZ,
        };
        const rootsOk = !rootsDiskBlockedAt(straightDownBase.x, straightDownBase.y);
        const shaftOk = !segmentBlockedBetween(lastPointBeforeBase, straightDownRootTop);
        const angleOk = segmentSatisfiesLengthAwareMaxAngleFromVertical(
            lastPointBeforeBase, straightDownRootTop, maxSegmentAngleFromVerticalDeg,
        );
        if (rootsOk && shaftOk && angleOk) {
            bestBase = {
                basePos: straightDownBase,
                rootTopTarget: straightDownRootTop,
                inboundLateralMm: 0,
                snapDistance: distanceXY(straightDownBase, unsnappedBottomPos),
                nodeKey: gridEnabled
                    ? gridNodeKeyFromXY(straightDownBase.x, straightDownBase.y, spacingMm)
                    : null,
            };
        }
    }

    if (contactConeBlockedAt(socketPos)) {
        const straightRescueFallback = buildStraightRescueFallback();
        if (straightRescueFallback) {
            return straightRescueFallback;
        }
        addBlockedReason('Contact cone became blocked before commit');
        setDebugOutcome('blocked', 'contact cone blocked before commit');
        publishPathfindingDebugSnapshot();
        return {
            ...standard,
            error: 'COLLISION_WITH_MODEL',
        };
    }

    // Preview fast-path: avoid expensive SDF simplification, straightening and
    // full-chain validation on every hover frame. Click-time placement (isPreview=false)
    // still executes the full quality pipeline below.
    if (isPreview) {
        const surfaceConeAxis = standard.coneAxis ?? input.tipNormal;
        const effectiveConeAxis = pathJoints.length > 0 && pathJoints[0]
            ? computeConeAxisFromShaftDirection(socketPos, pathJoints[0]!, surfaceConeAxis)
            : surfaceConeAxis;
        return {
            socketPos,
            joints: pathJoints,
            constructionJoints: [],
            basePos: bestBase.basePos,
            unsnappedBottomPos,
            snappedNodeKey: bestBase.nodeKey,
            warning: standard.warning,
            angle: standard.angle,
            coneAxis: effectiveConeAxis,
        };
    }

    // 7. Simplify joints using SDF-based collision checks (NOT raycasting).
    //    Raycaster-based simplification (simplifyRouteJoints) has blind spots
    //    between its 9-ray bundle, allowing joints to be removed even when
    //    the direct segment clips geometry. SDF checks at 0.5mm intervals
    //    along every candidate segment, catching all collisions.
    const simplifiedJoints = simplifyJointsSDF(
        pathJoints,
        socketPos,
        bestBase.rootTopTarget,
        sdf,
        clearance,
        maxSegmentAngleFromVerticalDeg,
        segmentBlockedBetween,
    );

    // 7b. Path straightening — eliminate zigzag by finding a base position
    //     where a straight (zero-joint) or single-bend (one-joint) path
    //     clears all geometry.  The A* at 0.25mm steps creates fine-grained
    //     detours that survive simplification; this pass searches for a
    //     more direct alternative before accepting the zigzag.
    let finalJoints = simplifiedJoints;
    let finalBase = bestBase;

    if (ENABLE_AGGRESSIVE_POST_PATH_STRAIGHTENING && finalJoints.length > 0) {
        const currentChainIsBetterThan = (candidateJoints: Vec3[], candidateRootTop: Vec3) => {
            const candidateMetrics = getResolvedChainMetrics(socketPos, candidateJoints, candidateRootTop);
            const currentMetrics = getResolvedChainMetrics(socketPos, finalJoints, finalBase.rootTopTarget);
            return isResolvedChainReplacementBetter(candidateMetrics, currentMetrics);
        };

        // ---------- Zero-joint radial sweep ----------
        // Search for ANY base position where a straight socket→rootTop line
        // is collision-free and angle-valid.  Start with the obvious candidates
        // (original base, below socket, below lowest joint) then sweep radially
        // around the socket XY projection at increasing radii.  The first hit
        // wins — it produces the straightest possible support.
        const zeroJointBaseXYCandidates: Array<{ x: number; y: number }> = [];

        // Priority candidates first
        zeroJointBaseXYCandidates.push({ x: bestBase.basePos.x, y: bestBase.basePos.y });
        zeroJointBaseXYCandidates.push({ x: socketPos.x, y: socketPos.y });
        if (finalJoints.length > 0) {
            const lowest = finalJoints[finalJoints.length - 1];
            zeroJointBaseXYCandidates.push({ x: lowest.x, y: lowest.y });
        }

        // Radial sweep around BOTH socket XY and A*-found base XY.
        // The model body is directly below the socket (hence straightClear=false),
        // so sweeping only around socket XY wastes most candidates. Sweeping
        // around the A*-found base (which is already clear) finds viable
        // straight-line positions much faster.
        //
        // Use the flat routing angle (80°) as a generous pre-filter so the
        // search isn't limited to ~9mm radius by length-aware tightening
        // on 22mm-tall supports. The tightened angle is enforced at commit time.
        const sweepDirs = 16;
        for (const r of rescueSweepRadiiMm) {
            if (r > maxTotalLateralMm) break;
            for (let d = 0; d < sweepDirs; d++) {
                const a = (d / sweepDirs) * Math.PI * 2;
                // Around socket XY
                zeroJointBaseXYCandidates.push({
                    x: socketPos.x + Math.cos(a) * r,
                    y: socketPos.y + Math.sin(a) * r,
                });
                // Around A*-found base XY (often on the other side of the obstacle)
                zeroJointBaseXYCandidates.push({
                    x: bestBase.basePos.x + Math.cos(a) * r,
                    y: bestBase.basePos.y + Math.sin(a) * r,
                });
            }
        }

        let foundStraight = false;
        for (const bxy of zeroJointBaseXYCandidates) {
            const candRootTop: Vec3 = { x: bxy.x, y: bxy.y, z: rootTopZ };

            // Pre-filter with flat routing angle (80°) — avoids discarding candidates
            // that would be reachable by A* but fail the length-aware tightening.
            // The tightened check below gates final commit.
            if (!segmentSatisfiesMaxAngleFromVertical(socketPos, candRootTop, ROUTING_ANGLE_FROM_VERTICAL_DEG)) continue;

            // Roots must fit
            if (rootsDiskBlockedAt(bxy.x, bxy.y)) continue;

            // Straight shaft must be clear
            if (segmentBlockedBetween(socketPos, candRootTop)) continue;

            // Final angle gate: enforce length-aware tightened constraint before commit
            // so we never return a geometrically invalid support.
            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, candRootTop, maxSegmentAngleFromVerticalDeg)) continue;
            if (!currentChainIsBetterThan([], candRootTop)) continue;

            // Winner — zero joints, straight support
            finalJoints = [];
            finalBase = {
                basePos: { x: bxy.x, y: bxy.y, z: 0 },
                rootTopTarget: candRootTop,
                snapDistance: distanceXY({ x: bxy.x, y: bxy.y, z: 0 }, unsnappedBottomPos),
                nodeKey: null,
            };
            foundStraight = true;
            break;
        }

        // ---------- One-joint fallback ----------
        // If no zero-joint path exists, try reducing to a single joint.
        if (!foundStraight && finalJoints.length >= 2) {
            const oneJointCandidates: Array<{ joint: Vec3; baseXY: { x: number; y: number } }> = [];

            // Keep first or last joint with original base
            oneJointCandidates.push({ joint: finalJoints[0], baseXY: { x: bestBase.basePos.x, y: bestBase.basePos.y } });
            oneJointCandidates.push({ joint: finalJoints[finalJoints.length - 1], baseXY: { x: bestBase.basePos.x, y: bestBase.basePos.y } });

            // Each joint with base below it
            for (const j of finalJoints) {
                oneJointCandidates.push({ joint: j, baseXY: { x: j.x, y: j.y } });
            }

            for (const oc of oneJointCandidates) {
                const candRootTop: Vec3 = { x: oc.baseXY.x, y: oc.baseXY.y, z: rootTopZ };

                if (rootsDiskBlockedAt(oc.baseXY.x, oc.baseXY.y)) continue;

                // Check both segments: socket→joint and joint→rootTop
                const seg1Ok = !segmentBlockedBetween(socketPos, oc.joint)
                    && segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, oc.joint, maxSegmentAngleFromVerticalDeg);
                if (!seg1Ok) continue;

                const seg2Ok = !segmentBlockedBetween(oc.joint, candRootTop)
                    && segmentSatisfiesLengthAwareMaxAngleFromVertical(oc.joint, candRootTop, maxSegmentAngleFromVerticalDeg);
                if (!seg2Ok) continue;
                if (!currentChainIsBetterThan([oc.joint], candRootTop)) continue;

                finalJoints = [oc.joint];
                finalBase = {
                    basePos: { x: oc.baseXY.x, y: oc.baseXY.y, z: 0 },
                    rootTopTarget: candRootTop,
                    snapDistance: distanceXY({ x: oc.baseXY.x, y: oc.baseXY.y, z: 0 }, unsnappedBottomPos),
                    nodeKey: null,
                };
                break;
            }
        }
    }

    // 8. Quality gate: reject paths where routing joints are compressed into a
    //    tight Z band near the socket — signature of squeezing through a crack.
    if (finalJoints.length >= 2) {
        const routingZSpan = socketPos.z - finalJoints[finalJoints.length - 1].z;
        if (routingZSpan < minRoutingZSpanMm) {
            const straightRescueFallback = buildStraightRescueFallback();
            if (straightRescueFallback) {
                return straightRescueFallback;
            }
            addBlockedReason(`Routing joints compressed into ${routingZSpan.toFixed(2)}mm Z span`);
            setDebugOutcome('blocked', 'route compressed into crack-like span');
            publishPathfindingDebugSnapshot();
            return {
                ...standard,
                error: 'COLLISION_WITH_MODEL',
            };
        }
    }

    publishPathfindingDebugSnapshot();

    // 8b. Final SDF validation of the complete chain.
    //    Even after simplification + straightening, verify every segment is clear.
    //    This is the last line of defense against any clipping.
    //    Chain runs high-Z (socketPos) → low-Z (rootTopTarget) so each
    //    segment descends and the angle helper sees positive vertical drop.
    const finalChainPoints: Vec3[] = [
        socketPos,
        ...finalJoints,
        finalBase.rootTopTarget,
    ];

    for (let i = 0; i < finalChainPoints.length - 1; i++) {
        const a = finalChainPoints[i];
        const b = finalChainPoints[i + 1];

        if (raycastSegmentBlockedBetween(a, b)) {
            const straightRescueFallback = buildStraightRescueFallback();
            if (straightRescueFallback) {
                return straightRescueFallback;
            }
            addBlockedReason(`Final chain segment ${i} collides with model`);
            setDebugOutcome('blocked', 'final chain collision check failed');
            publishPathfindingDebugSnapshot();
            return {
                ...standard,
                error: 'COLLISION_WITH_MODEL',
            };
        }

        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(a, b, maxSegmentAngleFromVerticalDeg)) {
            const straightRescueFallback = buildStraightRescueFallback();
            if (straightRescueFallback) {
                return straightRescueFallback;
            }
            addBlockedReason(`Final chain segment ${i} violates max angle constraint`);
            setDebugOutcome('blocked', 'final chain angle validation failed');
            publishPathfindingDebugSnapshot();
            return {
                ...standard,
                error: 'COLLISION_WITH_MODEL',
            };
        }
    }

    // 9. Build the result.
    // When the path has joints, align the contact cone axis with the first
    // shaft segment direction (socket → first joint) instead of the surface
    // normal.  This prevents the cone pointing north while the shaft goes
    // west — the cone and shaft should form one continuous line.
    const surfaceConeAxisFinal = standard.coneAxis ?? input.tipNormal;
    const effectiveConeAxis = finalJoints.length > 0 && finalJoints[0]
        ? computeConeAxisFromShaftDirection(socketPos, finalJoints[0]!, surfaceConeAxisFinal)
        : surfaceConeAxisFinal;
    const finalResult: TrunkPlacementResult = {
        socketPos,
        joints: finalJoints,
        constructionJoints: [],
        basePos: finalBase.basePos,
        unsnappedBottomPos,
        snappedNodeKey: finalBase.nodeKey,
        warning: standard.warning,
        angle: standard.angle,
        coneAxis: effectiveConeAxis,
    };
    setDebugOutcome(finalJoints.length === 0 ? 'straight' : 'routed', 'final validated chain');
    if (debugEnabled) {
        debugBasePos = finalBase.basePos;
        debugFinalChain = [socketPos, ...finalJoints, finalBase.rootTopTarget];
    }
    recordDebugEvent(() => ({
        stage: 'result',
        severity: 'success',
        message: `Placed ${finalJoints.length === 0 ? 'straight' : 'routed'} support`,
        details: `joints=${finalJoints.length} base=(${finalBase.basePos.x.toFixed(2)}, ${finalBase.basePos.y.toFixed(2)})`,
    }));

    if (!isPreview) {
        // Build the full chain for logging: socket → joints → rootTop
        const logChain = [socketPos, ...finalJoints, finalBase.rootTopTarget];
        const segmentLog = logChain.slice(0, -1).map((pt, i) => {
            const next = logChain[i + 1];
            const dz = next.z - pt.z;
            const dxy = Math.sqrt((next.x - pt.x) ** 2 + (next.y - pt.y) ** 2);
            const dir = dz > 0.001 ? '⬆️UP' : dz < -0.001 ? '⬇️dn' : '➡️hz';
            return `  seg${i}: (${pt.x.toFixed(2)},${pt.y.toFixed(2)},${pt.z.toFixed(2)}) → (${next.x.toFixed(2)},${next.y.toFixed(2)},${next.z.toFixed(2)}) dz=${dz.toFixed(2)} dxy=${dxy.toFixed(2)} ${dir}`;
        });
        const hasRise = logChain.slice(0, -1).some((pt, i) => logChain[i + 1].z > pt.z + 0.001);
        console.log(
            `[SmartPlacementV2] PLACED support — ${finalJoints.length} joint(s)${hasRise ? ' ⚠️ HAS UPWARD SEGMENTS' : ' ✅ monotonic'}\n` +
            `  socket:  (${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)})\n` +
            `  rawJoints(pre-filter): [${result.path.slice(1,-1).map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
            `  simplifiedJoints: [${simplifiedJoints.map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
            `  finalJoints: [${finalJoints.map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
            `  base/rootTop: (${finalBase.basePos.x.toFixed(2)},${finalBase.basePos.y.toFixed(2)}) rootTopZ=${finalBase.rootTopTarget.z.toFixed(2)}\n` +
            segmentLog.join('\n'),
        );
    }

    publishPathfindingDebugSnapshot();
    return finalResult;
}

// ---------- SDF-based joint simplification ----------

/**
 * Removes unnecessary joints from the route using SDF collision checks.
 *
 * Unlike `simplifyRouteJoints` (which uses 9-ray bundles), this validates
 * each candidate removal by checking the direct segment with
 * `sdf.segmentBlocked` at cellSize intervals — no gaps possible.
 *
 * Iteratively removes joints whose removal still produces a collision-free
 * and angle-valid chain.
 */
function buildShortcutCandidateRoute(routeJoints: Vec3[], startPointIndex: number, endPointIndex: number): Vec3[] {
    const prefixJointCount = Math.max(0, startPointIndex);
    const suffixJointStart = Math.max(0, endPointIndex - 1);

    return [
        ...routeJoints.slice(0, prefixJointCount),
        ...routeJoints.slice(suffixJointStart),
    ];
}

export function simplifyJointsSDF(
    routeJoints: Vec3[],
    socketPos: Vec3,
    rootTopTarget: Vec3,
    sdf: SDFCache,
    clearance: number,
    maxAngleFromVerticalDeg: number,
    segmentBlockedBetween?: SegmentBlockedBetween,
): Vec3[] {
    if (routeJoints.length === 0) return routeJoints;

    let simplified = [...routeJoints];
    let changed = true;

    while (changed) {
        changed = false;

        for (let i = 0; i < simplified.length; i++) {
            // Chain runs high-Z (socketPos) → low-Z (rootTopTarget) so each
            // segment descends and the angle helper sees positive vertical drop.
            const prev = i === 0 ? socketPos : simplified[i - 1];
            const current = simplified[i];
            const next = i === simplified.length - 1 ? rootTopTarget : simplified[i + 1];

            if (
                !jointsAreNearCollinear(prev, current, next)
                && !jointAddsNegligibleLateralDetour(prev, current, next)
                && !jointAddsNegligibleLengthDetour(prev, current, next)
            ) {
                continue;
            }

            // Check if the direct segment (skipping this joint) is clear
            const directSegmentBlocked = segmentBlockedBetween
                ? segmentBlockedBetween(prev, next)
                : sdf.segmentBlocked(prev.x, prev.y, prev.z, next.x, next.y, next.z, clearance);
            if (directSegmentBlocked) {
                continue; // Can't remove — direct path clips geometry
            }

            // Check angle constraint on the direct segment
            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(prev, next, maxAngleFromVerticalDeg)) {
                continue; // Can't remove — angle too steep
            }

            const candidateRoute = simplified.filter((_, idx) => idx !== i);
            const currentMetrics = getResolvedChainMetrics(socketPos, simplified, rootTopTarget);
            const candidateMetrics = getResolvedChainMetrics(socketPos, candidateRoute, rootTopTarget);
            if (!isResolvedChainReplacementBetter(candidateMetrics, currentMetrics)) {
                continue;
            }

            // Safe to remove this joint
            simplified = candidateRoute;
            changed = true;
            break; // Restart from beginning
        }

        if (changed) {
            continue;
        }

        const chainPoints = [socketPos, ...simplified, rootTopTarget];
        const currentMetrics = getResolvedChainMetrics(socketPos, simplified, rootTopTarget);

        outerShortcut:
        for (let startPointIndex = 0; startPointIndex < chainPoints.length - 2; startPointIndex++) {
            const start = chainPoints[startPointIndex];

            for (let endPointIndex = chainPoints.length - 1; endPointIndex > startPointIndex + 1; endPointIndex--) {
                const removedJointCount = endPointIndex - startPointIndex - 1;
                if (removedJointCount <= 0) {
                    continue;
                }

                const end = chainPoints[endPointIndex];

                const shortcutBlocked = segmentBlockedBetween
                    ? segmentBlockedBetween(start, end)
                    : sdf.segmentBlocked(start.x, start.y, start.z, end.x, end.y, end.z, clearance);
                if (shortcutBlocked) {
                    continue;
                }

                if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(start, end, maxAngleFromVerticalDeg)) {
                    continue;
                }

                const candidateRoute = buildShortcutCandidateRoute(simplified, startPointIndex, endPointIndex);
                const candidateMetrics = getResolvedChainMetrics(socketPos, candidateRoute, rootTopTarget);
                if (!isResolvedChainReplacementBetter(candidateMetrics, currentMetrics)) {
                    continue;
                }

                simplified = candidateRoute;
                changed = true;
                break outerShortcut;
            }
        }
    }

    return simplified;
}

function jointsAreNearCollinear(a: Vec3, b: Vec3, c: Vec3): boolean {
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const abLength = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z);
    const bcLength = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);
    if (abLength < 0.0001 || bcLength < 0.0001) {
        return true;
    }

    const abNorm = { x: ab.x / abLength, y: ab.y / abLength, z: ab.z / abLength };
    const bcNorm = { x: bc.x / bcLength, y: bc.y / bcLength, z: bc.z / bcLength };
    const dot = abNorm.x * bcNorm.x + abNorm.y * bcNorm.y + abNorm.z * bcNorm.z;
    return dot >= 0.995;
}

function jointAddsNegligibleLateralDetour(a: Vec3, b: Vec3, c: Vec3): boolean {
    const splitLateral = distanceXY(a, b) + distanceXY(b, c);
    const directLateral = distanceXY(a, c);
    return splitLateral - directLateral <= 0.75;
}

function jointAddsNegligibleLengthDetour(a: Vec3, b: Vec3, c: Vec3): boolean {
    const splitLength = distance3D(a, b) + distance3D(b, c);
    const directLength = distance3D(a, c);
    return splitLength - directLength <= 1.0;
}

/**
 * Clears warm-start state for a model (call when model is removed or
 * support mode is exited).
 */
export function clearWarmStart(modelId: string): void {
    warmStartByModel.delete(modelId);
}

export function clearAllWarmStarts(): void {
    warmStartByModel.clear();
    stagnationCache.clear();
}

export function clearStagnationCache(meshUuid?: string): void {
    if (meshUuid) {
        stagnationCache.delete(meshUuid);
    } else {
        stagnationCache.clear();
    }
}
