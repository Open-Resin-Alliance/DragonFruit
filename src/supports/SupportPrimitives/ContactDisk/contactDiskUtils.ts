import * as THREE from 'three';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';

/**
 * Calculates the thickness of the contact disk ("nib") based on cone angle relative to surface.
 * 
 * Logic:
 * - Ideally perpendicular (Cone Axis aligned with Surface Normal) -> Min thickness.
 * - Steeper angle -> Thicker disk to prevent cone body from clipping into wall.
 */
export function calculateDiskThickness(
    surfaceNormal: Vec3,
    coneAxis: Vec3, // The direction the cone is pointing (usually towards the socket)
    profile: ContactDiskProfile
): number {
    const n = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z).normalize();
    const axis = new THREE.Vector3(coneAxis.x, coneAxis.y, coneAxis.z).normalize();
    
    // Angle between Surface Normal and Cone Axis
    // 0 = Perfectly Perpendicular (Cone pointing straight out)
    // 90 = Parallel to surface (Bad)
    const angle = n.angleTo(axis);
    
    // Threshold: When do we start extending?
    // profile.standoffAngleThreshold is likely in radians.
    // e.g. 45 degrees.
    
    // SAFETY CHECK: Fallback for legacy profiles or missing props
    if (!profile) {
        return 0.1; // Default min thickness
    }

    const threshold = profile.standoffAngleThreshold ?? (Math.PI / 4);
    const minThickness = profile.diskThicknessMm ?? 0.1;
    
    // SMART LEGACY FIX: 
    // If maxStandoff is exactly 1.5 (old default), clamp it to 0.35.
    // If it's anything else (user customized), use it directly.
    const rawMax = profile.maxStandoffMm ?? 1.5;
    const maxStandoff = (rawMax === 1.5) ? 0.35 : rawMax;

    if (angle <= threshold) {
        return minThickness;
    }
    
    // Interpolate
    // We want to cap expansion at some max angle (e.g. 80 degrees?)
    // Let's assume max extension is reached at 70 degrees or so?
    // Or just linear map from Threshold to 90deg?
    
    const maxAngle = Math.PI / 2 * 0.9; // ~81 deg
    
    // Clamp angle
    const effectiveAngle = Math.min(angle, maxAngle);
    
    const t = (effectiveAngle - threshold) / (maxAngle - threshold);
    const factor = Math.max(0, Math.min(1, t));
    
    // Lerp
    return minThickness + factor * (maxStandoff - minThickness);
}

/**
 * Get the center position for the disk.
 * The disk is centered at: pos + (normal * thickness/2)
 */
export function getDiskCenter(
    pos: Vec3,
    normal: Vec3,
    thickness: number
): Vec3 {
    return {
        x: pos.x + normal.x * (thickness / 2),
        y: pos.y + normal.y * (thickness / 2),
        z: pos.z + normal.z * (thickness / 2),
    };
}

/**
 * Get Quaternion to align cylinder Y-axis with Normal.
 */
export function getDiskRotation(normal: Vec3): THREE.Quaternion {
    const alignVector = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const defaultUp = new THREE.Vector3(0, 1, 0); // Cylinder default axis
    return new THREE.Quaternion().setFromUnitVectors(defaultUp, alignVector);
}
