/**
 * Trunk Builder
 * 
 * Defines what a trunk is made of and builds the data structure.
 * Used for both preview and placement (same function, no duplication).
 */

import * as THREE from 'three';
import { Vec3, Roots, Trunk, Segment, Joint } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getFinalSocketPosition, getSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { getJointDiameter } from '../../constants';
import { getSettings } from '../../Settings';
import type { SupportData } from '../../rendering/SupportBuilder';
import { calculateStandardPlacement, type TrunkPlacementResult } from '../../PlacementLogic/StandardPlacement';
import { calculateSmartPlacementV2 } from '../../PlacementLogic/Pathfinding';
import type { LimitationCode, WarningCode } from '../../types';
import type { SnappedTrunkRouteResult, TrunkRouteResult } from './trunkRouteTypes';
import { gridSnappedXYFromKey } from '../../PlacementLogic/Grid/gridMath';
import { normalizeFirstConstructionJoint, withCentralStraightSupportJoint } from './trunkConstructionJoints';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

const JOINT_CHAIN_Z_EPSILON = 0.0001;

function getAscendingJointPenalty(joints: Vec3[], lowerBoundZ: number, upperBoundZ: number): number {
    let penalty = 0;
    let previousZ = lowerBoundZ;

    for (const joint of joints) {
        if (joint.z <= previousZ + JOINT_CHAIN_Z_EPSILON) {
            penalty += (previousZ + JOINT_CHAIN_Z_EPSILON) - joint.z + 1;
        }
        if (joint.z >= upperBoundZ - JOINT_CHAIN_Z_EPSILON) {
            penalty += joint.z - (upperBoundZ - JOINT_CHAIN_Z_EPSILON) + 1;
        }
        previousZ = Math.max(previousZ, joint.z);
    }

    return penalty;
}

function orientJointsBaseToSocket(joints: Vec3[], lowerBoundZ: number, upperBoundZ: number): Vec3[] {
    if (joints.length < 2) {
        return [...joints];
    }

    const forward = [...joints];
    const reversed = [...joints].reverse();
    const forwardPenalty = getAscendingJointPenalty(forward, lowerBoundZ, upperBoundZ);
    const reversedPenalty = getAscendingJointPenalty(reversed, lowerBoundZ, upperBoundZ);

    return reversedPenalty < forwardPenalty ? reversed : forward;
}

function filterStrictlyAscendingJoints(joints: Vec3[], lowerBoundZ: number, upperBoundZ: number): Vec3[] {
    const result: Vec3[] = [];
    let previousZ = lowerBoundZ;

    for (const joint of joints) {
        if (joint.z <= previousZ + JOINT_CHAIN_Z_EPSILON) {
            continue;
        }
        if (joint.z >= upperBoundZ - JOINT_CHAIN_Z_EPSILON) {
            continue;
        }

        result.push(joint);
        previousZ = joint.z;
    }

    return result;
}

function normalizeTrunkJointChain(args: {
    rootTopZ: number;
    socketPos: Vec3;
    routeJoints: Vec3[];
    constructionJoints: Vec3[];
}): { routeJoints: Vec3[]; constructionJoints: Vec3[] } {
    const { rootTopZ, socketPos } = args;
    const orientedConstruction = orientJointsBaseToSocket(args.constructionJoints, rootTopZ, socketPos.z);
    const normalizedConstruction = filterStrictlyAscendingJoints(orientedConstruction, rootTopZ, socketPos.z);

    const routeLowerBoundZ = normalizedConstruction[normalizedConstruction.length - 1]?.z ?? rootTopZ;
    const orientedRoute = orientJointsBaseToSocket(args.routeJoints, routeLowerBoundZ, socketPos.z);
    const normalizedRoute = filterStrictlyAscendingJoints(orientedRoute, routeLowerBoundZ, socketPos.z);

    return {
        constructionJoints: normalizedConstruction,
        routeJoints: normalizedRoute,
    };
}

function buildTipProfile(
    settings: ReturnType<typeof getSettings>,
    overrides: TrunkBuildInput['overrides'],
): SupportTipProfile {
    return {
        type: 'disk',
        contactDiameterMm: overrides?.tipContactDiameterMm ?? settings.tip.contactDiameterMm,
        bodyDiameterMm: overrides?.tipBodyDiameterMm ?? settings.tip.bodyDiameterMm,
        lengthMm: overrides?.tipLengthMm ?? settings.tip.lengthMm,
        penetrationMm: settings.tip.penetrationMm,
        diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? (Math.PI / 4),
    };
}

