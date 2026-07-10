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

/**
 * Resolve the penetration depth ("embed depth") for a contact disk.
 * Resolution order: explicit value → profile.penetrationMm → 0. Never negative.
 */
export function resolveDiskPenetrationMm(
    profile: { penetrationMm?: number } | undefined,
    explicitPenetrationMm?: number,
): number {
    const raw = explicitPenetrationMm ?? profile?.penetrationMm ?? 0;
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

export interface ContactDiskGeometrySpec {
    radius: number;             // Contact radius (mm)
    thickness: number;          // Resolved standoff thickness (excludes penetration)
    penetrationMm: number;      // Resolved, clamped penetration depth
    height: number;             // Full cylinder height = thickness + penetration
    center: Vec3;               // World center of the cylinder (accounts for penetration)
    tipCenter: Vec3;            // Cone-side tip sphere center — never moves with penetration
    rotation: THREE.Quaternion; // Aligns cylinder Y-axis with the surface normal
}

/**
 * Structural profile shape accepted by getContactDiskGeometrySpec, so both
 * ContactDiskProfile and disk-typed SupportTipProfile (or partial profiles
 * from export/slicing paths) can be passed without casts.
 */
export interface ContactDiskProfileLike {
    type?: string;
    diskThicknessMm?: number;
    maxStandoffMm?: number;
    standoffAngleThreshold?: number;
    penetrationMm?: number;
}

/**
 * Single source of truth for the contact-disk solid.
 *
 * The disk cylinder spans from (pos - normal·penetration) — embedded into the
 * model — up to (pos + normal·thickness) where the round tip meets the cone.
 * Penetration extends the disk INTO the model only; the cone-side connection
 * (tipCenter) is unaffected, so sockets and joints never move with this setting.
 *
 * Every consumer that produces disk geometry (detailed renderer, instanced
 * renderer, file export, slicer feed) must derive its dimensions from this
 * spec so viewport and printed output stay in lockstep.
 */
export function getContactDiskGeometrySpec(params: {
    pos: Vec3;
    surfaceNormal: Vec3;
    coneAxis: Vec3;
    profile: ContactDiskProfileLike;
    contactDiameterMm: number;
    penetrationMm?: number;     // Explicit override; defaults to profile.penetrationMm
    overrideThickness?: number; // Explicit thickness (e.g. from collision logic)
}): ContactDiskGeometrySpec {
    const { pos, surfaceNormal, coneAxis, profile, contactDiameterMm, penetrationMm, overrideThickness } = params;
    const thickness = overrideThickness !== undefined
        ? overrideThickness
        // calculateDiskThickness reads the standoff fields with ?? fallbacks,
        // so a partial profile is safe at runtime.
        : calculateDiskThickness(surfaceNormal, coneAxis, profile as ContactDiskProfile);
    const pen = resolveDiskPenetrationMm(profile, penetrationMm);
    // Cylinder spans pos - n·pen → pos + n·thickness.
    const centerOffset = (thickness - pen) / 2;
    return {
        radius: contactDiameterMm / 2,
        thickness,
        penetrationMm: pen,
        height: thickness + pen,
        center: {
            x: pos.x + surfaceNormal.x * centerOffset,
            y: pos.y + surfaceNormal.y * centerOffset,
            z: pos.z + surfaceNormal.z * centerOffset,
        },
        tipCenter: {
            x: pos.x + surfaceNormal.x * thickness,
            y: pos.y + surfaceNormal.y * thickness,
            z: pos.z + surfaceNormal.z * thickness,
        },
        rotation: getDiskRotation(surfaceNormal),
    };
}
