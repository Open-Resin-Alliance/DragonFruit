import type { Vec3 } from '@/supports/types';

export type HoverSource = 'model' | 'support' | 'contactDisk' | 'gizmo' | 'none';
export type HoverIntent = 'selection' | 'placement' | 'suppressed' | 'none';

export type SupportHoverCategory = 'support' | 'segment' | 'joint' | 'knot' | 'contactDisk' | 'raft';

export type HoverSuppressionReason =
    | 'gizmo-active'
    | 'orbit-active'
    | 'marquee-active'
    | 'interaction-disabled';

export interface ResolvedModelHoverHit {
    modelId: string;
    point?: Vec3;
}

export interface ResolvedSupportHoverHit {
    id: string | null;
    category: SupportHoverCategory;
}

export interface ResolvedHoverState {
    activeSource: HoverSource;
    intent: HoverIntent;
    modelHit: ResolvedModelHoverHit | null;
    supportHit: ResolvedSupportHoverHit | null;
    blockedReason: HoverSuppressionReason | null;
    isStale: boolean;
}

export const EMPTY_RESOLVED_HOVER_STATE: ResolvedHoverState = {
    activeSource: 'none',
    intent: 'none',
    modelHit: null,
    supportHit: null,
    blockedReason: null,
    isStale: false,
};
