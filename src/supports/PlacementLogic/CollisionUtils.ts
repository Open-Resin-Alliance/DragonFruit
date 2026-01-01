import * as THREE from 'three';
import { Vec3 } from '../types';
import { bezierToLineSegments } from '../Curves/BezierUtils';

export interface CollisionResult {
    hit: boolean;
    point?: Vec3;
    normal?: Vec3;
    distance?: number;
}

/**
 * Checks if a cylindrical shaft collides with a mesh.
 * Uses a bundle of rays (center + perimeter) to detect collisions.
 * 
 * @param start - Start position of the shaft segment (e.g. Socket or Joint)
 * @param end - End position of the shaft segment (e.g. Joint or Base)
 * @param radius - Radius of the shaft
 * @param mesh - The model mesh to check against
 * @param raycaster - Optional shared raycaster instance to avoid reallocation
 */
export function checkShaftCollision(
    start: Vec3,
    end: Vec3,
    radius: number,
    mesh: THREE.Mesh,
    raycaster: THREE.Raycaster = new THREE.Raycaster()
): CollisionResult {
    const startVec = new THREE.Vector3(start.x, start.y, start.z);
    const endVec = new THREE.Vector3(end.x, end.y, end.z);
    
    // Calculate direction and length
    const direction = new THREE.Vector3().subVectors(endVec, startVec);
    const length = direction.length();
    direction.normalize();

    // If segment is too short, skip check
    if (length < 0.1) {
        return { hit: false };
    }

    // Setup Raycaster
    raycaster.near = 0;
    raycaster.far = length;

    // Avoid false positives when the ray starts exactly on the mesh surface.
    // Move the origin slightly forward along the ray direction.
    const RAY_ORIGIN_EPS_MM = 0.02;
    const eps = Math.min(RAY_ORIGIN_EPS_MM, Math.max(0, length * 0.1));

    // 1. Check Center Ray
    const centerOrigin = startVec.clone().add(direction.clone().multiplyScalar(eps));
    raycaster.near = 0;
    raycaster.far = Math.max(0, length - eps);
    raycaster.set(centerOrigin, direction);
    const centerIntersects = raycaster.intersectObject(mesh, false);

    if (centerIntersects.length > 0) {
        const hit = centerIntersects[0];
        return {
            hit: true,
            point: hit.point,
            normal: hit.face?.normal ? hit.face.normal : undefined,
            distance: hit.distance
        };
    }

    // 2. Check Perimeter Rays (Whiskers)
    // We create 4 whiskers around the shaft circumference to catch edge clips.
    // We need a coordinate system perpendicular to the direction.
    
    // Create arbitrary perp vector
    const arbitrary = Math.abs(direction.dot(new THREE.Vector3(0, 1, 0))) > 0.9
        ? new THREE.Vector3(1, 0, 0) 
        : new THREE.Vector3(0, 1, 0);
        
    const perp1 = new THREE.Vector3().crossVectors(direction, arbitrary).normalize();
    const perp2 = new THREE.Vector3().crossVectors(direction, perp1).normalize();

    // 8 points around the circle (45 degrees)
    const d = 0.7071; // approx sqrt(2)/2
    const offsets = [
        { u: 1, v: 0 },
        { u: -1, v: 0 },
        { u: 0, v: 1 },
        { u: 0, v: -1 },
        { u: d, v: d },
        { u: -d, v: d },
        { u: d, v: -d },
        { u: -d, v: -d }
    ];

    for (const off of offsets) {
        const originOffset = new THREE.Vector3()
            .addScaledVector(perp1, off.u * radius)
            .addScaledVector(perp2, off.v * radius);
            
        const whiskerStart = new THREE.Vector3().addVectors(startVec, originOffset);
        const whiskerOrigin = whiskerStart.clone().add(direction.clone().multiplyScalar(eps));
        
        raycaster.near = 0;
        raycaster.far = Math.max(0, length - eps);
        raycaster.set(whiskerOrigin, direction);
        const intersects = raycaster.intersectObject(mesh, false);

        if (intersects.length > 0) {
            const hit = intersects[0];
            // Adjust hit point back to center line? 
            // For now, returning the actual hit point is fine, 
            // but the distance should be relative to start.
            return {
                hit: true,
                point: hit.point,
                normal: hit.face?.normal ? hit.face.normal : undefined,
                distance: hit.distance
            };
        }
    }

    return { hit: false };
}

/**
 * Checks if a Bezier curve collides with a mesh.
 * Approximates the curve as a series of straight segments.
 */
export function checkBezierCollision(
    p0: Vec3,
    p1: Vec3, // Control 1
    p2: Vec3, // Control 2
    p3: Vec3,
    radius: number,
    mesh: THREE.Mesh,
    raycaster: THREE.Raycaster = new THREE.Raycaster(),
    resolution: number = 8
): CollisionResult {
    // Convert to line segments
    const points = bezierToLineSegments(p0, p1, p2, p3, resolution);
    
    for (let i = 0; i < points.length - 1; i++) {
        const start = points[i];
        const end = points[i+1];
        
        const result = checkShaftCollision(start, end, radius, mesh, raycaster);
        if (result.hit) {
            return result; // Return first hit
        }
    }
    
    return { hit: false };
}
