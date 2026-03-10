import * as THREE from 'three';
import type { KickstandHostKind } from './types';

export const KICKSTAND_ALLOWED_HOST_KINDS: readonly KickstandHostKind[] = ['trunk', 'branch'];

export function isKickstandHostKind(kind: string): kind is KickstandHostKind {
    return KICKSTAND_ALLOWED_HOST_KINDS.includes(kind as KickstandHostKind);
}

export function clampKickstandHostT(t: number, minT = 0): number {
    return THREE.MathUtils.clamp(t, minT, 1);
}

export function assertKickstandHostKind(kind: string): asserts kind is KickstandHostKind {
    if (!isKickstandHostKind(kind)) {
        throw new Error(`Kickstand host must be trunk or branch. Received: ${kind}`);
    }
}
