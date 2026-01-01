// Core types for Support Mode. Mirrors what we need for full-featured supports,
// but maintains our own naming conventions.

export type SupportMode = 'prepare' | 'support';

export type SupportShape = 'cone' | 'cylinder' | 'cube';

export interface SupportTipProfile {
  shape: 'cone';
  type?: 'disk' | 'sphere'; // Added for Phase 1 Contact Primitives
  contactDiameterMm: number;
  bodyDiameterMm: number;
  lengthMm: number;
  penetrationMm: number;
  coneAngleDeg: number;
  breakpointMm: number;
  
  // Contact Disk Props
  diskThicknessMm?: number;
  maxStandoffMm?: number;
  standoffAngleThreshold?: number;
  
  // Contact Sphere Props
  sphereRadiusRatio?: number;
}

export function createSupportInstance(overrides: Partial<SupportInstance> & { id: string }): SupportInstance {
  return {
    id: overrides.id,
    objectIdTip: overrides.objectIdTip ?? null,
    objectIdBase: overrides.objectIdBase ?? null,
    tip: overrides.tip ?? { x: 0, y: 0, z: 0 },
    tipNormal: overrides.tipNormal ?? { x: 0, y: 0, z: 1 },
    base: overrides.base ?? { x: 0, y: 0, z: 0 },
    baseNormal: overrides.baseNormal ?? { x: 0, y: 0, z: 1 },
    gridNodeIndex: overrides.gridNodeIndex ?? null,
    isBaseTip: overrides.isBaseTip ?? false,
    isInFill: overrides.isInFill ?? false,
    isVisible: overrides.isVisible ?? true,
    collisionIsAccepted: overrides.collisionIsAccepted ?? false,
    isCollidingWithObject: overrides.isCollidingWithObject ?? false,
    parentBaseId: overrides.parentBaseId ?? null,
    parentTipId: overrides.parentTipId ?? null,
    parentIds: overrides.parentIds ?? [],
    group: overrides.group ?? null,
    tags: overrides.tags ?? [],
    updatedAt: overrides.updatedAt ?? Date.now(),
    type: overrides.type ?? 1,
    settings: overrides.settings ?? createDefaultSupportSettings(),
  };
}

export interface SupportMidProfile {
  shape: 'cylinder' | 'cube';
  diameterMm: number;
  secondaryDiameterMm?: number;
  isStraight: boolean;
}

export interface SupportBaseProfile {
  shape: 'cylinder' | 'cube';
  diameterMm: number;
  heightMm: number;
  sideAngleDeg: number;
  neckDiameterMm: number;
  neckHeightMm: number;
  neckBlend: number; // 0..1 blend factor
}

export interface SupportBaseFlareProfile {
  enabled: boolean;
  diameterMm: number;
  heightMm: number;
}

export interface SupportBaseJointProfile {
  shape: 'cone' | 'cube';
  contactDiameterMm: number;
  bodyDiameterMm: number;
  lengthMm: number;
  penetrationMm: number;
  coneAngleDeg: number;
  allowRotation: boolean;
}

export interface SupportGridSettings {
  enabled: boolean;
  spacingMm: number;
}

export interface SupportExtraDimensions {
  tipContactDiameter2Mm?: number;
  tipBodyDiameter2Mm?: number;
  baseDiameter2Mm?: number;
  baseJointBodyDiameter2Mm?: number;
  baseJointContactDiameter2Mm?: number;
}

export interface SupportJointSettings {
  ballDiameterMm: number;
  maxRotationDeg: number;
  maxSlideMm: number;
  defaultJointCount: number;
}

export interface SupportSettings {
  tip: SupportTipProfile;
  mid: SupportMidProfile;
  base: SupportBaseProfile;
  baseFlare: SupportBaseFlareProfile;
  baseJoint: SupportBaseJointProfile;
  grid: SupportGridSettings;
  extra?: SupportExtraDimensions;
  adaptiveBase: boolean;
  isTrunkStraight: boolean;
  jointDefaults: SupportJointSettings;
}

