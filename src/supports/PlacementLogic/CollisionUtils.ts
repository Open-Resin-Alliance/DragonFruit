import * as THREE from 'three';
import { Vec3 } from '../types';
import { bezierToLineSegments } from '../Curves/BezierUtils';

const DOUBLE_SIDED_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

const WHISKER_DIAGONAL = 0.7071067811865476;
const WHISKER_OFFSETS: ReadonlyArray<{ u: number; v: number }> = [
    { u: 1, v: 0 },
    { u: -1, v: 0 },
    { u: 0, v: 1 },
    { u: 0, v: -1 },
    { u: WHISKER_DIAGONAL, v: WHISKER_DIAGONAL },
    { u: -WHISKER_DIAGONAL, v: WHISKER_DIAGONAL },
    { u: WHISKER_DIAGONAL, v: -WHISKER_DIAGONAL },
    { u: -WHISKER_DIAGONAL, v: -WHISKER_DIAGONAL },
];

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0);

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
    const direction = new THREE.Vector3(end.x - start.x, end.y - start.y, end.z - start.z);
    const length = direction.length();

    // If segment is too short, skip check
    if (length < 0.1) {
        return { hit: false };
    }

    direction.multiplyScalar(1 / length);

    // Setup Raycaster
    raycaster.near = 0;
    raycaster.far = length;

    // Avoid false positives when the ray starts exactly on the mesh surface.
    // Move the origin slightly forward along the ray direction.
    const RAY_ORIGIN_EPS_MM = 0.02;
    const eps = Math.min(RAY_ORIGIN_EPS_MM, Math.max(0, length * 0.1));
    const maxRayDistance = Math.max(0, length - eps);
    const rayOrigin = new THREE.Vector3();

    const castFirstHit = (originX: number, originY: number, originZ: number): THREE.Intersection | null => {
        rayOrigin.set(originX, originY, originZ);
        raycaster.near = 0;
        raycaster.far = maxRayDistance;
        raycaster.set(rayOrigin, direction);
        
        const originalMaterial = mesh.material;
        try {
            mesh.material = DOUBLE_SIDED_MATERIAL;
            const intersections = raycaster.intersectObject(mesh, false);
            return intersections.length > 0 ? intersections[0] : null;
        } finally {
            mesh.material = originalMaterial;
        }
    };

    // 1. Check Center Ray
    const centerHit = castFirstHit(
        startVec.x + direction.x * eps,
        startVec.y + direction.y * eps,
        startVec.z + direction.z * eps,
    );

    if (centerHit) {
        return {
            hit: true,
            point: centerHit.point,
            normal: centerHit.face?.normal ? centerHit.face.normal : undefined,
            distance: centerHit.distance
        };
    }

    // 2. Check Perimeter Rays (Whiskers)
    // We create 4 whiskers around the shaft circumference to catch edge clips.
    // We need a coordinate system perpendicular to the direction.
    
    // Create arbitrary perp vector
    const arbitrary = Math.abs(direction.dot(WORLD_UP)) > 0.9 ? WORLD_RIGHT : WORLD_UP;

    const perp1 = new THREE.Vector3().crossVectors(direction, arbitrary).normalize();
    const perp2 = new THREE.Vector3().crossVectors(direction, perp1).normalize();

    for (const off of WHISKER_OFFSETS) {
        const offsetX = (perp1.x * off.u + perp2.x * off.v) * radius;
        const offsetY = (perp1.y * off.u + perp2.y * off.v) * radius;
        const offsetZ = (perp1.z * off.u + perp2.z * off.v) * radius;

        const whiskerHit = castFirstHit(
            startVec.x + offsetX + direction.x * eps,
            startVec.y + offsetY + direction.y * eps,
            startVec.z + offsetZ + direction.z * eps,
        );

        if (whiskerHit) {
            return {
                hit: true,
                point: whiskerHit.point,
                normal: whiskerHit.face?.normal ? whiskerHit.face.normal : undefined,
                distance: whiskerHit.distance
            };
        }
    }

    return { hit: false };
}

/**
 * Clearance for a SHORT bridge (a twig) between two model surfaces.
 *
 * `checkShaftCollision` fires whiskers offset from the axis by `radius`. A
 * twig's socket sits ON the surface it touches, so for any canted twig — the
 * normal case, since it bridges two features a couple of millimeters apart —
 * a whisker offset towards the lower surface starts *inside* the material and
 * the exit hit reads as a collision. Every canted twig was refused this way,
 * automatically and by hand. Check the middle of the span instead: the sockets
 * are anchored on surfaces by construction, and for a twig at most
 * `stickVsTwigCutoffMm` long the middle is what would cross anything.
 */
export function checkShortBridgeCollision(
    start: Vec3,
    end: Vec3,
    radius: number,
    mesh: THREE.Mesh,
): CollisionResult {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dy, dz);
    const inset = Math.min(radius + 0.1, length * 0.35);
    if (length <= inset * 2.2) return { hit: false };

    const ux = dx / length;
    const uy = dy / length;
    const uz = dz / length;
    return checkShaftCollision(
        { x: start.x + ux * inset, y: start.y + uy * inset, z: start.z + uz * inset },
        { x: end.x - ux * inset, y: end.y - uy * inset, z: end.z - uz * inset },
        radius,
        mesh,
    );
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
