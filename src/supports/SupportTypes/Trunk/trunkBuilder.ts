/**
 * Trunk Builder
 * 
 * Defines what a trunk is made of and builds the data structure.
 * Used for both preview and placement (same function, no duplication).
 */

import * as THREE from 'three';
import { Vec3, Roots, Trunk, Segment, Joint } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getJointDiameter } from '../../constants';
import { getSettings } from '../../Settings';
import type { SupportData } from '../../rendering/SupportBuilder';
import { calculateStandardPlacement, type TrunkPlacementResult } from '../../PlacementLogic/StandardPlacement';
import { calculateSmartPlacement } from '../../PlacementLogic/SmartPlacement';
import { calculateSmartPlacementV2, getOrCreateSDFCache } from '../../PlacementLogic/Pathfinding';
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
}

/**
 * Build trunk data from a tip position and normal.
 * 
 * A trunk consists of:
 * - Roots (disk + cone + sphere at base)
 * - Route-driven shaft segments and joints
 * - ContactCone at the tip
 */
export function buildTrunkData(input: TrunkBuildInput): TrunkBuildResult {
    const { tipPos, tipNormal, modelId, mesh, overrides } = input;

    // Read current settings
    const settings = getSettings();
    const tipProfile = buildTipProfile(settings, overrides);
    const tipDiskLengthOverrideMm = overrides?.tipDiskLengthOverrideMm;

    const shaftDiameter = overrides?.shaftDiameterMm ?? settings.shaft.diameterMm;
    const rootsDiameter = overrides?.rootsDiameterMm ?? settings.roots.diameterMm;
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
        // V2 grid A* pathfinder (SDF-backed, no raycast bundles)
        const v2Result = calculateSmartPlacementV2({ ...placementInput, mesh, modelId });
        if (v2Result.error === 'COLLISION_WITH_MODEL') {
            // Fallback to V1 raycast-based search, then SDF post-validate.
            // V1 uses 9-ray bundles which have gaps — verify every segment
            // of V1's result against the SDF before accepting it.
            const v1Result = calculateSmartPlacement({ ...placementInput, mesh, modelId });
            if (v1Result.error) {
                placement = v1Result; // V1 also failed — pass error through
            } else {
                const sdf = getOrCreateSDFCache(mesh);
                sdf.refreshMatrix();
                const shaftRadius = settings.shaft.diameterMm / 2;
                const sdfClearance = shaftRadius + 0.25;
                // Build the chain: rootTopTarget → joints → socketPos
                const v1RootTop: Vec3 = { x: v1Result.basePos.x, y: v1Result.basePos.y, z: rootsTopZ };
                const v1Chain: Vec3[] = [
                    v1RootTop,
                    ...(v1Result.joints ?? []),
                    v1Result.socketPos,
                ];
                let v1Clips = false;
                for (let i = 0; i < v1Chain.length - 1; i++) {
                    const a = v1Chain[i];
                    const b = v1Chain[i + 1];
                    if (sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, sdfClearance)) {
                        v1Clips = true;
                        break;
                    }
                }
                if (v1Clips) {
                    // V1's path clips the model — reject it
                    placement = { ...v1Result, error: 'COLLISION_WITH_MODEL' };
                } else {
                    placement = v1Result;
                }
            }
        } else {
            placement = v2Result;
        }
    } else {
        placement = calculateStandardPlacement(placementInput);
    }

    return buildTrunkDataFromPlacement(input, placement);
}

export function buildTrunkDataFromPlacement(input: TrunkBuildInput, placement: TrunkPlacementResult): TrunkBuildResult {
    const { tipPos, tipNormal, modelId, overrides } = input;
    const settings = getSettings();
    const settingsCodeHex = encodeSupportSettingsHex(settings);
    const tipProfile = buildTipProfile(settings, overrides);
    const tipDiskLengthOverrideMm = overrides?.tipDiskLengthOverrideMm;
    const shaftDiameter = overrides?.shaftDiameterMm ?? settings.shaft.diameterMm;
    const rootsDiameter = overrides?.rootsDiameterMm ?? settings.roots.diameterMm;
    const diskHeight = overrides?.rootsDiskHeightMm ?? settings.roots.diskHeightMm;
    const coneHeight = overrides?.rootsConeHeightMm ?? settings.roots.coneHeightMm;
    const rootsTopZ = diskHeight + coneHeight;
    const routeJoints = placement.joints ? [...placement.joints] : [];
    const isStraightSupport = routeJoints.length === 0;
    const initialConstructionJoints = placement.constructionJoints ? [...placement.constructionJoints] : [];
    const fallbackConstructionJoints = isStraightSupport
        ? withCentralStraightSupportJoint({
            basePos: placement.basePos,
            rootTopZ: rootsTopZ,
            socketPos: placement.socketPos,
        })
        : initialConstructionJoints;
    const normalizedConstructionJoints = normalizeFirstConstructionJoint({
        basePos: placement.basePos,
        rootTopZ: rootsTopZ,
        socketPos: placement.socketPos,
        routeJoints,
        constructionJoints: initialConstructionJoints.length > 0
            ? initialConstructionJoints
            : fallbackConstructionJoints,
    });

    const routeBase: TrunkRouteResult = {
        kind: isStraightSupport ? 'straight' : 'routed',
        basePos: placement.basePos,
        socketPos: placement.socketPos,
        unsnappedBottomPos: placement.unsnappedBottomPos ?? placement.basePos,
        joints: routeJoints,
        constructionJoints: normalizedConstructionJoints,
        validity: placement.error ? 'hard_invalid' : 'valid',
        error: placement.error,
        warning: placement.warning,
        angle: placement.angle,
        coneAxis: placement.coneAxis,
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

    const { basePos, socketPos: placementSocketPos, joints, constructionJoints, error, warning, angle, coneAxis } = route;
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
    // We need to account for the primitive thickness (offset) just like the Renderer does.
    const effectiveConeAxis = coneAxis ?? tipNormal;
    const diskThickness = tipProfile.type === 'disk'
        ? (tipDiskLengthOverrideMm ?? calculateDiskThickness(tipNormal, effectiveConeAxis, tipProfile))
        : 0;

    const coneStartPos = {
        x: tipPos.x + tipNormal.x * diskThickness,
        y: tipPos.y + tipNormal.y * diskThickness,
        z: tipPos.z + tipNormal.z * diskThickness,
    };

    const socketPos = placementSocketPos ?? getSocketPosition(coneStartPos, effectiveConeAxis, tipProfile);
    const socketJoint: Joint = {
        id: socketJointId,
        pos: socketPos,
        diameter: jointDiameter
    };

    // 2. Create Segments
    if (isStraightSupport && createdJoints.length === 1) {
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
        id: contactConeId,
        pos: tipPos,
        normal: effectiveConeAxis, // Cone axis may differ from surface normal due to tilt rules
        surfaceNormal: tipNormal, // The actual surface normal
        diskLengthOverride: tipDiskLengthOverrideMm,
        profile: tipProfile,
        socketJointId: socketJointId // Link to unique socket ID
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

    return { root, trunk, supportData, route, error, warning };
}