export function createDefaultSupportSettings(): SupportSettings {
  return {
    tip: {
      shape: 'cone',
      type: 'disk',
      contactDiameterMm: 0.3,
      bodyDiameterMm: 1.0,
      lengthMm: 2.5,
      penetrationMm: 0.05,
      coneAngleDeg: 100,
      breakpointMm: 0,
      // Disk defaults
      diskThicknessMm: 0.1,
      maxStandoffMm: 1.5,
      standoffAngleThreshold: Math.PI / 4,
    },
    mid: {
      shape: 'cylinder',
      diameterMm: 1.0,
      secondaryDiameterMm: 1.0,
      isStraight: true,
    },
    base: {
      shape: 'cylinder',
      diameterMm: 5.0,
      heightMm: 0.3,
      sideAngleDeg: 0,
      neckDiameterMm: 1.0,
      neckHeightMm: 0.5,
      neckBlend: 0.7,
    },
    baseFlare: {
      enabled: true,
      diameterMm: 3.0,
      heightMm: 1.5,
    },
    baseJoint: {
      shape: 'cone',
      contactDiameterMm: 1.0,
      bodyDiameterMm: 1.0,
      lengthMm: 2.0,
      penetrationMm: 0,
      coneAngleDeg: 100,
      allowRotation: true,
    },
    grid: {
      enabled: false,
      spacingMm: 4.0,
    },
    extra: {
      tipContactDiameter2Mm: 0.5,
      tipBodyDiameter2Mm: 0.8,
      baseDiameter2Mm: 6.0,
      baseJointBodyDiameter2Mm: 1.2,
      baseJointContactDiameter2Mm: 0.6,
    },
    adaptiveBase: false,
    isTrunkStraight: true,
    jointDefaults: {
      ballDiameterMm: 1.5,
      maxRotationDeg: 45,
      maxSlideMm: 5,
      defaultJointCount: 1,
    },
  };
}

// Single support instance placed in the scene.
// This follows the Lychee idea of one object per support with its own
// embedded settings and world-space placement.
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SupportInstance {
  id: string; // e.g. "s1", "s2" or a UUID

  objectIdTip: string | null;
  objectIdBase?: string | null;

  tip: Vec3;
  tipNormal: Vec3;
  base: Vec3;
  baseNormal: Vec3;

  gridNodeIndex?: number | null;

  isBaseTip?: boolean;
  isInFill?: boolean;
  isVisible?: boolean;
  collisionIsAccepted?: boolean;
  isCollidingWithObject?: boolean;

  parentBaseId?: string | null;
  parentTipId?: string | null;
  parentIds?: string[];

  group?: string | null;
  tags?: string[];

  updatedAt?: number;
  type?: number;

  settings: SupportSettings;
  joints?: Array<{
    id: string;
    position: Vec3;
    rotation?: Vec3;
    ballDiameterMm: number;
    parentSegmentId?: string;
    childSegmentId?: string;
    order: number;
    updatedAt?: number;
    isTipJoint?: boolean;
    type?: 'standard' | 'branch' | 'user' | 'leaf';
    lockedToSupportId?: string;
  }>;
}

// Collection structure for supports, similar to Lychee's present.byId/allIds.
export interface SupportCollection {
  byId: Record<string, SupportInstance>;
  allIds: string[];
}

// Preset system for quick support style switching
export interface SupportPreset {
  id: string;                    // e.g., "detail", "structure", "anchor", or UUID for custom
  name: string;                  // Display name
  description?: string;          // Optional description
  hotkey?: string;               // Keyboard shortcut (e.g., "1", "2", "3")
  icon?: string;                 // Icon identifier or emoji
  isBuiltIn: boolean;            // Cannot be deleted if true
  settings: SupportSettings;     // Full geometry configuration
  createdAt?: number;            // Timestamp for custom presets
  updatedAt?: number;            // Last modified timestamp
}

export interface PresetCollection {
  byId: Record<string, SupportPreset>;
  allIds: string[];
  activePresetId: string;        // Currently selected preset
}
