import * as THREE from 'three';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';

const DEFAULT_MIN_DISK_THICKNESS_MM = 0.1;
const DEFAULT_STANDOFF_ANGLE_THRESHOLD_RAD = Math.PI / 4;
const DEFAULT_LEGACY_MAX_STANDOFF_MM = 1.5;
const DEFAULT_LEGACY_CLAMPED_MAX_STANDOFF_MM = 0.35;
const MAX_STANDOFF_ANGLE_RAD = Math.PI * 0.5 * 0.9; // ~81°
const EPS = 1e-8;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

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
    // SAFETY CHECK: Fallback for legacy profiles or missing props
    if (!profile) {
        return DEFAULT_MIN_DISK_THICKNESS_MM;
    }

    const threshold = profile.standoffAngleThreshold ?? DEFAULT_STANDOFF_ANGLE_THRESHOLD_RAD;
    const minThickness = profile.diskThicknessMm ?? DEFAULT_MIN_DISK_THICKNESS_MM;
    
    // SMART LEGACY FIX: 
    // If maxStandoff is exactly 1.5 (old default), clamp it to 0.35.
    // If it's anything else (user customized), use it directly.
    const rawMax = profile.maxStandoffMm ?? DEFAULT_LEGACY_MAX_STANDOFF_MM;
    const maxStandoff = (rawMax === DEFAULT_LEGACY_MAX_STANDOFF_MM)
        ? DEFAULT_LEGACY_CLAMPED_MAX_STANDOFF_MM
        : rawMax;
    const maxThickness = Math.max(minThickness, maxStandoff);

    const nx = surfaceNormal.x;
    const ny = surfaceNormal.y;
    const nz = surfaceNormal.z;
    const ax = coneAxis.x;
    const ay = coneAxis.y;
    const az = coneAxis.z;

    const nLenSq = nx * nx + ny * ny + nz * nz;
    const aLenSq = ax * ax + ay * ay + az * az;

    if (nLenSq < EPS || aLenSq < EPS) {
        return minThickness;
    }

    // Angle between Surface Normal and Cone Axis
    // 0 = Perfectly Perpendicular (Cone pointing straight out)
    // 90 = Parallel to surface (Bad)
    const invMag = 1 / Math.sqrt(nLenSq * aLenSq);
    const dot = (nx * ax + ny * ay + nz * az) * invMag;
    const clampedDot = Math.max(-1, Math.min(1, dot));
    const angle = Math.acos(clampedDot);

    if (angle <= threshold) {
        return minThickness;
    }
    
    // Interpolate
    // We want to cap expansion at some max angle (e.g. 80 degrees?)
    // Let's assume max extension is reached at 70 degrees or so?
    // Or just linear map from Threshold to 90deg?
    
    const maxAngle = MAX_STANDOFF_ANGLE_RAD;
    
    // Clamp angle
    const effectiveAngle = Math.min(angle, maxAngle);
    
    const denom = Math.max(EPS, maxAngle - threshold);
    const t = (effectiveAngle - threshold) / denom;
    const factor = clamp01(t);
    
    // Lerp
    return minThickness + factor * (maxThickness - minThickness);
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
