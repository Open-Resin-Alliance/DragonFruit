import React from 'react';
import { SupportBuilder } from '@/supports/rendering/SupportBuilder';
import { ANATOMY_CONFIG } from '../../AnatomyPreviewConfig';
import { buildGridPreviewSupports } from './previewSupports';
import type { SupportKind } from '../../../supportKindState';

interface GridPreviewProps {
    settings: any;
    liveConfig: any;
    activeKind: SupportKind;
    previewState: any;
    anatomyOverrides: any;
}

// Hardcode preview height to match previewSupports.ts
const PREVIEW_HEIGHT_MM = 15;

export function GridPreview({
    settings,
    liveConfig,
    activeKind,
    previewState,
    anatomyOverrides
}: GridPreviewProps) {
    const gridPreviewSupports = React.useMemo(() => {
        return buildGridPreviewSupports({ settings, liveConfig, activeKind });
    }, [activeKind, settings.grid.spacingMm, liveConfig, settings.tip]);

    const spacing = settings.grid.spacingMm;
    const sphereRadius = Math.max(5, spacing * 1.5);
    const sphereCenterZ = PREVIEW_HEIGHT_MM + sphereRadius;

    if (!gridPreviewSupports) return null;

    return (
        <>
            {gridPreviewSupports.map((data) => {
                // Apply DragonFruit Pink highlight to roots to emphasize the grid layout
                // And dim the rest of the support to make the roots pop
                const mergedOverrides = {
                    roots: ANATOMY_CONFIG.colors.highlight,
                    rootsDisk: ANATOMY_CONFIG.colors.highlight,
                    rootsCone: ANATOMY_CONFIG.colors.highlight,
                    // Dim the rest
                    shaft: ANATOMY_CONFIG.colors.dim,
                    joint: ANATOMY_CONFIG.colors.dim,
                    tipBody: ANATOMY_CONFIG.colors.dim,
                    tipDisk: ANATOMY_CONFIG.colors.dim,
                    ...anatomyOverrides
                };

                return (
                    <SupportBuilder
                        key={data.id}
                        data={data}
                        isPreview={ANATOMY_CONFIG.rendering.showAsGhostPreview}
                        raftOverride={{ bottomMode: 'off', thickness: 0 }}
                        highlightJoints={previewState.activeSettingKey === 'joint.defaultJointCount'}
                        anatomyOverrides={mergedOverrides}
                    />
                );
            })}

            <mesh position={[0, 0, sphereCenterZ]}>
                <sphereGeometry args={[sphereRadius, 32, 32]} />
                <meshStandardMaterial
                    color="#888888"
                    roughness={0.7}
                    metalness={0.2}
                />
            </mesh>
        </>
    );
}
