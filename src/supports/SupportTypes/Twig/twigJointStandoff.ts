import type { Vec3 } from '../../types';
import type { ContactDiskProfile } from '../../SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';

// Small extra distance between the joint sphere's surface and the disk's
// contact face — keeps the joint visually separate from the disk and prevents
// any z-fighting on perpendicular placements.
const TWIG_JOINT_SURFACE_CLEARANCE_MM = 0.05;

/**
 * Twig-only: how far the disk-end joint sits along the disk's surface normal,
 * away from the model contact face.
 *
 * Combines two requirements:
 *  - At least the angle-based stand-off the disk would normally use, so steep
 *    surfaces still push the joint out far enough to keep the shaft off the
 *    model (matches every other support).
 *  - At least the joint sphere's own radius (plus a small clearance), so a
 *    big joint never punches into the model when the disk is large. This is
 *    twig-specific because joints on a twig scale with the disk diameter.
 */
export function twigDiskJointStandoff(args: {
    surfaceNormal: Vec3;
    coneAxis: Vec3;
    profile: ContactDiskProfile;
    jointDiameterMm: number;
}): number {
    const { surfaceNormal, coneAxis, profile, jointDiameterMm } = args;
    const angleBased = calculateDiskThickness(surfaceNormal, coneAxis, profile);
    const radiusBased = jointDiameterMm / 2 + TWIG_JOINT_SURFACE_CLEARANCE_MM;
    return Math.max(angleBased, radiusBased);
}
