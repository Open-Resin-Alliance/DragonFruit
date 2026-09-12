import type { ContactCone } from './SupportPrimitives/ContactCone/types';
import type { SupportTypeId } from './supportTypeRegistry';
import type { SUPPORT_TYPE_COLLECTION } from './supportTypeRegistry';
import type { ContactDiskProfile } from './SupportPrimitives/ContactCone/types';
import type { KickstandBuildResult } from './SupportTypes/Kickstand/types';
import type { SupportOriginId } from './supportTypeRegistry';
import type { SupportSelectionCategory } from './supportTypeRegistry';

export type SupportMode = 'prepare' | 'analysis' | 'support' | 'export' | 'printing';

// --- Basic Math Types ---

export type LimitationCode =
    | 'ANGLE_TOO_STEEP'
    | 'KNOT_ABOVE_TIP'
    | 'ANCHOR_BELOW_ROOT'
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
/**
 * Who created a support.
 *
 * Absent means a person placed it by hand. A tool that regenerates its own
 * output filters on this rather than on the support's type -- before it existed,
 * auto-bracing knew kickstands by an `autoBracingGenerated` flag but had no way
 * to tell a hand-drawn brace from one of its own, so it removed every brace.
 */
export type SupportGeneratedBy = 'autoSupport' | 'autoBracing';

