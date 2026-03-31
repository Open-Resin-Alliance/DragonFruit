import * as THREE from 'three';
import { Vec3 } from '../types';
import { checkShaftCollision } from './CollisionUtils';
import {
    chainSatisfiesLengthAwareUpperSpanRule,
    distanceXY,
    segmentSatisfiesMaxAngleFromVertical,
} from './smartPlacementSearchUtils';

export interface SimplifyRouteJointsArgs {
    routeJoints: Vec3[];
    constructionJoints: Vec3[];
    socketPos: Vec3;
    rootTopTarget: Vec3;
    collisionRadius: number;
    mesh: THREE.Mesh;
    maxAngleFromVerticalDeg: number;
    raycaster?: THREE.Raycaster;
}

function chainIsValid(args: {
    points: Vec3[];
    collisionRadius: number;
    mesh: THREE.Mesh;
    maxAngleFromVerticalDeg: number;
    constructionJointCount: number;
    raycaster?: THREE.Raycaster;
}): boolean {
    const { points, collisionRadius, mesh, maxAngleFromVerticalDeg, constructionJointCount, raycaster } = args;

    for (let i = 0; i < points.length - 1; i++) {
        if (!segmentSatisfiesMaxAngleFromVertical(points[i], points[i + 1], maxAngleFromVerticalDeg)) {
            return false;
        }
        const hit = checkShaftCollision(points[i], points[i + 1], collisionRadius, mesh, raycaster);
        if (hit.hit) {
            return false;
        }
    }

    const upperSpanStartIndex = Math.min(points.length - 1, Math.max(0, constructionJointCount));
    const upperSpanPoints = points.slice(upperSpanStartIndex);
    if (!chainSatisfiesLengthAwareUpperSpanRule(upperSpanPoints, maxAngleFromVerticalDeg)) {
        return false;
    }

    return true;
}

function jointsAreNearCollinear(a: Vec3, b: Vec3, c: Vec3): boolean {
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const abLength = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z);
    const bcLength = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);
    if (abLength < 0.0001 || bcLength < 0.0001) {
        return true;
    }

    const abNorm = { x: ab.x / abLength, y: ab.y / abLength, z: ab.z / abLength };
    const bcNorm = { x: bc.x / bcLength, y: bc.y / bcLength, z: bc.z / bcLength };
    const dot = abNorm.x * bcNorm.x + abNorm.y * bcNorm.y + abNorm.z * bcNorm.z;
    return dot >= 0.995;
}

function jointAddsNegligibleLateralDetour(a: Vec3, b: Vec3, c: Vec3): boolean {
    const splitLateral = distanceXY(a, b) + distanceXY(b, c);
    const directLateral = distanceXY(a, c);
    return splitLateral - directLateral <= 0.75;
}

function jointAddsNegligibleLengthDetour(a: Vec3, b: Vec3, c: Vec3): boolean {
    const splitLength =
        Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2) +
        Math.sqrt((c.x - b.x) ** 2 + (c.y - b.y) ** 2 + (c.z - b.z) ** 2);
    const directLength = Math.sqrt((c.x - a.x) ** 2 + (c.y - a.y) ** 2 + (c.z - a.z) ** 2);
    return splitLength - directLength <= 1.0;
}

export function simplifyRouteJoints(args: SimplifyRouteJointsArgs): Vec3[] {
    const { routeJoints, constructionJoints, socketPos, rootTopTarget, collisionRadius, mesh, maxAngleFromVerticalDeg, raycaster } = args;

    if (routeJoints.length < 2) {
        return routeJoints;
    }

    let simplified = [...routeJoints];
    let changed = true;

    while (changed) {
        changed = false;

        for (let i = 0; i < simplified.length; i++) {
            const previous = i === 0 ? (constructionJoints[constructionJoints.length - 1] ?? rootTopTarget) : simplified[i - 1];
            const current = simplified[i];
            const next = i === simplified.length - 1 ? socketPos : simplified[i + 1];

            if (
                !jointsAreNearCollinear(previous, current, next) &&
                !jointAddsNegligibleLateralDetour(previous, current, next) &&
                !jointAddsNegligibleLengthDetour(previous, current, next)
            ) {
                continue;
            }

            const candidateRouteJoints = simplified.filter((_, index) => index !== i);
            const chainPoints = [
                rootTopTarget,
                ...constructionJoints,
                ...candidateRouteJoints,
                socketPos,
            ];

            if (!chainIsValid({
                points: chainPoints,
                collisionRadius,
                mesh,
                maxAngleFromVerticalDeg,
                constructionJointCount: constructionJoints.length,
                raycaster,
            })) {
                continue;
            }

            simplified = candidateRouteJoints;
            changed = true;
            break;
        }
    }

    return simplified;
}
