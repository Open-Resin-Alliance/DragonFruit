/**
 * Derived constants for support geometry.
 * 
 * Note: User-adjustable defaults are in Settings/defaults.ts
 * This file contains only derived/calculated values.
 */

// --- Joint Sizing ---
/** How much larger the joint diameter is compared to the shaft/body diameter */
export const JOINT_DIAMETER_OFFSET_MM = 0.1;

/**
 * Calculate joint diameter from shaft/body diameter.
 */
export function getJointDiameter(shaftDiameter: number): number {
    return shaftDiameter + JOINT_DIAMETER_OFFSET_MM;
}

/**
 * Calculate joint radius from shaft/body diameter.
 */
export function getJointRadius(shaftDiameter: number): number {
    return getJointDiameter(shaftDiameter) / 2;
}
