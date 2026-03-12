import type { LimitationCode, Vec3, WarningCode } from '../../types';

export type TrunkRouteKind = 'straight' | 'routed';
export type TrunkRouteValidity = 'valid' | 'route_invalid' | 'hard_invalid';
export type SnappedRouteValidity = 'valid' | 'invalid_assisted' | 'hard_invalid';

export interface TrunkRouteResult {
    kind: TrunkRouteKind;
    basePos: Vec3;
    socketPos: Vec3;
    unsnappedBottomPos: Vec3;
    joints: Vec3[];
    constructionJoints: Vec3[];
    validity: TrunkRouteValidity;
    error?: LimitationCode;
    warning?: WarningCode;
    angle?: number;
    coneAxis?: Vec3;
}

export interface SnappedTrunkRouteResult extends TrunkRouteResult {
    snappedRootPos: Vec3;
    snappedNodeKey: string | null;
    snappedValidity: SnappedRouteValidity;
}
