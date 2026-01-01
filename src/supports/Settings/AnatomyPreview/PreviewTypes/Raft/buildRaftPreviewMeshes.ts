import * as THREE from 'three';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { buildSolidRaftPreviewMeshes } from './buildSolidRaftPreviewMeshes';
import { buildLineRaftPreviewMeshes } from './buildLineRaftPreviewMeshes';

export type RaftPreviewMeshes =
    | { kind: 'solid'; baseMesh: THREE.Mesh; wallMesh: THREE.Mesh | null }
    | { kind: 'line'; beamMeshes: THREE.Mesh[]; borderMesh: THREE.Mesh | null; wallMesh: THREE.Mesh | null };

export function buildRaftPreviewMeshes(args: {
    circles: SupportBaseCircle[];
    raftSettings: RaftSettings;
    focusKey: string | null;
    colors: { normal: string; dim: string; highlight: string };
}): RaftPreviewMeshes | null {
    const focusKey = args.focusKey;
    const isRaftFocus = typeof focusKey === 'string' && focusKey.startsWith('raft.');

    const isThicknessFocus = focusKey === 'raft.thickness';
    const isChamferFocus = focusKey === 'raft.chamferAngle';

    const isLineWidthFocus = focusKey === 'raft.lineWidthMm';
    const isLineHeightFocus = focusKey === 'raft.lineHeightMm';
    const isLineFocus = isLineWidthFocus || isLineHeightFocus;

    const isWallHeightFocus = focusKey === 'raft.wallHeight';
    const isWallThicknessFocus = focusKey === 'raft.wallThickness';
    const isGapWidthFocus = focusKey === 'raft.crenulationGapWidth';
    const isWallFocus = isWallHeightFocus || isWallThicknessFocus || isGapWidthFocus;

    if (args.raftSettings.bottomMode === 'solid') {
        const baseColor = isWallFocus
            ? args.colors.dim
            : isThicknessFocus || isChamferFocus
                ? args.colors.highlight
                : isRaftFocus
                    ? args.colors.dim
                    : args.colors.normal;

        const wallColor = isWallFocus
            ? args.colors.highlight
            : isThicknessFocus || isChamferFocus
                ? args.colors.dim
                : isRaftFocus
                    ? args.colors.dim
                    : args.colors.normal;

        const solid = buildSolidRaftPreviewMeshes({
            circles: args.circles,
            raftSettings: args.raftSettings,
            baseColor,
            wallColor,
        });

        if (!solid) return null;
        return { kind: 'solid', baseMesh: solid.baseMesh, wallMesh: solid.wallMesh };
    }

    if (args.raftSettings.bottomMode === 'line') {
        const beamColor = isLineFocus
            ? args.colors.highlight
            : isWallFocus
                ? args.colors.dim
                : isRaftFocus
                    ? args.colors.dim
                    : args.colors.normal;

        const wallColor = isWallFocus
            ? args.colors.highlight
            : isLineFocus
                ? args.colors.dim
                : isRaftFocus
                    ? args.colors.dim
                    : args.colors.normal;

        const line = buildLineRaftPreviewMeshes({
            circles: args.circles,
            raftSettings: args.raftSettings,
            beamColor,
            wallColor,
        });

        if (!line) return null;
        return { kind: 'line', beamMeshes: line.beamMeshes, borderMesh: line.borderMesh, wallMesh: line.wallMesh };
    }

    return null;
}

export function disposeRaftPreviewMeshes(meshes: RaftPreviewMeshes | null) {
    if (!meshes) return;

    const disposeMesh = (m: THREE.Mesh | null) => {
        if (!m) return;
        m.geometry?.dispose?.();
        (m.material as any)?.dispose?.();
    };

    if (meshes.kind === 'solid') {
        disposeMesh(meshes.baseMesh);
        disposeMesh(meshes.wallMesh);
        return;
    }

    for (const m of meshes.beamMeshes) disposeMesh(m);
    disposeMesh(meshes.borderMesh);
    disposeMesh(meshes.wallMesh);
}
