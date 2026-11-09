import * as THREE from 'three';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { computeRaftFootprintPolygons, inflateModelPlateClearance, raftWallBaseHeightMm } from '@/supports/Rafts/Crenelated/geometry/computeRaftFootprint';
import { buildLineRaftEdgePairs } from '@/supports/Rafts/Crenelated/geometry/buildLineRaftEdgePairs';
import { filterLineRaftEdges, generateUnionedLineRaftMesh } from '@/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBeam';
import { generateWallFromPolygons, isUntrimmedFootprint } from '@/supports/Rafts/Crenelated/geometry/generateRaftFromFootprint';
import { generatePerimeterWall } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '@/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual';
import type { PolygonWithHoles } from '@/supports/Rafts/Crenelated/geometry/polygonSet2d';

export function buildLineRaftPreviewMeshes(args: {
    circles: SupportBaseCircle[];
    raftSettings: RaftSettings;
    beamColor: string;
    wallColor: string;
    /** Model plate footprint; beams are cut where a model stands on the plate. */
    clearance?: readonly PolygonWithHoles[] | null;
}): { beamMeshes: THREE.Mesh[]; borderMesh: THREE.Mesh | null; wallMesh: THREE.Mesh | null } | null {
    const nodes2d = args.circles.map((c) => new THREE.Vector2(c.x, c.y));
    if (nodes2d.length === 0) return null;

    const footprint = computeRaftFootprintPolygons({
        circles: args.circles,
        raft: args.raftSettings,
        clearance: args.clearance,
    });
    if (footprint.length === 0) return null;

    const hasBorderRing = footprint.length > 0;
    const edgePairs = buildLineRaftEdgePairs(nodes2d, {
        hasBorderRing,
        keepFactor: 8,
        absMaxLen: 220,
        enforceConnected: true,
    });

    const beamHeight = Math.max(0.01, args.raftSettings.lineHeightMm);
    // Beams a model on the plate is in the way of are never drawn: cutting them
    // would leave severed ends to close up again, and two clusters either side of
    // a model should stay two clusters.
    const unionEdges: Array<[THREE.Vector2, THREE.Vector2]> = filterLineRaftEdges(
      edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]),
      inflateModelPlateClearance(args.clearance ?? []),
      args.raftSettings.lineWidthMm,
    );

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

    const unionPositionAttribute = unionMesh.geometry.getAttribute('position');
    const unionHasGeometry = !!unionPositionAttribute && unionPositionAttribute.count > 0;
    const beamMeshes: THREE.Mesh[] = [];

    if (unionHasGeometry) {
        beamMeshes.push(unionMesh);
    } else {
        unionMesh.geometry.dispose();
        for (const [a, b] of unionEdges) {
            const start = new THREE.Vector3(a.x, a.y, 0);
            const end = new THREE.Vector3(b.x, b.y, 0);
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

    let wallMesh: THREE.Mesh | null = null;
    if (args.raftSettings.wallEnabled) {
        const wallBaseHeight = raftWallBaseHeightMm(args.raftSettings);
        if (isUntrimmedFootprint(footprint)) {
            const profile = footprint[0].outer;
            const useCrenels = args.raftSettings.crenulationSpacing > 0 && args.raftSettings.crenulationGapWidth > 0;
            wallMesh = useCrenels
                ? generateCrenelatedWallManual(profile, {
                    wallHeight: args.raftSettings.wallHeight,
                    wallThickness: args.raftSettings.wallThickness,
                    crenulationGapWidth: args.raftSettings.crenulationGapWidth,
                    crenulationSpacing: args.raftSettings.crenulationSpacing,
                    thickness: wallBaseHeight,
                    chamferAngle: args.raftSettings.chamferAngle,
                })
                : generatePerimeterWall(profile, {
                    wallHeight: args.raftSettings.wallHeight,
                    wallThickness: args.raftSettings.wallThickness,
                    thickness: wallBaseHeight,
                });
        } else {
            wallMesh = generateWallFromPolygons(footprint, {
                thickness: wallBaseHeight,
                chamferAngle: args.raftSettings.chamferAngle,
                wallHeight: args.raftSettings.wallHeight,
                wallThickness: args.raftSettings.wallThickness,
                crenulationGapWidth: args.raftSettings.crenulationGapWidth,
                crenulationSpacing: args.raftSettings.crenulationSpacing,
            });
        }

        if (wallMesh) {
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
    }

    return { beamMeshes, borderMesh: null, wallMesh };
}
