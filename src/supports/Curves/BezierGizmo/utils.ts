import * as THREE from 'three';
import { Camera } from 'three';

/**
 * Calculates a uniform scale factor based on distance to camera.
 * This ensures objects appear the same size on screen regardless of depth.
 */
export function getScreenSpaceScale(
    position: THREE.Vector3, 
    camera: Camera, 
    factor: number = 1
): number {
    const distance = camera.position.distanceTo(position);
    return distance * factor;
}

/**
 * Helper to calculate Bezier Control Point from Trunk Data
 * (Placeholder until we have real data structure integration)
 */
export function calculateControlPoint(
    jointPos: THREE.Vector3,
    tangent: THREE.Vector3,
    tension: number,
    segmentLength: number
): THREE.Vector3 {
    // Standard Bezier: Control Point = Joint + Tangent * (Tension * Length)
    // The 1/3 factor is common for cubic bezier approximation of circular arcs, 
    // but we'll stick to direct tension mapping for now.
    const handleLength = segmentLength * tension; 
    return jointPos.clone().add(tangent.clone().multiplyScalar(handleLength));
}
