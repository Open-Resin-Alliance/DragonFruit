import React from 'react';
import { SupportBuilder } from '@/supports/rendering/SupportBuilder';
import { ANATOMY_CONFIG } from '../../AnatomyPreviewConfig';
import { buildRaftPreviewBaseCircles, buildRaftPreviewSupports } from './previewSupports';
import { buildRaftPreviewMeshes, disposeRaftPreviewMeshes } from './buildRaftPreviewMeshes';
import type { SupportKind } from '../../../supportKindState';

interface RaftPreviewProps {
    settings: any;
    liveConfig: any;
    activeKind: SupportKind;
    raftSettings: any;
    previewState: any;
    anatomyOverrides?: any; // Optional as Raft implies specific overrides often, but good to have
}

export function RaftPreview({
    settings,
    liveConfig,
    activeKind,
    raftSettings,
    previewState,
}: RaftPreviewProps) {

    // --- Anatomy Highlight Logic reused or specific to Raft? ---
    // In Canvas, raft had specific color logic passed to buildRaftPreviewMeshes
    const HIGHLIGHT_COLOR = ANATOMY_CONFIG.colors.highlight;
    const DIM_COLOR = ANATOMY_CONFIG.colors.dim;
    const NORMAL_COLOR = ANATOMY_CONFIG.colors.normal;

    const raftPreviewMeshes = React.useMemo(() => {
        if (activeKind !== 'raft') return null;
        if (raftSettings.bottomMode === 'off') return null;

        const focusKey = previewState.activeSettingKey;

        const rRaw = settings.roots.diameterMm / 2;
        const r = Math.min(3.0, Math.max(0.25, Number.isFinite(rRaw) ? rRaw : 0.75));

        // 5-point pattern: center + 4 corners
        const spread = 4;

        const circles = buildRaftPreviewBaseCircles({ rootsDiameterMm: r * 2, spreadMm: spread });

        return buildRaftPreviewMeshes({
            circles,
            raftSettings,
            focusKey,
            colors: {
                normal: NORMAL_COLOR,
                dim: DIM_COLOR,
                highlight: HIGHLIGHT_COLOR,
            },
        });
    }, [
        activeKind,
        previewState.activeSettingKey,
        settings.roots.diameterMm,
        raftSettings.bottomMode,
        raftSettings.thickness,
        raftSettings.chamferAngle,
        raftSettings.lineWidthMm,
        raftSettings.lineHeightMm,
        raftSettings.wallHeight,
        raftSettings.wallThickness,
        raftSettings.crenulationGapWidth,
        raftSettings.crenulationSpacing,
        raftSettings.wallEnabled,
    ]);

    const raftPreviewSupports = React.useMemo(() => {
        if (activeKind !== 'raft') return null;
        if (raftSettings.bottomMode === 'off') return null;

        const rRaw = settings.roots.diameterMm / 2;
        const r = Math.min(3.0, Math.max(0.25, Number.isFinite(rRaw) ? rRaw : 0.75));

        // 5-point pattern: center + 4 corners
        const spread = 4;
        const circles = buildRaftPreviewBaseCircles({ rootsDiameterMm: r * 2, spreadMm: spread });
        return buildRaftPreviewSupports({ previewHeightMm: liveConfig.previewHeightMm, circles });
    }, [activeKind, raftSettings.bottomMode, settings.roots.diameterMm, liveConfig.previewHeightMm]);

    React.useEffect(() => {
        return () => {
            if (!raftPreviewMeshes) return;
            disposeRaftPreviewMeshes(raftPreviewMeshes);
        };
    }, [raftPreviewMeshes]);

    if (activeKind !== 'raft') return null;

    return (
        <>
            {/* Raft-specific lighting was in the Canvas, should we move it here? 
                The Canvas had:
                {activeKind === 'raft' && ( <directionalLight ... /> )}
                It's better to keep scene lighting in the scene/canvas or move it here if it's strictly raft related.
                Let's keep it in Canvas for now to minimize changes to global scene, 
                OR move it here if we want self-contained component. 
                Self-contained is better for refactoring.
            */}
            <directionalLight
                position={[0, 0, -20]}
                intensity={0.8}
                color={'#93c5fd'}
            />

            {raftPreviewSupports?.map((data) => (
                <SupportBuilder
                    key={data.id}
                    data={data}
                    isPreview={true}
                    raftOverride={{ bottomMode: raftSettings.bottomMode, thickness: raftSettings.thickness }}
                    previewMaterialOverride={{ color: '#d4d4d4', opacity: 0.12 }}
                    rootsDiskMaterialOverride={{ transparent: false, opacity: 1, depthWrite: true }}
                    anatomyOverrides={{
                        rootsDisk: NORMAL_COLOR,
                    }}
                />
            ))}

            {raftPreviewMeshes?.kind === 'solid' && (
                <>
                    <primitive object={raftPreviewMeshes.baseMesh} />
                    {raftPreviewMeshes.wallMesh && <primitive object={raftPreviewMeshes.wallMesh} />}
                </>
            )}

            {raftPreviewMeshes?.kind === 'line' && (
                <>
                    {raftPreviewMeshes.beamMeshes.map((m, i) => (
                        <primitive key={`beam-${i}`} object={m} />
                    ))}
                    {raftPreviewMeshes.borderMesh && <primitive object={raftPreviewMeshes.borderMesh} />}
                    {raftPreviewMeshes.wallMesh && <primitive object={raftPreviewMeshes.wallMesh} />}
                </>
            )}
        </>
    );
}
