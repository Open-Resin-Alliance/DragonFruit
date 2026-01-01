import * as THREE from 'three';
import { Vec3 } from '../types';
import { checkShaftCollision } from './CollisionUtils';

/**
 * Calculates the required standoff distance (offset) from a surface to ensure
 * a connecting element (like a cone) does not collide with the mesh.
 * 
 * @param surfacePos - The starting point on the model surface.
 * @param surfaceNormal - The normal vector at the surface point (direction to extend).
 * @param targetPos - The target position the element connects to (e.g., Socket).
 * @param collisionRadius - The radius of the element for collision checking (include safety margin).
 * @param mesh - The model mesh to check against.
 * @param minOffset - The minimum/starting offset to test.
 * @param maxOffset - The maximum allowable offset.
 * @param step - The increment for iterative testing (default: 0.2mm).
 * @returns The calculated safe offset distance.
 */
export function calculateSafeOffset(
    surfacePos: Vec3,
    surfaceNormal: Vec3,
    targetPos: Vec3,
    collisionRadius: number,
    mesh: THREE.Mesh,
    minOffset: number,
    maxOffset: number,
    step: number = 0.2
): number {
    let safeOffset = minOffset;
    
    const start = new THREE.Vector3(surfacePos.x, surfacePos.y, surfacePos.z);
    const normal = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z).normalize();
    const target = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z); // Not used directly in loop but good for ref
    
    // Check initial position first
    // Note: checkShaftCollision expects Vec3 inputs
    
    for (let t = minOffset; t <= maxOffset; t += step) {
        // Calculate proposed start position: Surface + (Normal * t)
        const testStartVec = start.clone().add(normal.clone().multiplyScalar(t));
        const testStart: Vec3 = { x: testStartVec.x, y: testStartVec.y, z: testStartVec.z };
        
        // Check collision from TestStart -> Target
        const col = checkShaftCollision(testStart, targetPos, collisionRadius, mesh);
        
        if (!col.hit) {
            // Found a safe path!
            return t;
        }
        
        // If hit, we continue loop to try next thickness
        safeOffset = t;
    }
    
    // If we exhausted the loop without finding a clear path, returns the last checked (max) offset.
    // Alternatively, return maxOffset explicitly if we want to cap it.
    // Depending on step, safeOffset might be slightly less than maxOffset.
    return Math.min(safeOffset + step, maxOffset); 
}
