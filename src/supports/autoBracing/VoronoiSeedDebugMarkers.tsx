import React from 'react';
import { getVoronoiSeedDebugMarkers } from './voronoiPartitioning';

interface VoronoiSeedDebugMarkersProps {
    enabled: boolean;
    ghostRenderOrder: number;
    isModelVisible: (modelId?: string, supportId?: string) => boolean;
    applyDropToVec3Like: (pos: { x: number; y: number; z: number }, modelId?: string) => { x: number; y: number; z: number };
}

export function VoronoiSeedDebugMarkers({
    enabled,
    ghostRenderOrder,
    isModelVisible,
    applyDropToVec3Like,
}: VoronoiSeedDebugMarkersProps) {
    if (!enabled) return null;

    const markers = getVoronoiSeedDebugMarkers()
        .filter((seed) => isModelVisible(seed.modelId, seed.id.split(':')[1]))
        .map((seed) => ({
            ...seed,
            pos: applyDropToVec3Like(seed.pos, seed.modelId),
        }));

    return (
        <>
            {markers.map((seed) => (
                <mesh
                    key={`voronoi-seed:${seed.id}`}
                    position={[seed.pos.x, seed.pos.y, seed.pos.z]}
                    userData={{ modelId: seed.modelId }}
                    renderOrder={ghostRenderOrder + 1}
                >
                    <sphereGeometry args={[0.6, 10, 8]} />
                    <meshBasicMaterial color="#ffffff" transparent opacity={0.95} depthTest={false} />
                </mesh>
            ))}
        </>
    );
}
