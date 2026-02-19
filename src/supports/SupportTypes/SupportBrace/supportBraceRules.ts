import * as THREE from 'three';
import type { SupportBraceHostKind } from './types';

export const SUPPORT_BRACE_ALLOWED_HOST_KINDS: readonly SupportBraceHostKind[] = ['trunk', 'branch'];

export function isSupportBraceHostKind(kind: string): kind is SupportBraceHostKind {
    return SUPPORT_BRACE_ALLOWED_HOST_KINDS.includes(kind as SupportBraceHostKind);
}

export function clampSupportBraceHostT(t: number, minT = 0): number {
    return THREE.MathUtils.clamp(t, minT, 1);
}

export function assertSupportBraceHostKind(kind: string): asserts kind is SupportBraceHostKind {
    if (!isSupportBraceHostKind(kind)) {
        throw new Error(`Support brace host must be trunk or branch. Received: ${kind}`);
    }
}
