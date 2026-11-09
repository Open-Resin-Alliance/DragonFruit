/**
 * Default Support Settings
 * 
 * Edit these values to change the initial settings for new users
 * or when resetting to defaults.
 */

// --- Tip (Contact Cone) ---
export const DEFAULT_TIP_CONTACT_DIAMETER_MM = 0.3;
export const DEFAULT_TIP_BODY_DIAMETER_MM = 1.0;
export const DEFAULT_TIP_LENGTH_MM = 2.5;
export const DEFAULT_TIP_PENETRATION_MM = 0.1;
export const DEFAULT_TIP_CONE_ANGLE_DEG = 100;
export const DEFAULT_TIP_BREAKPOINT_MM = 0;

// --- Shaft ---
export const DEFAULT_SHAFT_DIAMETER_MM = 1.0;
export const DEFAULT_SHAFT_MAX_ANGLE_DEG = 80;

// --- Roots (Base) ---
export const DEFAULT_ROOTS_DIAMETER_MM = 3.0;
export const DEFAULT_ROOTS_DISK_HEIGHT_MM = 0.5;
export const DEFAULT_ROOTS_CONE_HEIGHT_MM = 1.5;
export const DEFAULT_ROOTS_NECK_DIAMETER_MM = 1.0;
export const DEFAULT_ROOTS_NECK_BLEND = 0.7;

// --- Base Flare ---
export const DEFAULT_BASE_FLARE_ENABLED = true;
export const DEFAULT_BASE_FLARE_DIAMETER_MM = 3.0;
export const DEFAULT_BASE_FLARE_HEIGHT_MM = 1.5;

// --- Joint ---
export const DEFAULT_JOINT_BALL_DIAMETER_MM = 1.5;
export const DEFAULT_JOINT_MAX_ROTATION_DEG = 45;
export const DEFAULT_JOINT_MAX_SLIDE_MM = 5;

// --- Grid ---
export const DEFAULT_GRID_ENABLED = false;
export const DEFAULT_GRID_SPACING_MM = 4.0;

export const DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG = 60;
export const DEFAULT_GRID_ATTACH_SEARCH_STEP_MM = 2.0;
export const DEFAULT_GRID_MIN_ROUTED_TRUNK_ANGLE_DEG = 60;

export const DEFAULT_MESH_TO_MESH_STICK_VS_TWIG_CUTOFF_MM = 5.0;

// --- Profile field limits ---
/**
 * Sane ranges for the General tab's profile fields, in one place: the settings
 * store clamps every write through them (UI, preset, import, plugin) so a
 * negative or absurd value can never reach the geometry, and the inputs take
 * their `min`/`max` from the same table.
 *
 * Lower bounds are the smallest value that still means something: 0 for a height
 * that may legitimately be "no feature", a hair above 0 for a diameter, because a
 * zero-radius disk/cone has no usable normal. Upper bounds are generous — they
 * catch a typo (a stray digit), not model a printer.
 */
export const SUPPORT_PROFILE_LIMITS = {
    tip: {
        contactDiameterMm: { min: 0.05, max: 5 },
        lengthMm: { min: 0.1, max: 50 },
        adaptiveConeAngleOffsetDeg: { min: 0, max: 90 },
    },
    shaft: {
        diameterMm: { min: 0.05, max: 20 },
    },
    roots: {
        diameterMm: { min: 0.05, max: 50 },
        diskHeightMm: { min: 0, max: 20 },
        coneHeightMm: { min: 0, max: 50 },
    },
} as const;
