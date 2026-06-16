import { Vec3 } from '../../types';

/**
 * ContactDiskProfile: "The Nib"
 * A flat cylinder with variable standoff thickness.
 */
export interface ContactDiskProfile {
    type: 'disk';
    diskThicknessMm: number;       // Minimum base thickness (flat surfaces)
    maxStandoffMm: number;         // Max extension length (steep surfaces)
    standoffAngleThreshold: number; // Angle (radians) where extension starts
}

/**
 * ContactSphereProfile: "The Ball Joint"
 * A spherical buffer object.
 */
export interface ContactSphereProfile {
    type: 'sphere';
    sphereRadiusRatio: number;     // Multiplier of contact diameter (e.g. 1.5x)
}

/**
 * SupportTipProfile: Configuration for contact cone geometry.
 * Now a discriminated union based on `type`.
 */
export type SupportTipProfile = {
    contactDiameterMm: number;  // The actual contact footprint size
    bodyDiameterMm: number;     // Larger end (socket side)
    lengthMm: number;           // Total head length (excluding primitive offset)
    penetrationMm: number;      // Embed depth (legacy use, mostly for sphere now)
} & (ContactDiskProfile | ContactSphereProfile | { type?: undefined }); // Allow undefined for legacy compatibility

/**
 * ContactCone: The terminal piece at the model interface.
 * - Contact face touches model
 * - Socket side connects directly to a Joint (never to a Shaft)
 */
export interface ContactCone {
    id: string;
    pos: Vec3;                  // Contact point on model surface
    normal: Vec3;               // Cone axis direction (points into model)
    surfaceNormal?: Vec3;       // ACTUAL surface normal (for disk alignment)
    diskLengthOverride?: number; // Override for disk thickness (e.g. from collision)
    placementSurface?: 'interior' | 'exterior';
    profile: SupportTipProfile;
    socketJointId?: string;      // The Joint this cone connects to (optional for Leaf)
}

/**
 * Default profile matching legacy behavior.
 * Defaults to Disk type for Phase 1.
 */
export const DEFAULT_TIP_PROFILE: SupportTipProfile = {
    type: 'disk',
    contactDiameterMm: 0.4,
    bodyDiameterMm: 1.2,
    lengthMm: 3.0,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25, // Reduced from 1.5mm to prevent fragility
    standoffAngleThreshold: Math.PI / 4, // 45 degrees
};
