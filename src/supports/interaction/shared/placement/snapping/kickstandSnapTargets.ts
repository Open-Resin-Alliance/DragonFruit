import type { SnapTarget } from '../../../SnappingManager';
import type { SupportState } from '../../../../types';
import type { KickstandHostKind } from '../../../../SupportTypes/Kickstand/types';
import { buildPrimarySnapTargetIndex, buildSupportPathSnapTargets } from './supportPathTargets';

export interface KickstandSnapTargetMeta {
    segmentId: string;
    supportKind: KickstandHostKind;
    modelId: string;
    diameterMm: number;
    minT: number;
    target: SnapTarget;
}

export function buildKickstandSnapTargetMetaIndex(
    supportState: Pick<SupportState, 'trunks' | 'branches' | 'roots' | 'knots' | 'braces' | 'twigs' | 'sticks'>
): Map<string, KickstandSnapTargetMeta> {
    const targets = buildSupportPathSnapTargets(supportState, {
        includeTrunks: true,
        includeBranches: true,
        includeBraces: false,
        includeTwigs: false,
        includeSticks: false,
    });

    const targetById = buildPrimarySnapTargetIndex(targets);
    const map = new Map<string, KickstandSnapTargetMeta>();

    for (const trunk of Object.values(supportState.trunks)) {
        for (const segment of trunk.segments) {
            const target = targetById.get(segment.id);
            if (!target?.pathSegment) continue;

            map.set(segment.id, {
                segmentId: segment.id,
                supportKind: 'trunk',
                modelId: trunk.modelId,
                diameterMm: segment.diameter,
                minT: 0,
                target,
            });
        }
    }

    for (const branch of Object.values(supportState.branches)) {
        for (const segment of branch.segments) {
            const target = targetById.get(segment.id);
            if (!target?.pathSegment) continue;

            map.set(segment.id, {
                segmentId: segment.id,
                supportKind: 'branch',
                modelId: branch.modelId,
                diameterMm: segment.diameter,
                minT: 0,
                target,
            });
        }
    }

    return map;
}
