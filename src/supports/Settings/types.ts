/**
 * Support Settings Types
 * 
 * Defines all configuration interfaces for support geometry.
 * This is the single source of truth for settings shapes.
 */

import {
    DEFAULT_TIP_CONTACT_DIAMETER_MM,
    DEFAULT_TIP_BODY_DIAMETER_MM,
    DEFAULT_TIP_LENGTH_MM,
    DEFAULT_TIP_PENETRATION_MM,
    DEFAULT_TIP_CONE_ANGLE_DEG,
    DEFAULT_TIP_BREAKPOINT_MM,
    DEFAULT_SHAFT_DIAMETER_MM,
    DEFAULT_SHAFT_MAX_ANGLE_DEG,
    DEFAULT_ROOTS_DIAMETER_MM,
    DEFAULT_ROOTS_DISK_HEIGHT_MM,
    DEFAULT_ROOTS_CONE_HEIGHT_MM,
    DEFAULT_ROOTS_NECK_DIAMETER_MM,
    DEFAULT_ROOTS_NECK_BLEND,
    DEFAULT_BASE_FLARE_ENABLED,
    DEFAULT_BASE_FLARE_DIAMETER_MM,
    DEFAULT_BASE_FLARE_HEIGHT_MM,
    DEFAULT_JOINT_BALL_DIAMETER_MM,
    DEFAULT_JOINT_MAX_ROTATION_DEG,
    DEFAULT_JOINT_MAX_SLIDE_MM,
    DEFAULT_JOINT_DEFAULT_COUNT,
    DEFAULT_GRID_ENABLED,
    DEFAULT_GRID_SPACING_MM,
    DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG,
    DEFAULT_GRID_ATTACH_SEARCH_STEP_MM,
    DEFAULT_MESH_TO_MESH_STICK_VS_TWIG_CUTOFF_MM,
} from './defaults';
import {
    createDefaultAutoBracingSettings,
    type AutoBracingSettings,
} from '../autoBracing/settings';

// --- Profile Types ---

export interface TipProfile {
    shape: 'cone';
    type?: 'disk' | 'sphere'; // Phase 1 Contact Primitives
    contactDiameterMm: number;   // Small end touching model
    bodyDiameterMm: number;      // Larger end (socket side)
    lengthMm: number;            // Total cone length
    penetrationMm: number;       // Embed depth into model
    coneAngleMode?: 'normal' | 'locked' | 'adaptive';
    adaptiveConeAngleOffsetDeg?: number;
    coneAngleDeg?: number;       // Overall cone profile (derived)
    breakpointMm?: number;       // Optional internal breakpoint

    // Contact Disk Props
    diskThicknessMm?: number;
    maxStandoffMm?: number;
    standoffAngleThreshold?: number;

    // Contact Sphere Props
    sphereRadiusRatio?: number;
}

export interface ShaftProfile {
    shape: 'cylinder' | 'cube';
    diameterMm: number;
    secondaryDiameterMm?: number;
    isStraight: boolean;
    maxAngleDeg?: number;
}

export interface RootsProfile {
    shape: 'cylinder' | 'cube';
    diameterMm: number;          // Base disk diameter
    diskHeightMm: number;        // Flat disk height
    coneHeightMm: number;        // Transition cone height
    neckDiameterMm: number;      // Where it meets the shaft
    neckBlend: number;           // 0..1 blend factor
}

export interface BaseFlareProfile {
    enabled: boolean;
    diameterMm: number;
    heightMm: number;
}

export interface JointProfile {
    ballDiameterMm: number;
    maxRotationDeg: number;
    maxSlideMm: number;
    defaultJointCount: number;
}

export interface GridSettings {
    enabled: boolean;
    spacingMm: number;
    minBranchAngleDeg: number;
    attachSearchStepMm: number;
}

export interface MeshToMeshSettings {
    stickVsTwigCutoffMm: number;
}

// --- Main Settings Interface ---

export interface SupportSettings {
    tip: TipProfile;
    shaft: ShaftProfile;
    roots: RootsProfile;
    baseFlare: BaseFlareProfile;
    joint: JointProfile;
    grid: GridSettings;
    meshToMesh: MeshToMeshSettings;
    autoBracing: AutoBracingSettings;
}

// --- Default Factory ---

export function createDefaultSettings(): SupportSettings {
    return {
        tip: {
            shape: 'cone',
            type: 'disk',
            contactDiameterMm: DEFAULT_TIP_CONTACT_DIAMETER_MM,
            bodyDiameterMm: DEFAULT_TIP_BODY_DIAMETER_MM,
            lengthMm: DEFAULT_TIP_LENGTH_MM,
            penetrationMm: DEFAULT_TIP_PENETRATION_MM,
            coneAngleMode: 'adaptive',
            adaptiveConeAngleOffsetDeg: 60,
            coneAngleDeg: DEFAULT_TIP_CONE_ANGLE_DEG,
            breakpointMm: DEFAULT_TIP_BREAKPOINT_MM,
            // Disk Defaults
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.5,
            standoffAngleThreshold: Math.PI / 4,
        },
        shaft: {
            shape: 'cylinder',
            diameterMm: DEFAULT_SHAFT_DIAMETER_MM,
            secondaryDiameterMm: DEFAULT_SHAFT_DIAMETER_MM,
            isStraight: true,
            maxAngleDeg: DEFAULT_SHAFT_MAX_ANGLE_DEG,
        },
        roots: {
            shape: 'cylinder',
            diameterMm: DEFAULT_ROOTS_DIAMETER_MM,
            diskHeightMm: DEFAULT_ROOTS_DISK_HEIGHT_MM,
            coneHeightMm: DEFAULT_ROOTS_CONE_HEIGHT_MM,
            neckDiameterMm: DEFAULT_ROOTS_NECK_DIAMETER_MM,
            neckBlend: DEFAULT_ROOTS_NECK_BLEND,
        },
        baseFlare: {
            enabled: DEFAULT_BASE_FLARE_ENABLED,
            diameterMm: DEFAULT_BASE_FLARE_DIAMETER_MM,
            heightMm: DEFAULT_BASE_FLARE_HEIGHT_MM,
        },
        joint: {
            ballDiameterMm: DEFAULT_JOINT_BALL_DIAMETER_MM,
            maxRotationDeg: DEFAULT_JOINT_MAX_ROTATION_DEG,
            maxSlideMm: DEFAULT_JOINT_MAX_SLIDE_MM,
            defaultJointCount: DEFAULT_JOINT_DEFAULT_COUNT,
        },
        grid: {
            enabled: DEFAULT_GRID_ENABLED,
            spacingMm: DEFAULT_GRID_SPACING_MM,
            minBranchAngleDeg: DEFAULT_GRID_MIN_BRANCH_ANGLE_DEG,
            attachSearchStepMm: DEFAULT_GRID_ATTACH_SEARCH_STEP_MM,
        },
        meshToMesh: {
            stickVsTwigCutoffMm: DEFAULT_MESH_TO_MESH_STICK_VS_TWIG_CUTOFF_MM,
        },
        autoBracing: createDefaultAutoBracingSettings(),
    };
}

// --- Preset Types ---

export interface SupportPreset {
    id: string;
    name: string;
    description?: string;
    hotkey?: string;
    icon?: string;
    isBuiltIn: boolean;
    settings: SupportSettings;
    createdAt?: number;
    updatedAt?: number;
}

export interface PresetCollection {
    byId: Record<string, SupportPreset>;
    allIds: string[];
    activePresetId: string | null;
}
