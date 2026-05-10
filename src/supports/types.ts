import * as THREE from 'three';
import type { ContactCone } from './SupportPrimitives/ContactCone/types';
import type { ContactDiskProfile } from './SupportPrimitives/ContactCone/types';
import type { KickstandBuildResult } from './SupportTypes/Kickstand/types';

export type SupportMode = 'prepare' | 'analysis' | 'support' | 'export' | 'printing';

// --- Basic Math Types ---

export type LimitationCode =
    | 'ANGLE_TOO_STEEP'
    | 'KNOT_ABOVE_TIP'
    | 'COLLISION_WITH_MODEL'
    | 'TOO_CLOSE_TO_EXISTING'
    | 'OUT_OF_BOUNDS';

export type WarningCode =
    | 'ANGLE_VERTICAL_WARNING'
    | 'SHAFT_ANGLE_TOO_FLAT';

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface Quaternion {
    x: number;
    y: number;
    z: number;
    w: number;
}

export interface Transform {
    pos: Vec3;
    rot: Quaternion;
    scale?: Vec3;
}

// --- Core Anatomy Entities ---

/**
 * Base interface for all top-level support entities.
 * Ensures every support element is linked to a specific model.
 */
export interface SupportEntity {
    id: string;
    modelId: string; // The model this support belongs to
    settingsCodeHex?: string;
}

/**
 * Roots: The anchor point on the build plate or raft.
 * It does NOT contain the vertical shaft (that's the Trunk).
 */
export interface Roots extends SupportEntity {
    transform: Transform; // Position on the plate
    diameter: number; // Base diameter (bottom of cone)
    diskHeight: number; // Flat disk thickness
    coneHeight: number; // Height of transition cone alone
}

/**
 * Knot (Anchor): A connection point on a Shaft.
 * Branches and Braces attach here.
 */
export interface Knot {
    id: string;
    parentShaftId: string; // The shaft this knot belongs to
    t?: number; // 0-1 position along the shaft segment (preferred representation)
    pos: Vec3; // World position on the host shaft
    diameter?: number; // Host shaft diameter + 0.1mm (computed at creation if absent)
    /**
     * Import-time hint stamped by converters (e.g. LYS).
     * Consumed and stripped by normalizeLoadedKnotAndLeafGeometry.
     * 'preserve' → keep authored pos; 'project' → project to shaft geometry.
     * Not present for runtime-created knots.
     */
    _importHint?: 'preserve' | 'project' | 'braceImported';
}

/**
 * Joint: A spherical articulation point between shaft segments.
 */
export interface Joint {
    id: string;
    pos: Vec3;
    diameter: number;
}

/**
 * Segment: A section of a support (straight or curved).
 */
export interface BaseSegment {
    id: string;
    diameter: number;
    topJoint?: Joint; // If null, it might be the tip
    bottomJoint?: Joint; // If null, it connects to Root or Knot
}

export interface StraightSegment extends BaseSegment {
    type?: 'straight';
}

export interface BezierSegment extends BaseSegment {
    type: 'bezier';
    controlPoint1: Vec3;
    controlPoint2: Vec3;
    startTangent: Vec3;
    endTangent: Vec3;
    tension: number;
    bias: number; // 0..1, 0.5 = balanced
    resolution: number;
}

export type Segment = StraightSegment | BezierSegment;

/**
 * Trunk: A vertical column extending from Roots.
 */
export interface Trunk extends SupportEntity {
    rootId: string; // Link to the Roots anchor
    baseDiameterMm?: number; // Baseline shaft diameter captured at creation/promotion
    segments: Segment[];
    contactCone?: ContactCone; // Terminal piece at model interface
}

/**
 * Branch: A column extending from a Knot on another support.
 */
export interface Branch extends SupportEntity {
    parentKnotId: string; // Link to the Knot on the parent
    segments: Segment[];
    contactCone?: ContactCone; // Terminal piece at model interface
}

/**
 * Leaf: A minimal model -> support connection.
 * Uses a contact tip on the model and a Knot on a host shaft.
 * No segments, no joints.
 */
export interface Leaf extends SupportEntity {
    parentKnotId: string;
    contactCone: ContactCone;
}

export interface ContactDisk {
    id: string;
    pos: Vec3;
    surfaceNormal: Vec3;
    coneAxis: Vec3;
    diskLengthOverride?: number;
    profile: ContactDiskProfile;
    contactDiameterMm: number;
}

export interface Twig extends SupportEntity {
    segments: Segment[];
    contactDiskA: ContactDisk;
    contactDiskB: ContactDisk;
}

export interface Stick extends SupportEntity {
    segments: Segment[];
    contactConeA: ContactCone;
    contactConeB: ContactCone;
}

export type BraceCurve = {
    type: 'bezier';
    controlPoint1: Vec3;
    controlPoint2: Vec3;
    startTangent: Vec3;
    endTangent: Vec3;
    tension: number;
    bias: number;
    resolution: number;
};

/**
 * Anchor: A minimal near-plate support for contact points below 5mm.
 * Bypasses grid system entirely. Not a target for branches, leaves, or braces.
 * Geometry: frustum root → joint → single segment → contact cone.
 */
export interface Anchor extends SupportEntity {
    rootPos: Vec3;
    rootBaseDiameter: number;
    rootTopDiameter: number;
    rootHeight: number;
    joint: Joint;
    segments: Segment[];
    contactCone: ContactCone;
}

/**
 * Brace: A stabilizer bar connecting two supports.
 */
export interface Brace extends SupportEntity {
    startKnotId: string;
    endKnotId: string;
    curve?: BraceCurve;
    profile: {
        diameter: number;
    };
    debugSection?: 'initial' | 'repeating';
}

// --- Collection State ---
export interface SupportState {
    roots: Record<string, Roots>;
    trunks: Record<string, Trunk>;
    branches: Record<string, Branch>;
    leaves: Record<string, Leaf>;
    twigs: Record<string, Twig>;
    sticks: Record<string, Stick>;
    braces: Record<string, Brace>;
    anchors: Record<string, Anchor>;
    knots: Record<string, Knot>;
    // Interaction State
    selectedId: string | null;
    selectedCategory?: 'trunk' | 'branch' | 'leaf' | 'twig' | 'stick' | 'brace' | 'anchor' | 'root' | 'joint' | 'knot' | 'segment' | 'contactDisk' | null;
    hoveredId: string | null;
    hoveredCategory?: 'model' | 'support' | 'contactDisk' | 'segment' | 'joint' | 'knot' | 'raft' | 'gizmo' | 'none';
    interactionWarning?: WarningCode | null;
}

// --- Import/Export Format ---
export interface DragonfruitImportFormat {
    version: number;
    meta: {
        source: string;
        objectCenter: Vec3;
        updatedAt?: number;
    };
    roots: Roots[];
    trunks: Trunk[];
    branches: Branch[];
    leaves: Leaf[];
    twigs?: Twig[];
    sticks?: Stick[];
    braces: Brace[];
    anchors?: Anchor[];
    knots: Knot[];
    kickstands?: KickstandBuildResult[];
}
