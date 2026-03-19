import type { Vec3 } from '@/supports/types';

export type ResolvedSnapStatus = 'none' | 'candidate' | 'locked';

export interface ResolvedSnapState {
    state: ResolvedSnapStatus;
    targetId: string | null;
    snappedPos: Vec3 | null;
    t: number | null;
    metadata: Record<string, unknown> | null;
}

export const EMPTY_RESOLVED_SNAP_STATE: ResolvedSnapState = {
    state: 'none',
    targetId: null,
    snappedPos: null,
    t: null,
    metadata: null,
};

export interface SnapTargetRegistration {
    id: string;
    metadata?: Record<string, unknown>;
}
