import * as THREE from 'three';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { buildLineRaftEdgePairs } from '@/supports/Rafts/Crenelated/geometry/buildLineRaftEdgePairs';
import { generateUnionedLineRaftMesh } from '@/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBeam';
import { generatePerimeterWall } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '@/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual';

export function buildLineRaftPreviewMeshes(args: {
    circles: SupportBaseCircle[];
    raftSettings: RaftSettings;
    beamColor: string;
    wallColor: string;
}): { beamMeshes: THREE.Mesh[]; borderMesh: THREE.Mesh | null; wallMesh: THREE.Mesh | null } | null {
    const nodes2d = args.circles.map((c) => new THREE.Vector2(c.x, c.y));
    if (nodes2d.length === 0) return null;

    const chamferInset = Math.max(0, args.raftSettings.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, args.raftSettings.chamferAngle))));
    const profile = computeFootprint(args.circles, { marginMm: 0.2 + chamferInset, samplesPerCircle: 24 });
    const hasBorderRing = !!profile && profile.length >= 3;

    const edgePairs = buildLineRaftEdgePairs(nodes2d, {
        hasBorderRing,
        keepFactor: 8,
        absMaxLen: 220,
        enforceConnected: true,
    });

    const beamHeight = Math.max(0.01, args.raftSettings.lineHeightMm);
    const unionEdges: Array<[THREE.Vector2, THREE.Vector2]> = edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]);

    const beamMaterial = new THREE.MeshStandardMaterial({
        color: args.beamColor,
        emissive: args.beamColor,
        emissiveIntensity: 0.08,
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
    });

    const unionMesh = generateUnionedLineRaftMesh(unionEdges, {
        widthMm: args.raftSettings.lineWidthMm,
        heightMm: beamHeight,
        borderProfile: null,
    });
    unionMesh.material = beamMaterial;
    unionMesh.castShadow = false;
    unionMesh.receiveShadow = true;

    const unionHasGeometry = (unionMesh.geometry as any)?.attributes?.position?.count > 0;
    const beamMeshes: THREE.Mesh[] = [];

    if (unionHasGeometry) {
        beamMeshes.push(unionMesh);
    } else {
        (unionMesh.geometry as any)?.dispose?.();
        for (const [a, b] of edgePairs) {
            const start = new THREE.Vector3(nodes2d[a].x, nodes2d[a].y, 0);
            const end = new THREE.Vector3(nodes2d[b].x, nodes2d[b].y, 0);
            const mesh = generateChamferedBeam(start, end, {
                widthMm: args.raftSettings.lineWidthMm,
                heightMm: beamHeight,
                chamferAngleDeg: 90,
            });
            mesh.material = beamMaterial;
            mesh.castShadow = false;
            mesh.receiveShadow = true;
            beamMeshes.push(mesh);
        }
    }

    const borderMesh: THREE.Mesh | null = null;

    let wallMesh: THREE.Mesh | null = null;
    if (args.raftSettings.wallEnabled && profile && profile.length >= 3) {
        const useCrenels = args.raftSettings.crenulationSpacing > 0 && args.raftSettings.crenulationGapWidth > 0;
        wallMesh = useCrenels
            ? generateCrenelatedWallManual(profile, {
                wallHeight: args.raftSettings.wallHeight,
                wallThickness: args.raftSettings.wallThickness,
                crenulationGapWidth: args.raftSettings.crenulationGapWidth,
                crenulationSpacing: args.raftSettings.crenulationSpacing,
                thickness: beamHeight,
                chamferAngle: args.raftSettings.chamferAngle,
            })
            : generatePerimeterWall(profile, {
                wallHeight: args.raftSettings.wallHeight,
                wallThickness: args.raftSettings.wallThickness,
                thickness: beamHeight,
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

    return { beamMeshes, borderMesh, wallMesh };
}
