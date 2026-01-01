import * as THREE from 'three';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import type { SupportData } from '@/supports/rendering/SupportBuilder';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';

export function buildRaftPreviewBaseCircles(args: { rootsDiameterMm: number; spreadMm?: number }): SupportBaseCircle[] {
    const rRaw = args.rootsDiameterMm / 2;
    const r = Math.min(3.0, Math.max(0.25, Number.isFinite(rRaw) ? rRaw : 0.75));
    const spread = args.spreadMm ?? 4;

    return [
        { x: 0, y: 0, r },
        { x: -spread, y: -spread, r },
        { x: spread, y: -spread, r },
        { x: -spread, y: spread, r },
        { x: spread, y: spread, r },
    ];
}

export function buildRaftPreviewSupports(args: { previewHeightMm: number; circles: SupportBaseCircle[] }): SupportData[] {
    const tipNormal = { x: 0, y: 0, z: -1 };

    return args.circles.map((c, i) => {
        const tipPos = { x: c.x, y: c.y, z: args.previewHeightMm };
        const built = buildTrunkData({
            tipPos,
            tipNormal,
            modelId: `anatomy-preview-raft-${i}`,
            overrides: {
                jointCount: 0,
            },
        });

        return built.supportData;
    });
}

export function circlesToNodes2d(circles: SupportBaseCircle[]): THREE.Vector2[] {
    return circles.map((c) => new THREE.Vector2(c.x, c.y));
}
