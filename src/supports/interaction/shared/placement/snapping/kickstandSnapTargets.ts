import type { SnapTarget } from '../../../SnappingManager';
import type { SupportState, Segment } from '../../../../types';
import type { SupportCollectionKey } from '../../../../supportTypeRegistry';
import {
    getSupportTypeDescriptor,
    KICKSTAND_HOST_TYPES,
    type KickstandHostTypeId,
} from '../../../../supportTypeRegistry';
import { buildPrimarySnapTargetIndex, buildSupportPathSnapTargets } from './supportPathTargets';

export interface KickstandSnapTargetMeta {
    segmentId: string;
    supportKind: KickstandHostTypeId;
    modelId: string;
    diameterMm: number;
    minT: number;
    target: SnapTarget;
    hostRootId?: string;
}

interface KickstandHostEntity {
    modelId: string;
    segments: Segment[];
    /** Only the types that own a root declare one; the rest are anchored elsewhere. */
    rootId?: string;
}

/**
 * Snap metadata for every segment a kickstand may mount to, one entry per host
 * segment. The host types come from the registry, so a type that gains or loses
 * `hostsKickstand` joins or leaves without a second list here.
 */
export function buildKickstandSnapTargetMetaIndex(
    supportState: Pick<SupportState, SupportCollectionKey>
): Map<string, KickstandSnapTargetMeta> {
    const targets = buildSupportPathSnapTargets(supportState, {
        // A kickstand braces against a shaft, so only the shafted hosts.
        snapTypes: KICKSTAND_HOST_TYPES,
    });

    const targetById = buildPrimarySnapTargetIndex(targets);
    const map = new Map<string, KickstandSnapTargetMeta>();
    const collections = supportState as unknown as
        Partial<Record<SupportCollectionKey, Record<string, KickstandHostEntity>>>;

    for (const typeId of KICKSTAND_HOST_TYPES) {
        const collection = collections[getSupportTypeDescriptor(typeId).location.key];
        for (const entity of Object.values(collection ?? {})) {
            for (const segment of entity.segments) {
                const target = targetById.get(segment.id);
                if (!target?.pathSegment) continue;

                map.set(segment.id, {
                    segmentId: segment.id,
                    supportKind: typeId,
                    modelId: entity.modelId,
                    diameterMm: segment.diameter,
                    minT: 0,
                    target,
                    hostRootId: entity.rootId,
                });
            }
        }
    }

    return map;
}
