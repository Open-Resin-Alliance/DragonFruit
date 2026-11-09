import * as THREE from 'three';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { buildRaftFootprintMeshes } from '@/supports/Rafts/Crenelated/geometry/generateRaftFromFootprint';
import type { PolygonWithHoles } from '@/supports/Rafts/Crenelated/geometry/polygonSet2d';

export function buildSolidRaftPreviewMeshes(args: {
    circles: SupportBaseCircle[];
    raftSettings: RaftSettings;
    baseColor: string;
    wallColor: string;
    /** Model plate footprint; the raft is trimmed where a model stands on the plate. */
    clearance?: readonly PolygonWithHoles[] | null;
}): { baseMesh: THREE.Mesh; wallMesh: THREE.Mesh | null } | null {
    const parts = buildRaftFootprintMeshes({
        circles: args.circles,
        raft: args.raftSettings,
        clearance: args.clearance,
    });
    if (!parts.baseMesh) return null;

    const baseMesh = parts.baseMesh;
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

    const wallMesh = parts.wallMesh;
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

    return { baseMesh, wallMesh };
}