export interface TrunkBuildInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    mesh?: THREE.Mesh;
    /** When true, uses a fast first-pass preview search and then parity-checks
     *  collision outcomes against click-time tolerances before surfacing errors. */
    isPreview?: boolean;
    overrides?: {
        rootsDiameterMm?: number;
        rootsDiskHeightMm?: number;
        rootsConeHeightMm?: number;
        shaftDiameterMm?: number;
        tipContactDiameterMm?: number;
        tipBodyDiameterMm?: number;
        tipLengthMm?: number;
        tipDiskLengthOverrideMm?: number;
    };
}

export interface TrunkBuildResult {
    root: Roots;
    trunk: Trunk;
    // For SupportBuilder (generic format)
    supportData: SupportData;
    route: TrunkRouteResult | SnappedTrunkRouteResult;
    error?: LimitationCode;
    warning?: WarningCode;
    /** True if the pathfinder stagnated (trapped in a cavity). */
    stagnated?: boolean;
    /** True if V2 exhausted its expansion budget without reaching the goal. */
    exhaustedBudget?: boolean;
}

/**
 * Build trunk data from a tip position and normal.
 * 
 * A trunk consists of:
 * - Roots (disk + cone + sphere at base)
 * - Route-driven shaft segments and joints
 * - ContactCone at the tip
 */
// ---------------------------------------------------------------------------
// Placement result cache — covers V2 A* + V1 fallback together.
// Multi-entry LRU per model (24 slots) avoids cache thrashing when the cursor
// sweeps through a transition zone at the 0.5mm quantisation boundary.
// ---------------------------------------------------------------------------
const PLACEMENT_CACHE_QUANT = 0.5; // mm — matches SDF cell size
const NORMAL_CACHE_QUANT = 0.05;   // ~2.9° buckets
const MAX_PLACEMENT_CACHE_ENTRIES = 24;

// Map<modelId, Map<cacheKey, result>> — insertion-ordered for FIFO eviction
type ModelPlacementCache = Map<string, TrunkPlacementResult>;
const placementCacheByModel = new Map<string, ModelPlacementCache>();

function placementCacheKey(tipPos: Vec3, tipNormal: Vec3): string {
    const Q = PLACEMENT_CACHE_QUANT;
    const NQ = NORMAL_CACHE_QUANT;
    return `${Math.round(tipPos.x / Q)},${Math.round(tipPos.y / Q)},${Math.round(tipPos.z / Q)},${Math.round(tipNormal.x / NQ)},${Math.round(tipNormal.y / NQ)},${Math.round(tipNormal.z / NQ)}`;
}

function getPlacementCache(modelId: string, key: string): TrunkPlacementResult | undefined {
    return placementCacheByModel.get(modelId)?.get(key);
}

function setPlacementCache(modelId: string, key: string, result: TrunkPlacementResult): void {
    let cache = placementCacheByModel.get(modelId);
    if (!cache) {
        cache = new Map();
        placementCacheByModel.set(modelId, cache);
    }
    if (cache.has(key)) {
        // Re-insert to promote to newest (for FIFO correctness)
        cache.delete(key);
    } else if (cache.size >= MAX_PLACEMENT_CACHE_ENTRIES) {
        // Evict oldest entry (first inserted)
        cache.delete(cache.keys().next().value!);
    }
    cache.set(key, result);
}

/** Clear cached placement for a specific model (call when model moves). */
export function clearPlacementCache(modelId?: string): void {
    if (modelId) placementCacheByModel.delete(modelId);
    else placementCacheByModel.clear();
}

export function buildTrunkData(input: TrunkBuildInput): TrunkBuildResult {
    const { tipPos, tipNormal, modelId, mesh, overrides, isPreview } = input;

    // Placement computation always runs (no cache). This ensures preview and click
    // use consistent logic and settings, preventing the mismatches that occurred
    // when coarse preview results were cached and reused for click placement.

    // Read current settings
    const settings = getSettings();
    const tipProfile = buildTipProfile(settings, overrides);
    const diskHeight = overrides?.rootsDiskHeightMm ?? settings.roots.diskHeightMm;
    const coneHeight = overrides?.rootsConeHeightMm ?? settings.roots.coneHeightMm;

    // Roots dimensions
    const rootsTopZ = diskHeight + coneHeight; // Where the Roots sphere center is

    // Calculate Placement
    // If mesh is provided, use SmartPlacement (which handles collision).
    // Otherwise fallback to StandardPlacement.
    const placementInput = {
        tipPos,
        tipNormal,
        tipProfile,
        rootsTopZ
    };

    let placement: TrunkPlacementResult;
    if (mesh) {
        // V2 grid A* pathfinder (SDF-backed).
        // Both preview and click use FULL collision checks to ensure consistent safety.
        // Preview uses lower budget (1200 expansions) for responsiveness, but same
        // collision detection rigor as click. This trades slightly slower preview
        // exploration for correct collision avoidance.
        const v2Context = isPreview ? { maxExpansions: 1200 } : undefined;
        const result = calculateSmartPlacementV2({ ...placementInput, mesh, modelId }, v2Context);
        placement = result;
    } else {
        placement = calculateStandardPlacement(placementInput);
    }

    return buildTrunkDataFromPlacement(input, placement);
}

