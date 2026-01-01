import * as THREE from 'three';
import { Vec3 } from '../../types';
import { SupportTipProfile, DEFAULT_TIP_PROFILE } from './types';

import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { ContactCone } from './types';

/**
 * Calculate the socket position (where the cone connects to the joint).
 * The socket is at pos + normal * length.
 */
export function getSocketPosition(
    contactPos: Vec3,
    normal: Vec3,
    profile: SupportTipProfile = DEFAULT_TIP_PROFILE
): Vec3 {
    return {
        x: contactPos.x + normal.x * profile.lengthMm,
        y: contactPos.y + normal.y * profile.lengthMm,
        z: contactPos.z + normal.z * profile.lengthMm,
    };
}

/**
 * Calculates the FINAL, effective socket position for a Contact Cone.
 * This accounts for:
 * 1. The base surface position.
 * 2. The primitive offset (Contact Disk thickness) along the surface normal.
 * 3. The cone body length along the cone axis.
 */
export function getFinalSocketPosition(cone: ContactCone): Vec3 {
    const { pos, normal, surfaceNormal, profile } = cone;
    
    // Fallback surface normal
    const effectiveSurfaceNormal = surfaceNormal || normal;
    
    // 1. Calculate Primitive Thickness (Offset)
    let offset = 0;
    if (profile.type === 'disk') {
        if (cone.diskLengthOverride !== undefined) {
            offset = cone.diskLengthOverride;
        } else {
            offset = calculateDiskThickness(effectiveSurfaceNormal, normal, profile);
        }
    }

    // 2. Calculate Start of Cone Body (offset from surface)
    // The disk pushes OUT along the surface normal.
    const startPos = {
        x: pos.x + effectiveSurfaceNormal.x * offset,
        y: pos.y + effectiveSurfaceNormal.y * offset,
        z: pos.z + effectiveSurfaceNormal.z * offset
    };
    
    // 3. Calculate End of Cone Body (Socket)
    // The cone extends along the cone axis (normal).
    return getSocketPosition(startPos, normal, profile);
}

/**
 * Calculate the cone's center position (midpoint between contact and socket).
 */
export function getConeCenterPosition(
    contactPos: Vec3,
    normal: Vec3,
    profile: SupportTipProfile = DEFAULT_TIP_PROFILE
): Vec3 {
    const halfLength = profile.lengthMm / 2;
    return {
        x: contactPos.x + normal.x * halfLength,
        y: contactPos.y + normal.y * halfLength,
        z: contactPos.z + normal.z * halfLength,
    };
}

/**
 * Calculate the quaternion to orient the cone.
 * Three.js CylinderGeometry is Y-up by default.
 * We need to rotate so Y aligns with -normal (cone points into model).
 */
export function getConeQuaternion(normal: Vec3): THREE.Quaternion {
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(normal.x, normal.y, normal.z).negate();
    return new THREE.Quaternion().setFromUnitVectors(up, dir);
}

/**
 * Get the penetration-adjusted contact position.
 * Pushes the contact face slightly into the model along the axis.
 */
export function getPenetratedContactPosition(
    contactPos: Vec3,
    normal: Vec3,
    profile: SupportTipProfile = DEFAULT_TIP_PROFILE
): Vec3 {
    const pen = profile.penetrationMm;
    return {
        x: contactPos.x - normal.x * pen,
        y: contactPos.y - normal.y * pen,
        z: contactPos.z - normal.z * pen,
    };
}
