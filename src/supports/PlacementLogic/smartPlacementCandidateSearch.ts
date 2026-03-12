import * as THREE from 'three';
import { Vec3 } from '../types';
import { checkShaftCollision } from './CollisionUtils';
import {
    CandidateNode,
    distance3D,
    distanceXY,
    positionKey,
    SearchNode,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
} from './smartPlacementSearchUtils';

export interface BuildCandidateNodesArgs {
    current: SearchNode;
    socketPos: Vec3;
    blockPoint: Vec3;
    rootTopZ: number;
    mesh: THREE.Mesh;
    collisionRadius: number;
    minAngleDeg: number;
    maxTotalLateralMm: number;
    searchRadiiMm: number[];
    searchDropsMm: number[];
    searchAngles: number;
    minSegmentLengthMm: number;
}

export function buildCandidateNodes(args: BuildCandidateNodesArgs): CandidateNode[] {
    const {
        current,
        socketPos,
        blockPoint,
        rootTopZ,
        mesh,
        collisionRadius,
        minAngleDeg,
        maxTotalLateralMm,
        searchRadiiMm,
        searchDropsMm,
        searchAngles,
        minSegmentLengthMm,
    } = args;

    const candidates: CandidateNode[] = [];
    const seen = new Set<string>();
    const anchorPoints: Vec3[] = [current.pos];

    if (distanceXY(current.pos, blockPoint) > 0.25 || Math.abs(current.pos.z - blockPoint.z) > 0.25) {
        anchorPoints.push(blockPoint);
    }

    for (const anchor of anchorPoints) {
        for (const radius of searchRadiiMm) {
            const requiredDrop = radius * Math.tan((minAngleDeg * Math.PI) / 180);

            for (const drop of searchDropsMm) {
                const targetDrop = Math.max(drop, requiredDrop);
                const nextZ = current.pos.z - targetDrop;

                if (nextZ <= rootTopZ + 0.25) continue;

                for (let angleIdx = 0; angleIdx < searchAngles; angleIdx++) {
                    const angleRad = (angleIdx / searchAngles) * Math.PI * 2;
                    const candidate: Vec3 = {
                        x: anchor.x + Math.cos(angleRad) * radius,
                        y: anchor.y + Math.sin(angleRad) * radius,
                        z: nextZ,
                    };

                    const key = positionKey(candidate);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    if (distance3D(current.pos, candidate) < minSegmentLengthMm) continue;
                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(current.pos, candidate, 90 - minAngleDeg)) continue;

                    const lateralFromSocket = distanceXY(socketPos, candidate);
                    if (lateralFromSocket > maxTotalLateralMm) continue;

                    const segmentCollision = checkShaftCollision(current.pos, candidate, collisionRadius, mesh);
                    if (segmentCollision.hit) continue;

                    const rootTopTarget: Vec3 = { x: candidate.x, y: candidate.y, z: rootTopZ };
                    const descentCollision = checkShaftCollision(candidate, rootTopTarget, collisionRadius, mesh);
                    const downwardProgress = descentCollision.point ? Math.max(0, blockPoint.z - descentCollision.point.z) : (candidate.z - rootTopZ + 20);
                    const anchorPenalty = anchor === current.pos ? 0 : 2;
                    const candidateScore =
                        lateralFromSocket * 8 +
                        distance3D(current.pos, candidate) * 1.5 +
                        current.totalLateral * 5 +
                        anchorPenalty -
                        downwardProgress * 1.25;

                    candidates.push({
                        pos: candidate,
                        score: candidateScore,
                    });
                }
            }
        }
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates;
}