export function buildTrunkDataFromPlacement(input: TrunkBuildInput, placement: TrunkPlacementResult): TrunkBuildResult {
    const { tipPos, tipNormal, modelId, overrides, mesh } = input;
    const settings = getSettings();
    const settingsCodeHex = encodeSupportSettingsHex(settings);
    const tipProfile = buildTipProfile(settings, overrides);
    const tipDiskLengthOverrideMm = overrides?.tipDiskLengthOverrideMm;
    const shaftDiameter = overrides?.shaftDiameterMm ?? settings.shaft.diameterMm;
    const rootsDiameter = overrides?.rootsDiameterMm ?? settings.roots.diameterMm;
    const diskHeight = overrides?.rootsDiskHeightMm ?? settings.roots.diskHeightMm;
    const coneHeight = overrides?.rootsConeHeightMm ?? settings.roots.coneHeightMm;
    const effectiveConeAxis = placement.coneAxis ?? tipNormal;
    const diskThickness = tipProfile.type === 'disk'
        ? (tipDiskLengthOverrideMm ?? calculateDiskThickness(tipNormal, effectiveConeAxis, tipProfile))
        : 0;

    const coneStartPos = {
        x: tipPos.x + tipNormal.x * diskThickness,
        y: tipPos.y + tipNormal.y * diskThickness,
        z: tipPos.z + tipNormal.z * diskThickness,
    };

    const liveSocketPos = getSocketPosition(coneStartPos, effectiveConeAxis, tipProfile);
    const solverSocketPos = placement.socketPos ?? liveSocketPos;
    const solverSocketDeltaSq =
        (solverSocketPos.x - liveSocketPos.x) ** 2
        + (solverSocketPos.y - liveSocketPos.y) ** 2
        + (solverSocketPos.z - liveSocketPos.z) ** 2;
    const contactConeTemplate: ContactCone = recomputeContactConeForMovedDisk(
        {
            id: '__solver-authored-socket__',
            pos: tipPos,
            normal: effectiveConeAxis,
            surfaceNormal: tipNormal,
            diskLengthOverride: tipDiskLengthOverrideMm,
            profile: tipProfile,
        },
        tipPos,
        tipNormal,
        solverSocketPos,
        mesh,
    );
    const resolvedSocketPos = getFinalSocketPosition(contactConeTemplate);
    const rootsTopZ = diskHeight + coneHeight;
    const authoredRouteJoints = placement.joints ? [...placement.joints] : [];
    const authoredConstructionJoints = placement.constructionJoints ? [...placement.constructionJoints] : [];
    const normalizedAuthoredChains = normalizeTrunkJointChain({
        rootTopZ: rootsTopZ,
        socketPos: resolvedSocketPos,
        routeJoints: authoredRouteJoints,
        constructionJoints: authoredConstructionJoints,
    });
    const routeJoints = normalizedAuthoredChains.routeJoints;
    const isStraightSupport = routeJoints.length === 0;
    const initialConstructionJoints = normalizedAuthoredChains.constructionJoints;
    const fallbackConstructionJoints = isStraightSupport
        ? withCentralStraightSupportJoint({
            basePos: placement.basePos,
            rootTopZ: rootsTopZ,
            socketPos: resolvedSocketPos,
        })
        : initialConstructionJoints;
    const normalizedConstructionJoints = normalizeFirstConstructionJoint({
        basePos: placement.basePos,
        rootTopZ: rootsTopZ,
        socketPos: resolvedSocketPos,
        routeJoints,
        constructionJoints: initialConstructionJoints.length > 0
            ? initialConstructionJoints
            : fallbackConstructionJoints,
    });
    const normalizedJointChains = normalizeTrunkJointChain({
        rootTopZ: rootsTopZ,
        socketPos: resolvedSocketPos,
        routeJoints,
        constructionJoints: normalizedConstructionJoints,
    });
    const finalRouteJoints = normalizedJointChains.routeJoints;
    const finalConstructionJoints = normalizedJointChains.constructionJoints;
    const finalIsStraightSupport = finalRouteJoints.length === 0;

    const routeBase: TrunkRouteResult = {
        kind: finalIsStraightSupport ? 'straight' : 'routed',
        basePos: placement.basePos,
        socketPos: resolvedSocketPos,
        unsnappedBottomPos: placement.unsnappedBottomPos ?? placement.basePos,
        joints: finalRouteJoints,
        constructionJoints: finalConstructionJoints,
        validity: placement.error ? 'hard_invalid' : 'valid',
        error: placement.error,
        warning: placement.warning,
        angle: placement.angle,
        coneAxis: effectiveConeAxis,
    };
    const route: TrunkRouteResult | SnappedTrunkRouteResult = placement.snappedNodeKey
        ? {
            ...routeBase,
            snappedNodeKey: placement.snappedNodeKey,
            snappedRootPos: settings.grid.enabled
                ? {
                    ...gridSnappedXYFromKey(placement.snappedNodeKey, settings.grid.spacingMm),
                    z: routeBase.basePos.z,
                }
                : routeBase.basePos,
            snappedValidity: placement.error
                ? 'hard_invalid'
                : routeBase.unsnappedBottomPos.x === routeBase.basePos.x && routeBase.unsnappedBottomPos.y === routeBase.basePos.y
                    ? 'valid'
                    : 'invalid_assisted',
            validity: placement.error
                ? 'hard_invalid'
                : routeBase.unsnappedBottomPos.x === routeBase.basePos.x && routeBase.unsnappedBottomPos.y === routeBase.basePos.y
                    ? 'valid'
                    : 'route_invalid',
        }
        : routeBase;

    const { basePos, socketPos, joints, constructionJoints, error, warning, angle } = route;
    const routeJointPositions: Vec3[] = [...joints];
    const constructionJointPositions: Vec3[] = [...constructionJoints];
    const jointPositions: Vec3[] = [...constructionJointPositions, ...routeJointPositions];

    // Generate IDs
    const rootId = uuidv4();
    const trunkId = uuidv4();
    const contactConeId = uuidv4();
    // NEW: Generate a dedicated ID for the socket joint to ensure it is distinct from the knee.
    const socketJointId = uuidv4();

    const jointDiameter = getJointDiameter(shaftDiameter);

    // Build Joints and Segments
    // We need N joints and N+1 segments.
    // Strategy:
    // 1. Create Joint entities.
    // 2. Create Top Segment (connects to ContactCone, no topJoint).
    // 3. Create descending segments (each connects to the joint above it).

    const createdJoints: Joint[] = [];
    const createdSegments: Segment[] = [];

    // 1. Create Joints
    jointPositions.forEach(pos => {
        createdJoints.push({
            id: uuidv4(),
            pos,
            diameter: jointDiameter
        });
    });

    // NEW: Calculate Socket Joint Position and Create it
    const socketJoint: Joint = {
        id: socketJointId,
        pos: socketPos,
        diameter: jointDiameter
    };

    // 2. Create Segments
    if (finalIsStraightSupport && createdJoints.length === 1) {
        createdSegments.push({
            id: uuidv4(),
            diameter: shaftDiameter,
            topJoint: createdJoints[0]
        });
        createdSegments.push({
            id: uuidv4(),
            diameter: shaftDiameter,
            bottomJoint: createdJoints[0],
            topJoint: socketJoint
        });
    } else {
        createdJoints.forEach((joint, index) => {
            createdSegments.push({
                id: uuidv4(),
                diameter: shaftDiameter,
                bottomJoint: index > 0 ? createdJoints[index - 1] : undefined,
                topJoint: joint
            });
        });

        createdSegments.push({
            id: uuidv4(),
            diameter: shaftDiameter,
            bottomJoint: createdJoints.length > 0 ? createdJoints[createdJoints.length - 1] : undefined,
            topJoint: socketJoint
        });
    }

    // Build Root
    const root: Roots = {
        id: rootId,
        modelId: modelId, // Link to model
        transform: {
            pos: basePos,
            rot: { x: 0, y: 0, z: 0, w: 1 }
        },
        diameter: rootsDiameter,
        diskHeight: diskHeight,
        coneHeight: coneHeight
    };

    // Build ContactCone
    const contactCone: ContactCone = {
        ...contactConeTemplate,
        id: contactConeId,
        socketJointId: socketJointId,
    };

    // Build Trunk
    const trunk: Trunk = {
        id: trunkId,
        modelId: modelId, // Link to model
        settingsCodeHex,
        rootId: rootId,
        baseDiameterMm: shaftDiameter,
        segments: createdSegments,
        contactCone: contactCone
    };

    // Build generic SupportData for SupportBuilder
    const supportData: SupportData = {
        id: trunkId,
        roots: root,
        segments: createdSegments,
        contactCone: contactCone,
        error: error,
        warning: warning,
        angle: angle // Required for gradient color
    };

    return { root, trunk, supportData, route, error, warning, stagnated: placement.stagnated, exhaustedBudget: placement.exhaustedBudget };
}