export interface SupportEntity {
    id: string;
    modelId: string; // The model this support belongs to
    settingsCodeHex?: string;
    /** Set when a tool created this; absent when a person did. */
    generatedBy?: SupportGeneratedBy;
    /** Auto-support origin, for debug origin colouring. */
    origin?: SupportOrigin;
    /**
     * Which support type this is.
     *
     * Optional only for files written before the field existed: those have it
     * derived on load from the array they came out of. Everything the store
     * hands out carries it, and `__tests__/entityTypeId.test.ts` holds the two
     * sources of truth -- this field and collection membership -- in agreement.
     */
    typeId?: SupportTypeId;
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
     * Persistent normalization intent that should survive save/load roundtrips.
     * Used when imported support geometry needs deterministic preserve/project behavior
     * instead of falling back to heuristics on subsequent reloads.
     */
    normalizationHint?: 'preserve' | 'project' | 'braceImported';
    /**
     * Import-time hint stamped by converters (e.g. LYS).
     * Consumed by normalizeLoadedKnotAndLeafGeometry and promoted into
     * `normalizationHint` for roundtrip-stable persistence.
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
 * Where an auto-placed support came from. Declared in `supportTypeRegistry.ts`
 * alongside what each origin implies; re-exported here for entity interfaces.
 */
export type SupportOrigin = SupportOriginId;

/**
 * Trunk: A vertical column extending from Roots.
 */
export interface TrunkFields {
    rootId: string; // Link to the Roots anchor
    baseDiameterMm?: number; // Baseline shaft diameter captured at creation/promotion
    segments: Segment[];
    contactCone?: ContactCone; // Terminal piece at model interface
}

export type Trunk = SupportEntity & TrunkFields;

/**
 * Branch: A column extending from a Knot on another support.
 */
export interface BranchFields {
    parentKnotId: string; // Link to the Knot on the parent
    segments: Segment[];
    contactCone?: ContactCone; // Terminal piece at model interface
}

export type Branch = SupportEntity & BranchFields;

/**
 * Leaf: A minimal model -> support connection.
 * Uses a contact tip on the model and a Knot on a host shaft.
 * No segments, no joints.
 */
export interface LeafFields {
    parentKnotId: string;
    contactCone: ContactCone;
}

export type Leaf = SupportEntity & LeafFields;

export interface ContactDisk {
    id: string;
    pos: Vec3;
    surfaceNormal: Vec3;
    coneAxis: Vec3;
    diskLengthOverride?: number;
    placementSurface?: 'interior' | 'exterior';
    profile: ContactDiskProfile;
    contactDiameterMm: number;
}

export interface TwigFields {
    segments: Segment[];
    contactDiskA: ContactDisk;
    contactDiskB: ContactDisk;
}

export type Twig = SupportEntity & TwigFields;

export interface StickFields {
    segments: Segment[];
    contactConeA: ContactCone;
    contactConeB: ContactCone;
}

export type Stick = SupportEntity & StickFields;

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
export interface AnchorFields {
    rootPos: Vec3;
    rootBaseDiameter: number;
    rootTopDiameter: number;
    rootHeight: number;
    joint: Joint;
    segments: Segment[];
    contactCone: ContactCone;
}

export type Anchor = SupportEntity & AnchorFields;

/**
 * Brace: A stabilizer bar connecting two supports.
 */
export interface BraceFields {
    startKnotId: string;
    endKnotId: string;
    placementSurface?: 'interior' | 'exterior';
    curve?: BraceCurve;
    profile: {
        diameter: number;
    };
    debugSection?: 'initial' | 'repeating';
}

export type Brace = SupportEntity & BraceFields;

/**
 * Kickstand: A grounded column bracing a shaft it attaches to.
 */
export interface KickstandFields {
    rootId: string;
    hostKnotId: string;
    hostSegmentId: string;
    hostMinT: number;
    /**
     * @deprecated Superseded by `generatedBy` on SupportEntity. Kept so scenes
     * saved before the change still identify their auto-generated kickstands.
     */
    autoBracingGenerated?: boolean;
    segments: Segment[];
    profile: {
        bodyDiameterMm: number;
        terminalStartDiameterMm: number;
        terminalEndDiameterMm: number;
    };
}

export type Kickstand = SupportEntity & KickstandFields;

// --- Collection State ---

/**
 * The entity each collection holds.
 *
 * The one place a collection name is written down; SupportState and
 * SupportCollectionKey both derive from it.
 */
/**
 * How a collection's entity is reported when a removal takes it.
 *
 * Every collection reports the entity itself. A type owning a root or hanging
 * off a knot reports those as ordinary members of the `roots` and `knots`
 * cascades, so there is no wrapper form.
 */
export type SupportRemovedEntityByCollection = SupportEntityByCollection;

/**
 * The one place a support type is named.
 *
 * Each key is a type id; its value is that type's own fields, on top of
 * `SupportEntity`. `SupportTypeId`, `SUPPORT_TYPE_COLLECTION` and the
 * collection keys all derive from this, so renaming a key here renames the
 * type everywhere and leaves every stale name a compile error.
 */
export interface SupportFieldsByType {
    trunk: TrunkFields;
    branch: BranchFields;
    leaf: LeafFields;
    twig: TwigFields;
    stick: StickFields;
    brace: BraceFields;
    anchor: AnchorFields;
    kickstand: KickstandFields;
}

/** Which collection each type's entities live in. */
export interface SupportCollectionByType {
    trunk: 'trunks';
    branch: 'branches';
    leaf: 'leaves';
    twig: 'twigs';
    stick: 'sticks';
    brace: 'braces';
    anchor: 'anchors';
    kickstand: 'kickstands';
}

export interface SupportEntityByCollection {
    roots: Roots;
    trunks: Trunk;
    branches: Branch;
    leaves: Leaf;
    twigs: Twig;
    sticks: Stick;
    braces: Brace;
    anchors: Anchor;
    kickstands: Kickstand;
    knots: Knot;
}

/** Keys of SupportState holding entity collections. */
export type SupportCollectionName = keyof SupportEntityByCollection;

/**
 * Any one of the support entities.
 *
 * Keyed off `SUPPORT_TYPE_COLLECTION`, which maps a type id to its collection,
 * so this covers exactly the declared types -- not `roots` and `knots`, which
 * are collections but not support types. A ninth type joins by being declared
 * in the registry.
 */
export type SupportEntityAny =
    SupportEntityByCollection[(typeof SUPPORT_TYPE_COLLECTION)[SupportTypeId]];

export type SupportCollections = {
    [K in SupportCollectionName]: Record<string, SupportEntityByCollection[K]>;
};

export interface SupportState extends SupportCollections {
    /**
     * Every support entity by id. The named collections are non-enumerable
     * views over this, partitioned by `typeId`. Optional on input only.
     */
    supports?: Record<string, SupportEntityAny>;
    // Interaction State
    selectedId: string | null;
    selectedCategory?: SupportSelectionCategory | null;
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
