import type { Kickstand, Knot, Roots, Vec3 } from '../../types';

// Declared with the other support types; re-exported so this module stays the
// import site for everything kickstand-shaped.
export type { Kickstand };

export type KickstandHostKind = 'trunk' | 'branch';

export interface KickstandHostTarget {
    segmentId: string;
    supportKind: KickstandHostKind;
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
}

export interface KickstandBuildResult {
    root: Roots;
    hostKnot: Knot;
    kickstand: Kickstand;
}

export interface KickstandState {
    kickstands: Record<string, Kickstand>;
    roots: Record<string, Roots>;
    knots: Record<string, Knot>;
    selectedId: string | null;
}
