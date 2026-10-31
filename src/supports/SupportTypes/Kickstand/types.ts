import type * as THREE from 'three';
import type { Kickstand, Knot, LimitationCode, Roots, Vec3 } from '../../types';
import type { KickstandHostTypeId } from '../../supportTypeRegistry';

// Declared with the other support types; re-exported so this module stays the
// import site for everything kickstand-shaped.
export type { Kickstand };

export interface KickstandHostTarget {
    segmentId: string;
    supportKind: KickstandHostTypeId;
    t: number;
    pos: Vec3;
    diameterMm: number;
    minT?: number;
}

export interface KickstandPlacementLayout {
    firstJointHeightRatio: number;
    secondJointHeightRatio: number;
    minJointSpacingMm: number;
    minTerminalClearanceMm: number;
}


export interface KickstandBuildInput {
    modelId: string;
    rootPos: Vec3;
    host: KickstandHostTarget;
    layoutOverrides?: Partial<KickstandPlacementLayout>;
    /** A column known end to end; without one the derived four-segment shape applies. */
    authoredColumn?: { topPos: Vec3 };
    /** The model the column must not run through. Without one it is not checked. */
    collisionMesh?: THREE.Mesh;
    /** How far a run may lean from vertical, from the shaft setting. */
    maxShaftAngleDeg?: number;
    /**
     * Prefix for every id this build creates. Auto-bracing passes one so a
     * repeat run builds the same forest; manual placement leaves it unset and
     * gets uuids.
     */
    idSeed?: string;
}

export interface KickstandBuildResult {
    root: Roots;
    hostKnot: Knot;
    kickstand: Kickstand;
    /** Why this column is illegal, when it is. Force placement ignores it. */
    error?: LimitationCode;
}

export interface KickstandState {
    kickstands: Record<string, Kickstand>;
    roots: Record<string, Roots>;
    knots: Record<string, Knot>;
    selectedId: string | null;
}
