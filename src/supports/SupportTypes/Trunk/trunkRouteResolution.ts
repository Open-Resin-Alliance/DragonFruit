import type { Vec3 } from '../../types';
import type { SnappedTrunkRouteResult, TrunkRouteResult } from './trunkRouteTypes';

export function getResolvedSnappedNodeKey(route: TrunkRouteResult | SnappedTrunkRouteResult): string | null {
    const snappedRoute = route as Partial<SnappedTrunkRouteResult>;
    return snappedRoute.snappedNodeKey ?? null;
}

export function hasResolvedSnappedRoot(route: TrunkRouteResult | SnappedTrunkRouteResult): boolean {
    return getResolvedSnappedNodeKey(route) != null;
}

export function getResolvedSnappedRootPos(
    route: TrunkRouteResult | SnappedTrunkRouteResult,
    fallbackRootPos: Vec3,
): Vec3 {
    const snappedRoute = route as Partial<SnappedTrunkRouteResult>;
    return snappedRoute.snappedRootPos ?? fallbackRootPos;
}

export function getResolvedSnappedValidity(
    route: TrunkRouteResult | SnappedTrunkRouteResult,
): SnappedTrunkRouteResult['snappedValidity'] | null {
    const snappedRoute = route as Partial<SnappedTrunkRouteResult>;
    return snappedRoute.snappedValidity ?? null;
}

export function getDefaultSnappedValidity(
    route: TrunkRouteResult | SnappedTrunkRouteResult,
): SnappedTrunkRouteResult['snappedValidity'] {
    if (route.validity === 'hard_invalid') {
        return 'hard_invalid';
    }
    return route.validity === 'route_invalid' ? 'invalid_assisted' : 'valid';
}
