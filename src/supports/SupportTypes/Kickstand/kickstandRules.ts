import * as THREE from 'three';
import { isKickstandHostType, KICKSTAND_HOST_TYPES, type KickstandHostTypeId } from '../../supportTypeRegistry';

export function clampKickstandHostT(t: number, minT = 0): number {
    return THREE.MathUtils.clamp(t, minT, 1);
}

/** Throws unless `kind` names a type a kickstand's host knot may ride. */
export function assertKickstandHostKind(kind: string): asserts kind is KickstandHostTypeId {
    if (!isKickstandHostType(kind)) {
        throw new Error(`Kickstand host must be ${KICKSTAND_HOST_TYPES.join(' or ')}. Received: ${kind}`);
    }
}
