import * as THREE from 'three';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { delaunayTriangulate2d } from '@/supports/Rafts/Crenelated/geometry/delaunayTriangulate2d';
import { generateUnionedLineRaftMesh } from '@/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBeam';
import { generatePerimeterBorderBeam } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterBorderBeam';
import { generatePerimeterWall } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '@/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual';

type EdgeKey = string;

function edgeKey(a: number, b: number): EdgeKey {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function edgeLen(a: THREE.Vector2, b: THREE.Vector2): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
}

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

    const hull = convexHull2d(nodes2d);

    const hullIndices: number[] = hull.map((hp) => {
        let best = 0;
        let bestD2 = Infinity;
        for (let i = 0; i < nodes2d.length; i++) {
            const p = nodes2d[i];
            const dx = p.x - hp.x;
            const dy = p.y - hp.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = i;
            }
        }
        return best;
    });

    const hullEdges: Array<[number, number]> = [];
    if (hullIndices.length >= 2) {
        for (let i = 0; i < hullIndices.length; i++) {
            const a = hullIndices[i];
            const b = hullIndices[(i + 1) % hullIndices.length];
            if (a !== b) hullEdges.push([a, b]);
        }
    }

    const hullEdgeSet = new Set<EdgeKey>();
    for (const [a, b] of hullEdges) hullEdgeSet.add(edgeKey(a, b));

    const tris = delaunayTriangulate2d(nodes2d);

    const nn = new Array(nodes2d.length).fill(Infinity);
    for (let i = 0; i < nodes2d.length; i++) {
        for (let j = 0; j < nodes2d.length; j++) {
            if (i === j) continue;
            nn[i] = Math.min(nn[i], edgeLen(nodes2d[i], nodes2d[j]));
        }
        if (!Number.isFinite(nn[i])) nn[i] = 0;
    }

    const keepFactor = 3.2;
    const absMaxLen = 120;
    const edges = new Set<EdgeKey>();
    const edgePairs: Array<[number, number]> = [];

    if (!hasBorderRing) {
        for (const [a, b] of hullEdges) {
            const key = edgeKey(a, b);
            if (!edges.has(key)) {
                edges.add(key);
                edgePairs.push([a, b]);
            }
        }
    }

    for (const [i, j, k] of tris) {
        const triEdges: Array<[number, number]> = [
            [i, j],
            [j, k],
            [k, i],
        ];

        for (const [a, b] of triEdges) {
            const key = edgeKey(a, b);
            if (edges.has(key)) continue;
            if (hasBorderRing && hullEdgeSet.has(key)) continue;
            const len = edgeLen(nodes2d[a], nodes2d[b]);
            const localMax = keepFactor * Math.min(nn[a], nn[b]);
            if (len > absMaxLen) continue;
            if (nn[a] > 0 && nn[b] > 0 && len > localMax) continue;
            edges.add(key);
            edgePairs.push([a, b]);
        }
    }

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

    let borderMesh: THREE.Mesh | null = null;
    if (hasBorderRing && profile) {
        borderMesh = generatePerimeterBorderBeam(profile, {
            widthMm: args.raftSettings.lineWidthMm,
            heightMm: beamHeight,
            chamferAngleDeg: args.raftSettings.chamferAngle,
        });
        borderMesh.material = beamMaterial;
        borderMesh.castShadow = false;
        borderMesh.receiveShadow = true;
    }

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
