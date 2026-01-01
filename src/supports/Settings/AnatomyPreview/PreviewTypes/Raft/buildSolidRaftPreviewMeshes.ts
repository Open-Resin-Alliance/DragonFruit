import * as THREE from 'three';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { generateChamferedBase } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBase';
import { generatePerimeterWall } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '@/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual';

export function buildSolidRaftPreviewMeshes(args: {
    circles: SupportBaseCircle[];
    raftSettings: RaftSettings;
    baseColor: string;
    wallColor: string;
}): { baseMesh: THREE.Mesh; wallMesh: THREE.Mesh | null } | null {
    const profile = computeFootprint(args.circles, { marginMm: 0.2, samplesPerCircle: 24 });
    if (!profile || profile.length < 3) return null;

    const baseMesh = generateChamferedBase(profile, {
        thickness: args.raftSettings.thickness,
        chamferAngle: args.raftSettings.chamferAngle,
    });

    baseMesh.material = new THREE.MeshStandardMaterial({
        color: args.baseColor,
        emissive: args.baseColor,
        emissiveIntensity: 0.08,
        roughness: 0.9,
        metalness: 0.0,
        opacity: 1.0,
        transparent: false,
        side: THREE.DoubleSide,
    });
    baseMesh.castShadow = false;
    baseMesh.receiveShadow = true;

    let wallMesh: THREE.Mesh | null = null;
    if (args.raftSettings.wallEnabled) {
        const useCrenels = args.raftSettings.crenulationSpacing > 0 && args.raftSettings.crenulationGapWidth > 0;
        wallMesh = useCrenels
            ? generateCrenelatedWallManual(profile, {
                wallHeight: args.raftSettings.wallHeight,
                wallThickness: args.raftSettings.wallThickness,
                crenulationGapWidth: args.raftSettings.crenulationGapWidth,
                crenulationSpacing: args.raftSettings.crenulationSpacing,
                thickness: args.raftSettings.thickness,
                chamferAngle: args.raftSettings.chamferAngle,
            })
            : generatePerimeterWall(profile, {
                wallHeight: args.raftSettings.wallHeight,
                wallThickness: args.raftSettings.wallThickness,
                thickness: args.raftSettings.thickness,
            });

        wallMesh.material = new THREE.MeshStandardMaterial({
            color: args.wallColor,
            roughness: 0.9,
            metalness: 0.0,
            opacity: 1.0,
            transparent: false,
        });
        wallMesh.castShadow = false;
        wallMesh.receiveShadow = true;
    }

    return { baseMesh, wallMesh };
}
