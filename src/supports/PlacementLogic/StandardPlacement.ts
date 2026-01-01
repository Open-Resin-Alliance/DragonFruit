import * as THREE from 'three';
import { Vec3, LimitationCode, WarningCode } from '../types';
import type { SupportTipProfile } from '../SupportPrimitives/ContactCone/types';
import { getSocketPosition } from '../SupportPrimitives/ContactCone';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getSettings } from '../Settings';
import { resolveConeAxisPolicy } from './ConeAxisPolicy';

export interface TrunkPlacementInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    tipProfile: SupportTipProfile;
    rootsTopZ: number; // Height where the root ends and shaft begins
}

export interface TrunkPlacementResult {
    basePos: Vec3;
    socketPos: Vec3;
    jointPos?: Vec3; // Legacy/Standard single joint
    joints?: Vec3[]; // New: List of all joints for multi-segment paths
    error?: LimitationCode; // Block placement
    warning?: WarningCode; // Allow with warning
    angle?: number; // Surface angle in degrees (0=Up, 90=Vert, 180=Down)
    coneAxis?: Vec3; // Cone axis used for socket placement (may differ from surface normal)
}

/**
 * Standard Placement Strategy:
 * - Base is placed directly below the socket (vertical drop).
 * - Joint is placed at the midpoint between the roots and the socket.
 * - Ignores surface normal for direction (always vertical).
 * - Checks angle:
 *   - < 90 deg (Upward): Error.
 *   - 90-100 deg (Vertical/Horizontal): Warning.
 *   - > 100 deg (Downward): OK.
 */
export function calculateStandardPlacement(input: TrunkPlacementInput): TrunkPlacementResult {
    const { tipPos, tipNormal, tipProfile, rootsTopZ } = input;
    let error: LimitationCode | undefined;
    let warning: WarningCode | undefined;

    // 0. Check Surface Angle
    // Normal points OUT of the mesh.
    // Up = (0,0,1).
    // Angle 0 = Facing Up.
    // Angle 90 = Vertical Wall.
    // Angle 180 = Facing Down.
    
    const settings = getSettings();
    const coneAngleMode = settings.tip.coneAngleMode ?? 'normal';
    const adaptiveConeAngleOffsetDeg = settings.tip.adaptiveConeAngleOffsetDeg ?? 30;

    const { coneAxis, surfaceAngleFromUpDeg, minAllowedSurfaceAngleFromUpDeg } = resolveConeAxisPolicy({
        surfaceNormal: tipNormal,
        coneAngleMode,
        adaptiveConeAngleOffsetDeg,
    });

    if (surfaceAngleFromUpDeg < minAllowedSurfaceAngleFromUpDeg) {
        // Upward facing (or effectively flat/up/vertical)
        error = 'ANGLE_TOO_STEEP';
    } else if (surfaceAngleFromUpDeg <= 115) {
        // Vertical wall (Horizontal normal) to 30-degree overhang -> Warning
        // "Horizontal angles are not good for holding up supports..."
        warning = 'ANGLE_VERTICAL_WARNING';
    }

    // 1. Calculate Socket Position (where shaft connects to cone)
    let diskThickness = 0;
    if (tipProfile.type === 'disk') {
        diskThickness = calculateDiskThickness(tipNormal, coneAxis, tipProfile);
    }

    const coneStartPos: Vec3 = {
        x: tipPos.x + tipNormal.x * diskThickness,
        y: tipPos.y + tipNormal.y * diskThickness,
        z: tipPos.z + tipNormal.z * diskThickness,
    };

    const socketPos = getSocketPosition(coneStartPos, coneAxis, tipProfile);

    // 2. Calculate Base Position
    // Updated Behavior: Vertical drop from the SOCKET position.
    // This aligns the trunk center with the joint where the shaft meets the cone.
    const basePos: Vec3 = { 
        x: socketPos.x, 
        y: socketPos.y, 
        z: 0 
    };

    // 3. Calculate Joint Position
    // Default: Midpoint between roots top and socket
    const jointZ = (rootsTopZ + socketPos.z) / 2;
    
    // Ensure joint is not below roots or above socket
    const safeJointZ = Math.max(rootsTopZ, Math.min(jointZ, socketPos.z));

    const jointPos: Vec3 = { 
        x: basePos.x, 
        y: basePos.y, 
        z: safeJointZ 
    };

    return {
        basePos,
        socketPos,
        jointPos,
        error,
        warning,
        angle: surfaceAngleFromUpDeg, // Verified
        coneAxis
    };
}
