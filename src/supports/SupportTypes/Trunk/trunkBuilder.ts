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
import { calculateStandardPlacement } from '../../PlacementLogic/StandardPlacement';
import { calculateSmartPlacement } from '../../PlacementLogic/SmartPlacement';
import type { LimitationCode, WarningCode } from '../../types';

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
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
        jointCount?: number;
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
    error?: LimitationCode;
    warning?: WarningCode;
}

/**
 * Build trunk data from a tip position and normal.
 * 
 * A trunk consists of:
 * - Roots (disk + cone + sphere at base)
 * - 2 Segments with 1 Joint between them
 * - ContactCone at the tip
 */
export function buildTrunkData(input: TrunkBuildInput): TrunkBuildResult {
    const { tipPos, tipNormal, modelId, mesh, overrides } = input;

    // Read current settings
    const settings = getSettings();
    const contactDiameter = overrides?.tipContactDiameterMm ?? settings.tip.contactDiameterMm;
    const length = overrides?.tipLengthMm ?? settings.tip.lengthMm;
    const tipDiskLengthOverrideMm = overrides?.tipDiskLengthOverrideMm;

    const tipProfile: SupportTipProfile = {
        type: 'disk', // Updated from 'cone' to match new type definition
        contactDiameterMm: contactDiameter,
        bodyDiameterMm: overrides?.tipBodyDiameterMm ?? settings.tip.bodyDiameterMm,
        lengthMm: length,
        penetrationMm: settings.tip.penetrationMm,
        // Disk-specific props (dynamic standoff). Do NOT hardcode preview values here.
        // Preview-only visuals should use `diskLengthOverride` instead.
        diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? (Math.PI / 4)
    };

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

    const placement = mesh
        ? calculateSmartPlacement({ ...placementInput, mesh, modelId })
        : calculateStandardPlacement(placementInput);

    const { basePos, socketPos: placementSocketPos, joints, jointPos, error, warning, angle, coneAxis } = placement;

    // Normalize joints list (Top to Bottom order expected from SmartPlacement)
    // If SmartPlacement provided joints, use them.
    // Otherwise, generate joints based on the 'jointCount' setting.
    let jointPositions: Vec3[] = joints || (jointPos ? [jointPos] : []);

    if (!joints) {
        // Standard/Preview Placement Strategy with Joint Count
        const count = overrides?.jointCount ?? settings.joint.defaultJointCount;

        if (count > 0) {
            // Need to clear the legacy single joint if we are generating multiple
            // But if count is explicitly requested, we probably want to ignore the 'jointPos' derived from StandardPlacement default.
            // StandardPlacement returns 1 joint by default.
            // If we have an override count, we should replace it.
            jointPositions = []; // Reset

            // Distribute 'count' joints evenly between Roots Top and Socket Bottom
            const startZ = rootsTopZ;
            const endZ = placementSocketPos.z;
            const totalHeight = endZ - startZ;

            // We want 'count' internal points.
            // Segments = count + 1.
            // Step = totalHeight / (count + 1).
            const step = totalHeight / (count + 1);

            for (let i = 1; i <= count; i++) {
                jointPositions.push({
                    x: basePos.x,
                    y: basePos.y,
                    z: startZ + (step * i)
                });
            }
        }

        // Ensure consistent order. 
        // Logic below creates segments connected to topJoints using this array.
        // It creates joints, then segments. 
        // Lower segments logic: createdJoints.forEach(joint => push segment)
        // If jointPositions is [Bottom, ..., Top]
        // createdJoints is [Bottom, ..., Top]
        // segment 1: topJoint = BottomJoint. This is the Very Bottom Segment? No.
        // The logic at line 204: topJoint = joint.
        // This segment connects FROM ??? TO 'joint'.
        // Wait, line 204 loops createdJoints.
        // createSegments has Top Segment (Socket -> ?).
        // Then subsequent segments connect to these joints.

        // Let's trace Standard logic (1 joint):
        // jointPos = middle.
        // jointPositions = [middle].
        // createdJoints = [middle].
        // Top Seg: Socket -> First Knee? (Wait, logic line 154 says topJoint: socketJoint).
        // That Top Seg (id X) has topJoint=SocketJoint. It has NO bottomJoint specified?
        // Ah, Trunk Renderer/Data structure usually implies segments span between joints.

        // Actually, SupportBuilder sees 'topJoint' property on a segment.
        // It assumes segment goes TO that topJoint? 
        // Line 208 in SupportBuilder: if (seg.topJoint) endPoint = seg.topJoint.pos.
        // So 'topJoint' means the UPPER END of the segment.

        // Back to trunkBuilder:
        // Top Segment (line 196): topJoint = SocketJoint. 
        // This means it ends at the socket. Where does it start?
        // SupportBuilder logic: currentStart = Roots Top (initially).
        // Then it iterates segments.
        // Segment 1 (Top Seg): ends at Socket. Starts at Roots.
        // That draws ONE segment from Roots to Socket.

        // Lower Segments (line 204):
        // For each createdJoint (knee), make a segment with topJoint = knee.
        // So this segment ends at the knee.
        // Where does it start? SupportBuilder daisy-chains.

        // ORDER MATTERS IN SUPPORTBUILDER.
        // SupportBuilder iterates data.segments array.
        // 1. currentStart = Roots Top.
        // 2. data.segments[0]. Ends at topJoint. Draws line Start->End. Start becomes End.
        // 3. data.segments[1]. Ends at its topJoint. Draws line Start->End.

        // So segments must be ordered Bottom -> Top for SupportBuilder to draw correctly 
        // (if it starts at roots).

        // Let's look at trunkBuilder line 214: createdSegments.reverse().
        // BEFORE REVERSE:
        // [Top Segment (ends at Socket)]
        // [Seg (ends at Joint 1)]
        // [Seg (ends at Joint 2)]

        // AFTER REVERSE:
        // [Seg (ends at Joint 2), Seg (ends at Joint 1), Top Segment (ends at Socket)]

        // This implies SupportBuilder processes Bottom -> Top.
        // So the first segment should end at the LOWEST joint.
        // The last segment should end at the SOCKET.

        // So we need:
        // Joint 1 = Lowest. Joint 2 = Higher.
        // Segments: 
        // - Seg A ends at Joint 1.
        // - Seg B ends at Joint 2.
        // - TopSeg ends at Socket.

        // If we push Segments in order: TopSeg, then JointSegs.
        // We want JointSegs to correspond to joints Top -> Bottom?
        // If createdJoints is [J_top, J_mid, J_bot]
        // Segments created: TopSeg(Socket), Seg(J_top), Seg(J_mid), Seg(J_bot).
        // Reverse: Seg(J_bot), Seg(J_mid), Seg(J_top), TopSeg(Socket).
        // This looks correct.

        // So createdJoints should be ordered Top -> Bottom (High Z -> Low Z).
        // jointPositions should be Top -> Bottom.

        // My loop generates 1..count (Low -> High).
        // So I need to reverse it to be Top -> Bottom.
        jointPositions.reverse();
    }

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

    // 2. Create Top Segment (Socket Joint -> First Knee Joint)
    createdSegments.push({
        id: uuidv4(),
        diameter: shaftDiameter,
        topJoint: socketJoint // Explicit connection to the Socket Joint
    });

    // 3. Create Lower Segments
    // Each knee joint spawns a segment below it.
    createdJoints.forEach(joint => {
        createdSegments.push({
            id: uuidv4(),
            diameter: shaftDiameter,
            topJoint: joint
        });
    });

    // Current order: [Top, NextDown, ..., Bottom]
    // Standard format expects [Bottom, Top] order (mostly convention, but good to preserve)
    createdSegments.reverse();

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

    return { root, trunk, supportData, error, warning };
}
