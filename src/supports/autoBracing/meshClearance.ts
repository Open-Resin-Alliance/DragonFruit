import * as THREE from 'three';
import type { Vec3 } from '../types';
import { AUTO_BRACING_HARD_RULES } from './settings';
import { getAllMeshEntriesForAutoBrace } from './meshGeometryStore';

const BRACE_CLEARANCE_SAMPLE_COUNT = 12;

/**
 * Returns true if the centerline from posA to posB maintains model clearance.
 */
export function linePassesMeshClearance(posA: Vec3, posB: Vec3, modelId: string, diameterMm: number): boolean {
    const minClearance = AUTO_BRACING_HARD_RULES.supportBraceMeshClearanceMm + diameterMm / 2;
    const meshEntries = getAllMeshEntriesForAutoBrace();

    const entry = meshEntries.get(modelId);
    if (!entry) return true;

    const bvh = (entry.geometry as any).boundsTree;
    if (!bvh) return true;

    const inverseMatrix = entry.transform.clone().invert();
    const scaleVec = new THREE.Vector3();
    entry.transform.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleVec);
    const worldScale = (scaleVec.x + scaleVec.y + scaleVec.z) / 3;

    const ax = posA.x, ay = posA.y, az = posA.z;
    const bx = posB.x, by = posB.y, bz = posB.z;
    const resultTarget: { point?: THREE.Vector3; distance?: number } = {};

    for (let i = 0; i <= BRACE_CLEARANCE_SAMPLE_COUNT; i++) {
        const t = i / BRACE_CLEARANCE_SAMPLE_COUNT;
        const worldPoint = new THREE.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        const localPoint = worldPoint.clone().applyMatrix4(inverseMatrix);
        const result = bvh.closestPointToPoint(localPoint, resultTarget);
        if (!result) continue;

        const worldDist = (result.distance as number) * worldScale;
        if (worldDist < minClearance) return false;
    }
    return true;
}
