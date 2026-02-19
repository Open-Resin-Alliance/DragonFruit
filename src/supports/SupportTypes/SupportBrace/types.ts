import type { Knot, Roots, Segment, SupportEntity, Vec3 } from '../../types';

export type SupportBraceHostKind = 'trunk' | 'branch';

export interface SupportBraceHostTarget {
    segmentId: string;
    supportKind: SupportBraceHostKind;
    t: number;
    pos: Vec3;
    diameterMm: number;
    minT?: number;
}

export interface SupportBracePlacementLayout {
    firstJointHeightRatio: number;
    secondJointHeightRatio: number;
    minJointSpacingMm: number;
    minTerminalClearanceMm: number;
}

export interface SupportBrace extends SupportEntity {
    rootId: string;
    hostKnotId: string;
    hostSegmentId: string;
    hostMinT: number;
    segments: Segment[];
    profile: {
        bodyDiameterMm: number;
        terminalStartDiameterMm: number;
        terminalEndDiameterMm: number;
    };
}

export interface SupportBraceBuildInput {
    modelId: string;
    rootPos: Vec3;
    host: SupportBraceHostTarget;
    layoutOverrides?: Partial<SupportBracePlacementLayout>;
}

export interface SupportBraceBuildResult {
    root: Roots;
    hostKnot: Knot;
    supportBrace: SupportBrace;
}

export interface SupportBraceState {
    supportBraces: Record<string, SupportBrace>;
    roots: Record<string, Roots>;
    knots: Record<string, Knot>;
    selectedId: string | null;
}
